import { Hono, type Context } from 'hono';
import {
  ErrorCode,
  UserRole,
  type AgentHeartbeatRequest,
  type AgentPollCommandsRequest,
  type AgentRegisterRequest,
  type AgentResultRequest,
  type CommandTask,
  type CommandType,
  type DeviceMetrics,
} from '../../../shared/types';
import type { AppConfig } from '../config';
import type { SqlDriver, SqlStatement } from '../db/driver';
import { maybeRunScheduledCleanup } from '../lib/cleanup';
import { nextCronAfter } from '../lib/cron';
import { generateId } from '../lib/crypto';
import { loadDeviceGroupIdsMap, uniqueStrings } from '../lib/device-groups';
import {
  reapTimedOutExecutions,
  reconcileExecutionAndCommand,
  writeDeviceLog,
} from '../lib/reconcile';
import {
  decodeBase64Utf8,
  fail,
  getClientIp,
  ok,
  parseJsonSafe,
  readJsonBody,
  truncateUtf8Bytes,
} from '../lib/response';
import { resolveEffectiveTimeZone } from '../lib/timezone';
import { authenticateApiKeyWithScope, type AppEnv } from '../middleware/auth';
import { getOnlineThresholdMs, isDeviceOnline } from './devices';

interface AgentDeviceRow {
  agent_id: string;
  device_id: string;
  owner_id: number;
  device_status: string;
  device_last_seen: string;
  last_heartbeat: string | null;
  group_id: string | null;
  ip_address: string;
  agent_version: string;
  metrics_json: string | null;
  os_version: string;
  hostname: string;
}

type PollTelemetry = Pick<
  Partial<AgentPollCommandsRequest>,
  'metrics' | 'ip_address' | 'version' | 'os_version' | 'hostname'
>;

interface DueScheduledCommandRow {
  id: string;
  type: CommandType;
  schedule: string;
  target_type: string;
  next_run_at: string;
}

interface QueuedTaskRow {
  id: string;
  execution_id: string;
  command_id: string;
  cmd_name: string;
  cmd_type: CommandType;
  cmd_schedule: string;
  cmd_content: string;
  cmd_timeout: number;
  cmd_shell: string;
  cmd_env_vars_json: string | null;
}

const LAST_SEEN_THROTTLE_MS = 30_000;

function extractApiKey(c: Context, bodyKey?: unknown): string {
  const headerKey = c.req.header('x-api-key')?.trim();
  if (headerKey) return headerKey;
  const auth = c.req.header('authorization')?.trim();
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  if (typeof bodyKey === 'string' && bodyKey.trim()) {
    return bodyKey.trim();
  }
  const queryKey = c.req.query('api_key')?.trim();
  return queryKey || '';
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const maybe = err as { code?: unknown; errno?: unknown; message?: unknown };
  if (maybe.code === 'ER_DUP_ENTRY' || maybe.errno === 1062) return true;
  const msg = String(maybe.message ?? '');
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT|Duplicate entry/i.test(msg);
}

async function resolveCommandTargetDeviceIds(
  driver: SqlDriver,
  commandId: string,
  targetType: string,
): Promise<string[]> {
  if (targetType === 'devices') {
    const rows = await driver.all<{ target_id: string }>(
      "SELECT target_id FROM command_targets WHERE command_id = ? AND target_type = 'devices'",
      [commandId],
    );
    return uniqueStrings(rows.map((r) => r.target_id));
  }
  const rows = await driver.all<{ id: string }>(
    "SELECT DISTINCT d.id FROM devices d INNER JOIN command_targets ct ON ct.target_type = 'groups' LEFT JOIN device_groups dg ON dg.device_id = d.id AND dg.group_id = ct.target_id WHERE ct.command_id = ? AND (dg.group_id IS NOT NULL OR d.group_id = ct.target_id)",
    [commandId],
  );
  return uniqueStrings(rows.map((r) => r.id));
}

