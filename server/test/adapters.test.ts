import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfig } from '../src/config';
import { createD1Driver } from '../src/db/d1';
import type { SqlDriver } from '../src/db/driver';
import { createNodeSqliteDriver } from '../src/db/node-sqlite';
import { MYSQL_DDL_STATEMENTS } from '../src/db/schema';
import { createTursoDriver, encodeTursoArgs, normalizeTursoUrl } from '../src/db/turso';
import { createScfHandler } from '../src/entry-scf';

const drivers: SqlDriver[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (drivers.length > 0) {
    await drivers.pop()!.close?.();
  }
});

describe('Runtime Isolation, SCF, Turso, D1 & MySQL Adapters', () => {
  it('keeps app.ts and entry-worker.ts free of Node-only and mysql2 imports', () => {
    const appSrc = readFileSync(resolve(process.cwd(), 'server/src/app.ts'), 'utf8');
    const workerSrc = readFileSync(resolve(process.cwd(), 'server/src/entry-worker.ts'), 'utf8');
    const forbidden = ['node:sqlite', 'node:crypto', 'node:fs', '@hono/node-server', 'mysql2'];

    for (const mod of forbidden) {
      expect(appSrc).not.toContain(mod);
      expect(workerSrc).not.toContain(mod);
    }
  });

  it('keeps 0001_init.sql clean single-line SQL and MySQL DDL valid without TEXT defaults', () => {
    const initSql = readFileSync(resolve(process.cwd(), 'server/migrations/0001_init.sql'), 'utf8');
    expect(initSql).not.toContain('--');
    expect(initSql).not.toContain('/*');
    const lines = initSql.trim().split('\n');
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(line.endsWith(';')).toBe(true);
    }

    const joinedMysql = MYSQL_DDL_STATEMENTS.join('\n');
    expect(joinedMysql).toContain('MEDIUMTEXT');
    expect(joinedMysql).toContain('AUTO_INCREMENT');
    expect(joinedMysql).toContain('`groups`');
    expect(joinedMysql).not.toMatch(/MEDIUMTEXT[^,)]*DEFAULT/i);
    expect(joinedMysql).not.toMatch(/CREATE INDEX IF NOT EXISTS/i);
  });

  it('handles SCF APIGW events: callbackWaitsForEmptyEventLoop, GET without body, base64 POST, query params, Set-Cookie', async () => {
    const driver = await createNodeSqliteDriver(':memory:');
    drivers.push(driver);
    const config = buildConfig(
      { CSLITE_ADMIN_USERNAME: 'admin', CSLITE_ADMIN_PASSWORD: 'admin' },
      'scf',
    );
    const scfHandler = createScfHandler(async () => driver, config);

    const ctx1 = { callbackWaitsForEmptyEventLoop: true };
    const healthResp = await scfHandler(
      {
        httpMethod: 'GET',
        path: '/health',
        body: '',
      },
      ctx1,
    );
    expect(ctx1.callbackWaitsForEmptyEventLoop).toBe(false);
    expect(healthResp.statusCode).toBe(200);
    expect(JSON.parse(healthResp.body).data.runtime).toBe('scf');

    // Base64-encoded login event produces Set-Cookie in multiValueHeaders
    const loginPayload = Buffer.from(
      JSON.stringify({ username: 'admin', password: 'admin' }),
      'utf8',
    ).toString('base64');
    const loginResp = await scfHandler({
      httpMethod: 'POST',
      path: '/api/auth/login',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        host: 'scf.example.com',
      },
      body: loginPayload,
      isBase64Encoded: true,
    });
    expect(loginResp.statusCode).toBe(200);
    const setCookies = loginResp.multiValueHeaders?.['Set-Cookie'] ?? [];
    expect(setCookies.length).toBe(1);
    expect(setCookies[0]).toContain('cslite_session=');
    expect(setCookies[0]).toContain('Secure');

    const token = JSON.parse(loginResp.body).data.session_token as string;

    // GET with queryStringParameters
    const devCreateResp = await scfHandler({
      httpMethod: 'POST',
      path: '/api/devices',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'scf-dev', platform: 'linux' }),
    });
    const devId = JSON.parse(devCreateResp.body).data.id as string;

    const statusResp = await scfHandler({
      httpMethod: 'GET',
      path: '/api/devices/status',
      headers: { authorization: `Bearer ${token}` },
      queryStringParameters: { id: devId },
    });
    expect(statusResp.statusCode).toBe(200);
    expect(JSON.parse(statusResp.body).data.id).toBe(devId);
  });

  it('serializes Turso integer params as stringified decimals and executes pipeline batches', async () => {
    expect(normalizeTursoUrl('libsql://demo-db.turso.io/')).toBe('https://demo-db.turso.io');
    expect(encodeTursoArgs([42, 3.14, null, 'hello'])).toEqual([
      { type: 'integer', value: '42' },
      { type: 'float', value: 3.14 },
      { type: 'null' },
      { type: 'text', value: 'hello' },
    ]);

    const requestsCaptured: Array<{ url: string; body: unknown; auth: string | null }> = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const parsedBody = JSON.parse(String(init?.body ?? '{}'));
      const hdrs = new Headers(init?.headers);
      requestsCaptured.push({
        url: String(url),
        body: parsedBody,
        auth: hdrs.get('Authorization'),
      });

      if (parsedBody.requests.length === 2) {
        return new Response(
          JSON.stringify({
            results: [
              {
                type: 'ok',
                response: {
                  type: 'execute',
                  result: {
                    cols: [{ name: 'id' }, { name: 'username' }],
                    rows: [[{ type: 'integer', value: '7' }, { type: 'text', value: 'admin' }]],
                    affected_row_count: 0,
                    last_insert_rowid: null,
                  },
                },
              },
              { type: 'ok', response: { type: 'close' } },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          results: [
            { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } },
            { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: '10' } } },
            { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null } } },
            { type: 'ok', response: { type: 'close' } },
          ],
        }),
        { status: 200 },
      );
    });

    const turso = createTursoDriver('libsql://unit-test.turso.io', 'tok_123');
    const row = await turso.get<{ id: number; username: string }>(
      'SELECT id, username FROM users WHERE id = ?',
      [7],
    );
    expect(row).toEqual({ id: 7, username: 'admin' });
    expect(requestsCaptured[0]?.url).toBe('https://unit-test.turso.io/v2/pipeline');
    expect(requestsCaptured[0]?.auth).toBe('Bearer tok_123');

    const batchRes = await turso.batch([
      { sql: 'INSERT INTO users (username) VALUES (?)', params: ['bob'] },
    ]);
    expect(batchRes).toEqual([{ changes: 1, lastInsertRowid: 10 }]);
    expect((requestsCaptured[1]?.body as { requests: Array<{ stmt?: { sql: string } }> }).requests.map((r) => r.stmt?.sql)).toEqual([
      'BEGIN',
      'INSERT INTO users (username) VALUES (?)',
      'COMMIT',
      undefined,
    ]);
  });

  it('wraps D1Database batch and coerces changes cleanly', async () => {
    const fakeStmt = (sql: string) => ({
      sql,
      params: [] as unknown[],
      bind(...vals: unknown[]) {
        this.params = vals;
        return this;
      },
      async all() {
        return { results: [{ ok: 1 }], success: true, meta: { changes: 0 } };
      },
      async first() {
        return { ok: 1 };
      },
      async run() {
        return { results: [], success: true, meta: { changes: 2, last_row_id: 5 } };
      },
      async raw() {
        return [];
      },
    });

    const fakeD1 = {
      prepare(sql: string) {
        return fakeStmt(sql);
      },
      async batch(stmts: unknown[]) {
        return stmts.map(() => ({ results: [], success: true, meta: { changes: 1, last_row_id: 9 } }));
      },
    };

    const driver = createD1Driver(fakeD1 as unknown as Parameters<typeof createD1Driver>[0]);
    expect(await driver.get('SELECT 1')).toEqual({ ok: 1 });
    expect(await driver.run('UPDATE t SET a = ?', [1])).toEqual({ changes: 2, lastInsertRowid: 5 });
    expect(await driver.batch([{ sql: 'DELETE FROM t' }])).toEqual([
      { changes: 1, lastInsertRowid: 9 },
    ]);
  });

  it('normalizes MySQL Date objects to UTC ISO-8601 strings and handles batch transactions', async () => {
    const sampleDate = new Date('2026-01-02T03:04:05.000Z');
    const mockPool = {
      query: vi.fn(async () => [[{ id: 1, created_at: sampleDate }], []]),
      getConnection: vi.fn(async () => ({
        beginTransaction: vi.fn(async () => {}),
        query: vi.fn(async () => [{ affectedRows: 1, insertId: 42 }, []]),
        commit: vi.fn(async () => {}),
        rollback: vi.fn(async () => {}),
        release: vi.fn(() => {}),
      })),
      end: vi.fn(async () => {}),
    };

    vi.doMock('mysql2/promise', () => ({
      createPool: vi.fn(() => mockPool),
    }));

    const { createMysqlDriver } = await import('../src/db/mysql');
    const driver = await createMysqlDriver('mysql://user:pass@localhost:3306/cslite');
    const row = await driver.get<{ id: number; created_at: string }>('SELECT id, created_at FROM users');
    expect(row).toEqual({ id: 1, created_at: '2026-01-02T03:04:05.000Z' });

    const batchRes = await driver.batch([{ sql: 'INSERT INTO users VALUES (?)' , params: ['a'] }]);
    expect(batchRes).toEqual([{ changes: 1, lastInsertRowid: 42 }]);
    await driver.close?.();
  });
});
