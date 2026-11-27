import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { buildConfig } from '../src/config';
import type { SqlDriver } from '../src/db/driver';
import { buildMysqlDsnFromEnv, normalizeMysqlDsn, resolveMysqlDsn } from '../src/db/mysql';
import { createNodeSqliteDriver } from '../src/db/node-sqlite';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');

interface Envelope<T = unknown> {
  code: number;
  message: string;
  data: T;
}

const driversToClose: SqlDriver[] = [];

async function setupTestApp(overrides: Record<string, string | undefined> = {}) {
  const driver = await createNodeSqliteDriver(':memory:');
  driversToClose.push(driver);
  const config = buildConfig(
    {
      CSLITE_ADMIN_USERNAME: 'admin',
      CSLITE_ADMIN_PASSWORD: 'admin',
      CSLITE_HEARTBEAT_INTERVAL: '60',
      CSLITE_POLL_INTERVAL: '10',
      ...overrides,
    },
    'node',
  );
  const app = createApp(driver, config);
  return { app, driver, config };
}

async function reqJson<T = unknown>(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
): Promise<{ res: Response; body: Envelope<T> }> {
  const res = await app.request(path, init);
  const body = (await res.json()) as Envelope<T>;
  return { res, body };
}

function extractCookieValue(setCookie: string | null, name = 'cslite_session'): string {
  if (!setCookie) return '';
  const match = new RegExp(`${name}=([^;]+)`).exec(setCookie);
  return match?.[1] ?? '';
}

afterEach(async () => {
  while (driversToClose.length > 0) {
    const d = driversToClose.pop()!;
    await d.close?.();
  }
});