async function materializeDueScheduledForDevice(
  driver: SqlDriver,
  config: AppConfig,
  deviceId: string,
  fallbackGroupId: string | null,
  now: Date,
  nowIso: string,
): Promise<void> {
  const groupMap = await loadDeviceGroupIdsMap(driver, [deviceId]);
  const groupIds = uniqueStrings([...(groupMap.get(deviceId) ?? []), fallbackGroupId]);

  const dueCommands =
    groupIds.length > 0
      ? await driver.all<DueScheduledCommandRow>(
          `SELECT DISTINCT c.id, c.type, c.schedule, c.target_type, c.next_run_at FROM commands c INNER JOIN command_targets ct ON ct.command_id = c.id WHERE ((c.type = 'cron' AND c.status IN ('pending', 'running')) OR (c.type = 'once' AND c.status = 'pending')) AND c.next_run_at IS NOT NULL AND c.next_run_at <= ? AND ((ct.target_type = 'devices' AND ct.target_id = ?) OR (ct.target_type = 'groups' AND ct.target_id IN (${groupIds.map(() => '?').join(', ')}))) ORDER BY c.next_run_at ASC LIMIT 10`,
          [nowIso, deviceId, ...groupIds],
        )
      : await driver.all<DueScheduledCommandRow>(
          "SELECT DISTINCT c.id, c.type, c.schedule, c.target_type, c.next_run_at FROM commands c INNER JOIN command_targets ct ON ct.command_id = c.id WHERE ((c.type = 'cron' AND c.status IN ('pending', 'running')) OR (c.type = 'once' AND c.status = 'pending')) AND c.next_run_at IS NOT NULL AND c.next_run_at <= ? AND ct.target_type = 'devices' AND ct.target_id = ? ORDER BY c.next_run_at ASC LIMIT 10",
          [nowIso, deviceId],
        );

  if (dueCommands.length === 0) return;

  let effectiveTimeZone = 'UTC';
  if (dueCommands.some((cmd) => cmd.type === 'cron')) {
    effectiveTimeZone = (await resolveEffectiveTimeZone(driver, config)).timezone;
  }

  for (const cmd of dueCommands) {
    const scheduledFor = cmd.next_run_at;
    const targetDeviceIds = await resolveCommandTargetDeviceIds(driver, cmd.id, cmd.target_type);
    if (!targetDeviceIds.includes(deviceId)) {
      targetDeviceIds.push(deviceId);
    }

    const execId = generateId('exec');
    const stmts: SqlStatement[] = [
      {
        sql: "INSERT INTO executions (id, command_id, status, scheduled_for, started_at, completed_at, created_at) VALUES (?, ?, 'queued', ?, ?, NULL, ?)",
        params: [execId, cmd.id, scheduledFor, nowIso, nowIso],
      },
    ];

    for (const devId of targetDeviceIds) {
      stmts.push({
        sql: "INSERT INTO execution_results (id, execution_id, command_id, device_id, status, exit_code, output, log_content, timeout_at, started_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, '', NULL, NULL, NULL, NULL, ?, ?)",
        params: [generateId('res'), execId, cmd.id, devId, nowIso, nowIso],
      });
    }

    if (cmd.type === 'cron') {
      const nextRun = nextCronAfter(cmd.schedule, now, effectiveTimeZone);
      stmts.push({
        sql: 'UPDATE commands SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ?',
        params: [nextRun, nowIso, cmd.id, scheduledFor],
      });
    } else {
      stmts.push({
        sql: "UPDATE commands SET status = 'running', next_run_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending' AND next_run_at = ?",
        params: [nowIso, cmd.id, scheduledFor],
      });
    }

    try {
      await driver.batch(stmts);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        // Another concurrent poller materialized this exact scheduled execution first
        continue;
      }
      throw err;
    }
  }
}

function hasPollTelemetry(telemetry?: PollTelemetry): boolean {
  if (!telemetry) return false;
  if (telemetry.metrics && typeof telemetry.metrics === 'object' && !Array.isArray(telemetry.metrics)) {
    return true;
  }
  return Boolean(
    (typeof telemetry.ip_address === 'string' && telemetry.ip_address.trim()) ||
      (typeof telemetry.version === 'string' && telemetry.version.trim()) ||
      (typeof telemetry.os_version === 'string' && telemetry.os_version.trim()) ||
      (typeof telemetry.hostname === 'string' && telemetry.hostname.trim()),
  );
}

