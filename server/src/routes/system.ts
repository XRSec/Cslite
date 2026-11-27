import { Hono, type Context } from 'hono';
import {
  ErrorCode,
  type SystemCleanupRequest,
  type SystemInfoDTO,
  type UpdateSystemSettingsRequest,
} from '../../../shared/types';
import type { AppConfig } from '../config';
import type { SqlDriver, SqlStatement } from '../db/driver';
import {
  normalizeRetentionDays,
  resolveRetentionConfig,
  runLogRetentionCleanup,
} from '../lib/cleanup';
import { writeAuditLog } from '../lib/reconcile';
import { fail, getClientIp, ok, readJsonBody } from '../lib/response';
import { isValidTimeZone, resolveEffectiveTimeZone } from '../lib/timezone';
import { requireAdmin, requireAuth, type AppEnv } from '../middleware/auth';

async function buildSystemInfoDTO(driver: SqlDriver, config: AppConfig): Promise<SystemInfoDTO> {
  const [tzInfo, retentionInfo] = await Promise.all([
    resolveEffectiveTimeZone(driver, config),
    resolveRetentionConfig(driver, config),
  ]);
  return {
    version: config.version,
    runtime: config.runtime,
    db_dialect: driver.dialect,
    allow_registration: config.allowRegistration,
    heartbeat_interval: config.heartbeatInterval,
    poll_interval: config.pollInterval,
    timezone: tzInfo.timezone,
    timezone_source: tzInfo.source,
    env_timezone: tzInfo.envTimezone,
    log_retention_days: retentionInfo.retentionDays,
    log_retention_source: retentionInfo.source,
    env_log_retention_days: retentionInfo.envRetentionDays,
    last_cleanup_at: retentionInfo.lastCleanupAt,
    server_time: new Date().toISOString(),
  };
}

export function createSystemRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/info', async (c) => {
    const config = c.get('config');
    const driver = c.get('driver');
    return ok(c, await buildSystemInfoDTO(driver, config));
  });

  const handleUpdateSettings = async (c: Context<AppEnv>) => {
    const config = c.get('config');
    const driver = c.get('driver');
    const user = c.get('user');

    const body = await readJsonBody<Partial<UpdateSystemSettingsRequest>>(
      c,
      config.maxPayloadBytes,
    );

    if (body.timezone === undefined && body.log_retention_days === undefined) {
      return fail(
        c,
        ErrorCode.VALIDATION_ERROR,
        'At least one of timezone or log_retention_days must be provided',
        400,
      );
    }

    const nowIso = new Date().toISOString();
    const stmts: SqlStatement[] = [];
    const auditDetail: Record<string, unknown> = {};

    if (body.timezone !== undefined) {
      if (body.timezone === null || (typeof body.timezone === 'string' && !body.timezone.trim())) {
        stmts.push({ sql: "DELETE FROM system_settings WHERE key_name = 'timezone'" });
        auditDetail.timezone = null;
      } else if (typeof body.timezone === 'string') {
        const trimmed = body.timezone.trim();
        if (!isValidTimeZone(trimmed)) {
          return fail(c, ErrorCode.VALIDATION_ERROR, `Invalid IANA timezone: "${trimmed}"`, 400);
        }
        stmts.push(
          { sql: "DELETE FROM system_settings WHERE key_name = 'timezone'" },
          {
            sql: "INSERT INTO system_settings (key_name, value, updated_at) VALUES ('timezone', ?, ?)",
            params: [trimmed, nowIso],
          },
        );
        auditDetail.timezone = trimmed;
      } else {
        return fail(
          c,
          ErrorCode.VALIDATION_ERROR,
          'timezone must be a valid IANA timezone string or null',
          400,
        );
      }
    }

    if (body.log_retention_days !== undefined) {
      if (body.log_retention_days === null) {
        stmts.push({ sql: "DELETE FROM system_settings WHERE key_name = 'log_retention_days'" });
        auditDetail.log_retention_days = null;
      } else {
        const days = normalizeRetentionDays(body.log_retention_days);
        if (days === null) {
          return fail(
            c,
            ErrorCode.VALIDATION_ERROR,
            'log_retention_days must be an integer between 0 and 3650',
            400,
          );
        }
        stmts.push(
          { sql: "DELETE FROM system_settings WHERE key_name = 'log_retention_days'" },
          {
            sql: "INSERT INTO system_settings (key_name, value, updated_at) VALUES ('log_retention_days', ?, ?)",
            params: [String(days), nowIso],
          },
        );
        auditDetail.log_retention_days = days;
      }
    }

    if (stmts.length > 0) {
      await driver.batch(stmts);
    }

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'update_system_settings',
      targetId: 'system',
      ip: getClientIp(c),
      detail: JSON.stringify(auditDetail),
      timestamp: nowIso,
    });

    return ok(c, await buildSystemInfoDTO(driver, config), 'System settings updated');
  };

  router.put('/settings', requireAuth, requireAdmin, handleUpdateSettings);
  router.patch('/settings', requireAuth, requireAdmin, handleUpdateSettings);

  router.post('/cleanup', requireAuth, requireAdmin, async (c) => {
    const config = c.get('config');
    const driver = c.get('driver');
    const user = c.get('user');

    const body = await readJsonBody<Partial<SystemCleanupRequest>>(c, config.maxPayloadBytes);
    let retentionDays: number;

    if (body.retention_days !== undefined) {
      const parsed = normalizeRetentionDays(body.retention_days);
      if (parsed === null || parsed < 1) {
        return fail(
          c,
          ErrorCode.VALIDATION_ERROR,
          'retention_days must be an integer between 1 and 3650',
          400,
        );
      }
      retentionDays = parsed;
    } else {
      const resolved = await resolveRetentionConfig(driver, config);
      if (resolved.retentionDays <= 0) {
        return fail(
          c,
          ErrorCode.VALIDATION_ERROR,
          'Log retention cleanup is currently disabled (log_retention_days=0); specify retention_days >= 1 for manual cleanup',
          400,
        );
      }
      retentionDays = resolved.retentionDays;
    }

    const result = await runLogRetentionCleanup(driver, retentionDays);

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'run_log_cleanup',
      targetId: 'system',
      ip: getClientIp(c),
      detail: JSON.stringify({
        retention_days: result.retention_days,
        cutoff_at: result.cutoff_at,
        deleted: result.deleted,
      }),
      timestamp: result.ran_at,
    });

    return ok(c, result, 'Log cleanup completed');
  });

  return router;
}
