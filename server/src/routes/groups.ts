import { Hono } from 'hono';
import {
  ErrorCode,
  UserRole,
  type CreateGroupRequest,
  type GroupDTO,
  type GroupDevicesRequest,
  type UpdateGroupRequest,
} from '../../../shared/types';
import { generateId } from '../lib/crypto';
import {
  buildAddDevicesToGroupStmts,
  loadGroupDeviceIdsMap,
  syncDevicesPrimaryGroup,
  uniqueStrings,
} from '../lib/device-groups';
import { writeAuditLog } from '../lib/reconcile';
import { fail, getClientIp, ok, readJsonBody } from '../lib/response';
import { requireAuth, type AppEnv } from '../middleware/auth';

interface GroupRow {
  id: string;
  name: string;
  description: string;
  created_by: number;
  device_count: number;
  created_at: string;
  updated_at: string;
}

function toGroupDTO(row: GroupRow, deviceIds?: string[]): GroupDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    created_by: Number(row.created_by),
    device_count: Number(row.device_count ?? 0),
    device_ids: deviceIds ?? [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createGroupRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', requireAuth);

  router.post('/', async (c) => {
    const body = await readJsonBody<Partial<CreateGroupRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description =
      typeof body.description === 'string' ? body.description.trim().slice(0, 1000) : '';

    if (!name || name.length > 100) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'Group name (1-100 chars) is required', 400);
    }

    const driver = c.get('driver');
    const user = c.get('user');

    const dup = await driver.get<{ id: string }>(
      'SELECT id FROM `groups` WHERE created_by = ? AND name = ? LIMIT 1',
      [user.id, name],
    );
    if (dup) {
      return fail(c, ErrorCode.CONFLICT, 'Group name already exists', 409);
    }

    const id = generateId('grp');
    const nowIso = new Date().toISOString();
    await driver.run(
      'INSERT INTO `groups` (id, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name, description, user.id, nowIso, nowIso],
    );

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'create_group',
      targetId: id,
      ip: getClientIp(c),
      detail: name,
      timestamp: nowIso,
    });

    const dto: GroupDTO = {
      id,
      name,
      description,
      created_by: user.id,
      device_count: 0,
      device_ids: [],
      created_at: nowIso,
      updated_at: nowIso,
    };

    return ok(c, dto, 'Group created', 201);
  });

  router.get('/', async (c) => {
    const driver = c.get('driver');
    const user = c.get('user');

    const isAdmin = user.role === UserRole.ADMIN;
    const whereSql = isAdmin ? '' : 'WHERE g.created_by = ?';
    const params = isAdmin ? [] : [user.id];

    const rows = await driver.all<GroupRow>(
      `SELECT g.id, g.name, g.description, g.created_by, g.created_at, g.updated_at, COUNT(DISTINCT dg.device_id) AS device_count FROM \`groups\` g LEFT JOIN device_groups dg ON dg.group_id = g.id ${whereSql} GROUP BY g.id, g.name, g.description, g.created_by, g.created_at, g.updated_at ORDER BY g.created_at DESC`,
      params,
    );

    const groupDevMap = await loadGroupDeviceIdsMap(
      driver,
      rows.map((r) => r.id),
    );
    const groups = rows.map((row) => toGroupDTO(row, groupDevMap.get(row.id) ?? []));
    return ok(c, { total: groups.length, groups });
  });

  router.put('/:id', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');

    const existing = await driver.get<GroupRow>(
      'SELECT id, name, description, created_by, created_at, updated_at, 0 AS device_count FROM `groups` WHERE id = ? LIMIT 1',
      [id],
    );
    if (!existing) {
      return fail(c, ErrorCode.NOT_FOUND, 'Group not found', 404);
    }
    if (Number(existing.created_by) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const body = await readJsonBody<Partial<UpdateGroupRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    const nextName =
      body.name !== undefined ? (typeof body.name === 'string' ? body.name.trim() : '') : existing.name;
    const nextDesc =
      body.description !== undefined
        ? typeof body.description === 'string'
          ? body.description.trim().slice(0, 1000)
          : ''
        : existing.description;

    if (!nextName || nextName.length > 100) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'Group name (1-100 chars) is required', 400);
    }

    if (nextName !== existing.name) {
      const dup = await driver.get<{ id: string }>(
        'SELECT id FROM `groups` WHERE created_by = ? AND name = ? AND id != ? LIMIT 1',
        [Number(existing.created_by), nextName, id],
      );
      if (dup) {
        return fail(c, ErrorCode.CONFLICT, 'Group name already exists', 409);
      }
    }

    const nowIso = new Date().toISOString();
    await driver.run(
      'UPDATE `groups` SET name = ?, description = ?, updated_at = ? WHERE id = ?',
      [nextName, nextDesc, nowIso, id],
    );

    const updated = await driver.get<GroupRow>(
      'SELECT g.id, g.name, g.description, g.created_by, g.created_at, g.updated_at, COUNT(DISTINCT dg.device_id) AS device_count FROM `groups` g LEFT JOIN device_groups dg ON dg.group_id = g.id WHERE g.id = ? GROUP BY g.id, g.name, g.description, g.created_by, g.created_at, g.updated_at',
      [id],
    );
    const groupDevMap = await loadGroupDeviceIdsMap(driver, [id]);

    return ok(c, toGroupDTO(updated ?? existing, groupDevMap.get(id) ?? []));
  });

  router.put('/:id/devices', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');

    const group = await driver.get<{ id: string; created_by: number }>(
      'SELECT id, created_by FROM `groups` WHERE id = ? LIMIT 1',
      [id],
    );
    if (!group) {
      return fail(c, ErrorCode.NOT_FOUND, 'Group not found', 404);
    }
    if (Number(group.created_by) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const body = await readJsonBody<Partial<GroupDevicesRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    if (!Array.isArray(body.device_ids) || body.device_ids.length === 0) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'device_ids must be a non-empty array', 400);
    }
    const deviceIds = [
      ...new Set(
        body.device_ids.filter((d): d is string => typeof d === 'string' && d.trim().length > 0),
      ),
    ];
    if (deviceIds.length === 0 || deviceIds.length !== body.device_ids.length) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'Invalid device_ids', 400);
    }

    const placeholders = deviceIds.map(() => '?').join(', ');
    const devices = await driver.all<{ id: string; owner_id: number }>(
      `SELECT id, owner_id FROM devices WHERE id IN (${placeholders})`,
      deviceIds,
    );
    if (devices.length !== deviceIds.length) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'One or more devices not found', 404);
    }
    if (user.role !== UserRole.ADMIN && devices.some((d) => Number(d.owner_id) !== user.id)) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const nowIso = new Date().toISOString();
    await driver.batch(buildAddDevicesToGroupStmts(driver, id, deviceIds, nowIso));

    return ok(c, { group_id: id, updated_count: deviceIds.length }, 'Devices added to group');
  });

  router.delete('/:id/devices', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');

    const group = await driver.get<{ id: string; created_by: number }>(
      'SELECT id, created_by FROM `groups` WHERE id = ? LIMIT 1',
      [id],
    );
    if (!group) {
      return fail(c, ErrorCode.NOT_FOUND, 'Group not found', 404);
    }
    if (Number(group.created_by) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const body = await readJsonBody<Partial<GroupDevicesRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    if (!Array.isArray(body.device_ids) || body.device_ids.length === 0) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'device_ids must be a non-empty array', 400);
    }
    const deviceIds = [
      ...new Set(
        body.device_ids.filter((d): d is string => typeof d === 'string' && d.trim().length > 0),
      ),
    ];
    if (deviceIds.length === 0) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'Invalid device_ids', 400);
    }

    const placeholders = deviceIds.map(() => '?').join(', ');
    const devices = await driver.all<{ id: string; owner_id: number }>(
      `SELECT id, owner_id FROM devices WHERE id IN (${placeholders})`,
      deviceIds,
    );
    if (devices.length !== deviceIds.length) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'One or more devices not found', 404);
    }
    if (user.role !== UserRole.ADMIN && devices.some((d) => Number(d.owner_id) !== user.id)) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const nowIso = new Date().toISOString();
    const res = await driver.run(
      `DELETE FROM device_groups WHERE group_id = ? AND device_id IN (${placeholders})`,
      [id, ...deviceIds],
    );
    await syncDevicesPrimaryGroup(driver, deviceIds, nowIso);

    return ok(c, { group_id: id, removed_count: res.changes }, 'Devices removed from group');
  });

  router.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');

    const group = await driver.get<{ id: string; name: string; created_by: number }>(
      'SELECT id, name, created_by FROM `groups` WHERE id = ? LIMIT 1',
      [id],
    );
    if (!group) {
      return fail(c, ErrorCode.NOT_FOUND, 'Group not found', 404);
    }
    if (Number(group.created_by) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const dgRows = await driver.all<{ device_id: string }>(
      'SELECT device_id FROM device_groups WHERE group_id = ?',
      [id],
    );
    const legacyDevRows = await driver.all<{ id: string }>(
      'SELECT id FROM devices WHERE group_id = ?',
      [id],
    );
    const affectedIds = uniqueStrings([
      ...dgRows.map((r) => r.device_id),
      ...legacyDevRows.map((r) => r.id),
    ]);

    const nowIso = new Date().toISOString();
    await driver.batch([
      { sql: 'DELETE FROM device_groups WHERE group_id = ?', params: [id] },
      {
        sql: "DELETE FROM command_targets WHERE target_type = 'groups' AND target_id = ?",
        params: [id],
      },
      { sql: 'DELETE FROM `groups` WHERE id = ?', params: [id] },
    ]);

    await syncDevicesPrimaryGroup(driver, affectedIds, nowIso);

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'delete_group',
      targetId: id,
      ip: getClientIp(c),
      detail: group.name,
      timestamp: nowIso,
    });

    return ok(c, { id, deleted_at: nowIso }, 'Group deleted');
  });

  return router;
}