function summarizeMetrics(metricsObj: DeviceMetrics | null): string {
  if (!metricsObj) return '';
  const parts: string[] = [];
  if (typeof metricsObj.cpu_usage === 'number' && Number.isFinite(metricsObj.cpu_usage)) {
    parts.push(`CPU ${metricsObj.cpu_usage.toFixed(1)}%`);
  }
  if (typeof metricsObj.memory_percent === 'number' && Number.isFinite(metricsObj.memory_percent)) {
    parts.push(`Mem ${metricsObj.memory_percent.toFixed(1)}%`);
  } else if (typeof metricsObj.memory_used === 'number' && Number.isFinite(metricsObj.memory_used)) {
    const memSummary =
      typeof metricsObj.memory_total === 'number' && metricsObj.memory_total > 0
        ? `Mem ${metricsObj.memory_used}/${metricsObj.memory_total}`
        : `Mem ${metricsObj.memory_used}`;
    parts.push(memSummary);
  }
  if (typeof metricsObj.disk_usage === 'number' && Number.isFinite(metricsObj.disk_usage)) {
    parts.push(`Disk ${metricsObj.disk_usage.toFixed(1)}%`);
  }
  if (typeof metricsObj.load_avg === 'string' && metricsObj.load_avg.trim()) {
    parts.push(`Load ${metricsObj.load_avg.trim()}`);
  }
  if (
    typeof metricsObj.network_in === 'number' &&
    Number.isFinite(metricsObj.network_in) &&
    typeof metricsObj.network_out === 'number' &&
    Number.isFinite(metricsObj.network_out)
  ) {
    parts.push(`Net ↓${Math.round(metricsObj.network_in)} ↑${Math.round(metricsObj.network_out)} KB/s`);
  }
  return parts.join(', ');
}

async function persistAgentTelemetry(
  c: Context<AppEnv>,
  driver: SqlDriver,
  row: AgentDeviceRow,
  telemetry: PollTelemetry,
  nowIso: string,
): Promise<void> {
  const nextIp =
    getClientIp(c, typeof telemetry.ip_address === 'string' ? telemetry.ip_address : undefined) ||
    row.ip_address;
  const nextVersion =
    typeof telemetry.version === 'string' && telemetry.version.trim()
      ? telemetry.version.trim().slice(0, 64)
      : row.agent_version;
  const nextOsVersion =
    typeof telemetry.os_version === 'string' && telemetry.os_version.trim()
      ? telemetry.os_version.trim().slice(0, 191)
      : row.os_version;
  const nextHostname =
    typeof telemetry.hostname === 'string' && telemetry.hostname.trim()
      ? telemetry.hostname.trim().slice(0, 191)
      : row.hostname;
  const metricsObj =
    telemetry.metrics && typeof telemetry.metrics === 'object' && !Array.isArray(telemetry.metrics)
      ? telemetry.metrics
      : null;
  const nextMetricsJson = metricsObj ? JSON.stringify(metricsObj) : row.metrics_json;
  const config = c.get('config');
  const nowMs = Date.parse(nowIso) || Date.now();
  const recoveredFromOffline =
    Boolean(row.device_last_seen) &&
    !isDeviceOnline(row.device_last_seen, nowMs, getOnlineThresholdMs(config));

  await driver.batch([
    {
      sql: "UPDATE devices SET last_seen = ?, status = 'online', ip_address = ?, os_version = ?, hostname = ?, agent_version = ?, metrics_json = ?, updated_at = ? WHERE id = ?",
      params: [
        nowIso,
        nextIp,
        nextOsVersion,
        nextHostname,
        nextVersion,
        nextMetricsJson,
        nowIso,
        row.device_id,
      ],
    },
    {
      sql: 'UPDATE agents SET last_heartbeat = ?, heartbeat_metrics = ?, version = ?, updated_at = ? WHERE id = ?',
      params: [nowIso, nextMetricsJson, nextVersion, nowIso, row.agent_id],
    },
  ]);

  const metricSummary = summarizeMetrics(metricsObj);
  if (recoveredFromOffline) {
    await writeDeviceLog(
      driver,
      row.device_id,
      'health_online',
      `Device recovered online after offline period${metricSummary ? ` (${metricSummary})` : ''}`,
      {
        previous_last_seen: row.device_last_seen,
        ip_address: nextIp,
        agent_version: nextVersion,
        ...(metricsObj ? { metrics: metricsObj } : {}),
      },
      nowIso,
    );
  } else if (metricsObj) {
    const prevHbMs = row.last_heartbeat ? Date.parse(row.last_heartbeat) : 0;
    const minGapMs = Math.max(30_000, Math.floor(config.heartbeatInterval * 0.75) * 1000);
    const shouldLogHeartbeat =
      !row.metrics_json || !Number.isFinite(prevHbMs) || prevHbMs <= 0 || nowMs - prevHbMs >= minGapMs;
    if (shouldLogHeartbeat) {
      await writeDeviceLog(
        driver,
        row.device_id,
        'heartbeat',
        metricSummary ? `Heartbeat OK (${metricSummary})` : 'Heartbeat OK',
        { ip_address: nextIp, agent_version: nextVersion, metrics: metricsObj },
        nowIso,
      );
    }
  }
}

