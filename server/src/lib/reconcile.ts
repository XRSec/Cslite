import type { CommandStatus, ExecutionStatus } from '../../../shared/types';
import type { SqlDriver } from '../db/driver';
import { generateId } from './crypto';

interface ExecutionResultStatusRow {
  status: ExecutionStatus;
}

interface CommandTypeRow {
  type: string;
  status: CommandStatus;
}

/**
 * Recomputes parent execution status and non-cron command status from child results.
 * Cron commands are NEVER marked 'completed'.
 */
export async function reconcileExecutionAndCommand(
  driver: SqlDriver,
  executionId: string,
  commandId: string,
  nowIso: string,
): Promise<void> {
  const results = await driver.all<ExecutionResultStatusRow>(
    'SELECT status FROM execution_results WHERE execution_id = ?',
    [executionId],
  );
  if (results.length === 0) return;

  const hasActive = results.some((r) => r.status === 'queued' || r.status === 'running');
  if (hasActive) return;

  const hasFailed = results.some((r) => r.status === 'failed');
  const hasTimeout = results.some((r) => r.status === 'timeout');
  const hasCompleted = results.some((r) => r.status === 'completed');
  const allCancelled = results.every((r) => r.status === 'cancelled');

  let execStatus: ExecutionStatus;
  if (allCancelled) {
    execStatus = 'cancelled';
  } else if (hasFailed) {
    execStatus = 'failed';
  } else if (hasTimeout) {
    execStatus = 'timeout';
  } else if (hasCompleted) {
    execStatus = 'completed';
  } else {
    execStatus = 'failed';
  }

  await driver.run(
    "UPDATE executions SET status = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'running')",
    [execStatus, nowIso, executionId],
  );

  const cmd = await driver.get<CommandTypeRow>(
    'SELECT type, status FROM commands WHERE id = ?',
    [commandId],
  );
  if (!cmd) return;

  if (cmd.type === 'cron') {
    if (cmd.status === 'running') {
      await driver.run(
        "UPDATE commands SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'running'",
        [nowIso, commandId],
      );
    }
    return;
  }

  if (cmd.status === 'paused' || cmd.status === 'cancelled') {
    return;
  }

  const nextCmdStatus: CommandStatus =
    execStatus === 'completed'
      ? 'completed'
      : execStatus === 'cancelled'
        ? 'cancelled'
        : 'failed';

  await driver.run(
    "UPDATE commands SET status = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')",
    [nextCmdStatus, nowIso, commandId],
  );
}

interface TimedOutRow {
  id: string;
  execution_id: string;
  command_id: string;
  device_id: string;
}

/**
 * Lazily transitions timed-out running execution results to 'timeout' and reconciles parents.
 */
export async function reapTimedOutExecutions(
  driver: SqlDriver,
  nowIso: string,
): Promise<number> {
  const overdue = await driver.all<TimedOutRow>(
    "SELECT id, execution_id, command_id, device_id FROM execution_results WHERE status = 'running' AND timeout_at IS NOT NULL AND timeout_at < ? LIMIT 50",
    [nowIso],
  );
  if (overdue.length === 0) return 0;

  let reaped = 0;
  const touchedExecutions = new Map<string, string>();
  for (const row of overdue) {
    const res = await driver.run(
      "UPDATE execution_results SET status = 'timeout', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
      [nowIso, nowIso, row.id],
    );
    if (res.changes === 1) {
      reaped += 1;
      touchedExecutions.set(row.execution_id, row.command_id);
      await writeDeviceLog(
        driver,
        row.device_id,
        'command_timeout',
        `Execution ${row.execution_id} timed out`,
        { execution_id: row.execution_id, command_id: row.command_id, result_id: row.id },
        nowIso,
      );
    }
  }

  for (const [executionId, commandId] of touchedExecutions) {
    await reconcileExecutionAndCommand(driver, executionId, commandId, nowIso);
  }

  return reaped;
}

export async function writeDeviceLog(
  driver: SqlDriver,
  deviceId: string,
  type: string,
  message: string,
  metadata: Record<string, unknown> | null = null,
  timestamp: string = new Date().toISOString(),
): Promise<void> {
  await driver.run(
    'INSERT INTO device_logs (id, device_id, type, timestamp, message, metadata_json) VALUES (?, ?, ?, ?, ?, ?)',
    [
      generateId('dlog'),
      deviceId,
      type,
      timestamp,
      message,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}

export async function writeAuditLog(
  driver: SqlDriver,
  entry: {
    userId: number;
    username: string;
    action: string;
    targetId?: string;
    ip?: string;
    detail?: string;
    timestamp?: string;
  },
): Promise<void> {
  await driver.run(
    'INSERT INTO audit_logs (id, user_id, username, action, target_id, ip, detail, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      generateId('alog'),
      entry.userId,
      entry.username,
      entry.action,
      entry.targetId ?? '',
      entry.ip ?? '',
      entry.detail ?? null,
      entry.timestamp ?? new Date().toISOString(),
    ],
  );
}
