import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { buildConfig } from '../src/config';
import type { SqlDriver } from '../src/db/driver';
import { buildMysqlDsnFromEnv, normalizeMysqlDsn, resolveMysqlDsn } from '../src/db/mysql';
import { createNodeSqliteDriver } from '../src/db/node-sqlite';
import { nextCronAfter } from '../src/lib/cron';

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
    expect(html).toContain('CSLite');

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
      name: string;
      platform: string;
      api_key: string;
      api_key_id: string;
      api_key_prefix: string;
      install_command: string;
      install_commands: Record<string, string>;
      expires_at: string;
    }>(app, '/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'openwrt-router', platform: 'openwrt' }),
    });
    expect(preDev.res.status).toBe(201);
    expect(preDev.body.data.api_key).toMatch(/^ak_dev_[0-9a-f]{40}$/);
    expect(preDev.body.data.api_key_id).toMatch(/^key_/);
    expect(preDev.body.data.api_key_prefix).toBe(`${preDev.body.data.api_key.slice(0, 12)}...`);
    expect(Object.keys(preDev.body.data.install_commands).sort()).toEqual([
      'android',
      'unix',
      'windows',
    ]);
    expect(preDev.body.data.install_command).toBe(preDev.body.data.install_commands.unix);
    expect(preDev.body.data.install_commands.unix).toBe(
      `curl -fsSL http://localhost/i | sh -s -- ${preDev.body.data.api_key} ${preDev.body.data.id}`,
    );
    expect(preDev.body.data.install_commands.windows).toBe(
      `$k="${preDev.body.data.api_key}";$d="${preDev.body.data.id}";irm http://localhost/i.ps1|iex`,
    );
    expect(preDev.body.data.install_commands.android).toBe(
      `curl -fsSL http://localhost/ia | sh -s -- ${preDev.body.data.api_key} ${preDev.body.data.id}`,
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
      PUBLIC_BASE_URL: 'https://ctrl.example.com/',
    });
    expect(config.publicBaseUrl).toBe('https://ctrl.example.com');

    const fallbackConfig = buildConfig(
      { CSLITE_PUBLIC_BASE_URL: 'https://alt.example.com///' },
      'scf',
    );
    expect(fallbackConfig.publicBaseUrl).toBe('https://alt.example.com');

    const loginRes = await reqJson<{ session_token: string }>(
      app,
      'https://1300000000-test.ap-nanjing.tencentscf.com/api/auth/login',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Host: '1300000000-test.ap-nanjing.tencentscf.com',
          Origin: 'https://ctrl.example.com',
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
      api_key: string;
      install_command: string;
      install_commands: Record<string, string>;
    }>(app, 'http://1300000000-test.ap-nanjing.tencentscf.com/api/devices', {
      method: 'POST',
      headers: {
        Cookie: `cslite_session=${cookieToken}`,
        Host: '1300000000-test.ap-nanjing.tencentscf.com',
        Origin: 'https://ctrl.example.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'cdn-edge-node', platform: 'linux' }),
    });
    expect(createRes.res.status).toBe(201);
    expect(createRes.body.data.api_key).toMatch(/^ak_dev_[0-9a-f]{40}$/);
    expect(createRes.body.data.install_command).toBe(
      `curl -fsSL https://ctrl.example.com/i | sh -s -- ${createRes.body.data.api_key} ${createRes.body.data.id}`,
    );
    expect(createRes.body.data.install_commands.windows).toBe(
      `$k="${createRes.body.data.api_key}";$d="${createRes.body.data.id}";irm https://ctrl.example.com/i.ps1|iex`,
    );
    expect(createRes.body.data.install_commands.android).toBe(
      `curl -fsSL https://ctrl.example.com/ia | sh -s -- ${createRes.body.data.api_key} ${createRes.body.data.id}`,
    );
    expect(createRes.body.data.install_command).not.toContain('tencentscf.com');
    for (const cmd of Object.values(createRes.body.data.install_commands)) {
      expect(cmd).toContain('https://ctrl.example.com');
      expect(cmd).not.toContain('tencentscf.com');
    }

    for (const shortRoute of ['/i', '/i.ps1', '/ia']) {
      const sRes = await app.request(`http://1300000000-test.ap-nanjing.tencentscf.com${shortRoute}`, {
        headers: { Host: '1300000000-test.ap-nanjing.tencentscf.com' },
      });
      expect(sRes.status).toBe(200);
      expect(sRes.headers.get('cache-control')).toBe('no-store');
      const txt = await sRes.text();
      expect(txt).toContain('https://ctrl.example.com');
      expect(txt).not.toContain('__CSLITE_DEFAULT_SERVER__');
      expect(txt).not.toContain('tencentscf.com');
    }

    // Wrong Origin still fails CSRF check with 403
    const evilOriginRes = await reqJson(
      app,
      'http://1300000000-test.ap-nanjing.tencentscf.com/api/devices',
      {
        method: 'POST',
        headers: {
          Cookie: `cslite_session=${cookieToken}`,
          Host: '1300000000-test.ap-nanjing.tencentscf.com',
          Origin: 'https://evil.example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'evil-node', platform: 'linux' }),
      },
    );
    expect(evilOriginRes.res.status).toBe(403);
  });

  it('resolves standard MYSQL_* env vars, Go-style DSNs, and serverless MySQL pool SSL options', async () => {
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
        MYSQL_HOST: 'mysql.example.com',
        MYSQL_PORT: '3307',
        MYSQL_USER: 'cslite_user',
        MYSQL_PASSWORD: 'secret',
        MYSQL_DATABASE: 'cslite',
      }),
    ).toBe('mysql://cslite_user:secret@mysql.example.com:3307/cslite');

    expect(
      resolveMysqlDsn({
        CSLITE_DB_DRIVER: 'sqlite',
        MYSQL_HOST: 'mysql.example.com',
        MYSQL_USER: 'cslite_user',
        MYSQL_DATABASE: 'cslite',
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

  it('serves all installer, upgrade, and agent script endpoints zero-DB, bakes origin into installers, and preserves pre-created name on registration', async () => {
    const { app, driver } = await setupTestApp();

    const expectedScripts: Array<[string, string, string, boolean]> = [
      ['/i', 'text/x-shellscript; charset=utf-8', 'agent/scripts/install.sh', true],
      ['/install.sh', 'text/x-shellscript; charset=utf-8', 'agent/scripts/install.sh', true],
      ['/u', 'text/x-shellscript; charset=utf-8', 'agent/scripts/upgrade.sh', true],
      ['/upgrade.sh', 'text/x-shellscript; charset=utf-8', 'agent/scripts/upgrade.sh', true],
      ['/i.ps1', 'text/plain; charset=utf-8', 'agent/scripts/install.ps1', true],
      ['/install.ps1', 'text/plain; charset=utf-8', 'agent/scripts/install.ps1', true],
      ['/u.ps1', 'text/plain; charset=utf-8', 'agent/scripts/upgrade.ps1', true],
      ['/upgrade.ps1', 'text/plain; charset=utf-8', 'agent/scripts/upgrade.ps1', true],
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
      const res = await app.request(`https://ctrl.example.com${shortRoute}`);
      expect(res.status).toBe(200);
      const txt = await res.text();
      expect(txt).toContain('https://ctrl.example.com');
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
      api_key: string;
      install_command: string;
      install_commands: Record<string, string>;
    }>(app, 'https://ctrl.example.com/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'openwrt-edge-01', platform: 'unix' }),
    });
    expect(unixDev.res.status).toBe(201);
    expect(unixDev.body.data.api_key).toMatch(/^ak_dev_[0-9a-f]{40}$/);
    expect(Object.keys(unixDev.body.data.install_commands).sort()).toEqual([
      'android',
      'unix',
      'windows',
    ]);
    expect(unixDev.body.data.install_command).toBe(unixDev.body.data.install_commands.unix);
    expect(unixDev.body.data.install_command).toBe(
      `curl -fsSL https://ctrl.example.com/i | sh -s -- ${unixDev.body.data.api_key} ${unixDev.body.data.id}`,
    );

    const winDev = await reqJson<{
      id: string;
      api_key: string;
      install_command: string;
      install_commands: Record<string, string>;
    }>(app, 'https://ctrl.example.com/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'win-box-01', platform: 'windows' }),
    });
    expect(winDev.res.status).toBe(201);
    expect(winDev.body.data.api_key).toMatch(/^ak_dev_[0-9a-f]{40}$/);
    expect(winDev.body.data.install_command).toBe(winDev.body.data.install_commands.windows);
    expect(winDev.body.data.install_command).toBe(
      `$k="${winDev.body.data.api_key}";$d="${winDev.body.data.id}";irm https://ctrl.example.com/i.ps1|iex`,
    );

    const androidDev = await reqJson<{
      id: string;
      api_key: string;
      install_command: string;
      install_commands: Record<string, string>;
    }>(app, 'https://ctrl.example.com/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pixel-termux', platform: 'android' }),
    });
    expect(androidDev.res.status).toBe(201);
    expect(androidDev.body.data.api_key).toMatch(/^ak_dev_[0-9a-f]{40}$/);
    expect(androidDev.body.data.install_command).toBe(androidDev.body.data.install_commands.android);
    expect(androidDev.body.data.install_command).toBe(
      `curl -fsSL https://ctrl.example.com/ia | sh -s -- ${androidDev.body.data.api_key} ${androidDev.body.data.id}`,
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
          hostname: 'edge-01-gw',
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
      name: 'openwrt-edge-01',
      platform: 'openwrt',
      arch: 'aarch64',
      os_version: 'OpenWrt 23.05.3',
      hostname: 'edge-01-gw',
      agent_version: '4.1.0',
      status: 'online',
    });

    // Re-registering with agent fallback name === hostname STILL preserves pre-created 'openwrt-edge-01'
    const regHostnameFallback = await reqJson(app, '/api/agent/register', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        device_id: unixDev.body.data.id,
        name: 'edge-01-gw',
        platform: 'openwrt',
        hostname: 'edge-01-gw',
        version: '4.1.0',
      }),
    });
    expect(regHostnameFallback.res.status).toBe(200);
    const afterHostFallback = await reqJson<{ name: string }>(
      app,
      `/api/devices/${unixDev.body.data.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(afterHostFallback.body.data.name).toBe('openwrt-edge-01');

    // Explicitly passing a custom name !== hostname updates the device name
    const regCustomName = await reqJson(app, '/api/agent/register', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: JSON.stringify({
        device_id: unixDev.body.data.id,
        name: 'openwrt-edge-custom',
        platform: 'openwrt',
        hostname: 'edge-01-gw',
        version: '4.1.0',
      }),
    });
    expect(regCustomName.res.status).toBe(200);
    const afterCustomName = await reqJson<{ name: string }>(
      app,
      `/api/devices/${unixDev.body.data.id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(afterCustomName.body.data.name).toBe('openwrt-edge-custom');

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

  it('preserves API keys, device ownership, and admin seed invariants across admin replacement', async () => {
    const { app, driver, config } = await setupTestApp();

    // 1. Admin A logs in, creates an API key, and registers a device
    const adminALogin = await reqJson<{
      user: { id: number; username: string; role: number };
      session_token: string;
    }>(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    expect(adminALogin.res.status).toBe(200);
    const adminAId = adminALogin.body.data.user.id;
    const adminAToken = adminALogin.body.data.session_token;

    const keyARes = await reqJson<{ id: string; api_key: string }>(app, '/api/auth/key', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminAToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'admin-a-probe-key' }),
    });
    expect(keyARes.res.status).toBe(201);
    const keyAId = keyARes.body.data.id;
    const keyA = keyARes.body.data.api_key;

    const reg = (
      await reqJson<{ agent_id: string; device_id: string }>(app, '/api/agent/register', {
        method: 'POST',
        headers: { 'X-API-Key': keyA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'prod-node-1', platform: 'linux', version: '4.0.0' }),
      })
    ).body.data;

    // 2. Admin A creates Admin B (role: 1) and Admin B logs in
    const adminBCreate = await reqJson<{ id: number; username: string; role: number }>(
      app,
      '/api/auth/user',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminAToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin2', password: 'Password123!', role: 1 }),
      },
    );
    expect(adminBCreate.res.status).toBe(201);
    const adminBId = adminBCreate.body.data.id;

    const adminBLogin = await reqJson<{ session_token: string }>(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin2', password: 'Password123!' }),
    });
    expect(adminBLogin.res.status).toBe(200);
    const adminBToken = adminBLogin.body.data.session_token;

    // Admin B immediately sees Admin A's probe key with owner_username === 'admin'
    const keysBeforeDelete = await reqJson<{
      total: number;
      keys: Array<{ id: string; user_id?: number; owner_username?: string }>;
    }>(app, '/api/auth/key', {
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    expect(keysBeforeDelete.res.status).toBe(200);
    expect(keysBeforeDelete.body.data.total).toBeGreaterThanOrEqual(1);
    expect(keysBeforeDelete.body.data.keys[0]).toMatchObject({
      id: keyAId,
      user_id: adminAId,
      owner_username: 'admin',
    });

    // 3. Admin B deletes Admin A
    const delAdminA = await reqJson(app, `/api/auth/user/${adminAId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    expect(delAdminA.res.status).toBe(200);

    // Admin B still sees the API key, now transferred to adminB
    const keysAfterDelete = await reqJson<{
      total: number;
      keys: Array<{ id: string; user_id?: number; owner_username?: string }>;
    }>(app, '/api/auth/key', {
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    expect(keysAfterDelete.res.status).toBe(200);
    expect(keysAfterDelete.body.data.total).toBe(1);
    expect(keysAfterDelete.body.data.keys[0]).toMatchObject({
      id: keyAId,
      user_id: adminBId,
      owner_username: 'admin2',
    });

    // Old API key from Admin A still authenticates agent heartbeat & poll with 200
    const hbAfter = await reqJson(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': keyA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: reg.agent_id }),
    });
    expect(hbAfter.res.status).toBe(200);

    const pollAfter = await reqJson<{ commands: unknown[] }>(app, '/api/agent/commands', {
      method: 'POST',
      headers: { 'X-API-Key': keyA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: reg.agent_id, limit: 5 }),
    });
    expect(pollAfter.res.status).toBe(200);

    // Device owner_id transferred to Admin B
    const devAfter = await reqJson<{ owner_id: number }>(app, `/api/devices/${reg.device_id}`, {
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    expect(devAfter.res.status).toBe(200);
    expect(devAfter.body.data.owner_id).toBe(adminBId);

    // 4. Deleting the last remaining admin fails with 409
    const delLastAdmin = await reqJson(app, `/api/auth/user/${adminBId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    expect(delLastAdmin.res.status).toBe(409);
    expect(delLastAdmin.body.message).toBe('Cannot delete the last admin');

    // 5. Simulate cold-start ensureMigrated on a fresh Hono app sharing the same DB
    const coldStartDriver: SqlDriver = {
      dialect: driver.dialect,
      all: (sql, params) => driver.all(sql, params),
      get: (sql, params) => driver.get(sql, params),
      run: (sql, params) => driver.run(sql, params),
      batch: (stmts) => driver.batch(stmts),
    };
    const coldStartApp = createApp(coldStartDriver, config);

    const usersAfterRestart = await reqJson<{
      total: number;
      users: Array<{ id: number; username: string; role: number }>;
    }>(coldStartApp, '/api/auth/user', {
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    expect(usersAfterRestart.res.status).toBe(200);
    expect(usersAfterRestart.body.data.total).toBe(1);
    expect(usersAfterRestart.body.data.users.map((u) => u.username)).toEqual(['admin2']);
  });

  it('revokes personal API keys and transfers devices when deleting a non-admin user', async () => {
    const { app } = await setupTestApp();

    const adminLogin = await reqJson<{
      user: { id: number };
      session_token: string;
    }>(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const adminId = adminLogin.body.data.user.id;
    const adminToken = adminLogin.body.data.session_token;

    const memberRes = await reqJson<{ id: number }>(app, '/api/auth/user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'member1', password: 'Password123!', role: 0 }),
    });
    expect(memberRes.res.status).toBe(201);
    const memberId = memberRes.body.data.id;

    const memberToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'member1', password: 'Password123!' }),
      })
    ).body.data.session_token;

    const memberKey = (
      await reqJson<{ api_key: string }>(app, '/api/auth/key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'member-personal-key' }),
      })
    ).body.data.api_key;

    const memberReg = (
      await reqJson<{ agent_id: string; device_id: string }>(app, '/api/agent/register', {
        method: 'POST',
        headers: { 'X-API-Key': memberKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'member-node', platform: 'linux', version: '4.0.0' }),
      })
    ).body.data;

    // Delete non-admin user
    const delMember = await reqJson(app, `/api/auth/user/${memberId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delMember.res.status).toBe(200);

    // Member's personal API key is revoked (401)
    const revokedMe = await reqJson(app, '/api/auth/me', {
      headers: { 'X-API-Key': memberKey },
    });
    expect(revokedMe.res.status).toBe(401);

    const revokedHb = await reqJson(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': memberKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: memberReg.agent_id }),
    });
    expect(revokedHb.res.status).toBe(401);

    // Member's device is transferred to acting admin (not orphaned)
    const transferredDev = await reqJson<{ owner_id: number }>(
      app,
      `/api/devices/${memberReg.device_id}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(transferredDev.res.status).toBe(200);
    expect(transferredDev.body.data.owner_id).toBe(adminId);
  });

  it('decouples immediate commands from scheduled tasks and enriches command logs with type and content', async () => {
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
        body: JSON.stringify({ name: 'cmd-log-key' }),
      })
    ).body.data.api_key;

    const reg = (
      await reqJson<{ agent_id: string; device_id: string }>(app, '/api/agent/register', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sched-node', platform: 'linux', version: '4.0.0' }),
      })
    ).body.data;

    const immCmd = (
      await reqJson<{ id: string }>(app, '/api/commands', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'terminal-ls',
          type: 'immediate',
          content: 'ls -la /tmp',
          target_type: 'devices',
          target_ids: [reg.device_id],
        }),
      })
    ).body.data;

    const futureIso = new Date(Date.now() + 120_000).toISOString();
    const onceCmd = (
      await reqJson<{ id: string }>(app, '/api/commands', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'once-disk-check',
          type: 'once',
          schedule: futureIso,
          content: 'df -h',
          target_type: 'devices',
          target_ids: [reg.device_id],
        }),
      })
    ).body.data;

    const cronCmd = (
      await reqJson<{ id: string }>(app, '/api/commands', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'cron-uptime',
          type: 'cron',
          schedule: '* * * * *',
          content: 'uptime',
          target_type: 'devices',
          target_ids: [reg.device_id],
        }),
      })
    ).body.data;

    // Backdate scheduled next_run_at so agent poll materializes both once & cron commands
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    await driver.run('UPDATE commands SET next_run_at = ? WHERE id IN (?, ?)', [
      pastIso,
      onceCmd.id,
      cronCmd.id,
    ]);

    const polled = await reqJson<{
      commands: Array<{
        result_id: string;
        execution_id: string;
        command_id: string;
        type: string;
      }>;
    }>(app, '/api/agent/commands', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: reg.agent_id, limit: 10 }),
    });
    expect(polled.res.status).toBe(200);
    expect(polled.body.data.commands).toHaveLength(3);

    for (const task of polled.body.data.commands) {
      const submitRes = await reqJson(app, '/api/agent/result', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          result_id: task.result_id,
          execution_id: task.execution_id,
          device_id: reg.device_id,
          status: 'completed',
          exit_code: 0,
          output: `ran ${task.type}`,
        }),
      });
      expect(submitRes.res.status).toBe(200);
    }

    // GET /api/commands?type=cron,once returns ONLY once + cron
    const scheduledCmds = await reqJson<{
      total: number;
      commands: Array<{ id: string; type: string }>;
    }>(app, '/api/commands?type=cron,once', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(scheduledCmds.res.status).toBe(200);
    expect(scheduledCmds.body.data.total).toBe(2);
    expect(scheduledCmds.body.data.commands.map((c) => c.type).sort()).toEqual(['cron', 'once']);
    expect(scheduledCmds.body.data.commands.some((c) => c.id === immCmd.id)).toBe(false);

    // GET /api/commands?exclude_type=immediate excludes immediate
    const excludedImm = await reqJson<{
      total: number;
      commands: Array<{ id: string; type: string }>;
    }>(app, '/api/commands?exclude_type=immediate', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(excludedImm.res.status).toBe(200);
    expect(excludedImm.body.data.total).toBe(2);
    expect(excludedImm.body.data.commands.map((c) => c.type).sort()).toEqual(['cron', 'once']);

    // Invalid type filter returns 0 rows cleanly
    const invalidFilter = await reqJson<{ total: number; commands: unknown[] }>(
      app,
      '/api/commands?type=nonexistent',
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(invalidFilter.res.status).toBe(200);
    expect(invalidFilter.body.data.total).toBe(0);
    expect(invalidFilter.body.data.commands).toEqual([]);

    // GET /api/logs/command?type=immediate returns ONLY immediate logs with command_type & command_content
    const immLogs = await reqJson<{
      total: number;
      logs: Array<{
        command_id: string;
        command_type?: string;
        command_content?: string;
      }>;
    }>(app, '/api/logs/command?type=immediate', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(immLogs.res.status).toBe(200);
    expect(immLogs.body.data.total).toBe(1);
    expect(immLogs.body.data.logs[0]).toMatchObject({
      command_id: immCmd.id,
      command_type: 'immediate',
      command_content: 'ls -la /tmp',
    });

    // GET /api/logs/command?type=cron,once returns ONLY scheduled logs
    const schedLogs = await reqJson<{
      total: number;
      logs: Array<{
        command_id: string;
        command_type?: string;
        command_content?: string;
      }>;
    }>(app, '/api/logs/command?type=cron,once', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(schedLogs.res.status).toBe(200);
    expect(schedLogs.body.data.total).toBe(2);
    expect(schedLogs.body.data.logs.map((l) => l.command_type).sort()).toEqual(['cron', 'once']);
    expect(schedLogs.body.data.logs.map((l) => l.command_content).sort()).toEqual([
      'df -h',
      'uptime',
    ]);
  });

  it('binds per-device API keys, pre-fills install commands, enforces blast-radius isolation, supports idempotent/rotated deploy-key, and seals secrets with CSLITE_ENCRYPTION_KEY', async () => {
    const { app, driver } = await setupTestApp({
      CSLITE_ENCRYPTION_KEY: 'super-secret-device-key-encryption-passphrase',
    });

    const adminToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      })
    ).body.data.session_token;

    // Create global admin API key (ak_live_...)
    const globalKey = (
      await reqJson<{ id: string; api_key: string }>(app, '/api/auth/key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'global-admin-key' }),
      })
    ).body.data;
    expect(globalKey.api_key).toMatch(/^ak_live_/);

    // Create a non-admin user to verify ownership + cross-user isolation
    const memberCreate = await reqJson<{ id: number }>(app, '/api/auth/user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password123', role: 0 }),
    });
    expect(memberCreate.res.status).toBe(201);
    const aliceToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: 'password123' }),
      })
    ).body.data.session_token;

    // a) POST /api/devices returns ak_dev_... pre-filled in install commands & encrypted in DB
    const devA = await reqJson<{
      id: string;
      name: string;
      platform: string;
      api_key: string;
      api_key_id: string;
      api_key_prefix: string;
      install_command: string;
      install_commands: Record<string, string>;
    }>(app, 'https://ctrl.example.com/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'edge-node-01', platform: 'linux' }),
    });
    expect(devA.res.status).toBe(201);
    expect(devA.body.data.api_key).toMatch(/^ak_dev_[0-9a-f]{40}$/);
    expect(devA.body.data.api_key_id).toMatch(/^key_/);
    expect(devA.body.data.api_key_prefix).toBe(`${devA.body.data.api_key.slice(0, 12)}...`);
    expect(devA.body.data.install_command).toBe(
      `curl -fsSL https://ctrl.example.com/i | sh -s -- ${devA.body.data.api_key} ${devA.body.data.id}`,
    );
    expect(devA.body.data.install_commands.windows).toBe(
      `$k="${devA.body.data.api_key}";$d="${devA.body.data.id}";irm https://ctrl.example.com/i.ps1|iex`,
    );

    // f) CSLITE_ENCRYPTION_KEY seals key_secret with enc1:... in SQLite
    const dbRowA = await driver.get<{ device_id: string | null; key_secret: string | null }>(
      'SELECT device_id, key_secret FROM api_keys WHERE id = ?',
      [devA.body.data.api_key_id],
    );
    expect(dbRowA?.device_id).toBe(devA.body.data.id);
    expect(dbRowA?.key_secret).toMatch(/^enc1:[0-9a-f]{24}:[0-9a-f]+$/);
    expect(dbRowA?.key_secret).not.toContain(devA.body.data.api_key);

    // Sibling device B
    const devB = await reqJson<{
      id: string;
      api_key: string;
      api_key_id: string;
    }>(app, '/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'edge-node-02', platform: 'linux' }),
    });
    expect(devB.res.status).toBe(201);
    expect(devB.body.data.api_key).toMatch(/^ak_dev_/);

    // GET /api/auth/key lists device_id & device_name without leaking key_secret or key_hash
    const keysList = await reqJson<{
      total: number;
      keys: Array<Record<string, unknown>>;
    }>(app, '/api/auth/key', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(keysList.res.status).toBe(200);
    const listedDevAKey = keysList.body.data.keys.find((k) => k.id === devA.body.data.api_key_id);
    expect(listedDevAKey).toMatchObject({
      id: devA.body.data.api_key_id,
      name: 'device:edge-node-01',
      device_id: devA.body.data.id,
      device_name: 'edge-node-01',
    });
    expect(listedDevAKey).not.toHaveProperty('key_secret');
    expect(listedDevAKey).not.toHaveProperty('key_hash');

    const listedGlobalKey = keysList.body.data.keys.find((k) => k.id === globalKey.id);
    expect(listedGlobalKey?.device_id).toBeNull();
    expect(listedGlobalKey?.device_name).toBeUndefined();

    // b) Device-bound key works for its own device across /register (even omitting device_id), /heartbeat, /commands, /result
    const regAOmitId = await reqJson<{ agent_id: string; device_id: string }>(
      app,
      '/api/agent/register',
      {
        method: 'POST',
        headers: { 'X-API-Key': devA.body.data.api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'linux',
          arch: 'amd64',
          hostname: 'edge-node-01.local',
          version: '4.2.0',
        }),
      },
    );
    expect(regAOmitId.res.status).toBe(200);
    expect(regAOmitId.body.data.device_id).toBe(devA.body.data.id);

    // Verify no extra device was spawned by omitting device_id
    const devCountAfterReg = await driver.get<{ total: number }>(
      'SELECT COUNT(*) AS total FROM devices',
    );
    expect(Number(devCountAfterReg?.total)).toBe(2);

    // Register sibling device B with its own bound key
    const regB = await reqJson<{ agent_id: string; device_id: string }>(
      app,
      '/api/agent/register',
      {
        method: 'POST',
        headers: { 'X-API-Key': devB.body.data.api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: devB.body.data.id,
          platform: 'linux',
          version: '4.2.0',
        }),
      },
    );
    expect(regB.res.status).toBe(200);
    expect(regB.body.data.device_id).toBe(devB.body.data.id);

    // Own heartbeat succeeds
    const hbA = await reqJson<{ status: string }>(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': devA.body.data.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: regAOmitId.body.data.agent_id,
        device_id: devA.body.data.id,
      }),
    });
    expect(hbA.res.status).toBe(200);
    expect(hbA.body.data.status).toBe('ok');

    // Dispatch immediate command to device A and device B
    const cmdRes = await reqJson<{ id: string }>(app, '/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'scoped-check',
        type: 'immediate',
        content: 'uname -a',
        target_type: 'devices',
        target_ids: [devA.body.data.id, devB.body.data.id],
      }),
    });
    expect(cmdRes.res.status).toBe(201);

    // Own /commands succeeds and claims device A's task
    const pollA = await reqJson<{
      commands: Array<{ result_id: string; execution_id: string }>;
    }>(app, `/api/agent/commands?agent_id=${regAOmitId.body.data.agent_id}`, {
      headers: { 'X-API-Key': devA.body.data.api_key },
    });
    expect(pollA.res.status).toBe(200);
    expect(pollA.body.data.commands).toHaveLength(1);

    // Own /result succeeds
    const resA = await reqJson<{ logged: boolean }>(app, '/api/agent/result', {
      method: 'POST',
      headers: { 'X-API-Key': devA.body.data.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        result_id: pollA.body.data.commands[0]!.result_id,
        execution_id: pollA.body.data.commands[0]!.execution_id,
        device_id: devA.body.data.id,
        status: 'completed',
        exit_code: 0,
        output: 'Linux edge-node-01',
      }),
    });
    expect(resA.res.status).toBe(200);
    expect(resA.body.data.logged).toBe(true);

    // c) Blast-radius isolation: device-bound key gets 403 on management APIs (X-API-Key & Bearer)
    const deviceKeyHeaders: Array<Record<string, string>> = [
      { 'X-API-Key': devA.body.data.api_key },
      { Authorization: `Bearer ${devA.body.data.api_key}` },
    ];
    for (const headers of deviceKeyHeaders) {
      const mgmtDevices = await reqJson(app, '/api/devices', { headers });
      expect(mgmtDevices.res.status).toBe(403);
      const mgmtKeys = await reqJson(app, '/api/auth/key', { headers });
      expect(mgmtKeys.res.status).toBe(403);
      const mgmtCreate = await reqJson(app, '/api/devices', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'rogue', platform: 'linux' }),
      });
      expect(mgmtCreate.res.status).toBe(403);
      const mgmtDeploy = await reqJson(app, `/api/devices/${devA.body.data.id}/deploy-key`, {
        method: 'POST',
        headers,
      });
      expect(mgmtDeploy.res.status).toBe(403);
    }

    // Device A key gets 403 targeting sibling device B on /register, /heartbeat, /commands, /result
    const crossReg = await reqJson(app, '/api/agent/register', {
      method: 'POST',
      headers: { 'X-API-Key': devA.body.data.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: devB.body.data.id,
        platform: 'linux',
        version: '4.2.0',
      }),
    });
    expect(crossReg.res.status).toBe(403);

    const crossHbAgent = await reqJson(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': devA.body.data.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: regB.body.data.agent_id }),
    });
    expect(crossHbAgent.res.status).toBe(403);

    const crossHbDeviceMismatch = await reqJson(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': devA.body.data.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: regAOmitId.body.data.agent_id,
        device_id: devB.body.data.id,
      }),
    });
    expect(crossHbDeviceMismatch.res.status).toBe(403);

    const crossPoll = await reqJson(
      app,
      `/api/agent/commands?agent_id=${regB.body.data.agent_id}`,
      { headers: { 'X-API-Key': devA.body.data.api_key } },
    );
    expect(crossPoll.res.status).toBe(403);

    const crossResult = await reqJson(app, '/api/agent/result', {
      method: 'POST',
      headers: { 'X-API-Key': devA.body.data.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        execution_id: pollA.body.data.commands[0]!.execution_id,
        device_id: devB.body.data.id,
        status: 'completed',
        exit_code: 0,
      }),
    });
    expect(crossResult.res.status).toBe(403);

    // d) deploy-key is idempotent (supports empty POST body), and rotate=true rotates ONLY this device's key
    const deployRepeat1 = await reqJson<{
      id: string;
      device_id: string;
      name: string;
      api_key: string;
      key_prefix: string;
      created: boolean;
      rotated: boolean;
      install_command: string;
      install_commands: Record<string, string>;
    }>(app, `https://ctrl.example.com/api/devices/${devA.body.data.id}/deploy-key`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(deployRepeat1.res.status).toBe(200);
    expect(deployRepeat1.body.data.id).toBe(devA.body.data.api_key_id);
    expect(deployRepeat1.body.data.api_key).toBe(devA.body.data.api_key);
    expect(deployRepeat1.body.data.created).toBe(false);
    expect(deployRepeat1.body.data.rotated).toBe(false);
    expect(deployRepeat1.body.data.install_command).toBe(
      `curl -fsSL https://ctrl.example.com/i | sh -s -- ${devA.body.data.api_key} ${devA.body.data.id}`,
    );

    // Non-owner alice cannot call deploy-key on admin's device
    const aliceForbidden = await reqJson(app, `/api/devices/${devA.body.data.id}/deploy-key`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(aliceForbidden.res.status).toBe(403);

    // Rotate device A's key
    const rotatedA = await reqJson<{
      id: string;
      api_key: string;
      created: boolean;
      rotated: boolean;
      install_command: string;
    }>(app, `https://ctrl.example.com/api/devices/${devA.body.data.id}/deploy-key`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rotate: true }),
    });
    expect(rotatedA.res.status).toBe(200);
    expect(rotatedA.body.data.created).toBe(true);
    expect(rotatedA.body.data.rotated).toBe(true);
    expect(rotatedA.body.data.api_key).toMatch(/^ak_dev_[0-9a-f]{40}$/);
    expect(rotatedA.body.data.api_key).not.toBe(devA.body.data.api_key);
    expect(rotatedA.body.data.install_command).toContain(rotatedA.body.data.api_key);

    // Old device A key is revoked (401), new device A key works (200)
    const oldKeyHb = await reqJson(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': devA.body.data.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: regAOmitId.body.data.agent_id }),
    });
    expect(oldKeyHb.res.status).toBe(401);

    const newKeyHb = await reqJson(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': rotatedA.body.data.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: regAOmitId.body.data.agent_id }),
    });
    expect(newKeyHb.res.status).toBe(200);

    // Sibling device B's bound key and global admin key remain unaffected
    const sibPoll = await reqJson(
      app,
      `/api/agent/commands?agent_id=${regB.body.data.agent_id}`,
      { headers: { 'X-API-Key': devB.body.data.api_key } },
    );
    expect(sibPoll.res.status).toBe(200);

    const globalDevices = await reqJson(app, '/api/devices', {
      headers: { 'X-API-Key': globalKey.api_key },
    });
    expect(globalDevices.res.status).toBe(200);

    // e) Legacy device without bound key gets one on deploy-key, and deleting device removes its bound key
    await driver.run('DELETE FROM api_keys WHERE device_id = ?', [devB.body.data.id]);
    const legacyDeploy = await reqJson<{
      id: string;
      device_id: string;
      api_key: string;
      created: boolean;
      rotated: boolean;
    }>(app, `/api/devices/${devB.body.data.id}/deploy-key`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(legacyDeploy.res.status).toBe(200);
    expect(legacyDeploy.body.data.device_id).toBe(devB.body.data.id);
    expect(legacyDeploy.body.data.created).toBe(true);
    expect(legacyDeploy.body.data.rotated).toBe(false);
    expect(legacyDeploy.body.data.api_key).toMatch(/^ak_dev_/);

    // Deleting device B removes its bound key and revokes agent access
    const delB = await reqJson(app, `/api/devices/${devB.body.data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(delB.res.status).toBe(200);

    const boundRowBAfterDelete = await driver.get<{ id: string }>(
      'SELECT id FROM api_keys WHERE device_id = ?',
      [devB.body.data.id],
    );
    expect(boundRowBAfterDelete).toBeNull();

    const deletedKeyReg = await reqJson(app, '/api/agent/register', {
      method: 'POST',
      headers: { 'X-API-Key': legacyDeploy.body.data.api_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'linux', version: '4.2.0' }),
    });
    expect(deletedKeyReg.res.status).toBe(401);

    // Unrecoverable encrypted key (e.g. rotated CSLITE_ENCRYPTION_KEY) gracefully rebinds on deploy-key
    await driver.run('UPDATE api_keys SET key_secret = ? WHERE device_id = ?', [
      'enc1:000000000000000000000000:deadbeefdeadbeefdeadbeefdeadbeef',
      devA.body.data.id,
    ]);
    const recoveredDeploy = await reqJson<{ api_key: string; created: boolean; rotated: boolean }>(
      app,
      `/api/devices/${devA.body.data.id}/deploy-key`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );
    expect(recoveredDeploy.res.status).toBe(200);
    expect(recoveredDeploy.body.data.created).toBe(true);
    expect(recoveredDeploy.body.data.rotated).toBe(false);
    expect(recoveredDeploy.body.data.api_key).toMatch(/^ak_dev_/);

    // Batch-delete also removes bound api_keys
    const batchDel = await reqJson(app, '/api/devices/batch-delete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [devA.body.data.id] }),
    });
    expect(batchDel.res.status).toBe(200);
    const remainingDevKeys = await driver.all<{ id: string }>(
      'SELECT id FROM api_keys WHERE device_id IS NOT NULL',
    );
    expect(remainingDevKeys).toHaveLength(0);

    // CSLITE_SECRET fallback & plain: fallback when no encryption key is configured
    const secretFallbackConfig = buildConfig({ CSLITE_SECRET: 'fallback-secret' }, 'node');
    expect(secretFallbackConfig.encryptionKey).toBe('fallback-secret');
    const plainConfig = buildConfig({}, 'node');
    expect(plainConfig.encryptionKey).toBeUndefined();
    const { sealApiKeySecret, unsealApiKeySecret } = await import('../src/lib/crypto');
    const plainSealed = await sealApiKeySecret('ak_dev_test', plainConfig.encryptionKey);
    expect(plainSealed).toBe('plain:ak_dev_test');
    expect(await unsealApiKeySecret(plainSealed)).toBe('ak_dev_test');
    const encSealed = await sealApiKeySecret('ak_dev_test', secretFallbackConfig.encryptionKey);
    expect(encSealed).toMatch(/^enc1:/);
    expect(await unsealApiKeySecret(encSealed, 'wrong-secret')).toBeNull();
    expect(await unsealApiKeySecret(encSealed, 'fallback-secret')).toBe('ak_dev_test');
  });

  it('upgrades legacy SQLite api_keys tables missing device_id/key_secret and guards MySQL 8.4 DDL via information_schema', async () => {
    const legacyDriver = await createNodeSqliteDriver(':memory:');
    driversToClose.push(legacyDriver);

    // Simulate pre-existing legacy SQLite api_keys table without device_id / key_secret
    await legacyDriver.run(
      'CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, last_used TEXT, created_at TEXT NOT NULL)',
    );
    const legacyConfig = buildConfig(
      { CSLITE_ADMIN_USERNAME: 'admin', CSLITE_ADMIN_PASSWORD: 'admin' },
      'node',
    );
    const legacyApp = createApp(legacyDriver, legacyConfig);

    const sys = await reqJson(legacyApp, '/api/system/info');
    expect(sys.res.status).toBe(200);

    const cols = await legacyDriver.all<{ name: string }>('PRAGMA table_info(api_keys)');
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('device_id');
    expect(colNames).toContain('key_secret');

    // Verify MySQL 8.4 migration helper checks information_schema without IF NOT EXISTS
    const executedMysqlSql: string[] = [];
    const mockMysqlDriver: SqlDriver = {
      dialect: 'mysql',
      async all<T>(sql: string): Promise<T[]> {
        executedMysqlSql.push(sql);
        if (sql.includes('information_schema.COLUMNS')) {
          return [{ COLUMN_NAME: 'id' }, { COLUMN_NAME: 'key_hash' }] as T[];
        }
        return [] as T[];
      },
      async get<T>(sql: string): Promise<T | null> {
        executedMysqlSql.push(sql);
        return null;
      },
      async run(sql: string) {
        executedMysqlSql.push(sql);
        return { changes: 0 };
      },
      async batch() {
        return [];
      },
    };
    const { ensureApiKeyDeviceColumns } = await import('../src/db/migrate');
    await ensureApiKeyDeviceColumns(mockMysqlDriver);
    expect(executedMysqlSql).toEqual([
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_keys'",
      'ALTER TABLE api_keys ADD COLUMN device_id VARCHAR(64) NULL',
      'ALTER TABLE api_keys ADD COLUMN key_secret VARCHAR(512) NULL',
      "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_keys' AND INDEX_NAME = 'idx_api_keys_device_id' LIMIT 1",
      'ALTER TABLE api_keys ADD INDEX idx_api_keys_device_id (device_id)',
    ]);
    for (const sql of executedMysqlSql) {
      expect(sql).not.toMatch(/IF NOT EXISTS/i);
    }
  });

  it('supports server timezone configuration (env + system_settings), DST-safe nextCronAfter, and timezone-aware cron scheduling', async () => {
    // 1. Direct nextCronAfter DST & IANA timezone unit verification
    // Asia/Shanghai (UTC+8): 09:00 CST = 01:00 UTC
    expect(nextCronAfter('0 9 * * *', new Date('2026-06-01T00:30:00.000Z'), 'Asia/Shanghai')).toBe(
      '2026-06-01T01:00:00.000Z',
    );
    expect(nextCronAfter('0 9 * * *', new Date('2026-06-01T01:00:00.000Z'), 'Asia/Shanghai')).toBe(
      '2026-06-02T01:00:00.000Z',
    );

    // America/New_York spring forward (2026-03-08 02:00 EST -> 03:00 EDT):
    // 00:00 on 2026-03-08 must NOT be skipped when stepping from 2026-03-07
    expect(
      nextCronAfter('0 0 * * *', new Date('2026-03-07T06:00:00.000Z'), 'America/New_York'),
    ).toBe('2026-03-08T05:00:00.000Z');
    // 03:00 EDT after 01:30 EST on spring-forward day -> 07:00Z
    expect(
      nextCronAfter('0 3 * * *', new Date('2026-03-08T06:30:00.000Z'), 'America/New_York'),
    ).toBe('2026-03-08T07:00:00.000Z');
    // Non-existent 02:30 on 2026-03-08 advances cleanly to 2026-03-09 02:30 EDT (06:30Z)
    expect(
      nextCronAfter('30 2 * * *', new Date('2026-03-08T06:30:00.000Z'), 'America/New_York'),
    ).toBe('2026-03-09T06:30:00.000Z');
    // America/New_York fall back (2026-11-01): 00:00 EDT -> 04:00Z
    expect(
      nextCronAfter('0 0 * * *', new Date('2026-10-31T05:00:00.000Z'), 'America/New_York'),
    ).toBe('2026-11-01T04:00:00.000Z');
    // Invalid timezone falls back cleanly to UTC
    expect(nextCronAfter('0 9 * * *', new Date('2026-06-01T00:30:00.000Z'), 'Invalid/Zone')).toBe(
      '2026-06-01T09:00:00.000Z',
    );

    // 2. TZ / CSLITE_TIMEZONE env resolution & PUT/PATCH /api/system/settings overrides
    const { app, driver } = await setupTestApp({ TZ: 'Asia/Tokyo' });

    const sysInitial = await reqJson<{
      timezone: string;
      timezone_source?: string;
      env_timezone?: string | null;
      log_retention_days?: number;
      log_retention_source?: string;
    }>(app, '/api/system/info');
    expect(sysInitial.res.status).toBe(200);
    expect(sysInitial.body.data).toMatchObject({
      timezone: 'Asia/Tokyo',
      timezone_source: 'env',
      env_timezone: 'Asia/Tokyo',
      log_retention_days: 30,
      log_retention_source: 'default',
      env_log_retention_days: null,
    });

    const adminToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      })
    ).body.data.session_token;

    // Non-admin receives 403 on PUT /api/system/settings
    await reqJson(app, '/api/auth/user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'viewer', password: 'Password123!', role: 0 }),
    });
    const viewerToken = (
      await reqJson<{ session_token: string }>(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'viewer', password: 'Password123!' }),
      })
    ).body.data.session_token;

    const nonAdminSet = await reqJson(app, '/api/system/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${viewerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: 'Asia/Shanghai' }),
    });
    expect(nonAdminSet.res.status).toBe(403);

    // Empty body or invalid timezone returns 400
    const emptySet = await reqJson(app, '/api/system/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(emptySet.res.status).toBe(400);

    const invalidTzSet = await reqJson(app, '/api/system/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: 'Mars/Olympus' }),
    });
    expect(invalidTzSet.res.status).toBe(400);

    // Set timezone to Asia/Shanghai via PUT
    const setShanghai = await reqJson<{
      timezone: string;
      timezone_source?: string;
      env_timezone?: string | null;
    }>(app, '/api/system/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: 'Asia/Shanghai' }),
    });
    expect(setShanghai.res.status).toBe(200);
    expect(setShanghai.body.data).toMatchObject({
      timezone: 'Asia/Shanghai',
      timezone_source: 'setting',
      env_timezone: 'Asia/Tokyo',
    });

    // Cron command schedules in Asia/Shanghai (UTC+8)
    const apiKey = (
      await reqJson<{ api_key: string }>(app, '/api/auth/key', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'tz-key' }),
      })
    ).body.data.api_key;
    const reg = (
      await reqJson<{ agent_id: string; device_id: string }>(app, '/api/agent/register', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'shanghai-node', platform: 'linux', version: '4.0.0' }),
      })
    ).body.data;

    const beforeCmd = new Date();
    const cronRes = await reqJson<{ id: string; next_run: string | null }>(app, '/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'shanghai-daily',
        type: 'cron',
        schedule: '0 9 * * *',
        content: 'uptime',
        target_type: 'devices',
        target_ids: [reg.device_id],
      }),
    });
    const afterCmd = new Date();
    expect(cronRes.res.status).toBe(201);
    const expectedLow = nextCronAfter('0 9 * * *', beforeCmd, 'Asia/Shanghai');
    const expectedHigh = nextCronAfter('0 9 * * *', afterCmd, 'Asia/Shanghai');
    expect([expectedLow, expectedHigh]).toContain(cronRes.body.data.next_run);
    // 09:00 Asia/Shanghai is always 01:00 UTC
    expect(cronRes.body.data.next_run).toMatch(/T01:00:00\.000Z$/);

    // Pause -> backdate -> resume recomputes next_run in Asia/Shanghai
    await reqJson(app, `/api/commands/${cronRes.body.data.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    });
    await driver.run('UPDATE commands SET next_run_at = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      cronRes.body.data.id,
    ]);
    await reqJson(app, `/api/commands/${cronRes.body.data.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });
    const resumedCmd = await driver.get<{ next_run_at: string | null }>(
      'SELECT next_run_at FROM commands WHERE id = ?',
      [cronRes.body.data.id],
    );
    expect(resumedCmd?.next_run_at).toMatch(/T01:00:00\.000Z$/);

    // Reset timezone back to env via PATCH timezone: null
    const resetTz = await reqJson<{ timezone: string; timezone_source?: string }>(
      app,
      '/api/system/settings',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: null }),
      },
    );
    expect(resetTz.res.status).toBe(200);
    expect(resetTz.body.data).toMatchObject({
      timezone: 'Asia/Tokyo',
      timezone_source: 'env',
    });
  });

  it('supports configurable log retention days and manual POST /api/system/cleanup pruning while preserving cron definitions and recent logs', async () => {
    const { app, driver } = await setupTestApp({ CSLITE_LOG_RETENTION_DAYS: '14' });

    const sysEnvOnly = await reqJson<{
      log_retention_days?: number;
      log_retention_source?: string;
      env_log_retention_days?: number | null;
    }>(app, '/api/system/info');
    expect(sysEnvOnly.body.data).toMatchObject({
      log_retention_days: 14,
      log_retention_source: 'env',
      env_log_retention_days: 14,
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
        body: JSON.stringify({ name: 'cleanup-key' }),
      })
    ).body.data.api_key;

    const reg = (
      await reqJson<{ agent_id: string; device_id: string }>(app, '/api/agent/register', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'cleanup-node', platform: 'linux', version: '4.0.0' }),
      })
    ).body.data;

    // Invalid log_retention_days -> 400
    for (const badVal of [-1, 3651, 1.5, 'abc']) {
      const badRes = await reqJson(app, '/api/system/settings', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ log_retention_days: badVal }),
      });
      expect(badRes.res.status).toBe(400);
    }

    // Setting log_retention_days=0 disables automatic cleanup -> manual cleanup without retention_days returns 400
    const disableRes = await reqJson<{ log_retention_days?: number; log_retention_source?: string }>(
      app,
      '/api/system/settings',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ log_retention_days: 0 }),
      },
    );
    expect(disableRes.res.status).toBe(200);
    expect(disableRes.body.data).toMatchObject({
      log_retention_days: 0,
      log_retention_source: 'setting',
    });

    const disabledCleanup = await reqJson(app, '/api/system/cleanup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(disabledCleanup.res.status).toBe(400);

    // Update retention to 7 days (custom setting must override env CSLITE_LOG_RETENTION_DAYS=14)
    const set7Res = await reqJson<{
      log_retention_days?: number;
      log_retention_source?: string;
      env_log_retention_days?: number | null;
    }>(app, '/api/system/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ log_retention_days: 7 }),
    });
    expect(set7Res.res.status).toBe(200);
    expect(set7Res.body.data).toMatchObject({
      log_retention_days: 7,
      log_retention_source: 'setting',
      env_log_retention_days: 14,
    });

    // Seed old (30 days ago) and recent rows across tables + a cron command
    const oldIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recentIso = new Date(Date.now() - 3600_000).toISOString();

    await driver.batch([
      // Old non-cron completed command + execution + result + target
      {
        sql: "INSERT INTO commands (id, name, type, schedule, content, target_type, target_ids_json, timeout, shell, status, next_run_at, created_by, created_at, updated_at) VALUES ('cmd_old_imm', 'old-imm', 'immediate', '', 'echo old', 'devices', '[]', 60, '', 'completed', NULL, 1, ?, ?)",
        params: [oldIso, oldIso],
      },
      {
        sql: "INSERT INTO command_targets (command_id, target_type, target_id) VALUES ('cmd_old_imm', 'devices', ?)",
        params: [reg.device_id],
      },
      {
        sql: "INSERT INTO executions (id, command_id, status, scheduled_for, started_at, completed_at, created_at) VALUES ('exec_old_imm', 'cmd_old_imm', 'completed', NULL, ?, ?, ?)",
        params: [oldIso, oldIso, oldIso],
      },
      {
        sql: "INSERT INTO execution_results (id, execution_id, command_id, device_id, status, exit_code, output, completed_at, created_at, updated_at) VALUES ('res_old_imm', 'exec_old_imm', 'cmd_old_imm', ?, 'completed', 0, 'old out', ?, ?, ?)",
        params: [reg.device_id, oldIso, oldIso, oldIso],
      },
      // Old cron command (must stay!) + old cron execution/result (must be pruned!)
      {
        sql: "INSERT INTO commands (id, name, type, schedule, content, target_type, target_ids_json, timeout, shell, status, next_run_at, created_by, created_at, updated_at) VALUES ('cmd_old_cron', 'old-cron', 'cron', '0 * * * *', 'uptime', 'devices', '[]', 60, '', 'pending', ?, 1, ?, ?)",
        params: [recentIso, oldIso, oldIso],
      },
      {
        sql: "INSERT INTO executions (id, command_id, status, scheduled_for, started_at, completed_at, created_at) VALUES ('exec_old_cron', 'cmd_old_cron', 'completed', ?, ?, ?, ?)",
        params: [oldIso, oldIso, oldIso, oldIso],
      },
      {
        sql: "INSERT INTO execution_results (id, execution_id, command_id, device_id, status, exit_code, output, completed_at, created_at, updated_at) VALUES ('res_old_cron', 'exec_old_cron', 'cmd_old_cron', ?, 'completed', 0, 'cron out', ?, ?, ?)",
        params: [reg.device_id, oldIso, oldIso, oldIso],
      },
      // Recent non-cron completed command + execution + result (must stay!)
      {
        sql: "INSERT INTO commands (id, name, type, schedule, content, target_type, target_ids_json, timeout, shell, status, next_run_at, created_by, created_at, updated_at) VALUES ('cmd_recent_imm', 'recent-imm', 'immediate', '', 'echo new', 'devices', '[]', 60, '', 'completed', NULL, 1, ?, ?)",
        params: [recentIso, recentIso],
      },
      {
        sql: "INSERT INTO executions (id, command_id, status, scheduled_for, started_at, completed_at, created_at) VALUES ('exec_recent_imm', 'cmd_recent_imm', 'completed', NULL, ?, ?, ?)",
        params: [recentIso, recentIso, recentIso],
      },
      {
        sql: "INSERT INTO execution_results (id, execution_id, command_id, device_id, status, exit_code, output, completed_at, created_at, updated_at) VALUES ('res_recent_imm', 'exec_recent_imm', 'cmd_recent_imm', ?, 'completed', 0, 'new out', ?, ?, ?)",
        params: [reg.device_id, recentIso, recentIso, recentIso],
      },
      // Old & recent device_logs
      {
        sql: "INSERT INTO device_logs (id, device_id, type, timestamp, message, metadata_json) VALUES ('dlog_old', ?, 'heartbeat', ?, 'old log', NULL)",
        params: [reg.device_id, oldIso],
      },
      {
        sql: "INSERT INTO device_logs (id, device_id, type, timestamp, message, metadata_json) VALUES ('dlog_new', ?, 'heartbeat', ?, 'new log', NULL)",
        params: [reg.device_id, recentIso],
      },
      // Old & recent audit_logs
      {
        sql: "INSERT INTO audit_logs (id, user_id, username, action, target_id, ip, detail, timestamp) VALUES ('alog_old', 1, 'admin', 'old_action', '', '', NULL, ?)",
        params: [oldIso],
      },
      {
        sql: "INSERT INTO audit_logs (id, user_id, username, action, target_id, ip, detail, timestamp) VALUES ('alog_new', 1, 'admin', 'new_action', '', '', NULL, ?)",
        params: [recentIso],
      },
      // Expired session
      {
        sql: "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ('sess_expired', 1, 'expired_hash_123', ?, ?)",
        params: [oldIso, oldIso],
      },
    ]);

    const cleanupRes = await reqJson<{
      retention_days: number;
      cutoff_at: string;
      ran_at: string;
      deleted: {
        execution_results: number;
        executions: number;
        commands: number;
        device_logs: number;
        audit_logs: number;
        sessions: number;
      };
    }>(app, '/api/system/cleanup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(cleanupRes.res.status).toBe(200);
    expect(cleanupRes.body.data.retention_days).toBe(7);
    expect(cleanupRes.body.data.deleted).toEqual({
      execution_results: 2,
      executions: 2,
      commands: 1,
      device_logs: 1,
      audit_logs: 1,
      sessions: 1,
    });

    // Cron command definition and recent rows remain intact; old non-cron command & target removed
    const oldImmCmd = await driver.get('SELECT id FROM commands WHERE id = ?', ['cmd_old_imm']);
    const oldImmTarget = await driver.get('SELECT command_id FROM command_targets WHERE command_id = ?', [
      'cmd_old_imm',
    ]);
    const oldCronCmd = await driver.get('SELECT id FROM commands WHERE id = ?', ['cmd_old_cron']);
    const recentImmCmd = await driver.get('SELECT id FROM commands WHERE id = ?', ['cmd_recent_imm']);
    const recentRes = await driver.get('SELECT id FROM execution_results WHERE id = ?', [
      'res_recent_imm',
    ]);
    const recentDlog = await driver.get('SELECT id FROM device_logs WHERE id = ?', ['dlog_new']);
    const recentAlog = await driver.get('SELECT id FROM audit_logs WHERE id = ?', ['alog_new']);

    expect(oldImmCmd).toBeNull();
    expect(oldImmTarget).toBeNull();
    expect(oldCronCmd).not.toBeNull();
    expect(recentImmCmd).not.toBeNull();
    expect(recentRes).not.toBeNull();
    expect(recentDlog).not.toBeNull();
    expect(recentAlog).not.toBeNull();

    // GET /api/system/info reports last_cleanup_at and resets retention back to env when null
    const infoAfter = await reqJson<{ last_cleanup_at?: string | null }>(app, '/api/system/info');
    expect(infoAfter.body.data.last_cleanup_at).toBe(cleanupRes.body.data.ran_at);

    const resetRet = await reqJson<{ log_retention_days?: number; log_retention_source?: string }>(
      app,
      '/api/system/settings',
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ log_retention_days: null }),
      },
    );
    expect(resetRet.res.status).toBe(200);
    expect(resetRet.body.data).toMatchObject({
      log_retention_days: 14,
      log_retention_source: 'env',
    });
  });

  it('filters health command logs via source=health, records health_online on offline recovery, and supports comma-separated device log types', async () => {
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
        body: JSON.stringify({ name: 'health-key' }),
      })
    ).body.data.api_key;

    const reg = (
      await reqJson<{ agent_id: string; device_id: string }>(app, '/api/agent/register', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'health-node', platform: 'linux', version: '4.0.0' }),
      })
    ).body.data;

    // Dispatch 2 health-prefixed commands and 1 regular command
    for (const [cmdName, content] of [
      ['health-probe:ping-check', 'ping -c 1 1.1.1.1'],
      ['diag-dns:lookup', 'nslookup example.com'],
      ['regular-task', 'uname -a'],
    ]) {
      await reqJson(app, '/api/commands', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cmdName,
          type: 'immediate',
          content,
          target_type: 'devices',
          target_ids: [reg.device_id],
        }),
      });
    }

    const poll = await reqJson<{
      commands: Array<{ result_id: string; execution_id: string; name?: string }>;
    }>(app, `/api/agent/commands?agent_id=${reg.agent_id}&limit=10`, {
      headers: { 'X-API-Key': apiKey },
    });
    expect(poll.body.data.commands).toHaveLength(3);
    for (const task of poll.body.data.commands) {
      await reqJson(app, '/api/agent/result', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          result_id: task.result_id,
          execution_id: task.execution_id,
          device_id: reg.device_id,
          status: 'completed',
          exit_code: 0,
          output: `ok ${task.name}`,
        }),
      });
    }

    // GET /api/logs/command?source=health returns only health-probe:* and diag-*:*
    const healthLogs = await reqJson<{
      total: number;
      logs: Array<{ command_name?: string }>;
    }>(app, '/api/logs/command?source=health', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(healthLogs.res.status).toBe(200);
    expect(healthLogs.body.data.total).toBe(2);
    expect(healthLogs.body.data.logs.map((l) => l.command_name).sort()).toEqual([
      'diag-dns:lookup',
      'health-probe:ping-check',
    ]);

    // Backdate device last_seen beyond 180s offline threshold, then recover via heartbeat with metrics
    const offlineAt = new Date(Date.now() - 300_000).toISOString();
    await driver.run('UPDATE devices SET last_seen = ?, status = ? WHERE id = ?', [
      offlineAt,
      'offline',
      reg.device_id,
    ]);

    const recoverHb = await reqJson(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: reg.agent_id,
        metrics: {
          cpu_usage: 23.4,
          memory_used: 512,
          memory_total: 1024,
          memory_percent: 50,
          disk_usage: 40,
          network_in: 10,
          network_out: 20,
        },
      }),
    });
    expect(recoverHb.res.status).toBe(200);

    // Comma-separated device log types filter
    const recoveryOnly = await reqJson<{
      total: number;
      logs: Array<{ type: string; message: string }>;
    }>(app, `/api/logs/device?device_id=${reg.device_id}&type=health_online`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(recoveryOnly.res.status).toBe(200);
    expect(recoveryOnly.body.data.total).toBe(1);
    expect(recoveryOnly.body.data.logs[0]?.type).toBe('health_online');
    expect(recoveryOnly.body.data.logs[0]?.message).toContain('CPU 23.4%');
    expect(recoveryOnly.body.data.logs[0]?.message).toContain('Mem 50.0%');

    const multiTypes = await reqJson<{
      total: number;
      logs: Array<{ type: string }>;
    }>(app, `/api/logs/device?device_id=${reg.device_id}&type=health_online,register`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(multiTypes.res.status).toBe(200);
    expect(multiTypes.body.data.total).toBe(2);
    expect(multiTypes.body.data.logs.map((l) => l.type).sort()).toEqual([
      'health_online',
      'register',
    ]);

    // Rapid second online heartbeat within throttle window should NOT duplicate heartbeat log
    await reqJson(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: reg.agent_id,
        metrics: { cpu_usage: 24.0, memory_used: 512, memory_total: 1024, memory_percent: 50, disk_usage: 40, network_in: 12, network_out: 22 },
      }),
    });
    const hbNone = await reqJson<{ total: number }>(
      app,
      `/api/logs/device?device_id=${reg.device_id}&type=heartbeat`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(hbNone.body.data.total).toBe(0);

    // After heartbeat interval elapses, online heartbeat records a throttled heartbeat health log
    const oldHbAt = new Date(Date.now() - 120_000).toISOString();
    await driver.run('UPDATE agents SET last_heartbeat = ? WHERE id = ?', [oldHbAt, reg.agent_id]);
    await reqJson(app, '/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: reg.agent_id,
        metrics: { cpu_usage: 31.2, memory_used: 512, memory_total: 1024, memory_percent: 50, disk_usage: 42, network_in: 15, network_out: 25, ip_addresses: ['1.2.3.4', '2402:4e00::1'] },
      }),
    });

    const hbOnly = await reqJson<{ total: number; logs: Array<{ type: string; message: string }> }>(
      app,
      `/api/logs/device?device_id=${reg.device_id}&type=heartbeat`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(hbOnly.body.data.total).toBe(1);
    expect(hbOnly.body.data.logs[0]?.message).toContain('CPU 31.2%');

    const excludedHb = await reqJson<{ total: number; logs: Array<{ type: string }> }>(
      app,
      `/api/logs/device?device_id=${reg.device_id}&exclude_type=heartbeat`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(excludedHb.body.data.total).toBe(5);
    expect(excludedHb.body.data.logs.some((l) => l.type === 'heartbeat')).toBe(false);
    expect(excludedHb.body.data.logs.some((l) => l.type === 'health_online')).toBe(true);
    expect(excludedHb.body.data.logs.some((l) => l.type === 'command_result')).toBe(true);

    // POST /api/devices/:id/upgrade queues detached upgrade command without leaking API key
    const badVer = await reqJson(app, `/api/devices/${reg.device_id}/upgrade`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 'v1.0;id' }),
    });
    expect(badVer.res.status).toBe(400);

    const badUrl = await reqJson(app, `/api/devices/${reg.device_id}/upgrade`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bin_url: 'javascript:alert(1)' }),
    });
    expect(badUrl.res.status).toBe(400);

    const upgRes = await reqJson<{ command_id: string; execution_id: string; device_id: string; version: string }>(
      app,
      `/api/devices/${reg.device_id}/upgrade`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'v1.1.0' }),
      },
    );
    expect(upgRes.res.status).toBe(201);
    expect(upgRes.body.data.device_id).toBe(reg.device_id);
    expect(upgRes.body.data.version).toBe('v1.1.0');
    const upgCmdRow = await driver.get<{ name: string; content: string }>(
      'SELECT name, content FROM commands WHERE id = ?',
      [upgRes.body.data.command_id],
    );
    expect(upgCmdRow?.name).toContain('agent-upgrade:');
    expect(upgCmdRow?.content).toContain('/u');
    expect(upgCmdRow?.content).toContain('uclient-fetch');
    expect(upgCmdRow?.content).toContain('command -v setsid');
    expect(upgCmdRow?.content).toContain('command -v nohup');
    expect(upgCmdRow?.content).toContain('trap "" HUP TERM');
    expect(upgCmdRow?.content).toContain("trap '' HUP TERM");
    expect(upgCmdRow?.content).toContain('v1.1.0');
    expect(upgCmdRow?.content).not.toContain(apiKey);
  });

  it('supports multi-group device bindings, additive group assignments, group deletion primary fallback, and deduplicated multi-group command execution', async () => {
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
        body: JSON.stringify({ name: 'multi-grp-key' }),
      })
    ).body.data.api_key;

    const createGroup = async (name: string) =>
      (
        await reqJson<{ id: string }>(app, '/api/groups', {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      ).body.data.id;

    const grp1 = await createGroup('prod');
    const grp2 = await createGroup('canary');
    const grp3 = await createGroup('edge');

    // Create device bound to [grp1, grp2]
    const createdDev = await reqJson<{ id: string }>(app, '/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'multi-host-1',
        platform: 'linux',
        group_ids: [grp1, grp2],
      }),
    });
    expect(createdDev.res.status).toBe(201);
    const devId = createdDev.body.data.id;

    // Bind agent so we can poll commands later
    const reg = (
      await reqJson<{ agent_id: string; device_id: string }>(app, '/api/agent/register', {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: devId,
          platform: 'linux',
          version: '4.0.0',
        }),
      })
    ).body.data;

    const detail1 = await reqJson<{ group_id: string | null; group_ids?: string[] }>(
      app,
      `/api/devices/${devId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(detail1.res.status).toBe(200);
    expect(detail1.body.data.group_ids?.slice().sort()).toEqual([grp1, grp2].sort());
    expect(detail1.body.data.group_ids).toContain(detail1.body.data.group_id);

    // PATCH device group_ids replaces membership -> [grp2, grp3]
    const patched = await reqJson<{ group_id: string | null; group_ids?: string[] }>(
      app,
      `/api/devices/${devId}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_ids: [grp2, grp3] }),
      },
    );
    expect(patched.res.status).toBe(200);
    expect(patched.body.data.group_ids?.slice().sort()).toEqual([grp2, grp3].sort());

    // PUT /api/groups/:id/devices is additive and preserves grp2 & grp3
    const addToGrp1 = await reqJson(app, `/api/groups/${grp1}/devices`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [devId] }),
    });
    expect(addToGrp1.res.status).toBe(200);

    const detailAfterAdd = await reqJson<{ group_ids?: string[] }>(app, `/api/devices/${devId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(detailAfterAdd.body.data.group_ids?.slice().sort()).toEqual([grp1, grp2, grp3].sort());

    // GET /api/groups reports accurate device_count and device_ids for all 3 groups
    const groupsList = await reqJson<{
      groups: Array<{ id: string; device_count: number; device_ids?: string[] }>;
    }>(app, '/api/groups', { headers: { Authorization: `Bearer ${adminToken}` } });
    for (const gid of [grp1, grp2, grp3]) {
      const g = groupsList.body.data.groups.find((item) => item.id === gid);
      expect(g?.device_count).toBe(1);
      expect(g?.device_ids).toEqual([devId]);
    }

    // GET /api/devices?group= matches all bound groups, and ?group=__none__ excludes it
    for (const gid of [grp1, grp2, grp3]) {
      const byGrp = await reqJson<{ total: number; devices: Array<{ id: string }> }>(
        app,
        `/api/devices?group=${gid}`,
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      expect(byGrp.body.data.total).toBe(1);
      expect(byGrp.body.data.devices[0]?.id).toBe(devId);
    }
    const ungrouped = await reqJson<{ total: number }>(app, '/api/devices?group=__none__', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(ungrouped.body.data.total).toBe(0);

    // Command targeting [grp1, grp2] deduplicates execution_results for shared device
    const batchCmd = await reqJson<{ id: string }>(app, '/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'multi-grp-imm',
        type: 'immediate',
        content: 'hostname',
        target_type: 'groups',
        target_ids: [grp1, grp2],
      }),
    });
    expect(batchCmd.res.status).toBe(201);

    const execResults = await driver.all<{ id: string; device_id: string }>(
      'SELECT id, device_id FROM execution_results WHERE command_id = ?',
      [batchCmd.body.data.id],
    );
    expect(execResults).toHaveLength(1);
    expect(execResults[0]?.device_id).toBe(devId);

    const pollTasks = await reqJson<{ commands: Array<{ command_id: string }> }>(
      app,
      `/api/agent/commands?agent_id=${reg.agent_id}`,
      { headers: { 'X-API-Key': apiKey } },
    );
    expect(pollTasks.body.data.commands).toHaveLength(1);
    expect(pollTasks.body.data.commands[0]?.command_id).toBe(batchCmd.body.data.id);

    // Cron targeting non-primary group grp1 still matches device on poll and schedules once
    const multiCron = await reqJson<{ id: string }>(app, '/api/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'multi-grp-cron',
        type: 'cron',
        schedule: '* * * * *',
        content: 'date',
        target_type: 'groups',
        target_ids: [grp1, grp2],
      }),
    });
    expect(multiCron.res.status).toBe(201);

    // GET /api/commands?device= finds multi-group cron even before execution_results exist
    const cmdsByDev = await reqJson<{ commands: Array<{ id: string }> }>(
      app,
      `/api/commands?device=${devId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(cmdsByDev.body.data.commands.map((c) => c.id)).toContain(multiCron.body.data.id);

    await driver.run('UPDATE commands SET next_run_at = ? WHERE id = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      multiCron.body.data.id,
    ]);
    const cronPoll = await reqJson<{ commands: Array<{ command_id: string }> }>(
      app,
      `/api/agent/commands?agent_id=${reg.agent_id}`,
      { headers: { 'X-API-Key': apiKey } },
    );
    expect(cronPoll.body.data.commands).toHaveLength(1);
    expect(cronPoll.body.data.commands[0]?.command_id).toBe(multiCron.body.data.id);

    // Removing primary group syncs devices.group_id to next remaining group
    const beforeRemove = await reqJson<{ group_id: string | null; group_ids?: string[] }>(
      app,
      `/api/devices/${devId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const primaryGroupId = beforeRemove.body.data.group_id!;
    const remainingTwo = beforeRemove.body.data.group_ids!.filter((g) => g !== primaryGroupId);
    expect(remainingTwo).toHaveLength(2);

    await reqJson(app, `/api/groups/${primaryGroupId}/devices`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [devId] }),
    });
    const afterRemove = await reqJson<{ group_id: string | null; group_ids?: string[] }>(
      app,
      `/api/devices/${devId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(afterRemove.body.data.group_ids?.slice().sort()).toEqual(remainingTwo.slice().sort());
    expect(remainingTwo).toContain(afterRemove.body.data.group_id);

    // Deleting current primary group updates devices.group_id to the last remaining group
    const secondPrimary = afterRemove.body.data.group_id!;
    const lastGroup = remainingTwo.find((g) => g !== secondPrimary)!;
    await reqJson(app, `/api/groups/${secondPrimary}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const afterGrpDelete = await reqJson<{ group_id: string | null; group_ids?: string[] }>(
      app,
      `/api/devices/${devId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(afterGrpDelete.body.data.group_id).toBe(lastGroup);
    expect(afterGrpDelete.body.data.group_ids).toEqual([lastGroup]);

    // Deleting device cleans up device_groups rows
    await reqJson(app, `/api/devices/${devId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const leftoverDg = await driver.all('SELECT * FROM device_groups WHERE device_id = ?', [devId]);
    expect(leftoverDg).toHaveLength(0);
  });

  it('enforces origin-secret guard and security/cache headers', async () => {
    const secret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const { app, driver } = await setupTestApp({
      CSLITE_ORIGIN_SECRET: secret,
    });

    // Missing or wrong secret is rejected with 403 and zero-byte body BEFORE migration
    for (const target of ['/', '/health', '/api/system/info']) {
      const noHdr = await app.request(target);
      expect(noHdr.status).toBe(403);
      expect(await noHdr.text()).toBe('');

      const badHdr = await app.request(target, {
        headers: { 'X-CSLite-Origin-Secret': 'wrong-secret' },
      });
      expect(badHdr.status).toBe(403);
      expect(await badHdr.text()).toBe('');
    }

    const tablesBefore = await driver.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    );
    expect(tablesBefore).toHaveLength(0);

    // Matching origin secret passes through and emits Referrer-Policy + scoped Cache-Control headers
    const okUi = await app.request('/', {
      headers: { 'X-CSLite-Origin-Secret': secret },
    });
    expect(okUi.status).toBe(200);
    expect(okUi.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(okUi.headers.get('cache-control')).toBe('public, max-age=300');

    const okApi = await app.request('/api/system/info', {
      headers: { 'X-CSLite-Origin-Secret': secret },
    });
    expect(okApi.status).toBe(200);
    expect(okApi.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(okApi.headers.get('cache-control')).toBe('no-store');
  });

  it('aggregates 1h/24h/7d/30d health-history from device_logs with timezone alignment and ownership scoping', async () => {
    const { app, driver } = await setupTestApp({ CSLITE_HEARTBEAT_INTERVAL: '60' });

    // Unauthenticated rejected
    const noAuth = await app.request('/api/devices/health-history?range=24h');
    expect(noAuth.status).toBe(401);

    // Login admin
    const adminLogin = await reqJson<{ session_token: string }>(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const adminToken = adminLogin.body.data.session_token;

    // Create normal user via admin endpoint to test device_id ownership isolation
    const aliceCreate = await reqJson<{ id: number }>(app, '/api/auth/user', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'AlicePass123!', role: 0 }),
    });
    expect(aliceCreate.res.status).toBe(201);
    const aliceLogin = await reqJson<{ session_token: string }>(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'AlicePass123!' }),
    });
    const aliceToken = aliceLogin.body.data.session_token;

    // Invalid range -> 400
    const badRange = await reqJson(app, '/api/devices/health-history?range=99d', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(badRange.res.status).toBe(400);

    // Create two admin devices: dev1 (tracked for 3d) and dev2 (brand new, never seen -> empty)
    const dev1 = await reqJson<{ id: string }>(app, '/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'prod-vps', platform: 'linux' }),
    });
    const dev2 = await reqJson<{ id: string }>(app, '/api/devices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pending-node', platform: 'openwrt' }),
    });
    const id1 = dev1.body.data.id;
    const id2 = dev2.body.data.id;

    // Non-admin ownership & missing checks
    const forbidden = await reqJson(app, `/api/devices/health-history?device_id=${id1}`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    expect(forbidden.res.status).toBe(403);
    const notFound = await reqJson(app, '/api/devices/health-history?device_id=dev_missing', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(notFound.res.status).toBe(404);

    // Initially with 0 heartbeat logs & no last_seen -> empty buckets and null uptime
    const emptyHist = await reqJson<{
      overall_uptime_pct: number | null;
      buckets: Array<{ status: string }>;
      devices: Array<{ device_id: string; uptime_pct: number | null }>;
    }>(app, `/api/devices/health-history?range=24h&device_id=${id1}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(emptyHist.res.status).toBe(200);
    expect(emptyHist.body.data.overall_uptime_pct).toBeNull();
    expect(emptyHist.body.data.buckets).toHaveLength(24);
    expect(emptyHist.body.data.buckets.every((b) => b.status === 'empty')).toBe(true);

    // Seed dev1 created_at & last_seen + real heartbeat logs across 5m / hour / day buckets
    const nowMs = Date.now();
    const threeDaysAgoIso = new Date(nowMs - 3 * 86_400_000).toISOString();
    await driver.run('UPDATE devices SET created_at = ?, last_seen = ?, status = ? WHERE id = ?', [
      threeDaysAgoIso,
      new Date(nowMs - 5_000).toISOString(),
      'online',
      id1,
    ]);

    const hbStmts: Array<{ sql: string; params: Array<string | number> }> = [];
    let seq = 0;
    const addHb = (tsMs: number) => {
      hbStmts.push({
        sql: "INSERT INTO device_logs (id, device_id, type, timestamp, message, metadata_json) VALUES (?, ?, 'heartbeat', ?, 'ok', NULL)",
        params: [`hb_test_${++seq}`, id1, new Date(tsMs).toISOString()],
      });
    };

    // Anchor earliest telemetry 3 days ago + full hour 2h ago (60 HBs) + partial hour 1h ago (20 HBs -> warn)
    const curHourStart = Math.floor(nowMs / 3_600_000) * 3_600_000;
    addHb(nowMs - 2 * 86_400_000);
    for (let m = 0; m < 60; m++) addHb(curHourStart - 2 * 3_600_000 + m * 60_000 + 5_000);
    for (let m = 0; m < 20; m++) addHb(curHourStart - 1 * 3_600_000 + m * 60_000 + 5_000);

    // Full 5m slot right before current 5m slot for 1h test (5 HBs)
    const cur5mStart = Math.floor(nowMs / 300_000) * 300_000;
    for (let k = 0; k < 5; k++) addHb(cur5mStart - 300_000 + k * 60_000 + 5_000);
    await driver.batch(hbStmts);

    // 1h range -> 12 x 5m buckets, second-to-last bucket is ok with 5/5
    const h1 = await reqJson<{
      range: string;
      granularity: string;
      bucket_seconds: number;
      buckets: Array<{ status: string; samples: number }>;
    }>(app, `/api/devices/health-history?range=1h&device_id=${id1}&tz=Asia/Shanghai`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(h1.res.status).toBe(200);
    expect(h1.body.data.granularity).toBe('5m');
    expect(h1.body.data.bucket_seconds).toBe(300);
    expect(h1.body.data.buckets).toHaveLength(12);
    expect(h1.body.data.buckets[10]?.status).toBe('ok');
    expect(h1.body.data.buckets[10]?.samples).toBeGreaterThanOrEqual(5);

    // 24h fleet -> 24 x 1h buckets; buckets before trackingStart are 'empty'; -2h is 'ok'; -1h is 'warn'; pending dev2 stays empty
    const h24 = await reqJson<{
      range: string;
      granularity: string;
      timezone: string;
      overall_uptime_pct: number | null;
      buckets: Array<{ status: string; samples: number; total_devices: number }>;
      devices: Array<{ device_id: string; uptime_pct: number | null; slots: string[] }>;
    }>(app, '/api/devices/health-history?range=24h&tz=Asia/Shanghai', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(h24.res.status).toBe(200);
    expect(h24.body.data.granularity).toBe('hour');
    expect(h24.body.data.timezone).toBe('Asia/Shanghai');
    expect(h24.body.data.buckets).toHaveLength(24);
    expect(h24.body.data.buckets[21]?.status).toBe('ok');
    expect(h24.body.data.buckets[22]?.status).toBe('warn');
    expect(h24.body.data.devices.find((d) => d.device_id === id2)?.uptime_pct).toBeNull();
    expect(h24.body.data.overall_uptime_pct).not.toBeNull();

    // 7d and 30d + timezone label check (Asia/Shanghai vs UTC)
    const h7 = await reqJson<{
      granularity: string;
      bucket_seconds: number;
      buckets: Array<{ label: string; status: string }>;
    }>(app, '/api/devices/health-history?range=7d&tz=UTC', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(h7.res.status).toBe(200);
    expect(h7.body.data.granularity).toBe('day');
    expect(h7.body.data.bucket_seconds).toBe(86400);
    expect(h7.body.data.buckets).toHaveLength(7);
    expect(h7.body.data.buckets.slice(0, 4).every((b) => b.status === 'empty')).toBe(true);

    const h30 = await reqJson<{ buckets: Array<{ status: string }> }>(
      app,
      '/api/devices/health-history?range=30d&tz=Asia/Shanghai',
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(h30.res.status).toBe(200);
    expect(h30.body.data.buckets).toHaveLength(30);
    expect(h30.body.data.buckets[0]?.status).toBe('empty');
  });

  it('does not starve device_logs heartbeats when 60s agent heartbeats arrive under 300s server interval', async () => {
    vi.useFakeTimers();
    try {
      const baseMs = Date.parse('2026-11-28T10:00:00.000Z');
      vi.setSystemTime(baseMs);
      const { app, driver } = await setupTestApp({ CSLITE_HEARTBEAT_INTERVAL: '300' });

      const login = await reqJson(app, '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin' }),
      });
      const cookie = extractCookieValue(login.res.headers.get('set-cookie'));

      const dev = await reqJson<{ id: string; api_key: string }>(app, '/api/devices', {
        method: 'POST',
        headers: { Cookie: `cslite_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'go-node', platform: 'linux' }),
      });
      const reg = await reqJson<{ agent_id: string }>(app, '/api/agent/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: dev.body.data.api_key,
          device_id: dev.body.data.id,
          name: 'go-node',
          platform: 'linux',
          arch: 'amd64',
          version: 'v1.2.1',
        }),
      });
      const agentId = reg.body.data.agent_id;

      // Send 60s heartbeats for 6 minutes (t=0, 1m, 2m, 3m, 4m, 5m)
      // Under server heartbeatInterval=300s (minGap=225s), logs must be written at t=0 and t=4m (240s >= 225s)
      for (let m = 0; m <= 5; m++) {
        vi.setSystemTime(baseMs + m * 60_000);
        const hb = await reqJson(app, '/api/agent/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': dev.body.data.api_key },
          body: JSON.stringify({
            agent_id: agentId,
            metrics: { cpu_usage: 5 + m, memory_used: 100, memory_total: 1000 },
          }),
        });
        expect(hb.res.status).toBe(200);
      }

      const logs = await driver.all<{ timestamp: string }>(
        "SELECT timestamp FROM device_logs WHERE device_id = ? AND type = 'heartbeat' ORDER BY timestamp ASC",
        [dev.body.data.id],
      );
      expect(logs).toHaveLength(2);
      expect(logs[0]?.timestamp).toBe('2026-11-28T10:00:00.000Z');
      expect(logs[1]?.timestamp).toBe('2026-11-28T10:04:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('computes earliestTelemetryMs per device in fleet health-history so older devices do not turn newer logs red', async () => {
    const { app, driver } = await setupTestApp({ CSLITE_HEARTBEAT_INTERVAL: '300' });
    const login = await reqJson(app, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    const cookie = extractCookieValue(login.res.headers.get('set-cookie'));

    const oldDev = await reqJson<{ id: string }>(app, '/api/devices', {
      method: 'POST',
      headers: { Cookie: `cslite_session=${cookie}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'old-lite', platform: 'openwrt' }),
    });
    const newLogDev = await reqJson<{ id: string }>(app, '/api/devices', {
      method: 'POST',
      headers: { Cookie: `cslite_session=${cookie}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-go', platform: 'linux' }),
    });

    const nowMs = Date.now();
    const oldCreated = new Date(nowMs - 24 * 3600_000).toISOString();
    const nowIso = new Date(nowMs - 10_000).toISOString();
    await driver.run('UPDATE devices SET created_at = ?, last_seen = ? WHERE id IN (?, ?)', [
      oldCreated,
      nowIso,
      oldDev.body.data.id,
      newLogDev.body.data.id,
    ]);

    // old-lite has logs across the entire 1h window; new-go only has a log in the latest 5m bucket
    for (let i = 0; i < 12; i++) {
      await driver.run(
        'INSERT INTO device_logs (id, device_id, type, timestamp, message, metadata_json) VALUES (?, ?, ?, ?, ?, NULL)',
        [
          `dlog_old_${i}`,
          oldDev.body.data.id,
          'heartbeat',
          new Date(nowMs - (11 - i) * 300_000).toISOString(),
          'ok',
        ],
      );
    }
    await driver.run(
      'INSERT INTO device_logs (id, device_id, type, timestamp, message, metadata_json) VALUES (?, ?, ?, ?, ?, NULL)',
      ['dlog_new_cur', newLogDev.body.data.id, 'heartbeat', nowIso, 'ok'],
    );

    const h1 = await reqJson<{
      devices: Array<{ device_id: string; uptime_pct: number | null; slots: string[] }>;
    }>(app, '/api/devices/health-history?range=1h', {
      headers: { Cookie: `cslite_session=${cookie}` },
    });
    expect(h1.res.status).toBe(200);
    const newSummary = h1.body.data.devices.find((d) => d.device_id === newLogDev.body.data.id);
    expect(newSummary?.uptime_pct).toBe(100);
    expect(newSummary?.slots.slice(0, 11).every((s) => s === 'empty')).toBe(true);
    expect(newSummary?.slots[11]).toBe('ok');
  });
});
