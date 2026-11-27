import { Hono, type Context } from 'hono';
import {
  ErrorCode,
  UserRole,
  type BatchDeleteDevicesRequest,
  type CreateDeviceRequest,
  type CreateDeviceResponse,
  type DeviceDTO,
  type DeviceDeployKeyRequest,
  type DeviceDeployKeyResponse,
  type DeviceMetrics,
  type DeviceStatus,
  type UpdateDeviceRequest,
  type UpgradeDeviceRequest,
  type UpgradeDeviceResponse,
} from '../../../shared/types';
import type { AppConfig } from '../config';
import type { SqlDriver, SqlParam, SqlStatement } from '../db/driver';
import {
  generateDeviceApiKey,
  generateId,
  sealApiKeySecret,
  sha256Hex,
  unsealApiKeySecret,
} from '../lib/crypto';
import {
  buildReplaceDeviceGroupsStmts,
  loadDeviceGroupIdsMap,
  uniqueStrings,
} from '../lib/device-groups';
import { buildDeviceHealthHistory, isValidHealthRange } from '../lib/health-history';
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
import { isValidTimeZone, resolveEffectiveTimeZone } from '../lib/timezone';
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

export function toDeviceDTO(
  row: DeviceRow,
  config: AppConfig,
  nowMs: number = Date.now(),
  groupIds?: string[],
): DeviceDTO {
  const online = isDeviceOnline(row.last_seen, nowMs, getOnlineThresholdMs(config));
  const status: DeviceStatus = online ? 'online' : 'offline';
  const resolvedGroups = uniqueStrings(groupIds ?? (row.group_id ? [row.group_id] : []));
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    arch: row.arch || '',
    os_version: row.os_version || '',
    hostname: row.hostname || '',
    status,
    owner_id: Number(row.owner_id),
    group_id: resolvedGroups[0] ?? null,
    group_ids: resolvedGroups,
    ip_address: row.ip_address || '',
    agent_id: row.agent_id ?? undefined,
    agent_version: row.agent_version || '',
    metrics: parseJsonSafe<DeviceMetrics | null>(row.metrics_json, null),
    last_seen: row.last_seen || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildInstallCommands(
  origin: string,
  deviceId: string,
  apiKey: string = 'YOUR_API_KEY',
): Record<string, string> {
  const resolvedKey = apiKey.trim() || 'YOUR_API_KEY';
  return {
    unix: `curl -fsSL ${origin}/i | sh -s -- ${resolvedKey} ${deviceId}`,
    windows: `$k="${resolvedKey}";$d="${deviceId}";irm ${origin}/i.ps1|iex`,
    android: `curl -fsSL ${origin}/ia | sh -s -- ${resolvedKey} ${deviceId}`,
  };
}

function pickInstallCommand(platform: string, commands: Record<string, string>): string {
  const lower = platform.toLowerCase();
  if (lower.includes('win')) return commands.windows!;
  if (lower.includes('android')) return commands.android!;
  return commands.unix!;
}

function buildDeployKeyResponse(
  origin: string,
  device: { id: string; platform: string },
  key: { id: string; name: string; api_key: string; key_prefix: string; created_at: string },
  created: boolean,
  rotated: boolean,
): DeviceDeployKeyResponse {
  const installCommands = buildInstallCommands(origin, device.id, key.api_key);
  return {
    id: key.id,
    device_id: device.id,
    name: key.name,
    api_key: key.api_key,
    key_prefix: key.key_prefix,
    created_at: key.created_at,
    created,
    rotated,
    install_command: pickInstallCommand(device.platform, installCommands),
    install_commands: installCommands,
  };
}

interface BoundDeviceKeyParams {
  id: string;
  userId: number;
  deviceId: string;
  name: string;
  rawKey: string;
  keyHash: string;
  keyPrefix: string;
  keySecret: string;
  createdAt: string;
}

async function createBoundDeviceKeyParams(
  userId: number,
  deviceId: string,
  deviceName: string,
  nowIso: string,
  encryptionSecret?: string,
): Promise<BoundDeviceKeyParams> {
  const id = generateId('key');
  const rawKey = generateDeviceApiKey();
  const keyHash = await sha256Hex(rawKey);
  const keyPrefix = `${rawKey.slice(0, 12)}...`;
  const keySecret = await sealApiKeySecret(rawKey, encryptionSecret);
  const name = `device:${deviceName}`.slice(0, 100);
  return {
    id,
    userId,
    deviceId,
    name,
    rawKey,
    keyHash,
    keyPrefix,
    keySecret,
    createdAt: nowIso,
  };
}

function buildBoundKeyInsertStmt(boundKey: BoundDeviceKeyParams): SqlStatement {
  return {
    sql: 'INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, device_id, key_secret, last_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
    params: [
      boundKey.id,
      boundKey.userId,
      boundKey.name,
      boundKey.keyHash,
      boundKey.keyPrefix,
      boundKey.deviceId,
      boundKey.keySecret,
      boundKey.createdAt,
    ],
  };
}

async function validateOwnedGroupIds(
  driver: SqlDriver,
  groupIds: string[],
  user: { id: number; role: UserRole },
): Promise<
  | { ok: true; groupIds: string[] }
  | { ok: false; status: 403 | 404; code: ErrorCode; message: string }
> {
  const cleanIds = uniqueStrings(groupIds);
  if (cleanIds.length === 0) {
    return { ok: true, groupIds: [] };
  }
  const placeholders = cleanIds.map(() => '?').join(', ');
  const groups = await driver.all<{ id: string; created_by: number }>(
    `SELECT id, created_by FROM \`groups\` WHERE id IN (${placeholders})`,
    cleanIds,
  );
  if (groups.length !== cleanIds.length) {
    return {
      ok: false,
      status: 404,
      code: ErrorCode.NOT_FOUND,
      message: cleanIds.length === 1 ? 'Group not found' : 'One or more groups not found',
    };
  }
  if (user.role !== UserRole.ADMIN && groups.some((g) => Number(g.created_by) !== user.id)) {
    return {
      ok: false,
      status: 403,
      code: ErrorCode.FORBIDDEN,
      message: 'Forbidden',
    };
  }
  return { ok: true, groupIds: cleanIds };
}

async function deleteDevicesByIds(driver: SqlDriver, ids: string[]): Promise<void> {
  const stmts: SqlStatement[] = [];
  for (const id of ids) {
    stmts.push({ sql: 'DELETE FROM api_keys WHERE device_id = ?', params: [id] });
    stmts.push({ sql: 'DELETE FROM agents WHERE device_id = ?', params: [id] });
    stmts.push({ sql: 'DELETE FROM device_logs WHERE device_id = ?', params: [id] });
    stmts.push({ sql: 'DELETE FROM device_groups WHERE device_id = ?', params: [id] });
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

    if (body.group_ids !== undefined) {
      if (!Array.isArray(body.group_ids) || body.group_ids.some((g) => typeof g !== 'string')) {
        return fail(c, ErrorCode.VALIDATION_ERROR, 'group_ids must be an array of strings', 400);
      }
    }

    const driver = c.get('driver');
    const user = c.get('user');

    const requestedGroupIds =
      body.group_ids !== undefined ? uniqueStrings(body.group_ids) : groupId ? [groupId] : [];
    const groupCheck = await validateOwnedGroupIds(driver, requestedGroupIds, user);
    if (!groupCheck.ok) {
      return fail(c, groupCheck.code, groupCheck.message, groupCheck.status);
    }

    const devId = generateId('dev');
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
    const config = c.get('config');
    const boundKey = await createBoundDeviceKeyParams(
      user.id,
      devId,
      name,
      nowIso,
      config.encryptionKey,
    );

    await driver.batch([
      {
        sql: "INSERT INTO devices (id, name, platform, arch, os_version, hostname, status, owner_id, group_id, ip_address, agent_id, agent_version, metrics_json, last_seen, expires_at, created_at, updated_at) VALUES (?, ?, ?, '', '', '', 'offline', ?, ?, '', NULL, '', NULL, '', ?, ?, ?)",
        params: [
          devId,
          name,
          platform,
          user.id,
          groupCheck.groupIds[0] ?? null,
          expiresAt,
          nowIso,
          nowIso,
        ],
      },
      buildBoundKeyInsertStmt(boundKey),
      ...buildReplaceDeviceGroupsStmts(driver, devId, groupCheck.groupIds, nowIso),
    ]);

    const origin = getRequestOrigin(c);
    const installCommands = buildInstallCommands(origin, devId, boundKey.rawKey);
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

    const responsePayload: CreateDeviceResponse = {
      id: devId,
      name,
      platform,
      api_key: boundKey.rawKey,
      api_key_id: boundKey.id,
      api_key_prefix: boundKey.keyPrefix,
      install_command: installCommand,
      install_commands: installCommands,
      expires_at: expiresAt,
    };

    return ok(c, responsePayload, 'Device created', 201);
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

  // Register static /health-history BEFORE /:id so Hono resolves it deterministically
  router.get('/health-history', async (c) => {
    const rawRange = c.req.query('range')?.trim() || '24h';
    if (!isValidHealthRange(rawRange)) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'Invalid range (expected 1h, 24h, 7d, or 30d)', 400);
    }

    const driver = c.get('driver');
    const user = c.get('user');
    const config = c.get('config');
    const deviceId = c.req.query('device_id')?.trim();
    const tzQuery = c.req.query('tz')?.trim();
    const timeZone =
      tzQuery && isValidTimeZone(tzQuery)
        ? tzQuery
        : (await resolveEffectiveTimeZone(driver, config)).timezone;

    let scopedDevices: Array<Pick<DeviceRow, 'id' | 'last_seen' | 'created_at'>>;
    if (deviceId) {
      const row = await driver.get<DeviceRow>(
        'SELECT id, last_seen, created_at, owner_id FROM devices WHERE id = ? LIMIT 1',
        [deviceId],
      );
      if (!row) {
        return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);
      }
      if (Number(row.owner_id) !== user.id && user.role !== UserRole.ADMIN) {
        return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
      }
      scopedDevices = [row];
    } else if (user.role !== UserRole.ADMIN) {
      scopedDevices = await driver.all<Pick<DeviceRow, 'id' | 'last_seen' | 'created_at'>>(
        'SELECT id, last_seen, created_at FROM devices WHERE owner_id = ? ORDER BY created_at DESC LIMIT 200',
        [user.id],
      );
    } else {
      scopedDevices = await driver.all<Pick<DeviceRow, 'id' | 'last_seen' | 'created_at'>>(
        'SELECT id, last_seen, created_at FROM devices ORDER BY created_at DESC LIMIT 200',
      );
    }

    const history = await buildDeviceHealthHistory(driver, config, scopedDevices, {
      range: rawRange,
      timeZone,
    });
    return ok(c, history);
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
        where.push(
          "NOT EXISTS (SELECT 1 FROM device_groups dg WHERE dg.device_id = devices.id) AND (group_id IS NULL OR group_id = '')",
        );
      } else {
        where.push(
          '(EXISTS (SELECT 1 FROM device_groups dg WHERE dg.device_id = devices.id AND dg.group_id = ?) OR group_id = ?)',
        );
        params.push(groupFilter, groupFilter);
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
    const groupMap = await loadDeviceGroupIdsMap(
      driver,
      rows.map((r) => r.id),
    );

    return ok(c, {
      total: Number(countRow?.total ?? 0),
      page,
      per_page: limit,
      devices: rows.map((row) => toDeviceDTO(row, config, nowMs, groupMap.get(row.id))),
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

    const groupMap = await loadDeviceGroupIdsMap(driver, [row.id]);
    return ok(c, toDeviceDTO(row, config, Date.now(), groupMap.get(row.id)));
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
    let replaceGroupIds: string[] | null = null;

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

    if (body.group_ids !== undefined) {
      if (!Array.isArray(body.group_ids) || body.group_ids.some((g) => typeof g !== 'string')) {
        return fail(c, ErrorCode.VALIDATION_ERROR, 'group_ids must be an array of strings', 400);
      }
      const groupCheck = await validateOwnedGroupIds(driver, body.group_ids, user);
      if (!groupCheck.ok) {
        return fail(c, groupCheck.code, groupCheck.message, groupCheck.status);
      }
      replaceGroupIds = groupCheck.groupIds;
      updates.push('group_id = ?');
      params.push(replaceGroupIds[0] ?? null);
    } else if (body.group_id !== undefined) {
      if (body.group_id === null || (typeof body.group_id === 'string' && !body.group_id.trim())) {
        replaceGroupIds = [];
        updates.push('group_id = NULL');
      } else if (typeof body.group_id === 'string') {
        const gid = body.group_id.trim();
        const groupCheck = await validateOwnedGroupIds(driver, [gid], user);
        if (!groupCheck.ok) {
          return fail(c, groupCheck.code, groupCheck.message, groupCheck.status);
        }
        replaceGroupIds = groupCheck.groupIds;
        updates.push('group_id = ?');
        params.push(replaceGroupIds[0]!);
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

    const stmts: SqlStatement[] = [
      { sql: `UPDATE devices SET ${updates.join(', ')} WHERE id = ?`, params },
    ];
    if (replaceGroupIds !== null) {
      stmts.push(...buildReplaceDeviceGroupsStmts(driver, id, replaceGroupIds, nowIso));
    }

    await driver.batch(stmts);
    const updated = await driver.get<DeviceRow>('SELECT * FROM devices WHERE id = ? LIMIT 1', [id]);
    if (!updated) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);
    }

    const groupMap = await loadDeviceGroupIdsMap(driver, [id]);
    return ok(c, toDeviceDTO(updated, config, Date.now(), groupMap.get(id)));
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

  router.post('/:id/deploy-key', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');
    const config = c.get('config');

    const row = await driver.get<{ id: string; name: string; platform: string; owner_id: number }>(
      'SELECT id, name, platform, owner_id FROM devices WHERE id = ? LIMIT 1',
      [id],
    );
    if (!row) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);
    }
    if (Number(row.owner_id) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const body = await readJsonBody<Partial<DeviceDeployKeyRequest>>(c, config.maxPayloadBytes);
    const rotate = body.rotate === true;
    const origin = getRequestOrigin(c);

    if (!rotate) {
      const existing = await driver.get<{
        id: string;
        name: string;
        key_prefix: string;
        key_secret: string | null;
        created_at: string;
      }>(
        'SELECT id, name, key_prefix, key_secret, created_at FROM api_keys WHERE device_id = ? ORDER BY created_at DESC LIMIT 1',
        [row.id],
      );
      if (existing) {
        const rawKey = await unsealApiKeySecret(existing.key_secret, config.encryptionKey);
        if (rawKey) {
          return ok(
            c,
            buildDeployKeyResponse(
              origin,
              row,
              {
                id: existing.id,
                name: existing.name,
                api_key: rawKey,
                key_prefix: existing.key_prefix,
                created_at: existing.created_at,
              },
              false,
              false,
            ),
          );
        }
      }
    }

    const ownerExists = await driver.get<{ id: number }>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [Number(row.owner_id)],
    );
    const targetUserId = ownerExists ? Number(ownerExists.id) : user.id;
    const nowIso = new Date().toISOString();
    const boundKey = await createBoundDeviceKeyParams(
      targetUserId,
      row.id,
      row.name,
      nowIso,
      config.encryptionKey,
    );

    await driver.batch([
      { sql: 'DELETE FROM api_keys WHERE device_id = ?', params: [row.id] },
      buildBoundKeyInsertStmt(boundKey),
    ]);

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: rotate ? 'rotate_device_api_key' : 'bind_device_api_key',
      targetId: row.id,
      ip: getClientIp(c),
      detail: `${row.name} (${boundKey.id})`,
      timestamp: nowIso,
    });

    return ok(
      c,
      buildDeployKeyResponse(
        origin,
        row,
        {
          id: boundKey.id,
          name: boundKey.name,
          api_key: boundKey.rawKey,
          key_prefix: boundKey.keyPrefix,
          created_at: nowIso,
        },
        true,
        Boolean(rotate),
      ),
    );
  });

  const shSingleQuote = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`;
  const psSingleQuote = (v: string): string => `'${v.replace(/'/g, "''")}'`;

  const buildUpgradeCommand = (
    origin: string,
    platform: string,
    version: string,
    binUrl?: string,
    lite?: boolean,
  ): { shell: string; content: string } => {
    if (platform.toLowerCase().includes('win')) {
      const psArgs = [`-Server ${psSingleQuote(origin)}`, `-Version ${psSingleQuote(version)}`];
      if (binUrl) psArgs.push(`-BinUrl ${psSingleQuote(binUrl)}`);
      if (lite) psArgs.push('-Lite');
      const url = `${origin}/u.ps1`;
      return {
        shell: 'powershell',
        content:
          `$u=${psSingleQuote(url)}; $p=Join-Path $env:TEMP "cslite-upg-$PID.ps1"; ` +
          `Invoke-WebRequest -Uri $u -OutFile $p -UserAgent "CSLite-Installer/1.1" -UseBasicParsing; ` +
          `$cmd="Start-Sleep 2; & '" + $p.Replace("'","''") + "' ${psArgs.join(' ')}; Remove-Item -Force '" + $p.Replace("'","''") + "' -ErrorAction SilentlyContinue"; ` +
          `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -Command $cmd"; ` +
          `Write-Output "Upgrade scheduled (version: ${version})"`,
      };
    }

    const args = [`--server ${shSingleQuote(origin)}`, `--version ${shSingleQuote(version)}`];
    if (binUrl) args.push(`--bin-url ${shSingleQuote(binUrl)}`);
    if (lite) args.push('--lite');
    const url = `${origin}/u`;
    const qUrl = shSingleQuote(url);
    let parsedHost = 'localhost';
    let parsedPort = '443';
    let isHttps = true;
    try {
      const u = new URL(origin);
      isHttps = u.protocol === 'https:';
      parsedHost = u.hostname.replace(/^\[|\]$/g, '');
      parsedPort = u.port || (isHttps ? '443' : '80');
    } catch {
      const rawHost = origin.replace(/^https?:\/\//i, '').split('/')[0] || 'localhost';
      isHttps = /^https:/i.test(origin);
      parsedHost = rawHost.split(':')[0] || 'localhost';
      parsedPort = isHttps ? '443' : '80';
    }
    const connectTarget = `${parsedHost.includes(':') ? `[${parsedHost}]` : parsedHost}:${parsedPort}`;
    const osslFallback = isHttps
      ? `if [ ! -s "$tmp" ] && command -v openssl >/dev/null 2>&1; then ` +
        `printf 'GET /u HTTP/1.0\\r\\nHost: %s\\r\\nUser-Agent: CSLite-Installer/1.1\\r\\nReferer: %s\\r\\nConnection: close\\r\\n\\r\\n' ${shSingleQuote(parsedHost)} ${shSingleQuote(`${origin}/upgrade`)} | ` +
        `openssl s_client -quiet -ign_eof -connect ${shSingleQuote(connectTarget)} -servername ${shSingleQuote(parsedHost)} 2>/dev/null | ` +
        `awk 'BEGIN{b=0} b{print} !b{c=$0; sub(/\\r$/,"",c); if(c=="")b=1}' >"$tmp" 2>/dev/null || rm -f "$tmp"; fi; `
      : '';
    return {
      shell: 'sh',
      content:
        `set -eu; tmp="/tmp/cslite-upg-$$.sh"; rm -f "$tmp"; ` +
        `if [ ! -s "$tmp" ] && command -v curl >/dev/null 2>&1; then curl -fsSL -A "CSLite-Installer/1.1" -H ${shSingleQuote(`Referer: ${origin}/upgrade`)} ${qUrl} -o "$tmp" 2>/dev/null || rm -f "$tmp"; fi; ` +
        `if [ ! -s "$tmp" ] && command -v uclient-fetch >/dev/null 2>&1; then uclient-fetch -q -O "$tmp" ${qUrl} 2>/dev/null || rm -f "$tmp"; fi; ` +
        `if [ ! -s "$tmp" ] && command -v wget >/dev/null 2>&1; then wget -q -O "$tmp" ${qUrl} 2>/dev/null || rm -f "$tmp"; fi; ` +
        osslFallback +
        `[ -s "$tmp" ] && head -n 1 "$tmp" | grep -q '^#!' || { echo "Failed to download valid upgrade script from ${url}" >&2; rm -f "$tmp"; exit 1; }; ` +
        `if command -v setsid >/dev/null 2>&1; then ` +
          `setsid sh -c 'trap "" HUP TERM; sleep 2; tmp="$1"; shift; sh "$tmp" "$@"; rc=$?; rm -f "$tmp"; exit $rc' _ "$tmp" ${args.join(' ')} >/tmp/cslite-upgrade.log 2>&1 </dev/null & ` +
        `elif command -v nohup >/dev/null 2>&1; then ` +
          `nohup sh -c 'trap "" HUP TERM; sleep 2; tmp="$1"; shift; sh "$tmp" "$@"; rc=$?; rm -f "$tmp"; exit $rc' _ "$tmp" ${args.join(' ')} >/tmp/cslite-upgrade.log 2>&1 </dev/null & ` +
        `else ` +
          `( trap '' HUP TERM; sleep 2; sh "$tmp" ${args.join(' ')}; rc=$?; rm -f "$tmp"; exit $rc ) >/tmp/cslite-upgrade.log 2>&1 </dev/null & ` +
        `fi; ` +
        `echo "Upgrade scheduled (version: ${version}); log: /tmp/cslite-upgrade.log"`,
    };
  };

  router.post('/:id/upgrade', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');
    const config = c.get('config');

    const row = await driver.get<{ id: string; name: string; platform: string; owner_id: number }>(
      'SELECT id, name, platform, owner_id FROM devices WHERE id = ? LIMIT 1',
      [id],
    );
    if (!row) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);
    }
    if (Number(row.owner_id) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const body = await readJsonBody<Partial<UpgradeDeviceRequest>>(c, config.maxPayloadBytes);
    const version = (typeof body.version === 'string' && body.version.trim()) || 'latest';
    if (!/^(latest|v?[0-9A-Za-z][0-9A-Za-z._-]{0,63})$/.test(version)) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'Invalid target version format', 400);
    }

    let binUrl: string | undefined;
    if (typeof body.bin_url === 'string' && body.bin_url.trim()) {
      const candidate = body.bin_url.trim();
      if (!/^https?:\/\/[^\s'"`\\;$|&<>]+$/.test(candidate) || candidate.length > 512) {
        return fail(c, ErrorCode.VALIDATION_ERROR, 'Invalid custom binary URL', 400);
      }
      binUrl = candidate;
    }

    const origin = getRequestOrigin(c);
    const { shell, content } = buildUpgradeCommand(
      origin,
      row.platform,
      version,
      binUrl,
      body.lite === true,
    );

    const nowIso = new Date().toISOString();
    const cmdId = generateId('cmd');
    const execId = generateId('exec');
    const resId = generateId('res');
    const cmdName = `agent-upgrade: ${row.name} (${version})`;

    await driver.batch([
      {
        sql: "INSERT INTO commands (id, name, type, schedule, content, target_type, target_ids_json, timeout, shell, env_vars_json, status, next_run_at, created_by, created_at, updated_at) VALUES (?, ?, 'immediate', '', ?, 'devices', ?, 120, ?, NULL, 'pending', NULL, ?, ?, ?)",
        params: [cmdId, cmdName, content, JSON.stringify([row.id]), shell, user.id, nowIso, nowIso],
      },
      {
        sql: "INSERT INTO command_targets (command_id, target_type, target_id) VALUES (?, 'devices', ?)",
        params: [cmdId, row.id],
      },
      {
        sql: "INSERT INTO executions (id, command_id, status, scheduled_for, started_at, completed_at, created_at) VALUES (?, ?, 'queued', NULL, ?, NULL, ?)",
        params: [execId, cmdId, nowIso, nowIso],
      },
      {
        sql: "INSERT INTO execution_results (id, execution_id, command_id, device_id, status, exit_code, output, log_content, timeout_at, started_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, '', NULL, NULL, NULL, NULL, ?, ?)",
        params: [resId, execId, cmdId, row.id, nowIso, nowIso],
      },
    ]);

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'upgrade_device',
      targetId: row.id,
      ip: getClientIp(c),
      detail: `${row.name} (${version}${body.lite ? ', lite' : ''})`,
      timestamp: nowIso,
    });

    const payload: UpgradeDeviceResponse = {
      command_id: cmdId,
      execution_id: execId,
      device_id: row.id,
      version,
    };
    return ok(c, payload, 'Agent upgrade scheduled', 201);
  });

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
