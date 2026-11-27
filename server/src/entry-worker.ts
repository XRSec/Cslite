import type { D1Database, ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { buildConfig, createApp } from './app';
import { createD1Driver } from './db/d1';
import type { SqlDriver } from './db/driver';
import { ensureMigrated } from './db/migrate';
import { createTursoDriver } from './db/turso';
import { maybeRunScheduledCleanup } from './lib/cleanup';

export interface WorkerEnv {
  DB?: D1Database;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  CSLITE_VERSION?: string;
  CSLITE_ADMIN_USERNAME?: string;
  CSLITE_ADMIN_PASSWORD?: string;
  CSLITE_ALLOW_REGISTRATION?: string;
  CSLITE_HEARTBEAT_INTERVAL?: string;
  CSLITE_POLL_INTERVAL?: string;
  CSLITE_SESSION_TTL?: string;
  CSLITE_COOKIE_SECURE?: string;
  CSLITE_DEFAULT_TIMEOUT?: string;
  CSLITE_TIMEZONE?: string;
  TZ?: string;
  CSLITE_LOG_RETENTION_DAYS?: string;
  CSLITE_ORIGIN_SECRET?: string;
  CSLITE_ORIGIN_SECRET_HEADER?: string;
  [key: string]: unknown;
}

const d1Drivers = new WeakMap<D1Database, SqlDriver>();
const tursoDrivers = new Map<string, SqlDriver>();

function resolveWorkerDriver(env: WorkerEnv): SqlDriver | null {
  if (typeof env.TURSO_DATABASE_URL === 'string' && env.TURSO_DATABASE_URL.trim()) {
    const url = env.TURSO_DATABASE_URL.trim();
    const token = typeof env.TURSO_AUTH_TOKEN === 'string' ? env.TURSO_AUTH_TOKEN.trim() : '';
    const cacheKey = `${url}|${token}`;
    let driver = tursoDrivers.get(cacheKey);
    if (!driver) {
      driver = createTursoDriver(url, token || undefined);
      tursoDrivers.set(cacheKey, driver);
    }
    return driver;
  }

  if (env.DB) {
    let driver = d1Drivers.get(env.DB);
    if (!driver) {
      driver = createD1Driver(env.DB);
      d1Drivers.set(env.DB, driver);
    }
    return driver;
  }

  return null;
}

function toStringEnv(env: WorkerEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const driver = resolveWorkerDriver(env);
    if (!driver) {
      return new Response(
        JSON.stringify({
          code: 50001,
          message: 'Database binding DB or TURSO_DATABASE_URL is not configured',
          data: null,
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        },
      );
    }

    const config = buildConfig(toStringEnv(env), 'cloudflare-worker');
    const app = createApp(driver, config);
    return app.fetch(request);
  },

  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const driver = resolveWorkerDriver(env);
    if (!driver) return;
    const config = buildConfig(toStringEnv(env), 'cloudflare-worker');
    await ensureMigrated(driver, config);
    await maybeRunScheduledCleanup(driver, config);
  },
};
