import { Hono, type Context } from 'hono';
import {
  ErrorCode,
  UserRole,
  type BatchDeleteDevicesRequest,
  type CreateDeviceRequest,
  type DeviceDTO,
  type DeviceMetrics,
  type DeviceStatus,
  type UpdateDeviceRequest,
} from '../../../shared/types';
import type { AppConfig } from '../config';
import type { SqlDriver, SqlParam, SqlStatement } from '../db/driver';
import { generateId } from '../lib/crypto';
import { writeAuditLog } from '../lib/reconcile';
import {
  escapeLike,
  fail,
  getClientIp,
  getRequestOrigin,
  ok,
  parseJsonSafe,
  parsePagination,
  readJsonBody,
} from '../lib/response';
import { requireAuth, type AppEnv } from '../middleware/auth';

export interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  arch: string;
  os_version: string;
  hostname: string;
  status: string;
  owner_id: number;
  group_id: string | null;
  ip_address: string;
  agent_id: string | null;
  agent_version: string;
  metrics_json: string | null;
  last_seen: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export function getOnlineThresholdMs(config: AppConfig): number {
  return Math.max(config.heartbeatInterval * 3, 90) * 1000;
}

export function isDeviceOnline(lastSeen: string | null | undefined, nowMs: number, thresholdMs: number): boolean {
  if (!lastSeen) return false;
  const ts = Date.parse(lastSeen);
  return Number.isFinite(ts) && ts > 0 && nowMs - ts <= thresholdMs;
}

