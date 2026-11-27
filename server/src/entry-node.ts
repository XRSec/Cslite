import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { serve } from '@hono/node-server';
import { buildConfig, createApp } from './app';
import type { SqlDriver } from './db/driver';
import { createMysqlDriver, resolveMysqlDsn } from './db/mysql';
import { createNodeSqliteDriver } from './db/node-sqlite';
import { createTursoDriver } from './db/turso';

async function createNodeDriver(): Promise<SqlDriver> {
  const dbDriver = (process.env.CSLITE_DB_DRIVER || '').trim().toLowerCase();
  const mysqlDsn = resolveMysqlDsn(process.env);
  if (mysqlDsn) {
    return createMysqlDriver(mysqlDsn);
  }

  const tursoUrl = (process.env.TURSO_DATABASE_URL || '').trim();
  if (dbDriver === 'turso' || tursoUrl) {
    if (!tursoUrl) {
      throw new Error('TURSO_DATABASE_URL is required when CSLITE_DB_DRIVER=turso');
    }
    return createTursoDriver(tursoUrl, process.env.TURSO_AUTH_TOKEN?.trim() || undefined);
  }

  const dbPath = (process.env.CSLITE_DB_PATH || './data/cslite.db').trim();
  return createNodeSqliteDriver(dbPath);
}

async function start(): Promise<void> {
  const driver = await createNodeDriver();
  const isScf = Boolean(process.env.SCF_RUNTIMEAPI || process.env.TENCENTCLOUD_RUNENV);
  const config = buildConfig(process.env, isScf ? 'scf' : 'node');
  const app = createApp(driver, config);

  const portRaw =
    process.env.SCF_SERVER_PORT || process.env.PORT || process.env.CSLITE_PORT || '9000';
  const port = Number.parseInt(portRaw, 10) || 9000;
  const hostname = '0.0.0.0';

  const server = serve(
    {
      fetch: app.fetch,
      hostname,
      port,
    },
    (info) => {
      console.log(
        `[cslite] listening on http://${hostname}:${info.port} (dialect=${driver.dialect})`,
      );
    },
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[cslite] received ${signal}, shutting down...`);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await driver.close?.();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('[cslite] fatal startup error:', err);
  process.exit(1);
});