async function handlePollCommands(
  c: Context<AppEnv>,
  agentId: string,
  rawLimit: unknown,
  rawApiKey: string,
  pollTelemetry?: PollTelemetry,
): Promise<Response> {
  const driver = c.get('driver');
  const config = c.get('config');
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const keyAuth = await authenticateApiKeyWithScope(driver, rawApiKey, nowIso);
  if (!keyAuth) {
    return fail(c, ErrorCode.UNAUTHORIZED, 'Invalid API key', 401);
  }
  const keyUser = keyAuth.user;

  if (!agentId) {
    return fail(c, ErrorCode.VALIDATION_ERROR, 'agent_id is required', 400);
  }

  const limitNum =
    typeof rawLimit === 'number'
      ? rawLimit
      : typeof rawLimit === 'string' && rawLimit.trim()
        ? Number.parseInt(rawLimit, 10)
        : 5;
  const limit = Number.isFinite(limitNum) ? Math.max(1, Math.min(20, Math.floor(limitNum))) : 5;

  const agentRow = await driver.get<AgentDeviceRow>(
    'SELECT a.id AS agent_id, a.device_id, d.owner_id, d.status AS device_status, d.last_seen AS device_last_seen, a.last_heartbeat, d.group_id, d.ip_address, d.agent_version, d.metrics_json, d.os_version, d.hostname FROM agents a INNER JOIN devices d ON d.id = a.device_id WHERE a.id = ? LIMIT 1',
    [agentId],
  );
  if (!agentRow) {
    return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Agent or device not found', 404);
  }
  if (keyAuth.boundDeviceId && agentRow.device_id !== keyAuth.boundDeviceId) {
    return fail(c, ErrorCode.FORBIDDEN, 'API key is bound to a different device', 403);
  }
  if (Number(agentRow.owner_id) !== keyUser.id && keyUser.role !== UserRole.ADMIN) {
    return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
  }

  // 1. Lazy timeout reaper
  await reapTimedOutExecutions(driver, nowIso);

  // 2. Lazy cron & scheduled once materialization
  await materializeDueScheduledForDevice(
    driver,
    config,
    agentRow.device_id,
    agentRow.group_id,
    now,
    nowIso,
  );

  // 3. Atomic claim of up to `limit` queued results for this device
  const candidates = await driver.all<QueuedTaskRow>(
    "SELECT er.id, er.execution_id, er.command_id, c.name AS cmd_name, c.type AS cmd_type, c.schedule AS cmd_schedule, c.content AS cmd_content, c.timeout AS cmd_timeout, c.shell AS cmd_shell, c.env_vars_json AS cmd_env_vars_json FROM execution_results er INNER JOIN commands c ON c.id = er.command_id WHERE er.device_id = ? AND er.status = 'queued' AND c.status IN ('pending', 'running') ORDER BY er.created_at ASC LIMIT ?",
    [agentRow.device_id, limit],
  );

  const tasks: CommandTask[] = [];
  for (const row of candidates) {
    const timeoutSec =
      Number(row.cmd_timeout) > 0 ? Number(row.cmd_timeout) : config.defaultTimeoutSeconds;
    const timeoutAt = new Date(nowMs + timeoutSec * 1000).toISOString();

    const claim = await driver.run(
      "UPDATE execution_results SET status = 'running', started_at = ?, timeout_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
      [nowIso, timeoutAt, nowIso, row.id],
    );

    if (claim.changes === 1) {
      await driver.batch([
        {
          sql: "UPDATE executions SET status = 'running' WHERE id = ? AND status = 'queued'",
          params: [row.execution_id],
        },
        {
          sql: "UPDATE commands SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'",
          params: [nowIso, row.command_id],
        },
      ]);

      const envVars = parseJsonSafe<Record<string, string> | undefined>(
        row.cmd_env_vars_json,
        undefined,
      );
      tasks.push({
        result_id: row.id,
        command_id: row.command_id,
        execution_id: row.execution_id,
        name: row.cmd_name,
        type: row.cmd_type,
        schedule: row.cmd_schedule || undefined,
        content: row.cmd_content,
        timeout: timeoutSec,
        shell: row.cmd_shell || undefined,
        env_vars: envVars,
      });
    }
  }

  // 4. Persist telemetry immediately if carried, else throttled devices.last_seen (> 30s or offline)
  if (pollTelemetry && hasPollTelemetry(pollTelemetry)) {
    await persistAgentTelemetry(c, driver, agentRow, pollTelemetry, nowIso);
  } else {
    const lastSeenMs = agentRow.device_last_seen ? Date.parse(agentRow.device_last_seen) : 0;
    if (
      agentRow.device_status !== 'online' ||
      !agentRow.device_last_seen ||
      !Number.isFinite(lastSeenMs) ||
      nowMs - lastSeenMs > LAST_SEEN_THROTTLE_MS
    ) {
      await driver.run(
        "UPDATE devices SET last_seen = ?, status = 'online', updated_at = ? WHERE id = ?",
        [nowIso, nowIso, agentRow.device_id],
      );
    }
  }

  await maybeRunScheduledCleanup(driver, config, now);

  return ok(c, {
    commands: tasks,
    poll_interval: config.pollInterval,
    next_heartbeat: config.heartbeatInterval,
  });
}

