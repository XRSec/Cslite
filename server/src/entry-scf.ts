import { webcrypto } from 'node:crypto';
if (!(globalThis as { crypto?: unknown }).crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

import { buildConfig, createApp, type AppConfig } from './app';
import type { SqlDriver } from './db/driver';
import { createMysqlDriver, resolveMysqlDsn } from './db/mysql';
import { createNodeSqliteDriver } from './db/node-sqlite';
import { createTursoDriver } from './db/turso';

export interface ScfApiGatewayEvent {
  httpMethod?: string;
  path?: string;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  queryStringParameters?: Record<string, string>;
  multiValueQueryStringParameters?: Record<string, string[]>;
  queryString?: Record<string, string>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
  };
}

export interface ScfContext {
  callbackWaitsForEmptyEventLoop?: boolean;
  request_id?: string;
  [key: string]: unknown;
}

export interface ScfApiGatewayResponse {
  isBase64Encoded: boolean;
  statusCode: number;
  headers: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  body: string;
}

let cachedDriverPromise: Promise<SqlDriver> | null = null;

async function resolveScfDriver(): Promise<SqlDriver> {
  if (!cachedDriverPromise) {
    cachedDriverPromise = (async () => {
      const dbDriver = (process.env.CSLITE_DB_DRIVER || '').trim().toLowerCase();
      const mysqlDsn = resolveMysqlDsn(process.env);
      if (mysqlDsn) {
        return createMysqlDriver(mysqlDsn);
      }

      const tursoUrl = (process.env.TURSO_DATABASE_URL || '').trim();
      if (dbDriver === 'turso' || tursoUrl) {
        if (!tursoUrl) {
          throw new Error('TURSO_DATABASE_URL is required for Turso');
        }
        return createTursoDriver(tursoUrl, process.env.TURSO_AUTH_TOKEN?.trim() || undefined);
      }

      const dbPath = (process.env.CSLITE_DB_PATH || '/tmp/cslite.db').trim();
      return createNodeSqliteDriver(dbPath);
    })().catch((err) => {
      cachedDriverPromise = null;
      throw err;
    });
  }
  return cachedDriverPromise;
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildRequestFromScfEvent(event: ScfApiGatewayEvent): Request {
  const method = (
    event.httpMethod ||
    event.requestContext?.http?.method ||
    'GET'
  ).toUpperCase();

  const headers = new Headers();
  if (event.headers) {
    for (const [k, v] of Object.entries(event.headers)) {
      if (v !== undefined && v !== null) {
        headers.set(k, String(v));
      }
    }
  }
  if (event.multiValueHeaders) {
    for (const [k, list] of Object.entries(event.multiValueHeaders)) {
      if (Array.isArray(list) && list.length > 0) {
        headers.delete(k);
        for (const v of list) {
          headers.append(k, String(v));
        }
      }
    }
  }

  const host = headers.get('x-forwarded-host') || headers.get('host') || 'localhost';
  const proto = headers.get('x-forwarded-proto') || 'https';
  const rawPath = event.path || event.requestContext?.http?.path || '/';
  const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

  const query = new URLSearchParams();
  if (event.multiValueQueryStringParameters) {
    for (const [k, vals] of Object.entries(event.multiValueQueryStringParameters)) {
      if (Array.isArray(vals)) {
        for (const v of vals) {
          query.append(k, String(v));
        }
      }
    }
  } else {
    const singleParams = event.queryStringParameters || event.queryString;
    if (singleParams) {
      for (const [k, v] of Object.entries(singleParams)) {
        if (v !== undefined && v !== null) {
          query.append(k, String(v));
        }
      }
    }
  }

  const qs = query.toString();
  const url = `${proto}://${host}${normalizedPath}${qs ? `?${qs}` : ''}`;

  const init: RequestInit = {
    method,
    headers,
  };

  if (method !== 'GET' && method !== 'HEAD' && event.body != null && event.body !== '') {
    if (event.isBase64Encoded) {
      init.body = decodeBase64Bytes(event.body);
    } else {
      init.body = event.body;
    }
  }

  return new Request(url, init);
}

/**
 * Builds a testable Tencent SCF APIGW handler bound to an explicit driver/config.
 */
export function createScfHandler(
  getDriver: () => Promise<SqlDriver> = resolveScfDriver,
  overrideConfig?: AppConfig,
) {
  return async (
    event: ScfApiGatewayEvent,
    context?: ScfContext,
  ): Promise<ScfApiGatewayResponse> => {
    if (context && typeof context === 'object') {
      context.callbackWaitsForEmptyEventLoop = false;
    }

    const driver = await getDriver();
    const config = overrideConfig ?? buildConfig(process.env, 'scf');
    const app = createApp(driver, config);

    const req = buildRequestFromScfEvent(event);
    const res = await app.fetch(req);

    const outHeaders: Record<string, string> = {};
    const multiValueHeaders: Record<string, string[]> = {};

    const setCookies =
      typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      multiValueHeaders['Set-Cookie'] = setCookies;
    }

    res.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        if (!multiValueHeaders['Set-Cookie']) {
          multiValueHeaders['Set-Cookie'] = [value];
        }
        return;
      }
      outHeaders[key] = value;
    });

    const body = await res.text();
    return {
      isBase64Encoded: false,
      statusCode: res.status,
      headers: outHeaders,
      ...(Object.keys(multiValueHeaders).length > 0 ? { multiValueHeaders } : {}),
      body,
    };
  };
}

export const main_handler = createScfHandler();
export const handler = main_handler;