describe('Cslite Unified API', () => {
  it('keeps GET /health zero-DB and serves UI HTML at GET /', async () => {
    const { app, driver } = await setupTestApp();

    const healthRes = await app.request('/health');
    expect(healthRes.status).toBe(200);
    const health = (await healthRes.json()) as Envelope<{ status: string; runtime: string }>;
    expect(health.code).toBe(20000);
    expect(health.data.status).toBe('ok');

    // Verify ensureMigrated was NOT triggered by /health
    const tables = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    );
    expect(tables).toHaveLength(0);

    const uiRes = await app.request('/');
    expect(uiRes.status).toBe(200);
    expect(uiRes.headers.get('content-type')).toContain('text/html');
    const html = await uiRes.text();
    expect(html).toContain('Cslite');

    // Now /api/system/info triggers migration & admin seed
    const sys = await reqJson<{ db_dialect: string; runtime: string; allow_registration: boolean }>(
      app,
      '/api/system/info',
    );
    expect(sys.res.status).toBe(200);
    expect(sys.body.data.db_dialect).toBe('sqlite');
    expect(sys.body.data.allow_registration).toBe(true);
  });

  it('enforces PBKDF2 100k, consistent cookie Secure flags on login/logout, CSRF guard, password change, and API keys', async () => {
    const { app, driver } = await setupTestApp();

    // Bad credentials -> 401
    const badLogin = await reqJson(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    });
    expect(badLogin.res.status).toBe(401);
    expect(badLogin.body.code).toBe(40001);

    // HTTPS login via x-forwarded-proto sets Secure cookie
    const httpsLogin = await reqJson<{ user: { id: number; username: string; role: number }; session_token: string }>(
      app,
      'http://cslite.test/api/auth/login',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      },
    );
    expect(httpsLogin.res.status).toBe(200);
    const loginSetCookie = httpsLogin.res.headers.get('set-cookie') || '';
    expect(loginSetCookie).toContain('cslite_session=');
    expect(loginSetCookie).toContain('HttpOnly');
    expect(loginSetCookie).toContain('SameSite=Lax');
    expect(loginSetCookie).toContain('Path=/');
    expect(loginSetCookie).toContain('Secure');

    const adminRow = await driver.get<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE username = 'admin'",
    );
    expect(adminRow?.password_hash.startsWith('pbkdf2$100000$')).toBe(true);

    const token = extractCookieValue(loginSetCookie);
    expect(token).toBe(httpsLogin.body.data.session_token);

    // Logout over HTTPS also includes identical Secure flag
    const httpsLogout = await reqJson(app, 'http://cslite.test/api/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `cslite_session=${token}`,
        Origin: 'http://cslite.test',
        'x-forwarded-proto': 'https',
      },
    });
    expect(httpsLogout.res.status).toBe(200);
    const logoutSetCookie = httpsLogout.res.headers.get('set-cookie') || '';
    expect(logoutSetCookie).toContain('cslite_session=;');
    expect(logoutSetCookie).toContain('HttpOnly');
    expect(logoutSetCookie).toContain('SameSite=Lax');
    expect(logoutSetCookie).toContain('Path=/');
    expect(logoutSetCookie).toContain('Secure');

    // Old session revoked after logout
    const afterLogoutMe = await reqJson(app, '/api/auth/me', {
      headers: { Cookie: `cslite_session=${token}` },
    });
    expect(afterLogoutMe.res.status).toBe(401);

    // HTTP login does NOT set Secure; HTTP logout matches
    const httpLogin = await reqJson<{ session_token: string }>(
      app,
      'http://cslite.test/api/auth/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      },
    );
    const httpCookie = httpLogin.res.headers.get('set-cookie') || '';
    expect(httpCookie).not.toContain('Secure');
    const httpToken = extractCookieValue(httpCookie);

    // CSRF guard checks for cookie-authenticated mutations
    const csrfCrossOrigin = await reqJson(app, 'http://cslite.test/api/devices', {
      method: 'POST',
      headers: {
        Cookie: `cslite_session=${httpToken}`,
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'x', platform: 'linux' }),
    });
    expect(csrfCrossOrigin.res.status).toBe(403);

    const csrfNoJsonNoOrigin = await reqJson(app, 'http://cslite.test/api/devices', {
      method: 'POST',
      headers: {
        Cookie: `cslite_session=${httpToken}`,
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({ name: 'x', platform: 'linux' }),
    });
    expect(csrfNoJsonNoOrigin.res.status).toBe(403);

    // Bearer skips CSRF guard
    const bearerMe = await reqJson<{ username: string }>(app, '/api/auth/me', {
      headers: { Authorization: `Bearer ${httpToken}` },
    });
    expect(bearerMe.res.status).toBe(200);
    expect(bearerMe.body.data.username).toBe('admin');

    // Password change invalidates wrong old password, accepts valid change
    const badPwd = await reqJson(app, '/api/auth/password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${httpToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ old_password: 'nope', new_password: 'NewPass123!' }),
    });
    expect(badPwd.res.status).toBe(401);

    const okPwd = await reqJson(app, '/api/auth/password', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${httpToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ old_password: 'admin', new_password: 'NewPass123!' }),
    });
    expect(okPwd.res.status).toBe(200);

    const oldPwdLogin = await reqJson(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    expect(oldPwdLogin.res.status).toBe(401);

    const newPwdLogin = await reqJson<{ session_token: string }>(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'NewPass123!' }),
    });
    expect(newPwdLogin.res.status).toBe(200);
    const freshToken = newPwdLogin.body.data.session_token;

    // API Key create, list, use, revoke
    const keyRes = await reqJson<{ id: string; api_key: string; key_prefix: string }>(
      app,
      '/api/auth/key',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${freshToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'ci-key' }),
      },
    );
    expect(keyRes.res.status).toBe(201);
    expect(keyRes.body.data.api_key.startsWith('ak_live_')).toBe(true);

    const listKeys = await reqJson<{ total: number; keys: Array<{ id: string; api_key?: string; key_prefix: string }> }>(
      app,
      '/api/auth/key',
      { headers: { Authorization: `Bearer ${freshToken}` } },
    );
    expect(listKeys.body.data.total).toBe(1);
    expect(listKeys.body.data.keys[0]?.api_key).toBeUndefined();
    expect(listKeys.body.data.keys[0]?.key_prefix.startsWith('ak_live_')).toBe(true);

    // X-API-Key works for API access and skips CSRF
    const apiKeyMe = await reqJson<{ username: string }>(app, '/api/auth/me', {
      headers: { 'X-API-Key': keyRes.body.data.api_key },
    });
    expect(apiKeyMe.res.status).toBe(200);

    // Revoke API key
    const delKey = await reqJson(app, `/api/auth/key/${keyRes.body.data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${freshToken}` },
    });
    expect(delKey.res.status).toBe(200);

    const revokedUse = await reqJson(app, '/api/auth/me', {
      headers: { 'X-API-Key': keyRes.body.data.api_key },
    });
    expect(revokedUse.res.status).toBe(401);

    // HTTP logout has NO Secure flag
    const httpLogout = await reqJson(app, 'http://cslite.test/api/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `cslite_session=${httpToken}`,
        'Content-Type': 'application/json',
      },
    });
    expect(httpLogout.res.status).toBe(200);
    expect(httpLogout.res.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('enforces RBAC & IDOR protection across users, devices, groups, commands, and logs', async () => {
    const { app } = await setupTestApp();

    const adminLogin = await reqJson<{ session_token: string }>(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const adminToken = adminLogin.body.data.session_token;

    // Self-delete blocked (409), missing user (404)
    const selfDel = await reqJson(app, '/api/auth/user/1', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(selfDel.res.status).toBe(409);

    const missingDel = await reqJson(app, '/api/auth/user/9999', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(missingDel.res.status).toBe(404);

    // Create User A and User B
    const userARes = await reqJson<{ id: number }>(app, '/api/auth/user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'Password123', role: 0 }),
    });
    expect(userARes.res.status).toBe(201);

    const dupUser = await reqJson(app, '/api/auth/user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'Password123', role: 0 }),
    });
    expect(dupUser.res.status).toBe(409);
    expect(dupUser.body.code).toBe(40009);

    const userBRes = await reqJson<{ id: number }>(app, '/api/auth/user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'Password123', role: 0 }),
    });
    expect(userBRes.res.status).toBe(201);

    const aliceToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'Password123' }),
      })
    ).body.data.session_token;

    const bobToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'bob', password: 'Password123' }),
      })
    ).body.data.session_token;

    // Non-admin cannot access user admin endpoints or audit logs
    expect((await reqJson(app, '/api/auth/user', { headers: { Authorization: `Bearer ${aliceToken}` } })).res.status).toBe(403);
    expect((await reqJson(app, '/api/logs/user', { headers: { Authorization: `Bearer ${aliceToken}` } })).res.status).toBe(403);

    // Alice creates group, device, and command
    const aliceGroup = (
      await reqJson<{ id: string }>(app, '/api/groups', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice-grp', description: 'prod' }),
      })
    ).body.data;

    const aliceDev = (
      await reqJson<{ id: string }>(app, '/api/devices', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice-box', platform: 'linux', group_id: aliceGroup.id }),
      })
    ).body.data;

    const aliceCmd = (
      await reqJson<{ id: string }>(app, '/api/commands', {
        method: 'POST',
        headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'whoami',
          type: 'immediate',
          content: 'id',
          target_type: 'devices',
          target_ids: [aliceDev.id],
        }),
      })
    ).body.data;

    const aliceDetail = await reqJson<{
      execution_history: Array<{ device_results?: Array<{ result_id?: string }> }>;
    }>(app, `/api/commands/${aliceCmd.id}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const aliceResultId = aliceDetail.body.data.execution_history[0]!.device_results![0]!.result_id!;

    // Bob cannot read/modify/delete Alice's resources
    expect((await reqJson(app, `/api/devices/${aliceDev.id}`, { headers: { Authorization: `Bearer ${bobToken}` } })).res.status).toBe(403);
    expect((await reqJson(app, `/api/devices/status?id=${aliceDev.id}`, { headers: { Authorization: `Bearer ${bobToken}` } })).res.status).toBe(403);
    expect((await reqJson(app, `/api/devices/${aliceDev.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pwn' }),
    })).res.status).toBe(403);
    expect((await reqJson(app, `/api/devices/${aliceDev.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bobToken}` },
    })).res.status).toBe(403);
    expect((await reqJson(app, '/api/devices/batch-delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [aliceDev.id] }),
    })).res.status).toBe(403);

    expect((await reqJson(app, `/api/groups/${aliceGroup.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'hijack' }),
    })).res.status).toBe(403);
    expect((await reqJson(app, `/api/groups/${aliceGroup.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bobToken}` },
    })).res.status).toBe(403);

    expect((await reqJson(app, '/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'evil',
        type: 'immediate',
        content: 'rm -rf /',
        target_type: 'devices',
        target_ids: [aliceDev.id],
      }),
    })).res.status).toBe(403);
    expect((await reqJson(app, `/api/commands/${aliceCmd.id}`, { headers: { Authorization: `Bearer ${bobToken}` } })).res.status).toBe(403);
    expect((await reqJson(app, `/api/commands/${aliceCmd.id}/results`, { headers: { Authorization: `Bearer ${bobToken}` } })).res.status).toBe(403);
    expect((await reqJson(app, `/api/commands/${aliceCmd.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    })).res.status).toBe(403);

    const bobDownload = await app.request(`/api/logs/download/${aliceResultId}`, {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    expect(bobDownload.status).toBe(403);

    // Bob's device/command/log lists do NOT leak Alice's items
    const bobDevs = await reqJson<{ total: number }>(app, '/api/devices', {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    expect(bobDevs.body.data.total).toBe(0);

    const bobLogs = await reqJson<{ total: number }>(app, '/api/logs/command', {
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    expect(bobLogs.body.data.total).toBe(0);

    // Admin can delete User B
    const delBob = await reqJson(app, `/api/auth/user/${userBRes.body.data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delBob.res.status).toBe(200);
  });

  it('supports pre-created devices, dynamic online/offline filtering, groups, OpenWrt raw JSON agent protocol, UTF-8 byte truncation, and log download', async () => {
    const { app, driver } = await setupTestApp();

    const adminToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      })
    ).body.data.session_token;

    const apiKey = (
      await reqJson<{ api_key: string }>(app, '/api/auth/key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'agent-key' }),
      })
    ).body.data.api_key;

    // Pre-create OpenWrt device
    const preDev = await reqJson<{
      id: string;
      install_command: string;
      install_commands: Record<string, string>;
      expires_at: string;
    }>(app, '/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'openwrt-router', platform: 'openwrt' }),
    });
    expect(preDev.res.status).toBe(201);
    expect(Object.keys(preDev.body.data.install_commands).sort()).toEqual([
      'android',
      'unix',
      'windows',
    ]);
    expect(preDev.body.data.install_command).toBe(preDev.body.data.install_commands.unix);
    expect(preDev.body.data.install_commands.unix).toBe(
      `curl -fsSL http://localhost/i | sh -s -- YOUR_API_KEY ${preDev.body.data.id}`,
    );
    expect(preDev.body.data.install_commands.windows).toBe(
      `$k="YOUR_API_KEY";$d="${preDev.body.data.id}";irm http://localhost/i.ps1|iex`,
    );
    expect(preDev.body.data.install_commands.android).toBe(
      `curl -fsSL http://localhost/ia | sh -s -- YOUR_API_KEY ${preDev.body.data.id}`,
    );
    for (const cmd of Object.values(preDev.body.data.install_commands)) {
      expect(cmd).not.toContain('(');
      expect(cmd).not.toContain(')');
    }
    expect(preDev.body.data.expires_at).toBeTruthy();

    // Initially offline
    const preStatus = await reqJson<{ status: string }>(
      app,
      `/api/devices/status?id=${preDev.body.data.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(preStatus.body.data.status).toBe('offline');

    // Register binding pre-created device_id with NO Content-Type header and body api_key fallback
    const reg = await reqJson<{
      agent_id: string;
      device_id: string;
      heartbeat_interval: number;
      poll_interval: number;
    }>(app, '/api/agent/register', {
      method: 'POST',
      body: JSON.stringify({
        api_key: apiKey,
        device_id: preDev.body.data.id,
        name: 'openwrt-router',
        platform: 'openwrt',
        arch: 'mipsle',
        os_version: 'OpenWrt 23.05',
        hostname: 'router.lan',
        version: '4.0.0',
      }),
    });
    expect(reg.res.status).toBe(200);
    expect(reg.body.data.device_id).toBe(preDev.body.data.id);

    // Heartbeat with metrics (no Content-Type header, X-API-Key header)
    const hb = await reqJson<{ status: string }>(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'x-forwarded-for': '203.0.113.10' },
      body: JSON.stringify({
        agent_id: reg.body.data.agent_id,
        metrics: {
          cpu_usage: 12.5,
          memory_used: 64,
          memory_total: 128,
          disk_usage: 30,
          network_in: 100,
          network_out: 50,
        },
      }),
    });
    expect(hb.res.status).toBe(200);

    const detail = await reqJson<{
      status: string;
      ip_address: string;
      arch: string;
      os_version: string;
      hostname: string;
      agent_version: string;
      metrics: { cpu_usage: number };
    }>(app, `/api/devices/${preDev.body.data.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(detail.body.data.status).toBe('online');
    expect(detail.body.data.ip_address).toBe('203.0.113.10');
    expect(detail.body.data.arch).toBe('mipsle');
    expect(detail.body.data.metrics.cpu_usage).toBe(12.5);

    // Group CRUD + device assignment + unbind on delete
    const grp = await reqJson<{ id: string }>(app, '/api/groups', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'edge-routers', description: 'OpenWrt fleet' }),
    });
    expect(grp.res.status).toBe(201);

    await reqJson(app, `/api/groups/${grp.body.data.id}/devices`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [preDev.body.data.id] }),
    });

    const grpList = await reqJson<{ groups: Array<{ id: string; device_count: number }> }>(
      app,
      '/api/groups',
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(grpList.body.data.groups[0]?.device_count).toBe(1);

    // Filter devices by group, platform, status=online, search
    const filteredOnline = await reqJson<{ total: number }>(
      app,
      `/api/devices?status=online&group=${grp.body.data.id}&platform=openwrt&search=router`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(filteredOnline.body.data.total).toBe(1);

    // Invalid cron -> 400 / 60002
    const badCron = await reqJson(app, '/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'bad-cron',
        type: 'cron',
        schedule: '0 0 31 2 *',
        content: 'echo nope',
        target_type: 'groups',
        target_ids: [grp.body.data.id],
      }),
    });
    expect(badCron.res.status).toBe(400);
    expect(badCron.body.code).toBe(60002);

    // Dispatch immediate command to group
    const cmd = await reqJson<{ id: string }>(app, '/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'check-uname',
        type: 'immediate',
        content: 'uname -a',
        target_type: 'groups',
        target_ids: [grp.body.data.id],
      }),
    });
    expect(cmd.res.status).toBe(201);

    // Agent polls via POST /api/agent/commands with body api_key
    const polled = await reqJson<{ commands: Array<{ result_id: string; execution_id: string }> }>(
      app,
      '/api/agent/commands',
      {
        method: 'POST',
        body: JSON.stringify({ api_key: apiKey, agent_id: reg.body.data.agent_id }),
      },
    );
    expect(polled.res.status).toBe(200);
    expect(polled.body.data.commands).toHaveLength(1);
    const task = polled.body.data.commands[0]!;

    // Submit result > 256 KB UTF-8 multibyte text to test byte truncation without broken chars
    const bigMultiByte = '中'.repeat(100_000); // 300,000 bytes > 262,144 bytes
    const resSubmit = await reqJson<{ status: string; logged: boolean }>(app, '/api/agent/result', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        result_id: task.result_id,
        execution_id: task.execution_id,
        device_id: preDev.body.data.id,
        status: 'completed',
        exit_code: 0,
        output: bigMultiByte,
      }),
    });
    expect(resSubmit.res.status).toBe(200);
    expect(resSubmit.body.data.logged).toBe(true);

    // Duplicate idempotent retry returns logged=false without overwriting
    const dupSubmit = await reqJson<{ status: string; logged: boolean }>(app, '/api/agent/result', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        result_id: task.result_id,
        execution_id: task.execution_id,
        device_id: preDev.body.data.id,
        status: 'failed',
        exit_code: 99,
        output: 'should not overwrite',
      }),
    });
    expect(dupSubmit.res.status).toBe(200);
    expect(dupSubmit.body.data.logged).toBe(false);

    // Verify UTF-8 truncation <= 256 KB and no replacement character
    const dlRes = await app.request(`/api/logs/download/${task.result_id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get('content-disposition')).toContain(`cslite-${task.result_id}.log`);
    const dlText = await dlRes.text();
    expect(new TextEncoder().encode(dlText).byteLength).toBeLessThanOrEqual(256 * 1024);
    expect(dlText).not.toContain('\uFFFD');

    // Payload > 1 MB rejected with 413
    const hugeRes = await reqJson(app, '/api/agent/result', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: 'x'.repeat(1024 * 1024 + 64),
    });
    expect(hugeRes.res.status).toBe(413);

    // Unknown agent heartbeat -> 404 (40010)
    const missingAgentHb = await reqJson(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({ agent_id: 'agent_missing' }),
    });
    expect(missingAgentHb.res.status).toBe(404);
    expect(missingAgentHb.body.code).toBe(40010);

    // Simulate stale last_seen -> dynamic offline computation
    const staleIso = new Date(Date.now() - 200_000).toISOString();
    await driver.run('UPDATE devices SET last_seen = ? WHERE id = ?', [
      staleIso,
      preDev.body.data.id,
    ]);
    const listOffline = await reqJson<{ total: number; devices: Array<{ status: string }> }>(
      app,
      '/api/devices?status=offline',
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(listOffline.body.data.total).toBe(1);
    expect(listOffline.body.data.devices[0]?.status).toBe('offline');

    // Delete group unbinds device_id cleanly
    await reqJson(app, `/api/groups/${grp.body.data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const afterGrpDel = await reqJson<{ group_id: string | null }>(
      app,
      `/api/devices/${preDev.body.data.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(afterGrpDel.body.data.group_id).toBeNull();
  });

  it('covers command pause/resume/cancel, log queries, base64 result log, device/group delete, and registration lock', async () => {
    const { app } = await setupTestApp({ CSLITE_ALLOW_REGISTRATION: 'false' });

    const adminToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      })
    ).body.data.session_token;

    const apiKey = (
      await reqJson<{ api_key: string }>(app, '/api/auth/key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'locked-key' }),
      })
    ).body.data.api_key;

    // Registration disabled returns 403 / 40013
    const regBlocked = await reqJson(app, '/api/agent/register', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({ name: 'x', platform: 'linux', version: '4.0.0' }),
    });
    expect(regBlocked.res.status).toBe(403);
    expect(regBlocked.body.code).toBe(40013);

    // Pre-created device + command pause/resume/cancel + logs on registration-enabled app
    const env2 = await setupTestApp();
    const t2 = (
      await reqJson<{ session_token: string }>(env2.app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      })
    ).body.data.session_token;

    const k2 = (
      await reqJson<{ api_key: string }>(env2.app, '/api/auth/key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'k2' }),
      })
    ).body.data.api_key;

    const reg = (
      await reqJson<{ agent_id: string; device_id: string }>(env2.app, '/api/agent/register', {
        method: 'POST',
        headers: { 'X-API-Key': k2 },
        body: JSON.stringify({ name: 'mac-mini', platform: 'macos', version: '4.0.0' }),
      })
    ).body.data;

    const grp = (
      await reqJson<{ id: string }>(env2.app, '/api/groups', {
        method: 'POST',
        headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'macs', description: 'M-series' }),
      })
    ).body.data;

    await reqJson(env2.app, `/api/groups/${grp.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'apple-fleet', description: 'updated' }),
    });
    await reqJson(env2.app, `/api/groups/${grp.id}/devices`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [reg.device_id] }),
    });

    // Cron pause -> resume -> cancel lifecycle
    const cronCmd = (
      await reqJson<{ id: string }>(env2.app, '/api/commands', {
        method: 'POST',
        headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'cron-lifecycle',
          type: 'cron',
          schedule: '*/15 2-4 1,15 jan-mar mon-fri',
          content: 'date',
          target_type: 'groups',
          target_ids: [grp.id],
        }),
      })
    ).body.data;

    expect((await reqJson(env2.app, `/api/commands/${cronCmd.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    })).res.status).toBe(200);

    expect((await reqJson(env2.app, `/api/commands/${cronCmd.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    })).res.status).toBe(200);

    expect((await reqJson(env2.app, `/api/commands/${cronCmd.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    })).res.status).toBe(200);

    // Pausing cancelled command -> 409 conflict
    expect((await reqJson(env2.app, `/api/commands/${cronCmd.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    })).res.status).toBe(409);

    // Immediate command + base64 log result
    const immCmd = (
      await reqJson<{ id: string }>(env2.app, '/api/commands', {
        method: 'POST',
        headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'base64-cmd',
          type: 'immediate',
          content: 'echo b64',
          target_type: 'devices',
          target_ids: [reg.device_id],
        }),
      })
    ).body.data;

    const polled = (
      await reqJson<{ commands: Array<{ result_id: string; execution_id: string }> }>(
        env2.app,
        `/api/agent/commands?agent_id=${reg.agent_id}`,
        { headers: { 'X-API-Key': k2 } },
      )
    ).body.data.commands[0]!;

    const encodedLog = Buffer.from('hello from base64 log\nline 2', 'utf8').toString('base64');
    await reqJson(env2.app, '/api/agent/result', {
      method: 'POST',
      headers: { 'X-API-Key': k2 },
      body: JSON.stringify({
        result_id: polled.result_id,
        execution_id: polled.execution_id,
        device_id: reg.device_id,
        status: 'completed',
        exit_code: 0,
        log: encodedLog,
      }),
    });

    const cmdFilter = await reqJson<{ total: number }>(
      env2.app,
      `/api/commands?device=${reg.device_id}&type=immediate&status=completed`,
      { headers: { Authorization: `Bearer ${t2}` } },
    );
    expect(cmdFilter.body.data.total).toBe(1);

    // Query parameter aliases: group_id on GET /api/devices and device_id on GET /api/commands
    const devByGroupAlias = await reqJson<{ total: number; devices: Array<{ id: string }> }>(
      env2.app,
      `/api/devices?group_id=${grp.id}`,
      { headers: { Authorization: `Bearer ${t2}` } },
    );
    expect(devByGroupAlias.body.data.total).toBe(1);
    expect(devByGroupAlias.body.data.devices[0]?.id).toBe(reg.device_id);

    const cmdByDeviceAlias = await reqJson<{ total: number }>(
      env2.app,
      `/api/commands?device_id=${reg.device_id}&type=immediate&status=completed`,
      { headers: { Authorization: `Bearer ${t2}` } },
    );
    expect(cmdByDeviceAlias.body.data.total).toBe(1);

    // Invalid ISO schedule on once command -> 400 / 40004
    const badOnceSched = await reqJson(env2.app, '/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'bad-once-sched',
        type: 'once',
        schedule: 'not-a-timestamp',
        content: 'echo hi',
        target_type: 'devices',
        target_ids: [reg.device_id],
      }),
    });
    expect(badOnceSched.res.status).toBe(400);
    expect(badOnceSched.body.code).toBe(40004);

    const cmdResults = await reqJson<{ executions: Array<{ status: string }> }>(
      env2.app,
      `/api/commands/${immCmd.id}/results`,
      { headers: { Authorization: `Bearer ${t2}` } },
    );
    expect(cmdResults.body.data.executions[0]?.status).toBe('completed');

    const cmdLogs = await reqJson<{ total: number; logs: Array<{ output_preview: string }> }>(
      env2.app,
      `/api/logs/command?device_id=${reg.device_id}`,
      { headers: { Authorization: `Bearer ${t2}` } },
    );
    expect(cmdLogs.body.data.total).toBe(1);
    expect(cmdLogs.body.data.logs[0]?.output_preview).toContain('hello from base64 log');

    const devLogs = await reqJson<{ total: number }>(
      env2.app,
      `/api/logs/device?device_id=${reg.device_id}`,
      { headers: { Authorization: `Bearer ${t2}` } },
    );
    expect(devLogs.body.data.total).toBeGreaterThanOrEqual(2);

    const auditLogs = await reqJson<{ total: number }>(env2.app, '/api/logs/user', {
      headers: { Authorization: `Bearer ${t2}` },
    });
    expect(auditLogs.body.data.total).toBeGreaterThan(0);

    const userList = await reqJson<{ total: number }>(env2.app, '/api/auth/user?search=admin', {
      headers: { Authorization: `Bearer ${t2}` },
    });
    expect(userList.body.data.total).toBe(1);

    // Unbind device from group and delete device
    await reqJson(env2.app, `/api/groups/${grp.id}/devices`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [reg.device_id] }),
    });
    await reqJson(env2.app, `/api/devices/${reg.device_id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${t2}` },
    });
    const afterDel = await reqJson<{ total: number }>(env2.app, '/api/devices', {
      headers: { Authorization: `Bearer ${t2}` },
    });
    expect(afterDel.body.data.total).toBe(0);
  });

  it('supports PUBLIC_BASE_URL behind Tencent CDN for CSRF and install commands', async () => {
    const { app, config } = await setupTestApp({
      PUBLIC_BASE_URL: 'https://cs.xrsec.fun/',
    });
    expect(config.publicBaseUrl).toBe('https://cs.xrsec.fun');

    const fallbackConfig = buildConfig(
      { CSLITE_PUBLIC_BASE_URL: 'https://alt.xrsec.fun///' },
      'scf',
    );
    expect(fallbackConfig.publicBaseUrl).toBe('https://alt.xrsec.fun');

    const loginRes = await reqJson<{ session_token: string }>(
      app,
      'https://1316823487-test.ap-nanjing.tencentscf.com/api/auth/login',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Host: '1316823487-test.ap-nanjing.tencentscf.com',
          Origin: 'https://cs.xrsec.fun',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      },
    );
    expect(loginRes.res.status).toBe(200);
    const cookieToken = extractCookieValue(loginRes.res.headers.get('set-cookie'));
    expect(cookieToken).toBeTruthy();

    // Cookie-authenticated POST /api/devices succeeds when CDN forwards SCF Host but browser sends PUBLIC_BASE_URL Origin
    const createRes = await reqJson<{
      id: string;
      install_command: string;
      install_commands: Record<string, string>;
    }>(app, 'http://1316823487-test.ap-nanjing.tencentscf.com/api/devices', {
      method: 'POST',
      headers: {
        Cookie: `cslite_session=${cookieToken}`,
        Host: '1316823487-test.ap-nanjing.tencentscf.com',
        Origin: 'https://cs.xrsec.fun',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'cdn-edge-node', platform: 'linux' }),
    });
    expect(createRes.res.status).toBe(201);
    expect(createRes.body.data.install_command).toBe(
      `curl -fsSL https://cs.xrsec.fun/i | sh -s -- YOUR_API_KEY ${createRes.body.data.id}`,
    );
    expect(createRes.body.data.install_commands.windows).toBe(
      `$k="YOUR_API_KEY";$d="${createRes.body.data.id}";irm https://cs.xrsec.fun/i.ps1|iex`,
    );
    expect(createRes.body.data.install_commands.android).toBe(
      `curl -fsSL https://cs.xrsec.fun/ia | sh -s -- YOUR_API_KEY ${createRes.body.data.id}`,
    );
    expect(createRes.body.data.install_command).not.toContain('tencentscf.com');
    for (const cmd of Object.values(createRes.body.data.install_commands)) {
      expect(cmd).toContain('https://cs.xrsec.fun');
      expect(cmd).not.toContain('tencentscf.com');
    }

    for (const shortRoute of ['/i', '/i.ps1', '/ia']) {
      const sRes = await app.request(`http://1316823487-test.ap-nanjing.tencentscf.com${shortRoute}`, {
        headers: { Host: '1316823487-test.ap-nanjing.tencentscf.com' },
      });
      expect(sRes.status).toBe(200);
      expect(sRes.headers.get('cache-control')).toBe('no-store');
      const txt = await sRes.text();
      expect(txt).toContain('https://cs.xrsec.fun');
      expect(txt).not.toContain('__CSLITE_DEFAULT_SERVER__');
      expect(txt).not.toContain('tencentscf.com');
    }

    // Wrong Origin still fails CSRF check with 403
    const evilOriginRes = await reqJson(
      app,
      'http://1316823487-test.ap-nanjing.tencentscf.com/api/devices',
      {
        method: 'POST',
        headers: {
          Cookie: `cslite_session=${cookieToken}`,
          Host: '1316823487-test.ap-nanjing.tencentscf.com',
          Origin: 'https://evil.example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'evil-node', platform: 'linux' }),
      },
    );
    expect(evilOriginRes.res.status).toBe(403);
  });

  it('resolves MDM MySQL env vars, Go-style DSNs, and serverless MySQL pool SSL options', async () => {
    expect(
      buildMysqlDsnFromEnv({
        MYSQL_HOST: 'cdb-123.mysql.tencentcdb.com',
        MYSQL_USER: 'cslite',
        MYSQL_PASSWORD: 'p@ss:word/1?2',
        MYSQL_DATABASE: 'cslite_db',
      }),
    ).toBe('mysql://cslite:p%40ss%3Aword%2F1%3F2@cdb-123.mysql.tencentcdb.com:3306/cslite_db');

    expect(
      resolveMysqlDsn({
        MYSQL_HOST: 'sqlpub.example.com',
        MYSQL_PORT: '3307',
        MYSQL_USER: 'mdm_user',
        MYSQL_PASSWORD: 'secret',
        MYSQL_DATABASE: 'mdm',
      }),
    ).toBe('mysql://mdm_user:secret@sqlpub.example.com:3307/mdm');

    expect(
      resolveMysqlDsn({
        CSLITE_DB_DRIVER: 'sqlite',
        MYSQL_HOST: 'sqlpub.example.com',
        MYSQL_USER: 'mdm_user',
        MYSQL_DATABASE: 'mdm',
      }),
    ).toBeNull();

    expect(
      normalizeMysqlDsn(
        'cslite:p@ss:word@tcp(10.0.0.8:3306)/cslite?charset=utf8mb4,utf8&parseTime=True&loc=Local&tls=true',
      ),
    ).toBe('mysql://cslite:p%40ss%3Aword@10.0.0.8:3306/cslite?charset=utf8mb4');

    expect(
      resolveMysqlDsn({
        CSLITE_DB_DSN: 'root:secret@tcp(127.0.0.1:3306)/cslite?parseTime=True&loc=Local',
      }),
    ).toBe('mysql://root:secret@127.0.0.1:3306/cslite');

    const capturedConfigs: Array<Record<string, unknown>> = [];
    const mockPool = {
      query: vi.fn(async () => [[], []]),
      getConnection: vi.fn(),
      end: vi.fn(async () => {}),
    };
    vi.doMock('mysql2/promise', () => ({
      createPool: vi.fn((opts: Record<string, unknown>) => {
        capturedConfigs.push(opts);
        return mockPool;
      }),
    }));

    const prevSsl = process.env.MYSQL_SSL;
    try {
      const { createMysqlDriver } = await import('../src/db/mysql');

      delete process.env.MYSQL_SSL;
      const d1 = await createMysqlDriver('mysql://user:pass@localhost:3306/cslite');
      await d1.close?.();

      process.env.MYSQL_SSL = 'true';
      const d2 = await createMysqlDriver('user:pass@tcp(localhost:3306)/cslite?parseTime=True&loc=Local');
      await d2.close?.();

      expect(capturedConfigs[0]).toMatchObject({
        uri: 'mysql://user:pass@localhost:3306/cslite',
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        connectTimeout: 5000,
        timezone: 'Z',
      });
      expect('ssl' in capturedConfigs[0]!).toBe(false);

      expect(capturedConfigs[1]).toMatchObject({
        uri: 'mysql://user:pass@localhost:3306/cslite',
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        connectTimeout: 5000,
        timezone: 'Z',
        ssl: { rejectUnauthorized: false },
      });
    } finally {
      if (prevSsl === undefined) {
        delete process.env.MYSQL_SSL;
      } else {
        process.env.MYSQL_SSL = prevSsl;
      }
      vi.doUnmock('mysql2/promise');
    }
  });

  it('serves all 9 installer/agent script endpoints zero-DB, bakes origin into installers, and preserves pre-created name on registration', async () => {
    const { app, driver } = await setupTestApp();

    const expectedScripts: Array<[string, string, string, boolean]> = [
      ['/i', 'text/x-shellscript; charset=utf-8', 'agent/scripts/install.sh', true],
      ['/install.sh', 'text/x-shellscript; charset=utf-8', 'agent/scripts/install.sh', true],
      ['/i.ps1', 'text/plain; charset=utf-8', 'agent/scripts/install.ps1', true],
      ['/install.ps1', 'text/plain; charset=utf-8', 'agent/scripts/install.ps1', true],
      ['/ia', 'text/x-shellscript; charset=utf-8', 'agent/scripts/install-android.sh', true],
      ['/install-android.sh', 'text/x-shellscript; charset=utf-8', 'agent/scripts/install-android.sh', true],
      ['/agent-lite.sh', 'text/x-shellscript; charset=utf-8', 'agent/openwrt/cslite-agent-lite.sh', false],
      ['/agent-lite.ps1', 'text/plain; charset=utf-8', 'agent/scripts/cslite-agent-lite.ps1', false],
      ['/openwrt/cslite-agent.init', 'text/x-shellscript; charset=utf-8', 'agent/openwrt/cslite-agent.init', false],
    ];

    for (const [routePath, contentType, relFile, bakesOrigin] of expectedScripts) {
      const res = await app.request(routePath);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(contentType);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const bodyBytes = Buffer.from(await res.arrayBuffer());
      const sourceBytes = fs.readFileSync(path.join(repoRoot, relFile));
      if (bakesOrigin) {
        const expected = Buffer.from(
          sourceBytes.toString('utf8').replaceAll('__CSLITE_DEFAULT_SERVER__', 'http://localhost'),
          'utf8',
        );
        expect(bodyBytes.equals(expected)).toBe(true);
        const bodyText = bodyBytes.toString('utf8');
        expect(bodyText).toContain('http://localhost');
        expect(bodyText).not.toContain('__CSLITE_DEFAULT_SERVER__');
      } else {
        expect(bodyBytes.equals(sourceBytes)).toBe(true);
      }
      expect(bodyBytes.byteLength).toBeGreaterThan(100);
    }

    for (const shortRoute of ['/i', '/i.ps1', '/ia']) {
      const res = await app.request(`https://cs.xrsec.fun${shortRoute}`);
      expect(res.status).toBe(200);
      const txt = await res.text();
      expect(txt).toContain('https://cs.xrsec.fun');
      expect(txt).not.toContain('__CSLITE_DEFAULT_SERVER__');
    }

    // Confirm none of the 9 script routes triggered ensureMigrated()
    const tablesBeforeApi = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    );
    expect(tablesBeforeApi).toHaveLength(0);

    // Login & mint API key
    const adminToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      })
    ).body.data.session_token;

    const apiKey = (
      await reqJson<{ api_key: string }>(app, '/api/auth/key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'script-key' }),
      })
    ).body.data.api_key;

    // 3-family pickInstallCommand for unix, windows, android
    const unixDev = await reqJson<{
      id: string;
      install_command: string;
      install_commands: Record<string, string>;
    }>(app, 'https://cs.xrsec.fun/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'openwrt-hz-ys', platform: 'unix' }),
    });
    expect(unixDev.res.status).toBe(201);
    expect(Object.keys(unixDev.body.data.install_commands).sort()).toEqual([
      'android',
      'unix',
      'windows',
    ]);
    expect(unixDev.body.data.install_command).toBe(unixDev.body.data.install_commands.unix);
    expect(unixDev.body.data.install_command).toBe(
      `curl -fsSL https://cs.xrsec.fun/i | sh -s -- YOUR_API_KEY ${unixDev.body.data.id}`,
    );

    const winDev = await reqJson<{
      id: string;
      install_command: string;
      install_commands: Record<string, string>;
    }>(app, 'https://cs.xrsec.fun/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'win-box-01', platform: 'windows' }),
    });
    expect(winDev.res.status).toBe(201);
    expect(winDev.body.data.install_command).toBe(winDev.body.data.install_commands.windows);
    expect(winDev.body.data.install_command).toBe(
      `$k="YOUR_API_KEY";$d="${winDev.body.data.id}";irm https://cs.xrsec.fun/i.ps1|iex`,
    );

    const androidDev = await reqJson<{
      id: string;
      install_command: string;
      install_commands: Record<string, string>;
    }>(app, 'https://cs.xrsec.fun/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pixel-termux', platform: 'android' }),
    });
    expect(androidDev.res.status).toBe(201);
    expect(androidDev.body.data.install_command).toBe(androidDev.body.data.install_commands.android);
    expect(androidDev.body.data.install_command).toBe(
      `curl -fsSL https://cs.xrsec.fun/ia | sh -s -- YOUR_API_KEY ${androidDev.body.data.id}`,
    );

    // Pre-created 'unix' device keeps pre-created name when agent omits name, updates platform/arch/os_version/hostname
    const regOpenWrt = await reqJson<{ agent_id: string; device_id: string }>(
      app,
      '/api/agent/register',
      {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: JSON.stringify({
          device_id: unixDev.body.data.id,
          platform: 'openwrt',
          arch: 'aarch64',
          os_version: 'OpenWrt 23.05.3',
          hostname: 'hz-ys-gw',
          version: '4.1.0',
        }),
      },
    );
    expect(regOpenWrt.res.status).toBe(200);

    const updatedUnixDev = await reqJson<{
      name: string;
      platform: string;
      arch: string;
      os_version: string;
      hostname: string;
      agent_version: string;
      status: string;
    }>(app, `/api/devices/${unixDev.body.data.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(updatedUnixDev.body.data).toMatchObject({
      name: 'openwrt-hz-ys',
      platform: 'openwrt',
      arch: 'aarch64',
      os_version: 'OpenWrt 23.05.3',
      hostname: 'hz-ys-gw',
      agent_version: '4.1.0',
      status: 'online',
    });

    // Re-registering with agent fallback name === hostname STILL preserves pre-created 'openwrt-hz-ys'
    const regHostnameFallback = await reqJson(app, '/api/agent/register', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        device_id: unixDev.body.data.id,
        name: 'hz-ys-gw',
        platform: 'openwrt',
        hostname: 'hz-ys-gw',
        version: '4.1.0',
      }),
    });
    expect(regHostnameFallback.res.status).toBe(200);
    const afterHostFallback = await reqJson<{ name: string }>(
      app,
      `/api/devices/${unixDev.body.data.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(afterHostFallback.body.data.name).toBe('openwrt-hz-ys');

    // Explicitly passing a custom name !== hostname updates the device name
    const regCustomName = await reqJson(app, '/api/agent/register', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        device_id: unixDev.body.data.id,
        name: 'openwrt-hz-custom',
        platform: 'openwrt',
        hostname: 'hz-ys-gw',
        version: '4.1.0',
      }),
    });
    expect(regCustomName.res.status).toBe(200);
    const afterCustomName = await reqJson<{ name: string }>(
      app,
      `/api/devices/${unixDev.body.data.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(afterCustomName.body.data.name).toBe('openwrt-hz-custom');

    // Pre-created 'unix' device keeps 'unix' when agent sends platform='other'
    const unixKeepDev = await reqJson<{ id: string }>(app, '/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'freebsd-gw', platform: 'unix' }),
    });
    await reqJson(app, '/api/agent/register', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        device_id: unixKeepDev.body.data.id,
        name: 'freebsd-gw',
        platform: 'other',
        arch: 'amd64',
        os_version: 'FreeBSD 14.1',
        hostname: 'bsd-gw',
        version: '4.1.0',
      }),
    });
    const keptDetail = await reqJson<{ platform: string; arch: string; os_version: string }>(
      app,
      `/api/devices/${unixKeepDev.body.data.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(keptDetail.body.data.platform).toBe('unix');
    expect(keptDetail.body.data.arch).toBe('amd64');
    expect(keptDetail.body.data.os_version).toBe('FreeBSD 14.1');
  });

  it('supports two-tier passive poll-with-telemetry via POST /api/agent/commands and preserves lightweight polling', async () => {
    const { app, driver } = await setupTestApp({
      CSLITE_POLL_INTERVAL: '15',
      CSLITE_HEARTBEAT_INTERVAL: '300',
    });

    const adminToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      })
    ).body.data.session_token;

    const apiKey = (
      await reqJson<{ api_key: string }>(app, '/api/auth/key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'poll-telemetry-key' }),
      })
    ).body.data.api_key;

    const reg = (
      await reqJson<{
        agent_id: string;
        device_id: string;
        poll_interval: number;
        heartbeat_interval: number;
      }>(app, '/api/agent/register', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey },
        body: JSON.stringify({
          name: 'edge-gw',
          platform: 'linux',
          version: '1.0.0',
        }),
      })
    ).body.data;
    expect(reg.poll_interval).toBe(15);
    expect(reg.heartbeat_interval).toBe(300);

    // 1. Lightweight GET /api/agent/commands stays backwards-compatible and pushes intervals
    const getPoll = await reqJson<{
      commands: unknown[];
      poll_interval: number;
      next_heartbeat: number;
    }>(app, `/api/agent/commands?agent_id=${reg.agent_id}&limit=1`, {
      headers: { 'X-API-Key': apiKey },
    });
    expect(getPoll.res.status).toBe(200);
    expect(getPoll.body.data).toEqual({
      commands: [],
      poll_interval: 15,
      next_heartbeat: 300,
    });

    // 2. Lightweight POST /api/agent/commands returns intervals and keeps device online without clearing metrics
    const lightPoll = await reqJson<{
      commands: unknown[];
      poll_interval: number;
      next_heartbeat: number;
    }>(app, '/api/agent/commands', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        agent_id: reg.agent_id,
        limit: 1,
      }),
    });
    expect(lightPoll.res.status).toBe(200);
    expect(lightPoll.body.data).toEqual({
      commands: [],
      poll_interval: 15,
      next_heartbeat: 300,
    });

    const devAfterLight = await reqJson<{ status: string; metrics: unknown }>(
      app,
      `/api/devices/${reg.device_id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(devAfterLight.body.data.status).toBe('online');
    expect(devAfterLight.body.data.metrics).toBeNull();

    // 3. Queue a command and deliver telemetry + command in a single POST /api/agent/commands round-trip
    const createdCmd = await reqJson<{ id: string }>(app, '/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'uptime-check',
        type: 'immediate',
        content: 'uptime',
        target_type: 'devices',
        target_ids: [reg.device_id],
      }),
    });
    expect(createdCmd.res.status).toBe(201);

    const beforeRow = await driver.get<{ last_seen: string }>(
      'SELECT last_seen FROM devices WHERE id = ?',
      [reg.device_id],
    );
    await new Promise((r) => setTimeout(r, 15));

    const telemetryPoll = await reqJson<{
      commands: Array<{ command_id: string; content: string }>;
      poll_interval: number;
      next_heartbeat: number;
    }>(app, '/api/agent/commands', {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'x-forwarded-for': '198.51.100.7',
      },
      body: JSON.stringify({
        agent_id: reg.agent_id,
        limit: 5,
        version: '1.2.0',
        os_version: 'Debian 12',
        hostname: 'edge-gw-host',
        timestamp: new Date().toISOString(),
        metrics: {
          cpu_usage: 42.5,
          memory_used: 512,
          memory_total: 2048,
          memory_percent: 25,
          disk_usage: 18.2,
          network_in: 120,
          network_out: 80,
          load_avg: '0.15 0.10 0.05',
          uptime: 3600,
        },
      }),
    });
    expect(telemetryPoll.res.status).toBe(200);
    expect(telemetryPoll.body.data.poll_interval).toBe(15);
    expect(telemetryPoll.body.data.next_heartbeat).toBe(300);
    expect(telemetryPoll.body.data.commands).toHaveLength(1);
    expect(telemetryPoll.body.data.commands[0]?.command_id).toBe(createdCmd.body.data.id);

    const devAfterTelemetry = await reqJson<{
      status: string;
      ip_address: string;
      os_version: string;
      hostname: string;
      agent_version: string;
      last_seen: string;
      metrics: { cpu_usage: number; memory_used: number; uptime: number } | null;
    }>(app, `/api/devices/${reg.device_id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(devAfterTelemetry.body.data).toMatchObject({
      status: 'online',
      ip_address: '198.51.100.7',
      os_version: 'Debian 12',
      hostname: 'edge-gw-host',
      agent_version: '1.2.0',
    });
    expect(devAfterTelemetry.body.data.last_seen).not.toBe(beforeRow?.last_seen);
    expect(devAfterTelemetry.body.data.metrics).toMatchObject({
      cpu_usage: 42.5,
      memory_used: 512,
      uptime: 3600,
    });

    const agentRow = await driver.get<{ version: string; heartbeat_metrics: string | null }>(
      'SELECT version, heartbeat_metrics FROM agents WHERE id = ?',
      [reg.agent_id],
    );
    expect(agentRow?.version).toBe('1.2.0');
    expect(agentRow?.heartbeat_metrics).toContain('"cpu_usage":42.5');

    // 4. Subsequent lightweight poll preserves existing metrics and metadata
    const secondLightPoll = await reqJson<{ commands: unknown[] }>(app, '/api/agent/commands', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({ agent_id: reg.agent_id, limit: 1 }),
    });
    expect(secondLightPoll.res.status).toBe(200);
    const devPreserved = await reqJson<{
      hostname: string;
      os_version: string;
      agent_version: string;
      metrics: { cpu_usage: number } | null;
    }>(app, `/api/devices/${reg.device_id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(devPreserved.body.data.hostname).toBe('edge-gw-host');
    expect(devPreserved.body.data.os_version).toBe('Debian 12');
    expect(devPreserved.body.data.agent_version).toBe('1.2.0');
    expect(devPreserved.body.data.metrics?.cpu_usage).toBe(42.5);
  });
});
