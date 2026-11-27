import { Hono } from 'hono';
import {
  ErrorCode,
  UserRole,
  type CommandAction,
  type CommandDTO,
  type CommandDetailDTO,
  type CommandStatus,
  type CommandType,
  type CreateCommandRequest,
  type ExecutionDTO,
  type ExecutionDeviceResultDTO,
  type ExecutionStatus,
  type RetryPolicy,
  type TargetType,
  type UpdateCommandStatusRequest,
} from '../../../shared/types';
import type { SqlDriver, SqlParam, SqlStatement } from '../db/driver';
import { CronValidationError, nextCronAfter, parseCron } from '../lib/cron';
import { generateId } from '../lib/crypto';
import { uniqueStrings } from '../lib/device-groups';
import { reapTimedOutExecutions, writeAuditLog } from '../lib/reconcile';
import { resolveEffectiveTimeZone } from '../lib/timezone';
import {
  fail,
  getClientIp,
  ok,
  parseJsonSafe,
  parsePagination,
  readJsonBody,
} from '../lib/response';
import { requireAuth, type AppEnv } from '../middleware/auth';

interface CommandRow {
  id: string;
  name: string;
  type: CommandType;
  schedule: string;
  content: string;
  target_type: TargetType;
  target_ids_json: string;
  timeout: number;
  shell: string;
  retry_policy_json: string | null;
  env_vars_json: string | null;
  status: CommandStatus;
  next_run_at: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
}

