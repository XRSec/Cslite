import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { buildConfig } from '../src/config';
import type { SqlDriver } from '../src/db/driver';
import { createNodeSqliteDriver } from '../src/db/node-sqlite';

interface Envelope<T = unknown> {
  code: number;
  message: string;
  data: T;
}

const drivers: SqlDriver[] = [];

async function setupEnv() {
  const driver = await createNodeSqliteDriver(':memory:');
  drivers.push(driver);
  const config = buildConfig(
    {
      CSLITE_ADMIN_USERNAME: 'admin',
      CSLITE_ADMIN_PASSWORD: 'admin',
      CSLITE_HEARTBEAT_INTERVAL: '60',
    },
    'node',
  );
  const app = createApp(driver, config);

  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const token = ((await loginRes.json()) as Envelope<{ session_token: string }>).data.session_token;

  const keyRes = await app.request('/api/auth/key', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'concurrency-key' }),
  });
  const apiKey = ((await keyRes.json()) as Envelope<{ api_key: string }>).data.api_key;

  return { app, driver, token, apiKey };
}

afterEach(async () => {
  while (drivers.length > 0) {
    await drivers.pop()!.close?.();
  }
});

describe('Cslite Concurrency, Cron & Lazy Timeout Reaper', () => {
  it('guarantees parallel GET /api/agent/commands claims a queued task at most once', async () => {
    const { app, token, apiKey } = await setupEnv();

    const regRes = await app.request('/api/agent/register', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'race-node', platform: 'linux', version: '4.0.0' }),
    });
    const { agent_id: agentId, device_id: deviceId } = (
      (await regRes.json()) as Envelope<{ agent_id: string; device_id: string }>
    ).data;

    await app.request('/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'once-job',
        type: 'immediate',
        content: 'echo hi',
        target_type: 'devices',
        target_ids: [deviceId],
      }),
    });

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.request(`/api/agent/commands?agent_id=${agentId}`, {
          headers: { 'X-API-Key': apiKey },
        }),
      ),
    );

    const payloads = await Promise.all(
      responses.map((r) => r.json() as Promise<Envelope<{ commands: Array<{ result_id: string }> }>>),
    );
    const totalClaimed = payloads.reduce((acc, p) => acc + p.data.commands.length, 0);
    expect(totalClaimed).toBe(1);
  });

  it('materializes due cron tick uniquely across parallel pollers, coalesces missed ticks, and never marks cron completed', async () => {
    const { app, driver, token, apiKey } = await setupEnv();

    const grpRes = await app.request('/api/groups', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cron-group' }),
    });
    const groupId = ((await grpRes.json()) as Envelope<{ id: string }>).data.id;

    const reg1 = (
      (await (
        await app.request('/api/agent/register', {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'cron-node-1', platform: 'linux', version: '4.0.0' }),
        })
      ).json()) as Envelope<{ agent_id: string; device_id: string }>
    ).data;

    const reg2 = (
      (await (
        await app.request('/api/agent/register', {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'cron-node-2', platform: 'linux', version: '4.0.0' }),
        })
      ).json()) as Envelope<{ agent_id: string; device_id: string }>
    ).data;

    await app.request(`/api/groups/${groupId}/devices`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [reg1.device_id, reg2.device_id] }),
    });

    const cronCmdRes = await app.request('/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'every-minute-cron',
        type: 'cron',
        schedule: '* * * * *',
        content: 'uptime',
        target_type: 'groups',
        target_ids: [groupId],
      }),
    });
    const cmdId = ((await cronCmdRes.json()) as Envelope<{ id: string }>).data.id;

    // Backdate next_run_at 10 minutes into the past to verify missed tick coalescing + due trigger
    const pastTick = new Date(Date.now() - 10 * 60_000).toISOString();
    await driver.run('UPDATE commands SET next_run_at = ? WHERE id = ?', [pastTick, cmdId]);

    const pollResults = await Promise.all([
      app.request(`/api/agent/commands?agent_id=${reg1.agent_id}`, { headers: { 'X-API-Key': apiKey } }),
      app.request(`/api/agent/commands?agent_id=${reg1.agent_id}`, { headers: { 'X-API-Key': apiKey } }),
      app.request(`/api/agent/commands?agent_id=${reg2.agent_id}`, { headers: { 'X-API-Key': apiKey } }),
      app.request(`/api/agent/commands?agent_id=${reg2.agent_id}`, { headers: { 'X-API-Key': apiKey } }),
    ]);

    for (const r of pollResults) {
      expect(r.status).toBe(200);
    }

    const parsedPolls = await Promise.all(
      pollResults.map(
        (r) =>
          r.json() as Promise<
            Envelope<{ commands: Array<{ result_id: string; execution_id: string }> }>
          >,
      ),
    );
    const claimedForNode1 = parsedPolls[0]!.data.commands.length + parsedPolls[1]!.data.commands.length;
    const claimedForNode2 = parsedPolls[2]!.data.commands.length + parsedPolls[3]!.data.commands.length;
    expect(claimedForNode1).toBe(1);
    expect(claimedForNode2).toBe(1);

    // Exactly ONE execution row created for the tick, and next_run_at coalesced strictly > now
    const execs = await driver.all<{ id: string; scheduled_for: string }>(
      'SELECT id, scheduled_for FROM executions WHERE command_id = ?',
      [cmdId],
    );
    expect(execs).toHaveLength(1);
    expect(execs[0]?.scheduled_for).toBe(pastTick);

    const updatedCmd = await driver.get<{ next_run_at: string; status: string }>(
      'SELECT next_run_at, status FROM commands WHERE id = ?',
      [cmdId],
    );
    expect(updatedCmd?.next_run_at && updatedCmd.next_run_at > new Date().toISOString()).toBe(true);

    // Report results for both devices and verify cron command NEVER becomes 'completed'
    const task1 = parsedPolls[0]!.data.commands[0] ?? parsedPolls[1]!.data.commands[0]!;
    const task2 = parsedPolls[2]!.data.commands[0] ?? parsedPolls[3]!.data.commands[0]!;

    await app.request('/api/agent/result', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        result_id: task1.result_id,
        execution_id: task1.execution_id,
        device_id: reg1.device_id,
        status: 'completed',
        exit_code: 0,
        output: 'ok1',
      }),
    });

    await app.request('/api/agent/result', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        result_id: task2.result_id,
        execution_id: task2.execution_id,
        device_id: reg2.device_id,
        status: 'completed',
        exit_code: 0,
        output: 'ok2',
      }),
    });

    const finalCmd = await driver.get<{ status: string }>(
      'SELECT status FROM commands WHERE id = ?',
      [cmdId],
    );
    expect(finalCmd?.status).toBe('pending');
    expect(finalCmd?.status).not.toBe('completed');
  });

  it('reaps timed-out running execution_results lazily and reconciles parent execution & command', async () => {
    const { app, driver, token, apiKey } = await setupEnv();

    const reg = (
      (await (
        await app.request('/api/agent/register', {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'timeout-node', platform: 'linux', version: '4.0.0' }),
        })
      ).json()) as Envelope<{ agent_id: string; device_id: string }>
    ).data;

    const cmdId = (
      (await (
        await app.request('/api/commands', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'slow-cmd',
            type: 'once',
            content: 'sleep 999',
            timeout: 10,
            target_type: 'devices',
            target_ids: [reg.device_id],
          }),
        })
      ).json()) as Envelope<{ id: string }>
    ).data.id;

    // Claim the task
    const poll = (
      (await (
        await app.request(`/api/agent/commands?agent_id=${reg.agent_id}`, {
          headers: { 'X-API-Key': apiKey },
        })
      ).json()) as Envelope<{ commands: Array<{ result_id: string; execution_id: string }> }>
    ).data;
    expect(poll.commands).toHaveLength(1);

    // Backdate timeout_at into the past
    const expiredAt = new Date(Date.now() - 5000).toISOString();
    await driver.run('UPDATE execution_results SET timeout_at = ? WHERE id = ?', [
      expiredAt,
      poll.commands[0]!.result_id,
    ]);

    // Trigger lazy reaper via next agent poll
    await app.request(`/api/agent/commands?agent_id=${reg.agent_id}`, {
      headers: { 'X-API-Key': apiKey },
    });

    const cmdDetail = (
      (await (
        await app.request(`/api/commands/${cmdId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json()) as Envelope<{
        status: string;
        execution_history: Array<{
          status: string;
          device_results?: Array<{ status: string }>;
        }>;
      }>
    ).data;

    expect(cmdDetail.status).toBe('failed');
    expect(cmdDetail.execution_history[0]?.status).toBe('timeout');
    expect(cmdDetail.execution_history[0]?.device_results?.[0]?.status).toBe('timeout');
  });

  it('throttles devices.last_seen (30s) and api_keys.last_used (5m) writes on frequent polls', async () => {
    const { app, driver, apiKey } = await setupEnv();

    const reg = (
      (await (
        await app.request('/api/agent/register', {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'throttle-node', platform: 'linux', version: '4.0.0' }),
        })
      ).json()) as Envelope<{ agent_id: string; device_id: string }>
    ).data;

    const fixedLastSeen = new Date(Date.now() - 5000).toISOString();
    const fixedLastUsed = new Date(Date.now() - 10_000).toISOString();
    await driver.run('UPDATE devices SET last_seen = ?, status = ? WHERE id = ?', [
      fixedLastSeen,
      'online',
      reg.device_id,
    ]);
    await driver.run('UPDATE api_keys SET last_used = ?', [fixedLastUsed]);

    const poll1 = await app.request(`/api/agent/commands?agent_id=${reg.agent_id}`, {
      headers: { 'X-API-Key': apiKey },
    });
    expect(poll1.status).toBe(200);

    const devAfter1 = await driver.get<{ last_seen: string }>(
      'SELECT last_seen FROM devices WHERE id = ?',
      [reg.device_id],
    );
    const keyAfter1 = await driver.get<{ last_used: string }>('SELECT last_used FROM api_keys');
    expect(devAfter1?.last_seen).toBe(fixedLastSeen);
    expect(keyAfter1?.last_used).toBe(fixedLastUsed);

    // Once thresholds pass (>30s for device, >5m for api_key), writes occur
    const staleLastSeen = new Date(Date.now() - 60_000).toISOString();
    const staleLastUsed = new Date(Date.now() - 6 * 60_000).toISOString();
    await driver.run('UPDATE devices SET last_seen = ? WHERE id = ?', [
      staleLastSeen,
      reg.device_id,
    ]);
    await driver.run('UPDATE api_keys SET last_used = ?', [staleLastUsed]);

    await app.request(`/api/agent/commands?agent_id=${reg.agent_id}`, {
      headers: { 'X-API-Key': apiKey },
    });

    const devAfter2 = await driver.get<{ last_seen: string }>(
      'SELECT last_seen FROM devices WHERE id = ?',
      [reg.device_id],
    );
    const keyAfter2 = await driver.get<{ last_used: string }>('SELECT last_used FROM api_keys');
    expect(devAfter2?.last_seen).not.toBe(staleLastSeen);
    expect(keyAfter2?.last_used).not.toBe(staleLastUsed);
  });

  it('defers future-scheduled once commands until due, materializes uniquely across parallel pollers, and completes normally', async () => {
    const { app, driver, token, apiKey } = await setupEnv();

    const reg = (
      (await (
        await app.request('/api/agent/register', {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'once-sched-node', platform: 'linux', version: '4.0.0' }),
        })
      ).json()) as Envelope<{ agent_id: string; device_id: string }>
    ).data;

    const futureIso = new Date(Date.now() + 60_000).toISOString();
    const createRes = await app.request('/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'future-once',
        type: 'once',
        schedule: futureIso,
        content: 'echo scheduled-once',
        target_type: 'devices',
        target_ids: [reg.device_id],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Envelope<{
      id: string;
      status: string;
      next_run: string | null;
      schedule?: string;
    }>;
    expect(created.data.status).toBe('pending');
    expect(created.data.next_run).toBe(futureIso);
    expect(created.data.schedule).toBe(futureIso);

    // Before due time: poll must NOT return anything and no execution exists yet
    const earlyPoll = (
      (await (
        await app.request(`/api/agent/commands?agent_id=${reg.agent_id}`, {
          headers: { 'X-API-Key': apiKey },
        })
      ).json()) as Envelope<{ commands: unknown[] }>
    ).data;
    expect(earlyPoll.commands).toHaveLength(0);
    const earlyExecs = await driver.all<{ id: string }>(
      'SELECT id FROM executions WHERE command_id = ?',
      [created.data.id],
    );
    expect(earlyExecs).toHaveLength(0);

    // Backdate next_run_at so the scheduled once command becomes due
    const dueIso = new Date(Date.now() - 1000).toISOString();
    await driver.run('UPDATE commands SET next_run_at = ? WHERE id = ?', [dueIso, created.data.id]);

    const parallelPolls = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.request(`/api/agent/commands?agent_id=${reg.agent_id}`, {
          headers: { 'X-API-Key': apiKey },
        }),
      ),
    );
    const pollPayloads = await Promise.all(
      parallelPolls.map(
        (r) =>
          r.json() as Promise<
            Envelope<{ commands: Array<{ result_id: string; execution_id: string }> }>
          >,
      ),
    );
    const claimedTasks = pollPayloads.flatMap((p) => p.data.commands);
    expect(claimedTasks).toHaveLength(1);

    const execs = await driver.all<{ id: string; scheduled_for: string | null }>(
      'SELECT id, scheduled_for FROM executions WHERE command_id = ?',
      [created.data.id],
    );
    expect(execs).toHaveLength(1);
    expect(execs[0]?.scheduled_for).toBe(dueIso);

    const cmdAfterClaim = await driver.get<{ status: string; next_run_at: string | null }>(
      'SELECT status, next_run_at FROM commands WHERE id = ?',
      [created.data.id],
    );
    expect(cmdAfterClaim?.status).toBe('running');
    expect(cmdAfterClaim?.next_run_at).toBeNull();

    // Report result and verify once command transitions to completed
    await app.request('/api/agent/result', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        result_id: claimedTasks[0]!.result_id,
        execution_id: claimedTasks[0]!.execution_id,
        device_id: reg.device_id,
        status: 'completed',
        exit_code: 0,
        output: 'done once',
      }),
    });

    const cmdFinal = await driver.get<{ status: string }>(
      'SELECT status FROM commands WHERE id = ?',
      [created.data.id],
    );
    expect(cmdFinal?.status).toBe('completed');
  });
});
