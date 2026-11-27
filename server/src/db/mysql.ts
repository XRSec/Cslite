import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import type { RunResult, SqlDriver, SqlParam, SqlStatement } from './driver';

const GO_MYSQL_DSN_RE = /^(.*)@(?:tcp)?\(([^)]+)\)\/([^?]*)(?:\?(.*))?$/;
const GO_MYSQL_ONLY_PARAMS = new Set([
  'parsetime',
  'loc',
  'collation',
  'tls',
  'allownativepasswords',
  'allowallfiles',
  'allowcleartextpasswords',
  'allowfallbacktoplaintext',
  'allowoldpasswords',
  'checkconnliveness',
  'clientfoundrows',
  'columnswithalias',
  'interpolateparams',
  'maxallowedpacket',
  'readtimeout',
  'rejectreadonly',
  'timeout',
  'writetimeout',
  'connectionattributes',
]);

function filterMysqlQueryParams(rawQuery: string): string {
  const params = new URLSearchParams(rawQuery);
  const kept = new URLSearchParams();
  for (const [key, val] of params.entries()) {
    const lower = key.toLowerCase();
    if (GO_MYSQL_ONLY_PARAMS.has(lower)) {
      continue;
    }
    if (lower === 'charset') {
      const firstCharset = val.split(',')[0]?.trim();
      if (firstCharset) {
        kept.set('charset', firstCharset);
      }
      continue;
    }
    kept.set(key, val);
  }
  return kept.toString();
}

export function isGoMysqlDsn(rawDsn: string): boolean {
  return GO_MYSQL_DSN_RE.test(rawDsn.trim());
}

/**
 * Normalizes standard `mysql://` URLs and Go-style `user:pass@tcp(host:port)/db?...` DSNs
 * into a clean `mysql://` URI safe for `mysql2`.
 */
export function normalizeMysqlDsn(rawDsn: string): string {
  const trimmed = rawDsn.trim();
  if (/^mysql:\/\//i.test(trimmed)) {
    const qIdx = trimmed.indexOf('?');
    if (qIdx === -1) return trimmed;
    const base = trimmed.slice(0, qIdx);
    const qs = filterMysqlQueryParams(trimmed.slice(qIdx + 1));
    return qs ? `${base}?${qs}` : base;
  }

  const match = GO_MYSQL_DSN_RE.exec(trimmed);
  if (!match) {
    return trimmed;
  }

  const [, auth = '', hostPort = '', dbName = '', queryRaw = ''] = match;
  let authPrefix = '';
  if (auth) {
    const colonIdx = auth.indexOf(':');
    if (colonIdx === -1) {
      authPrefix = `${encodeURIComponent(auth)}@`;
    } else {
      const user = auth.slice(0, colonIdx);
      const pass = auth.slice(colonIdx + 1);
      authPrefix = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
    }
  }

  const encodedDb = dbName ? encodeURIComponent(dbName) : '';
  const qs = queryRaw ? filterMysqlQueryParams(queryRaw) : '';
  return `mysql://${authPrefix}${hostPort}/${encodedDb}${qs ? `?${qs}` : ''}`;
}

/**
 * Builds a MySQL URI from MDM-style environment variables when `MYSQL_HOST` and `MYSQL_DATABASE` are set.
 */
export function buildMysqlDsnFromEnv(env: Record<string, string | undefined>): string | null {
  const host = (env.MYSQL_HOST || '').trim();
  const database = (env.MYSQL_DATABASE || '').trim();
  if (!host || !database) {
    return null;
  }
  const user = (env.MYSQL_USER || '').trim();
  if (!user) {
    throw new Error('MYSQL_USER is required when MYSQL_HOST and MYSQL_DATABASE are set');
  }
  const port = (env.MYSQL_PORT || '').trim() || '3306';
  const password = env.MYSQL_PASSWORD ?? '';
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const auth = password
    ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
    : encodeURIComponent(user);
  return `mysql://${auth}@${formattedHost}:${port}/${encodeURIComponent(database)}`;
}

/**
 * Resolves a normalized MySQL DSN from `CSLITE_DB_DSN` or `MYSQL_*` variables when MySQL is active.
 */
export function resolveMysqlDsn(env: Record<string, string | undefined>): string | null {
  const dbDriver = (env.CSLITE_DB_DRIVER || '').trim().toLowerCase();
  const rawDsn = (env.CSLITE_DB_DSN || '').trim();

  if (dbDriver && dbDriver !== 'mysql') {
    return null;
  }

  if (rawDsn) {
    if (/^mysql:\/\//i.test(rawDsn) || isGoMysqlDsn(rawDsn) || dbDriver === 'mysql') {
      return normalizeMysqlDsn(rawDsn);
    }
    return null;
  }

  const envDsn = buildMysqlDsnFromEnv(env);
  if (envDsn) {
    return envDsn;
  }

  if (dbDriver === 'mysql') {
    throw new Error(
      'CSLITE_DB_DSN or MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE is required when CSLITE_DB_DRIVER=mysql',
    );
  }

  return null;
}

function normalizeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) {
      out[k] = v.toISOString();
    } else if (typeof v === 'bigint') {
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export async function createMysqlDriver(dsn: string): Promise<SqlDriver> {
  const mysql = await import('mysql2/promise');
  const poolSize = Number.parseInt(process.env.CSLITE_MYSQL_POOL_SIZE || '3', 10);
  const connectionLimit = Number.isFinite(poolSize) && poolSize > 0 ? poolSize : 3;
  const useSsl = (process.env.MYSQL_SSL || '').trim().toLowerCase() === 'true';

  const pool = mysql.createPool({
    uri: normalizeMysqlDsn(dsn),
    connectionLimit,
    waitForConnections: true,
    timezone: 'Z',
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 5000,
    ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  return {
    dialect: 'mysql',
    async all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]> {
      const [rows] = await pool.query<RowDataPacket[]>(sql, params ?? []);
      return rows.map((row) => normalizeRow<T>(row as Record<string, unknown>));
    },
    async get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null> {
      const [rows] = await pool.query<RowDataPacket[]>(sql, params ?? []);
      if (rows.length === 0) return null;
      return normalizeRow<T>(rows[0] as Record<string, unknown>);
    },
    async run(sql: string, params?: SqlParam[]): Promise<RunResult> {
      const [header] = await pool.query<ResultSetHeader>(sql, params ?? []);
      return {
        changes: Number(header.affectedRows ?? 0),
        lastInsertRowid: header.insertId ? Number(header.insertId) : undefined,
      };
    },
    async batch(stmts: SqlStatement[]): Promise<RunResult[]> {
      if (stmts.length === 0) return [];
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const out: RunResult[] = [];
        for (const s of stmts) {
          const [header] = await conn.query<ResultSetHeader>(s.sql, s.params ?? []);
          out.push({
            changes: Number(header.affectedRows ?? 0),
            lastInsertRowid: header.insertId ? Number(header.insertId) : undefined,
          });
        }
        await conn.commit();
        return out;
      } catch (err) {
        try {
          await conn.rollback();
        } catch {
          // ignore secondary rollback failure
        }
        throw err;
      } finally {
        conn.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
