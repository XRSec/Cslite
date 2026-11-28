import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/src/app';
import { buildConfig } from '../../server/src/config';
import type { SqlDriver } from '../../server/src/db/driver';
import { createNodeSqliteDriver } from '../../server/src/db/node-sqlite';
import { CsliteClient } from '../src/client';
import { createMcpServer, MCP_TOOLS } from '../src/server';

const driversToClose: SqlDriver[] = [];

afterEach(async () => {
  while (driversToClose.length > 0) {
    const d = driversToClose.pop()!;
    await d.close?.();
  }
});

async function setupServerWithKeys() {
  const driver = await createNodeSqliteDriver(':memory:');
  driversToClose.push(driver);
  const config = buildConfig(
    {
      CSLITE_ADMIN_USERNAME: 'admin',
      CSLITE_ADMIN_PASSWORD: 'admin',
      CSLITE_HEARTBEAT_INTERVAL: '60',
      CSLITE_POLL_INTERVAL: '10',
    },
    'node',
  );
  const app = createApp(driver, config);

  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const setCookie = loginRes.headers.get('set-cookie') || '';
  const cookie = /cslite_session=([^;]+)/.exec(setCookie)?.[1] || '';

  // Create a device (which also creates a device-scoped key)
  const devRes = await app.request('/api/devices', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `cslite_session=${cookie}`,
    },
    body: JSON.stringify({ name: 'colab-gpu', platform: 'linux', arch: 'amd64' }),
  });
  const devBody = (await devRes.json()) as {
    data: { id: string; api_key: string };
  };
  const deviceId = devBody.data.id;
  const deviceApiKey = devBody.data.api_key;

  // Create an unbound management API key for MCP
  const keyRes = await app.request('/api/auth/key', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `cslite_session=${cookie}`,
    },
    body: JSON.stringify({ name: 'mcp-controller' }),
  });
  const keyBody = (await keyRes.json()) as { data: { api_key: string } };
  const mgmtApiKey = keyBody.data.api_key;

  // Agent register + heartbeat to mark device online
  const regRes = await app.request('/api/agent/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: deviceApiKey,
      device_id: deviceId,
      name: 'colab-gpu',
      platform: 'linux',
      arch: 'amd64',
      version: 'v1.2.1',
      hostname: 'colab-runtime',
      os_version: 'Ubuntu 22.04',
    }),
  });
  const regBody = (await regRes.json()) as { data: { agent_id: string } };
  const agentId = regBody.data.agent_id;

  await app.request('/api/agent/heartbeat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': deviceApiKey,
    },
    body: JSON.stringify({
      agent_id: agentId,
      metrics: {
        cpu_usage: 12.5,
        memory_used: 2048,
        memory_total: 12288,
        memory_percent: 16.7,
        disk_usage: 25.0,
        network_in: 100,
        network_out: 50,
      },
    }),
  });

  const appFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const pathAndQuery = url.replace(/^https?:\/\/[^/]+/, '');
    return app.request(pathAndQuery, init as RequestInit);
  };

  return { app, deviceId, agentId, deviceApiKey, mgmtApiKey, appFetch };
}

describe('cslite-mcp', () => {
  it('handles MCP JSON-RPC initialize, ping, tools/list, and unknown methods', async () => {
    const client = new CsliteClient({
      baseUrl: 'https://cslite.test',
      apiKey: 'ak_dummy',
      fetchFn: async () => new Response('{}', { status: 200 }),
    });
    const mcp = createMcpServer(client);

    const init = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(init?.result).toMatchObject({
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'cslite-mcp' },
    });

    const notif = await mcp.handleRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notif).toBeNull();

    const ping = await mcp.handleRequest({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(ping?.result).toEqual({});

    const list = await mcp.handleRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect((list?.result as { tools: typeof MCP_TOOLS }).tools).toHaveLength(MCP_TOOLS.length);

    const unknown = await mcp.handleRequest({ jsonrpc: '2.0', id: 4, method: 'unknown/method' });
    expect(unknown?.error?.code).toBe(-32601);
  });

  it('rejects device-scoped API keys and executes full本机->cslite->colab command flow with unbound key', async () => {
    const { app, deviceId, agentId, deviceApiKey, mgmtApiKey, appFetch } = await setupServerWithKeys();

    // Device-scoped API key must be blocked from management endpoints
    const scopedClient = new CsliteClient({
      baseUrl: 'https://cslite.test',
      apiKey: deviceApiKey,
      fetchFn: appFetch,
    });
    const scopedMcp = createMcpServer(scopedClient);
    const denied = await scopedMcp.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'cslite_list_devices', arguments: {} },
    });
    expect((denied?.result as { isError: boolean }).isError).toBe(true);

    // Unbound management API key succeeds end-to-end
    const mgmtClient = new CsliteClient({
      baseUrl: 'https://cslite.test',
      apiKey: mgmtApiKey,
      fetchFn: appFetch,
    });
    const mcp = createMcpServer(mgmtClient);

    const listRes = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'cslite_list_devices', arguments: { status: 'online' } },
    });
    const listPayload = JSON.parse(
      (listRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { devices: Array<{ id: string; name: string }> };
    expect(listPayload.devices.some((d) => d.id === deviceId && d.name === 'colab-gpu')).toBe(true);

    const devRes = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'cslite_get_device', arguments: { device_id: deviceId } },
    });
    const devPayload = JSON.parse(
      (devRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { id: string; metrics: { cpu_usage: number } };
    expect(devPayload.id).toBe(deviceId);
    expect(devPayload.metrics.cpu_usage).toBe(12.5);

    // Dispatch async command (wait: false), have Colab agent poll & report, then inspect via cslite_get_command
    const runRes = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'cslite_run_command',
        arguments: {
          target_ids: [deviceId],
          content: 'nvidia-smi --query-gpu=name --format=csv,noheader',
          wait: false,
        },
      },
    });
    const runPayload = JSON.parse(
      (runRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { command_id: string; waited: boolean };
    expect(runPayload.waited).toBe(false);
    expect(runPayload.command_id).toMatch(/^cmd_/);

    // Simulate Colab agent polling and returning output
    const pollRes = await app.request(`/api/agent/commands?agent_id=${encodeURIComponent(agentId)}`, {
      headers: { 'X-API-Key': deviceApiKey },
    });
    const pollBody = (await pollRes.json()) as {
      data: { commands: Array<{ command_id: string; execution_id: string }> };
    };
    expect(pollBody.data.commands).toHaveLength(1);
    const execId = pollBody.data.commands[0]!.execution_id;

    await app.request('/api/agent/result', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': deviceApiKey,
      },
      body: JSON.stringify({
        execution_id: execId,
        agent_id: agentId,
        device_id: deviceId,
        status: 'completed',
        exit_code: 0,
        output: 'Tesla T4\n',
      }),
    });

    const getCmdRes = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'cslite_get_command', arguments: { command_id: runPayload.command_id } },
    });
    const cmdPayload = JSON.parse(
      (getCmdRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { status: string; execution_history: Array<{ device_results: Array<{ output: string; exit_code: number }> }> };
    expect(cmdPayload.status).toBe('completed');
    expect(cmdPayload.execution_history[0]?.device_results[0]?.output).toBe('Tesla T4\n');
    expect(cmdPayload.execution_history[0]?.device_results[0]?.exit_code).toBe(0);

    // Also test cslite_list_logs
    const logsRes = await mcp.handleRequest({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'cslite_list_logs', arguments: { type: 'device', device_id: deviceId, per_page: 5 } },
    });
    expect((logsRes?.result as { isError: boolean }).isError).toBe(false);
  });
});
