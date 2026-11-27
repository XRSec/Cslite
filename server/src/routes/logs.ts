import { Hono } from 'hono';
import {
  ErrorCode,
  UserRole,
  type AuditLogDTO,
  type CommandLogDTO,
  type CommandType,
  type DeviceLogDTO,
  type ExecutionStatus,
} from '../../../shared/types';
import type { SqlParam } from '../db/driver';
import { fail, ok, parseJsonSafe, parsePagination } from '../lib/response';
import { requireAdmin, requireAuth, type AppEnv } from '../middleware/auth';

const VALID_COMMAND_TYPES = new Set<CommandType>(['immediate', 'once', 'cron']);

interface CommandLogRow {
  result_id: string;
  execution_id: string;
  command_id: string;
  command_name: string;
  command_type: CommandType;
  command_content: string | null;
  device_id: string;
  device_name: string | null;
  status: ExecutionStatus;
  exit_code: number;
  output: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface DeviceLogRow {
  id: string;
  device_id: string;
  type: string;
  timestamp: string;
  message: string;
  metadata_json: string | null;
}

interface AuditLogRow {
  id: string;
  user_id: number;
  username: string;
  action: string;
  target_id: string;
  ip: string;
  detail: string | null;
  timestamp: string;
}

export function createLogRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', requireAuth);