interface ExecutionRow {
  id: string;
  command_id: string;
  status: ExecutionStatus;
  scheduled_for: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

interface ExecutionResultJoinedRow {
  id: string;
  execution_id: string;
  command_id: string;
  device_id: string;
  device_name: string | null;
  status: ExecutionStatus;
  exit_code: number;
  output: string | null;
  started_at: string | null;
  completed_at: string | null;
}

const VALID_COMMAND_TYPES = new Set<CommandType>(['immediate', 'once', 'cron']);

function appendCommandTypeFilters(
  where: string[],
  params: SqlParam[],
  typeFilter?: string,
  excludeTypeFilter?: string,
): void {
  if (typeFilter) {
    const valid = [
      ...new Set(
        typeFilter
          .split(',')
          .map((t) => t.trim())
          .filter((t): t is CommandType => VALID_COMMAND_TYPES.has(t as CommandType)),
      ),
    ];
    if (valid.length === 1) {
      where.push('c.type = ?');
      params.push(valid[0]!);
    } else if (valid.length > 1) {
      where.push(`c.type IN (${valid.map(() => '?').join(', ')})`);
      params.push(...valid);
    } else {
      where.push('c.type = ?');
      params.push(typeFilter);
    }
  }

  if (excludeTypeFilter) {
    const exValid = [
      ...new Set(
        excludeTypeFilter
          .split(',')
          .map((t) => t.trim())
          .filter((t): t is CommandType => VALID_COMMAND_TYPES.has(t as CommandType)),
      ),
    ];
    if (exValid.length > 0) {
      where.push(`c.type NOT IN (${exValid.map(() => '?').join(', ')})`);
      params.push(...exValid);
    }
  }
}

function toCommandDTO(row: CommandRow): CommandDTO {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    schedule: row.schedule || undefined,
    content: row.content,
    target_type: row.target_type,
    target_ids: parseJsonSafe<string[]>(row.target_ids_json, []),
    timeout: Number(row.timeout),
    shell: row.shell || undefined,
    status: row.status,
    next_run: row.next_run_at ?? null,
    created_by: Number(row.created_by),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function hydrateExecutions(
  driver: SqlDriver,
  executions: ExecutionRow[],
): Promise<ExecutionDTO[]> {
  if (executions.length === 0) return [];
  const execIds = executions.map((e) => e.id);
  const placeholders = execIds.map(() => '?').join(', ');
  const resultRows = await driver.all<ExecutionResultJoinedRow>(
    `SELECT er.id, er.execution_id, er.command_id, er.device_id, d.name AS device_name, er.status, er.exit_code, er.output, er.started_at, er.completed_at FROM execution_results er LEFT JOIN devices d ON d.id = er.device_id WHERE er.execution_id IN (${placeholders}) ORDER BY er.created_at ASC`,
    execIds,
  );

  const byExec = new Map<string, ExecutionDeviceResultDTO[]>();
  for (const r of resultRows) {
    const list = byExec.get(r.execution_id) ?? [];
    list.push({
      id: r.id,
      result_id: r.id,
      execution_id: r.execution_id,
      device_id: r.device_id,
      device_name: r.device_name ?? undefined,
      status: r.status,
      exit_code: Number(r.exit_code ?? 0),
      output: r.output ?? '',
      log_url: `/api/logs/download/${r.id}`,
      started_at: r.started_at ?? null,
      completed_at: r.completed_at ?? null,
    });
    byExec.set(r.execution_id, list);
  }

  return executions.map((e) => ({
    id: e.id,
    command_id: e.command_id,
    status: e.status,
    scheduled_for: e.scheduled_for ?? null,
    started_at: e.started_at,
    completed_at: e.completed_at ?? null,
    device_results: byExec.get(e.id) ?? [],
  }));
}

export function createCommandRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  router.use('*', requireAuth);

  router.post('/', async (c) => {
    const config = c.get('config');
    const body = await readJsonBody<Partial<CreateCommandRequest>>(c, config.maxPayloadBytes);

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const type = body.type;
    const content = typeof body.content === 'string' ? body.content : '';
    const targetType = body.target_type;
    const rawTargets = Array.isArray(body.target_ids) ? body.target_ids : [];
    const targetIds = [
      ...new Set(
        rawTargets.filter((t): t is string => typeof t === 'string' && t.trim().length > 0),
      ),
    ];

    if (!name || name.length > 191 || !content.trim()) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'name and content are required', 400);
    }
    if (type !== 'immediate' && type !== 'once' && type !== 'cron') {
      return fail(
        c,
        ErrorCode.VALIDATION_ERROR,
        'type must be immediate, once, or cron',
        400,
      );
    }
    if (targetType !== 'devices' && targetType !== 'groups') {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'target_type must be devices or groups', 400);
    }
    if (targetIds.length === 0) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'target_ids must be a non-empty array', 400);
    }

    const timeout =
      body.timeout !== undefined
        ? Number(body.timeout)
        : config.defaultTimeoutSeconds;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 86400) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'timeout must be an integer between 1 and 86400', 400);
    }

    const shell = typeof body.shell === 'string' ? body.shell.trim().slice(0, 64) : '';
    let envVarsJson: string | null = null;
    if (body.env_vars !== undefined && body.env_vars !== null) {
      if (typeof body.env_vars !== 'object' || Array.isArray(body.env_vars)) {
        return fail(c, ErrorCode.VALIDATION_ERROR, 'env_vars must be a string map', 400);
      }
      const normalizedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.env_vars)) {
        if (typeof k === 'string' && typeof v === 'string') {
          normalizedEnv[k] = v;
        }
      }
      envVarsJson = JSON.stringify(normalizedEnv);
    }

    let retryPolicyJson: string | null = null;
    if (body.retry_policy !== undefined && body.retry_policy !== null) {
      const rp = body.retry_policy as Partial<RetryPolicy>;
      retryPolicyJson = JSON.stringify({
        enabled: Boolean(rp.enabled),
        max_attempts:
          typeof rp.max_attempts === 'number' && rp.max_attempts >= 1
            ? Math.min(10, Math.floor(rp.max_attempts))
            : 1,
      });
    }

    const driver = c.get('driver');
    const user = c.get('user');
    const isAdmin = user.role === UserRole.ADMIN;
    const placeholders = targetIds.map(() => '?').join(', ');

    let resolvedDeviceIds: string[] = [];
    if (targetType === 'devices') {
      const devices = await driver.all<{ id: string; owner_id: number }>(
        `SELECT id, owner_id FROM devices WHERE id IN (${placeholders})`,
        targetIds,
      );
      if (devices.length !== targetIds.length) {
        return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'One or more target devices not found', 404);
      }
      if (!isAdmin && devices.some((d) => Number(d.owner_id) !== user.id)) {
        return fail(c, ErrorCode.FORBIDDEN, 'Forbidden for one or more target devices', 403);
      }
      resolvedDeviceIds = targetIds;
    } else {
      const groups = await driver.all<{ id: string; created_by: number }>(
        `SELECT id, created_by FROM \`groups\` WHERE id IN (${placeholders})`,
        targetIds,
      );
      if (groups.length !== targetIds.length) {
        return fail(c, ErrorCode.NOT_FOUND, 'One or more target groups not found', 404);
      }
      if (!isAdmin && groups.some((g) => Number(g.created_by) !== user.id)) {
        return fail(c, ErrorCode.FORBIDDEN, 'Forbidden for one or more target groups', 403);
      }
      const groupDevices = await driver.all<{ id: string; owner_id: number }>(
        `SELECT DISTINCT d.id, d.owner_id FROM devices d LEFT JOIN device_groups dg ON dg.device_id = d.id WHERE dg.group_id IN (${placeholders}) OR d.group_id IN (${placeholders})`,
        [...targetIds, ...targetIds],
      );
      if (!isAdmin && groupDevices.some((d) => Number(d.owner_id) !== user.id)) {
        return fail(c, ErrorCode.FORBIDDEN, 'Forbidden for device in target group', 403);
      }
      resolvedDeviceIds = uniqueStrings(groupDevices.map((d) => d.id));
      if (type !== 'cron' && resolvedDeviceIds.length === 0) {
        return fail(c, ErrorCode.VALIDATION_ERROR, 'Target groups contain no devices', 400);
      }
    }

    const now = new Date();
    const nowIso = now.toISOString();
    let scheduleStr = '';
    let nextRunAt: string | null = null;
    let shouldQueueNow = type === 'immediate' || type === 'once';

    if (type === 'cron') {
      scheduleStr = typeof body.schedule === 'string' ? body.schedule.trim() : '';
      if (!scheduleStr) {
        return fail(c, ErrorCode.INVALID_CRON, 'Cron schedule is required', 400);
      }
      try {
        const parsed = parseCron(scheduleStr);
        const { timezone } = await resolveEffectiveTimeZone(driver, config);
        nextRunAt = nextCronAfter(parsed, now, timezone);
      } catch (err) {
        const msg = err instanceof CronValidationError ? err.message : 'Invalid cron expression';
        return fail(c, ErrorCode.INVALID_CRON, msg, 400);
      }
    } else if (type === 'once' && body.schedule !== undefined && body.schedule !== null) {
      if (typeof body.schedule !== 'string') {
        return fail(c, ErrorCode.VALIDATION_ERROR, 'schedule must be an ISO-8601 string', 400);
      }
      const rawSchedule = body.schedule.trim();
      if (rawSchedule) {
        const parsedMs = Date.parse(rawSchedule);
        if (!Number.isFinite(parsedMs)) {
          return fail(
            c,
            ErrorCode.VALIDATION_ERROR,
            'Invalid ISO-8601 schedule timestamp for once command',
            400,
          );
        }
        const normalizedIso = new Date(parsedMs).toISOString();
        scheduleStr = normalizedIso;
        if (parsedMs > now.getTime()) {
          nextRunAt = normalizedIso;
          shouldQueueNow = false;
        }
      }
    }

    const cmdId = generateId('cmd');
    const stmts: SqlStatement[] = [
      {
        sql: "INSERT INTO commands (id, name, type, schedule, content, target_type, target_ids_json, timeout, shell, retry_policy_json, env_vars_json, status, next_run_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
        params: [
          cmdId,
          name,
          type,
          scheduleStr,
          content,
          targetType,
          JSON.stringify(targetIds),
          timeout,
          shell,
          retryPolicyJson,
          envVarsJson,
          nextRunAt,
          user.id,
          nowIso,
          nowIso,
        ],
      },
    ];

    for (const tid of targetIds) {
      stmts.push({
        sql: 'INSERT INTO command_targets (command_id, target_type, target_id) VALUES (?, ?, ?)',
        params: [cmdId, targetType, tid],
      });
    }

    if (shouldQueueNow) {
      const execId = generateId('exec');
      stmts.push({
        sql: "INSERT INTO executions (id, command_id, status, scheduled_for, started_at, completed_at, created_at) VALUES (?, ?, 'queued', NULL, ?, NULL, ?)",
        params: [execId, cmdId, nowIso, nowIso],
      });
      for (const devId of resolvedDeviceIds) {
        stmts.push({
          sql: "INSERT INTO execution_results (id, execution_id, command_id, device_id, status, exit_code, output, log_content, timeout_at, started_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, '', NULL, NULL, NULL, NULL, ?, ?)",
          params: [generateId('res'), execId, cmdId, devId, nowIso, nowIso],
        });
      }
    }

    await driver.batch(stmts);

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: 'create_command',
      targetId: cmdId,
      ip: getClientIp(c),
      detail: `${name} (${type})`,
      timestamp: nowIso,
    });

    const createdDto: CommandDTO = {
      id: cmdId,
      name,
      type,
      schedule: scheduleStr || undefined,
      content,
      target_type: targetType,
      target_ids: targetIds,
      timeout,
      shell: shell || undefined,
      status: 'pending',
      next_run: nextRunAt,
      created_by: user.id,
      created_at: nowIso,
      updated_at: nowIso,
    };

    return ok(c, createdDto, 'Command created', 201);
  });

  router.get('/', async (c) => {
    const driver = c.get('driver');
    const user = c.get('user');
    const { page, limit, offset } = parsePagination(c);

    const statusFilter = c.req.query('status')?.trim();
    const typeFilter = c.req.query('type')?.trim();
    const excludeTypeFilter = c.req.query('exclude_type')?.trim();
    const deviceFilter = (c.req.query('device') || c.req.query('device_id'))?.trim();
    const ownerFilter = c.req.query('owner')?.trim();

    const where: string[] = [];
    const params: SqlParam[] = [];

    if (user.role !== UserRole.ADMIN) {
      where.push('c.created_by = ?');
      params.push(user.id);
    } else if (ownerFilter && /^\d+$/.test(ownerFilter)) {
      where.push('c.created_by = ?');
      params.push(Number.parseInt(ownerFilter, 10));
    }

    if (statusFilter) {
      where.push('c.status = ?');
      params.push(statusFilter);
    }
    appendCommandTypeFilters(where, params, typeFilter, excludeTypeFilter);
    if (deviceFilter) {
      where.push(
        "(EXISTS (SELECT 1 FROM execution_results er WHERE er.command_id = c.id AND er.device_id = ?) OR EXISTS (SELECT 1 FROM command_targets ct WHERE ct.command_id = c.id AND ((ct.target_type = 'devices' AND ct.target_id = ?) OR (ct.target_type = 'groups' AND (EXISTS (SELECT 1 FROM device_groups dg WHERE dg.device_id = ? AND dg.group_id = ct.target_id) OR EXISTS (SELECT 1 FROM devices d WHERE d.id = ? AND d.group_id = ct.target_id))))))",
      );
      params.push(deviceFilter, deviceFilter, deviceFilter, deviceFilter);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await driver.get<{ total: number }>(
      `SELECT COUNT(*) AS total FROM commands c ${whereSql}`,
      params,
    );
    const rows = await driver.all<CommandRow>(
      `SELECT c.* FROM commands c ${whereSql} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return ok(c, {
      total: Number(countRow?.total ?? 0),
      page,
      per_page: limit,
      commands: rows.map(toCommandDTO),
    });
  });

  router.get('/:id', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');

    await reapTimedOutExecutions(driver, new Date().toISOString());

    const row = await driver.get<CommandRow>('SELECT * FROM commands WHERE id = ? LIMIT 1', [id]);
    if (!row) {
      return fail(c, ErrorCode.EXECUTION_NOT_FOUND, 'Command not found', 404);
    }
    if (Number(row.created_by) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const execRows = await driver.all<ExecutionRow>(
      'SELECT * FROM executions WHERE command_id = ? ORDER BY created_at DESC LIMIT 50',
      [id],
    );
    const executionHistory = await hydrateExecutions(driver, execRows);

    const detail: CommandDetailDTO = {
      ...toCommandDTO(row),
      schedule: row.schedule || '',
      content: row.content,
      target_type: row.target_type,
      target_ids: parseJsonSafe<string[]>(row.target_ids_json, []),
      timeout: Number(row.timeout),
      retry_policy: parseJsonSafe<RetryPolicy | null>(row.retry_policy_json, null),
      env_vars: parseJsonSafe<Record<string, string> | null>(row.env_vars_json, null),
      execution_history: executionHistory,
    };

    return ok(c, detail);
  });

  router.put('/:id', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');

    const row = await driver.get<CommandRow>('SELECT * FROM commands WHERE id = ? LIMIT 1', [id]);
    if (!row) {
      return fail(c, ErrorCode.EXECUTION_NOT_FOUND, 'Command not found', 404);
    }
    if (Number(row.created_by) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const body = await readJsonBody<Partial<UpdateCommandStatusRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    const action = body.action as CommandAction | undefined;
    if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'action must be pause, resume, or cancel', 400);
    }

    const now = new Date();
    const nowIso = now.toISOString();

    if (action === 'pause') {
      if (row.status !== 'pending' && row.status !== 'running') {
        return fail(c, ErrorCode.CONFLICT, `Cannot pause command in status "${row.status}"`, 409);
      }
      await driver.run("UPDATE commands SET status = 'paused', updated_at = ? WHERE id = ?", [
        nowIso,
        id,
      ]);
    } else if (action === 'resume') {
      if (row.status !== 'paused') {
        return fail(c, ErrorCode.CONFLICT, `Cannot resume command in status "${row.status}"`, 409);
      }
      let nextRun = row.next_run_at;
      if (row.type === 'cron' && (!nextRun || nextRun <= nowIso)) {
        const { timezone } = await resolveEffectiveTimeZone(driver, c.get('config'));
        nextRun = nextCronAfter(row.schedule, now, timezone);
      }
      await driver.run(
        "UPDATE commands SET status = 'pending', next_run_at = ?, updated_at = ? WHERE id = ?",
        [nextRun, nowIso, id],
      );
    } else if (action === 'cancel') {
      if (row.status !== 'pending' && row.status !== 'running' && row.status !== 'paused') {
        return fail(c, ErrorCode.CONFLICT, `Cannot cancel command in status "${row.status}"`, 409);
      }
      await driver.batch([
        {
          sql: "UPDATE commands SET status = 'cancelled', updated_at = ? WHERE id = ?",
          params: [nowIso, id],
        },
        {
          sql: "UPDATE execution_results SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE command_id = ? AND status IN ('queued', 'running')",
          params: [nowIso, nowIso, id],
        },
        {
          sql: "UPDATE executions SET status = 'cancelled', completed_at = ? WHERE command_id = ? AND status IN ('queued', 'running')",
          params: [nowIso, id],
        },
      ]);
    }

    await writeAuditLog(driver, {
      userId: user.id,
      username: user.username,
      action: `command_${action}`,
      targetId: id,
      ip: getClientIp(c),
      timestamp: nowIso,
    });

    return ok(c, { id, action, updated_at: nowIso }, `Command ${action}d`);
  });

  router.get('/:id/results', async (c) => {
    const id = c.req.param('id');
    const driver = c.get('driver');
    const user = c.get('user');
    const { limit, offset } = parsePagination(c);

    await reapTimedOutExecutions(driver, new Date().toISOString());

    const row = await driver.get<{ id: string; created_by: number }>(
      'SELECT id, created_by FROM commands WHERE id = ? LIMIT 1',
      [id],
    );
    if (!row) {
      return fail(c, ErrorCode.EXECUTION_NOT_FOUND, 'Command not found', 404);
    }
    if (Number(row.created_by) !== user.id && user.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const execRows = await driver.all<ExecutionRow>(
      'SELECT * FROM executions WHERE command_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [id, limit, offset],
    );
    const executions = await hydrateExecutions(driver, execRows);

    return ok(c, {
      command_id: id,
      executions,
    });
  });

  return router;
}