export function toDeviceDTO(row: DeviceRow, config: AppConfig, nowMs: number = Date.now()): DeviceDTO {
  const online = isDeviceOnline(row.last_seen, nowMs, getOnlineThresholdMs(config));
  const status: DeviceStatus = online ? 'online' : 'offline';
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    arch: row.arch || '',
    os_version: row.os_version || '',
    hostname: row.hostname || '',
    status,
    owner_id: Number(row.owner_id),
    group_id: row.group_id ?? null,
    ip_address: row.ip_address || '',
    agent_id: row.agent_id ?? undefined,
    agent_version: row.agent_version || '',
    metrics: parseJsonSafe<DeviceMetrics | null>(row.metrics_json, null),
    last_seen: row.last_seen || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildInstallCommands(origin: string, deviceId: string): Record<string, string> {
  return {
    unix: `curl -fsSL ${origin}/i | sh -s -- YOUR_API_KEY ${deviceId}`,
    windows: `$k="YOUR_API_KEY";$d="${deviceId}";irm ${origin}/i.ps1|iex`,
    android: `curl -fsSL ${origin}/ia | sh -s -- YOUR_API_KEY ${deviceId}`,
  };
}

function pickInstallCommand(platform: string, commands: Record<string, string>): string {
  const lower = platform.toLowerCase();
  if (lower.includes('win')) return commands.windows!;
  if (lower.includes('android')) return commands.android!;
  return commands.unix!;
}

async function deleteDevicesByIds(driver: SqlDriver, ids: string[]): Promise<void> {
  const stmts: SqlStatement[] = [];
  for (const id of ids) {
    stmts.push({ sql: 'DELETE FROM agents WHERE device_id = ?', params: [id] });
    stmts.push({ sql: 'DELETE FROM device_logs WHERE device_id = ?', params: [id] });
    stmts.push({
      sql: "DELETE FROM command_targets WHERE target_type = 'devices' AND target_id = ?",
      params: [id],
    });
    stmts.push({ sql: 'DELETE FROM devices WHERE id = ?', params: [id] });
  }
  await driver.batch(stmts);
}

export function createDeviceRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', requireAuth);

  router.post('/', async (c) => {
    const body = await readJsonBody<Partial<CreateDeviceRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const platform = typeof body.platform === 'string' ? body.platform.trim() : '';
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : undefined;

    if (!name || name.length > 100 || !platform || platform.length > 64) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'Valid name (1-100) and platform are required', 400);
    }

    const driver = c.get('driver');
    const user = c.get('user');

    if (groupId) {
      const grp = await driver.get<{ id: string; created_by: number }>(
        'SELECT id, created_by FROM `groups` WHERE id = ? LIMIT 1',
        [groupId],
      );
      if (!grp) {
        return fail(c, ErrorCode.NOT_FOUND, 'Group not found', 404);
      }
      if (Number(grp.created_by) !== user.id && user.role !== UserRole.ADMIN) {
        return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
      }
    }

    const devId = generateId('dev');
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();

    await driver.run(
      "INSERT INTO devices (id, name, platform, arch, os_version, hostname, status, owner_id, group_id, ip_address, agent_id, agent_version, metrics_json, last_seen, expires_at, created_at, updated_at) VALUES (?, ?, ?, '', '', '', 'offline', ?, ?, '', NULL, '', NULL, '', ?, ?, ?)",
      [devId, name, platform, user.id, groupId ?? null, expiresAt, nowIso, nowIso],
    );

    const origin = getRequestOrigin(c);
    const installCommands = buildInstallCommands(origin, devId);
    const installCommand = pickInstallCommand(platform, installCommands);

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'create_device',
      targetId: devId,
      ip: getClientIp(c),
      detail: `${name} (${platform})`,
      timestamp: nowIso,
    });

    return ok(
      c,
      {
        id: devId,
        name,
        platform,
        install_command: installCommand,
        install_commands: installCommands,
        expires_at: expiresAt,
      },
      'Device created',
      201,
    );
  });

  // Register static /status BEFORE /:id so Hono resolves it deterministically
  router.get('/status', async (c) => {
    const id = c.req.query('id')?.trim();
    if (!id) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'Query parameter id is required', 400);
    }

    const driver = c.get('driver');
    const user = c.get('user');
    const config = c.get('config');

    const row = await driver.get<DeviceRow>('SELECT * FROM devices WHERE id = ? LIMIT 1', [id]);
    if (!row) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);
    }
    if (Number(row.owner_id) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const dto = toDeviceDTO(row, config);
    return ok(c, {
      id: dto.id,
      status: dto.status,
      last_updated: dto.last_seen || row.updated_at,
      metrics: dto.metrics ?? null,
    });
  });

  router.get('/', async (c) => {
    const driver = c.get('driver');
    const user = c.get('user');
    const config = c.get('config');
    const { page, limit, offset } = parsePagination(c);

    const statusFilter = c.req.query('status')?.trim().toLowerCase();
    const groupFilter = (c.req.query('group') || c.req.query('group_id'))?.trim();
    const platformFilter = c.req.query('platform')?.trim();
    const ownerFilter = c.req.query('owner')?.trim();
    const search = c.req.query('search')?.trim();

    const nowMs = Date.now();
    const cutoffIso = new Date(nowMs - getOnlineThresholdMs(config)).toISOString();

    const where: string[] = [];
    const params: SqlParam[] = [];

    if (user.role !== UserRole.ADMIN) {
      where.push('owner_id = ?');
      params.push(user.id);
    } else if (ownerFilter && /^\d+$/.test(ownerFilter)) {
      where.push('owner_id = ?');
      params.push(Number.parseInt(ownerFilter, 10));
    }

    if (statusFilter === 'online') {
      where.push("last_seen != '' AND last_seen >= ?");
      params.push(cutoffIso);
    } else if (statusFilter === 'offline') {
      where.push("(last_seen = '' OR last_seen < ?)");
      params.push(cutoffIso);
    }

    if (groupFilter) {
      if (groupFilter === '__none__' || groupFilter === 'ungrouped') {
        where.push('group_id IS NULL');
      } else {
        where.push('group_id = ?');
        params.push(groupFilter);
      }
    }

    if (platformFilter) {
      if (platformFilter.includes('/')) {
        where.push('LOWER(platform) = ?');
        params.push(platformFilter.toLowerCase());
      } else {
        const lowerPlat = platformFilter.toLowerCase();
        where.push("(LOWER(platform) = ? OR LOWER(platform) LIKE ? ESCAPE '!')");
        params.push(lowerPlat, `${escapeLike(lowerPlat)}/%`);
      }
    }

    if (search) {
      const like = `%${escapeLike(search)}%`;
      where.push(
        "(name LIKE ? ESCAPE '!' OR hostname LIKE ? ESCAPE '!' OR ip_address LIKE ? ESCAPE '!')",
      );
      params.push(like, like, like);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await driver.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM devices ${whereSql}`,
      params,
    );
    const rows = await driver.all<DeviceRow>(
      `SELECT * FROM devices ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return ok(c, {
      total: Number(countRow?.total ?? 0),
      page,
      per_page: limit,
      devices: rows.map((row) => toDeviceDTO(row, config, nowMs)),
    });
  });

  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');
    const config = c.get('config');

    const row = await driver.get<DeviceRow>('SELECT * FROM devices WHERE id = ? LIMIT 1', [id]);
    if (!row) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);
    }
    if (Number(row.owner_id) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    return ok(c, toDeviceDTO(row, config));
  });

  const handleUpdateDevice = async (c: Context<AppEnv, '/:id'>) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');
    const config = c.get('config');

    const row = await driver.get<DeviceRow>('SELECT * FROM devices WHERE id = ? LIMIT 1', [id]);
    if (!row) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);
    }
    if (Number(row.owner_id) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const body = await readJsonBody<Partial<UpdateDeviceRequest>>(c, config.maxPayloadBytes);
    const updates: string[] = [];
    const params: SqlParam[] = [];

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 100) {
        return fail(c, ErrorCode.VALIDATION_ERROR, 'Invalid device name (1-100)', 400);
      }
      updates.push('name = ?');
      params.push(name);
    }

    if (body.platform !== undefined) {
      const platform = typeof body.platform === 'string' ? body.platform.trim() : '';
      if (!platform || platform.length > 64) {
        return fail(c, ErrorCode.VALIDATION_ERROR, 'Invalid platform', 400);
      }
      updates.push('platform = ?');
      params.push(platform);
    }

    if (body.group_id !== undefined) {
      if (body.group_id === null || body.group_id === '') {
        updates.push('group_id = NULL');
      } else if (typeof body.group_id === 'string') {
        const grp = await driver.get<{ id: string; created_by: number }>(
          'SELECT id, created_by FROM `groups` WHERE id = ? LIMIT 1',
          [body.group_id],
        );
        if (!grp) {
          return fail(c, ErrorCode.NOT_FOUND, 'Group not found', 404);
        }
        if (Number(grp.created_by) !== user.id && user.role !== UserRole.ADMIN) {
          return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
        }
        updates.push('group_id = ?');
        params.push(body.group_id);
      } else {
        return fail(c, ErrorCode.VALIDATION_ERROR, 'Invalid group_id', 400);
      }
    }

    if (updates.length === 0) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'No updatable fields provided', 400);
    }

    const nowIso = new Date().toISOString();
    updates.push('updated_at = ?');
    params.push(nowIso, id);

    await driver.run(`UPDATE devices SET ${updates.join(', ')} WHERE id = ?`, params);
    const updated = await driver.get<DeviceRow>('SELECT * FROM devices WHERE id = ? LIMIT 1', [id]);
    if (!updated) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);
    }

    return ok(c, toDeviceDTO(updated, config));
  };

  router.patch('/:id', handleUpdateDevice);
  router.put('/:id', handleUpdateDevice);

  const handleBatchDelete = async (c: Context<AppEnv>) => {
    const body = await readJsonBody<Partial<BatchDeleteDevicesRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'ids must be a non-empty array', 400);
    }
    const uniqueIds = [
      ...new Set(
        body.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
      ),
    ];
    if (uniqueIds.length === 0 || uniqueIds.length !== body.ids.length) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'All ids must be unique non-empty strings', 400);
    }

    const driver = c.get('driver');
    const user = c.get('user');
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const rows = await driver.all<{ id: string; owner_id: number }>(
      `SELECT id, owner_id FROM devices WHERE id IN (${placeholders})`,
      uniqueIds,
    );
    if (rows.length !== uniqueIds.length) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'One or more devices not found', 404);
    }
    if (user.role !== UserRole.ADMIN && rows.some((r) => Number(r.owner_id) !== user.id)) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    await deleteDevicesByIds(driver, uniqueIds);

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'batch_delete_devices',
      targetId: uniqueIds.join(',').slice(0, 128),
      ip: getClientIp(c),
    });

    return ok(c, { deleted_count: uniqueIds.length }, 'Devices deleted');
  };

  router.delete('/', handleBatchDelete);
  router.post('/batch-delete', handleBatchDelete);

  router.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');

    const row = await driver.get<{ id: string; owner_id: number }>(
      'SELECT id, owner_id FROM devices WHERE id = ? LIMIT 1',
      [id],
    );
    if (!row) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);
    }
    if (Number(row.owner_id) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    await deleteDevicesByIds(driver, [id]);

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'delete_device',
      targetId: id,
      ip: getClientIp(c),
    });

    return ok(c, { id, deleted_count: 1 }, 'Device deleted');
  });

  return router;
}
