import type { SystemCleanupResponse } from '../../../shared/types';
import type { AppConfig } from '../config';
import type { SqlDriver } from '../db/driver';

export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const MAX_LOG_RETENTION_DAYS = 3650;
const CHECK_THROTTLE_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const lastCheckedByDriver = new WeakMap<SqlDriver, number>();
const runningByDriver = new WeakMap<SqlDriver, Promise<void>>();

export interface ResolvedRetentionConfig {
  retentionDays: number;
  source: 'setting' | 'env' | 'default';
  envRetentionDays: number | null;
  lastCleanupAt: string | null;
}

export function normalizeRetentionDays(val: unknown): number | null {
  if (typeof val === 'number') {
    return Number.isInteger(val) && val >= 0 && val <= MAX_LOG_RETENTION_DAYS ? val : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_LOG_RETENTION_DAYS ? parsed : null;
  }
  return null;
}

/**
 * Resolves effective log retention configuration: DB system_settings > env > default (30).
 */
export async function resolveRetentionConfig(
  driver: SqlDriver,
  config: AppConfig,
): Promise<ResolvedRetentionConfig> {
  const envDays =
    typeof config.envLogRetentionDays === 'number' &&
    config.envLogRetentionDays >= 0 &&
    config.envLogRetentionDays <= MAX_LOG_RETENTION_DAYS
      ? config.envLogRetentionDays
      : null;

  let settingDays: number | null = null;
  let lastCleanupAt: string | null = null;

  try {
    const rows = await driver.all<{ key_name: string; value: string }>(
      "SELECT key_name, value FROM system_settings WHERE key_name IN ('log_retention_days', 'log_cleanup_last_run')",
    );
    for (const r of rows) {
      if (r.key_name === 'log_retention_days') {
        settingDays = normalizeRetentionDays(r.value);
      } else if (r.key_name === 'log_cleanup_last_run' && r.value.trim()) {
        lastCleanupAt = r.value.trim();
      }
    }
  } catch {
    // system_settings may be empty or absent during early boot
  }

  if (settingDays !== null) {
    return {
      retentionDays: settingDays,
      source: 'setting',
      envRetentionDays: envDays,
      lastCleanupAt,
    };
  }
  if (envDays !== null) {
    return {
      retentionDays: envDays,
      source: 'env',
      envRetentionDays: envDays,
      lastCleanupAt,
    };
  }
  const fallbackDays =
    typeof config.logRetentionDays === 'number' &&
    config.logRetentionDays >= 0 &&
    config.logRetentionDays <= MAX_LOG_RETENTION_DAYS
      ? config.logRetentionDays
      : DEFAULT_LOG_RETENTION_DAYS;
  return {
    retentionDays: fallbackDays,
    source: 'default',
    envRetentionDays: null,
    lastCleanupAt,
  };
}

/**
 * Prunes expired sessions and historical execution/device/audit logs older than `retentionDays`.
 */
export async function runLogRetentionCleanup(
  driver: SqlDriver,
  retentionDays: number,
  now: Date = new Date(),
): Promise<SystemCleanupResponse> {
  const safeDays = Math.max(0, Math.min(MAX_LOG_RETENTION_DAYS, Math.trunc(retentionDays)));
  const nowIso = now.toISOString();
  const cutoffIso =
    safeDays > 0 ? new Date(now.getTime() - safeDays * 86_400_000).toISOString() : nowIso;

  const sessRes = await driver.run('DELETE FROM sessions WHERE expires_at <= ?', [nowIso]);
  const deleted = {
    execution_results: 0,
    executions: 0,
    commands: 0,
    device_logs: 0,
    audit_logs: 0,
    sessions: sessRes.changes,
  };

  if (safeDays > 0) {
    const erRes = await driver.run(
      "DELETE FROM execution_results WHERE status IN ('completed', 'failed', 'timeout', 'cancelled') AND COALESCE(NULLIF(completed_at, ''), NULLIF(updated_at, ''), created_at) < ?",
      [cutoffIso],
    );
    deleted.execution_results = erRes.changes;

    const exRes = await driver.run(
      "DELETE FROM executions WHERE status IN ('completed', 'failed', 'timeout', 'cancelled') AND COALESCE(NULLIF(completed_at, ''), NULLIF(started_at, ''), created_at) < ? AND NOT EXISTS (SELECT 1 FROM execution_results er WHERE er.execution_id = executions.id)",
      [cutoffIso],
    );
    deleted.executions = exRes.changes;

    const cmdRes = await driver.run(
      "DELETE FROM commands WHERE type != 'cron' AND status IN ('completed', 'failed', 'cancelled') AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.command_id = commands.id)",
      [cutoffIso],
    );
    deleted.commands = cmdRes.changes;

    if (deleted.commands > 0) {
      await driver.run(
        'DELETE FROM command_targets WHERE NOT EXISTS (SELECT 1 FROM commands c WHERE c.id = command_targets.command_id)',
      );
    }

    const dlogRes = await driver.run('DELETE FROM device_logs WHERE timestamp < ?', [cutoffIso]);
    deleted.device_logs = dlogRes.changes;

    const alogRes = await driver.run('DELETE FROM audit_logs WHERE timestamp < ?', [cutoffIso]);
    deleted.audit_logs = alogRes.changes;
  }

  await driver.batch([
    { sql: "DELETE FROM system_settings WHERE key_name = 'log_cleanup_last_run'" },
    {
      sql: "INSERT INTO system_settings (key_name, value, updated_at) VALUES ('log_cleanup_last_run', ?, ?)",
      params: [nowIso, nowIso],
    },
  ]);

  return {
    retention_days: safeDays,
    cutoff_at: cutoffIso,
    ran_at: nowIso,
    deleted,
  };
}

/**
 * Throttled background sweep safe for SCF, Node, and Cloudflare Worker scheduled triggers.
 */
export async function maybeRunScheduledCleanup(
  driver: SqlDriver,
  config: AppConfig,
  now: Date = new Date(),
): Promise<boolean> {
  const nowMs = now.getTime();
  const lastCheck = lastCheckedByDriver.get(driver) ?? 0;
  if (nowMs - lastCheck < CHECK_THROTTLE_MS) {
    return false;
  }
  const existingRun = runningByDriver.get(driver);
  if (existingRun) {
    await existingRun;
    return false;
  }

  lastCheckedByDriver.set(driver, nowMs);
  let ran = false;

  const task = (async () => {
    const retention = await resolveRetentionConfig(driver, config);
    if (retention.retentionDays <= 0) return;

    const lastRunMs = retention.lastCleanupAt ? Date.parse(retention.lastCleanupAt) : 0;
    if (Number.isFinite(lastRunMs) && lastRunMs > 0 && nowMs - lastRunMs < CLEANUP_INTERVAL_MS) {
      return;
    }

    await runLogRetentionCleanup(driver, retention.retentionDays, now);
    ran = true;
  })()
    .catch(() => {
      /* background cleanup must never fail active agent/worker requests */
    })
    .finally(() => {
      runningByDriver.delete(driver);
    });

  runningByDriver.set(driver, task);
  await task;
  return ran;
}