  router.get('/command', async (c) => {
    const driver = c.get('driver');
    const user = c.get('user');
    const { page, limit, offset } = parsePagination(c);

    const commandId = c.req.query('command_id')?.trim();
    const deviceId = c.req.query('device_id')?.trim();
    const status = c.req.query('status')?.trim();
    const typeFilter = c.req.query('type')?.trim();
    const sourceFilter = c.req.query('source')?.trim().toLowerCase();

    const where: string[] = [];
    const params: SqlParam[] = [];

    if (user.role !== UserRole.ADMIN) {
      where.push('(c.created_by = ? OR d.owner_id = ?)');
      params.push(user.id, user.id);
    }
    if (commandId) {
      where.push('er.command_id = ?');
      params.push(commandId);
    }
    if (deviceId) {
      where.push('er.device_id = ?');
      params.push(deviceId);
    }
    if (status) {
      where.push('er.status = ?');
      params.push(status);
    }
    if (sourceFilter === 'health') {
      where.push("(c.name LIKE 'health-probe:%' OR c.name LIKE 'diag-%:%')");
    }
    if (typeFilter) {
      const validTypes = [
        ...new Set(
          typeFilter
            .split(',')
            .map((t) => t.trim())
            .filter((t): t is CommandType => VALID_COMMAND_TYPES.has(t as CommandType)),
        ),
      ];
      if (validTypes.length === 1) {
        where.push('c.type = ?');
        params.push(validTypes[0]!);
      } else if (validTypes.length > 1) {
        where.push(`c.type IN (${validTypes.map(() => '?').join(', ')})`);
        params.push(...validTypes);
      } else {
        where.push('c.type = ?');
        params.push(typeFilter);
      }
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await driver.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM execution_results er INNER JOIN commands c ON c.id = er.command_id LEFT JOIN devices d ON d.id = er.device_id ${whereSql}`,
      params,
    );
    const rows = await driver.all<CommandLogRow>(
      `SELECT er.id AS result_id, er.execution_id, er.command_id, c.name AS command_name, c.type AS command_type, c.content AS command_content, er.device_id, d.name AS device_name, er.status, er.exit_code, er.output, er.started_at, er.completed_at, er.created_at FROM execution_results er INNER JOIN commands c ON c.id = er.command_id LEFT JOIN devices d ON d.id = er.device_id ${whereSql} ORDER BY er.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const logs: CommandLogDTO[] = rows.map((r) => ({
      result_id: r.result_id,
      execution_id: r.execution_id,
      command_id: r.command_id,
      command_name: r.command_name,
      command_type: r.command_type,
      command_content: (r.command_content ?? '').slice(0, 240),
      device_id: r.device_id,
      device_name: r.device_name ?? undefined,
      status: r.status,
      exit_code: Number(r.exit_code ?? 0),
      output_preview: (r.output ?? '').slice(0, 500),
      log_url: `/api/logs/download/${r.result_id}`,
      started_at: r.started_at || r.created_at,
      completed_at: r.completed_at ?? null,
    }));

    return ok(c, {
      total: Number(countRow?.total ?? 0),
      page,
      per_page: limit,
      logs,
    });
  });

  router.get('/device', async (c) => {
    const driver = c.get('driver');
    const user = c.get('user');
    const { page, limit, offset } = parsePagination(c);

    const deviceId = c.req.query('device_id')?.trim();
    const typeFilter = c.req.query('type')?.trim();
    const excludeTypeFilter = c.req.query('exclude_type')?.trim();

    const where: string[] = [];
    const params: SqlParam[] = [];

    if (user.role !== UserRole.ADMIN) {
      where.push('d.owner_id = ?');
      params.push(user.id);
    }
    if (deviceId) {
      where.push('dl.device_id = ?');
      params.push(deviceId);
    }
    if (typeFilter) {
      const types = [
        ...new Set(
          typeFilter
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ];
      if (types.length === 1) {
        where.push('dl.type = ?');
        params.push(types[0]!);
      } else if (types.length > 1) {
        where.push(`dl.type IN (${types.map(() => '?').join(', ')})`);
        params.push(...types);
      } else {
        where.push('dl.type = ?');
        params.push(typeFilter);
      }
    } else if (excludeTypeFilter) {
      const excluded = [
        ...new Set(
          excludeTypeFilter
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ];
      if (excluded.length === 1) {
        where.push('dl.type != ?');
        params.push(excluded[0]!);
      } else if (excluded.length > 1) {
        where.push(`dl.type NOT IN (${excluded.map(() => '?').join(', ')})`);
        params.push(...excluded);
      }
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await driver.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM device_logs dl INNER JOIN devices d ON d.id = dl.device_id ${whereSql}`,
      params,
    );
    const rows = await driver.all<DeviceLogRow>(
      `SELECT dl.id, dl.device_id, dl.type, dl.timestamp, dl.message, dl.metadata_json FROM device_logs dl INNER JOIN devices d ON d.id = dl.device_id ${whereSql} ORDER BY dl.timestamp DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const logs: DeviceLogDTO[] = rows.map((r) => ({
      id: r.id,
      device_id: r.device_id,
      type: r.type,
      timestamp: r.timestamp,
      message: r.message,
      metadata: parseJsonSafe<Record<string, unknown> | null>(r.metadata_json, null),
    }));

    return ok(c, {
      total: Number(countRow?.total ?? 0),
      page,
      per_page: limit,
      logs,
    });
  });

  router.get('/user', requireAdmin, async (c) => {
    const driver = c.get('driver');
    const { page, limit, offset } = parsePagination(c);

    const userIdFilter = c.req.query('user_id')?.trim();
    const actionFilter = c.req.query('action')?.trim();

    const where: string[] = [];
    const params: SqlParam[] = [];

    if (userIdFilter && /^\d+$/.test(userIdFilter)) {
      where.push('user_id = ?');
      params.push(Number.parseInt(userIdFilter, 10));
    }
    if (actionFilter) {
      where.push('action = ?');
      params.push(actionFilter);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await driver.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM audit_logs ${whereSql}`,
      params,
    );
    const rows = await driver.all<AuditLogRow>(
      `SELECT id, user_id, username, action, target_id, ip, detail, timestamp FROM audit_logs ${whereSql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const logs: AuditLogDTO[] = rows.map((r) => ({
      id: r.id,
      user_id: Number(r.user_id),
      username: r.username,
      action: r.action,
      target_id: r.target_id,
      ip: r.ip,
      detail: r.detail ?? undefined,
      timestamp: r.timestamp,
    }));

    return ok(c, {
      total: Number(countRow?.total ?? 0),
      page,
      per_page: limit,
      logs,
    });
  });

  router.get('/download/:result_id', async (c) => {
    const resultId = c.req.param('result_id');
    const driver = c.get('driver');
    const user = c.get('user');

    const row = await driver.get<{
      id: string;
      output: string | null;
      log_content: string | null;
      created_by: number;
      owner_id: number | null;
    }>(
      'SELECT er.id, er.output, er.log_content, c.created_by, d.owner_id FROM execution_results er INNER JOIN commands c ON c.id = er.command_id LEFT JOIN devices d ON d.id = er.device_id WHERE er.id = ? LIMIT 1',
      [resultId],
    );

    if (!row) {
      return fail(c, ErrorCode.EXECUTION_NOT_FOUND, 'Execution result log not found', 404);
    }

    const isOwner =
      Number(row.created_by) === user.id ||
      (row.owner_id !== null && Number(row.owner_id) === user.id);
    if (!isOwner && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const content = row.log_content ?? row.output ?? '';
    const safeId = resultId.replace(/[^a-zA-Z0-9._-]/g, '_');

    return new Response(content, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="cslite-${safeId}.log"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  return router;
}