export function createAgentRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/register', async (c) => {
    const config = c.get('config');
    const driver = c.get('driver');
    const body = await readJsonBody<Partial<AgentRegisterRequest>>(c, config.maxPayloadBytes);
    const nowIso = new Date().toISOString();

    const rawApiKey = extractApiKey(c, body.api_key);
    const keyAuth = await authenticateApiKeyWithScope(driver, rawApiKey, nowIso);
    if (!keyAuth) {
      return fail(c, ErrorCode.UNAUTHORIZED, 'Invalid API key', 401);
    }
    const keyUser = keyAuth.user;

    if (!config.allowRegistration) {
      return fail(c, ErrorCode.REGISTRATION_DISABLED, 'Agent registration is disabled', 403);
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const platform = typeof body.platform === 'string' ? body.platform.trim().slice(0, 64) : '';
    const version = typeof body.version === 'string' ? body.version.trim().slice(0, 64) : '';
    const arch = typeof body.arch === 'string' ? body.arch.trim().slice(0, 64) : '';
    const osVersion =
      typeof body.os_version === 'string' ? body.os_version.trim().slice(0, 191) : '';
    const hostname = typeof body.hostname === 'string' ? body.hostname.trim().slice(0, 191) : '';
    let requestedDeviceId =
      typeof body.device_id === 'string' ? body.device_id.trim() : '';

    if (keyAuth.boundDeviceId) {
      if (requestedDeviceId && requestedDeviceId !== keyAuth.boundDeviceId) {
        return fail(c, ErrorCode.FORBIDDEN, 'API key is bound to a different device', 403);
      }
      requestedDeviceId = keyAuth.boundDeviceId;
    }

    if (name.length > 100 || !platform || !version || (!requestedDeviceId && !name)) {
      return fail(
        c,
        ErrorCode.VALIDATION_ERROR,
        requestedDeviceId
          ? 'platform and version are required'
          : 'name, platform, and version are required',
        400,
      );
    }

    const clientIp = getClientIp(c);

    if (requestedDeviceId) {
      const existingDevice = await driver.get<{
        id: string;
        name: string;
        owner_id: number;
        agent_id: string | null;
        platform: string;
        arch: string;
        os_version: string;
        hostname: string;
      }>(
        'SELECT id, name, owner_id, agent_id, platform, arch, os_version, hostname FROM devices WHERE id = ? LIMIT 1',
        [requestedDeviceId],
      );
      if (!existingDevice) {
        return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Pre-created device not found', 404);
      }
      if (Number(existingDevice.owner_id) !== keyUser.id && keyUser.role !== UserRole.ADMIN) {
        return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
      }

      const existingAgent = await driver.get<{ id: string }>(
        'SELECT id FROM agents WHERE device_id = ? LIMIT 1',
        [requestedDeviceId],
      );
      const agentId = existingAgent?.id || existingDevice.agent_id || generateId('agent');
      const nextName =
        existingDevice.name && (!name || name === hostname)
          ? existingDevice.name
          : name || existingDevice.name;
      const nextPlatform =
        platform && platform.toLowerCase() !== 'other' ? platform : existingDevice.platform;
      const nextArch = arch || existingDevice.arch;
      const nextOsVersion = osVersion || existingDevice.os_version;
      const nextHostname = hostname || existingDevice.hostname;

      const stmts: SqlStatement[] = [
        {
          sql: "UPDATE devices SET name = ?, platform = ?, arch = ?, os_version = ?, hostname = ?, status = 'online', ip_address = ?, agent_id = ?, agent_version = ?, last_seen = ?, updated_at = ? WHERE id = ?",
          params: [
            nextName,
            nextPlatform,
            nextArch,
            nextOsVersion,
            nextHostname,
            clientIp,
            agentId,
            version,
            nowIso,
            nowIso,
            requestedDeviceId,
          ],
        },
        existingAgent
          ? {
              sql: "UPDATE agents SET owner_id = ?, version = ?, status = 'active', last_heartbeat = ?, updated_at = ? WHERE id = ?",
              params: [keyUser.id, version, nowIso, nowIso, agentId],
            }
          : {
              sql: "INSERT INTO agents (id, device_id, owner_id, version, status, last_heartbeat, heartbeat_metrics, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?)",
              params: [agentId, requestedDeviceId, keyUser.id, version, nowIso, nowIso, nowIso],
            },
      ];
      await driver.batch(stmts);

      await writeDeviceLog(
        driver,
        requestedDeviceId,
        'register',
        `Agent ${agentId} registered (${nextPlatform} ${version})`,
        { agent_id: agentId, ip_address: clientIp },
        nowIso,
      );

      return ok(c, {
        agent_id: agentId,
        device_id: requestedDeviceId,
        heartbeat_interval: config.heartbeatInterval,
        poll_interval: config.pollInterval,
      });
    }

    const deviceId = generateId('dev');
    const agentId = generateId('agent');

    await driver.batch([
      {
        sql: "INSERT INTO devices (id, name, platform, arch, os_version, hostname, status, owner_id, group_id, ip_address, agent_id, agent_version, metrics_json, last_seen, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'online', ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, ?)",
        params: [
          deviceId,
          name,
          platform,
          arch,
          osVersion,
          hostname,
          keyUser.id,
          clientIp,
          agentId,
          version,
          nowIso,
          nowIso,
          nowIso,
        ],
      },
      {
        sql: "INSERT INTO agents (id, device_id, owner_id, version, status, last_heartbeat, heartbeat_metrics, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, ?)",
        params: [agentId, deviceId, keyUser.id, version, nowIso, nowIso, nowIso],
      },
    ]);

    await writeDeviceLog(
      driver,
      deviceId,
      'register',
      `Agent ${agentId} registered (${platform} ${version})`,
      { agent_id: agentId, ip_address: clientIp },
      nowIso,
    );

    return ok(c, {
      agent_id: agentId,
      device_id: deviceId,
      heartbeat_interval: config.heartbeatInterval,
      poll_interval: config.pollInterval,
    });
  });

  router.post('/heartbeat', async (c) => {
    const config = c.get('config');
    const driver = c.get('driver');
    const body = await readJsonBody<Partial<AgentHeartbeatRequest>>(c, config.maxPayloadBytes);
    const nowIso = new Date().toISOString();

    const rawApiKey = extractApiKey(c, body.api_key);
    const keyAuth = await authenticateApiKeyWithScope(driver, rawApiKey, nowIso);
    if (!keyAuth) {
      return fail(c, ErrorCode.UNAUTHORIZED, 'Invalid API key', 401);
    }
    const keyUser = keyAuth.user;

    const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
    if (!agentId) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'agent_id is required', 400);
    }

    const row = await driver.get<AgentDeviceRow>(
      'SELECT a.id AS agent_id, a.device_id, d.owner_id, d.status AS device_status, d.last_seen AS device_last_seen, a.last_heartbeat, d.group_id, d.ip_address, d.agent_version, d.metrics_json, d.os_version, d.hostname FROM agents a INNER JOIN devices d ON d.id = a.device_id WHERE a.id = ? LIMIT 1',
      [agentId],
    );
    if (!row) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Agent or device not found', 404);
    }
    if (
      keyAuth.boundDeviceId &&
      (row.device_id !== keyAuth.boundDeviceId ||
        (typeof body.device_id === 'string' &&
          body.device_id.trim() &&
          body.device_id.trim() !== keyAuth.boundDeviceId))
    ) {
      return fail(c, ErrorCode.FORBIDDEN, 'API key is bound to a different device', 403);
    }
    if (Number(row.owner_id) !== keyUser.id && keyUser.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    await persistAgentTelemetry(c, driver, row, body, nowIso);

    return ok(c, {
      status: 'ok' as const,
      next_heartbeat: config.heartbeatInterval,
      poll_interval: config.pollInterval,
    });
  });

  router.get('/commands', async (c) => {
    const agentId = c.req.query('agent_id')?.trim() || '';
    const limit = c.req.query('limit');
    const rawApiKey = extractApiKey(c);
    return handlePollCommands(c, agentId, limit, rawApiKey);
  });

  router.post('/commands', async (c) => {
    const body = await readJsonBody<Partial<AgentPollCommandsRequest>>(
      c,
      c.get('config').maxPayloadBytes,
    );
    const agentId =
      (typeof body.agent_id === 'string' ? body.agent_id.trim() : '') ||
      c.req.query('agent_id')?.trim() ||
      '';
    const limit = body.limit ?? c.req.query('limit');
    const rawApiKey = extractApiKey(c, body.api_key);
    return handlePollCommands(c, agentId, limit, rawApiKey, {
      metrics: body.metrics,
      ip_address: body.ip_address,
      version: body.version,
      os_version: body.os_version,
      hostname: body.hostname,
    });
  });

  router.post('/result', async (c) => {
    const config = c.get('config');
    const driver = c.get('driver');
    const body = await readJsonBody<Partial<AgentResultRequest>>(c, config.maxPayloadBytes);
    const nowIso = new Date().toISOString();

    const rawApiKey = extractApiKey(c, body.api_key);
    const keyAuth = await authenticateApiKeyWithScope(driver, rawApiKey, nowIso);
    if (!keyAuth) {
      return fail(c, ErrorCode.UNAUTHORIZED, 'Invalid API key', 401);
    }
    const keyUser = keyAuth.user;

    const executionId = typeof body.execution_id === 'string' ? body.execution_id.trim() : '';
    const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : '';
    const resultId = typeof body.result_id === 'string' ? body.result_id.trim() : '';
    const status = body.status;

    if (!executionId || !deviceId) {
      return fail(c, ErrorCode.VALIDATION_ERROR, 'execution_id and device_id are required', 400);
    }
    if (
      status !== 'completed' &&
      status !== 'failed' &&
      status !== 'timeout' &&
      status !== 'cancelled'
    ) {
      return fail(
        c,
        ErrorCode.VALIDATION_ERROR,
        'status must be completed, failed, timeout, or cancelled',
        400,
      );
    }

    const device = await driver.get<{ id: string; owner_id: number }>(
      'SELECT id, owner_id FROM devices WHERE id = ? LIMIT 1',
      [deviceId],
    );
    if (!device) {
      return fail(c, ErrorCode.DEVICE_NOT_FOUND, 'Device not found', 404);
    }
    if (keyAuth.boundDeviceId && device.id !== keyAuth.boundDeviceId) {
      return fail(c, ErrorCode.FORBIDDEN, 'API key is bound to a different device', 403);
    }
    if (Number(device.owner_id) !== keyUser.id && keyUser.role !== UserRole.ADMIN) {
      return fail(c, ErrorCode.FORBIDDEN, 'Forbidden', 403);
    }

    const resultRow = resultId
      ? await driver.get<{ id: string; execution_id: string; command_id: string }>(
          'SELECT id, execution_id, command_id FROM execution_results WHERE id = ? AND execution_id = ? AND device_id = ? LIMIT 1',
          [resultId, executionId, deviceId],
        )
      : await driver.get<{ id: string; execution_id: string; command_id: string }>(
          'SELECT id, execution_id, command_id FROM execution_results WHERE execution_id = ? AND device_id = ? LIMIT 1',
          [executionId, deviceId],
        );

    if (!resultRow) {
      return fail(c, ErrorCode.EXECUTION_NOT_FOUND, 'Execution result not found', 404);
    }

    const exitCode =
      typeof body.exit_code === 'number' && Number.isFinite(body.exit_code)
        ? Math.trunc(body.exit_code)
        : status === 'completed'
          ? 0
          : 1;

    const rawOutput = typeof body.output === 'string' ? body.output : '';
    const decodedLog = typeof body.log === 'string' ? decodeBase64Utf8(body.log) : null;
    const output = truncateUtf8Bytes(rawOutput || decodedLog || '', config.maxOutputBytes);
    const logContent =
      decodedLog !== null
        ? truncateUtf8Bytes(decodedLog, config.maxOutputBytes)
        : rawOutput
          ? output
          : null;
    const completedAt =
      typeof body.completed_at === 'string' && body.completed_at.trim()
        ? body.completed_at.trim().slice(0, 32)
        : nowIso;

    const updateRes = await driver.run(
      "UPDATE execution_results SET status = ?, exit_code = ?, output = ?, log_content = ?, completed_at = ?, updated_at = ? WHERE id = ? AND device_id = ? AND status IN ('queued', 'running')",
      [status, exitCode, output, logContent, completedAt, nowIso, resultRow.id, deviceId],
    );

    if (updateRes.changes > 0) {
      await reconcileExecutionAndCommand(
        driver,
        resultRow.execution_id,
        resultRow.command_id,
        nowIso,
      );
      await writeDeviceLog(
        driver,
        deviceId,
        'command_result',
        `Execution ${executionId} finished with ${status} (exit ${exitCode})`,
        {
          execution_id: executionId,
          command_id: resultRow.command_id,
          result_id: resultRow.id,
          exit_code: exitCode,
        },
        nowIso,
      );
    }

    return ok(c, {
      status: 'received' as const,
      logged: updateRes.changes > 0,
    });
  });

  return router;
}
