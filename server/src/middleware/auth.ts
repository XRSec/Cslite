import type { Context, MiddlewareHandler } from 'hono';
import { ErrorCode, UserRole } from '../../../shared/types';
import type { AppConfig } from '../config';
import type { SqlDriver } from '../db/driver';
import { sha256Hex } from '../lib/crypto';
import { fail } from '../lib/response';

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export type AuthMethod = 'cookie' | 'bearer' | 'api_key';

export interface AppEnv {
  Variables: {
    driver: SqlDriver;
    config: AppConfig;
    user: AuthUser;
    authMethod: AuthMethod;
    sessionTokenHash?: string;
  };
}

export const SESSION_COOKIE_NAME = 'cslite_session';
export const LEGACY_SESSION_COOKIE_NAME = 'session';
const API_KEY_LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

export function isCookieSecure(c: Context, config: AppConfig): boolean {
  if (config.cookieSecure !== undefined) {
    return config.cookieSecure;
  }
  const xfp = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (xfp === 'https') return true;
  if (xfp === 'http') return false;
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function buildSessionCookieHeader(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (maxAgeSeconds <= 0) {
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

export interface ApiKeyAuthResult {
  user: AuthUser;
  apiKeyId: string;
  boundDeviceId: string | null;
}

export async function authenticateApiKeyWithScope(
  driver: SqlDriver,
  rawKey: string,
  nowIso: string = new Date().toISOString(),
): Promise<ApiKeyAuthResult | null> {
  if (!rawKey) return null;
  const keyHash = await sha256Hex(rawKey);
  const row = await driver.get<
    AuthUser & { api_key_id: string; last_used: string | null; bound_device_id: string | null }
  >(
    'SELECT u.id, u.username, u.email, u.role, u.created_at, u.updated_at, ak.id AS api_key_id, ak.last_used, ak.device_id AS bound_device_id FROM api_keys ak INNER JOIN users u ON u.id = ak.user_id WHERE ak.key_hash = ? LIMIT 1',
    [keyHash],
  );
  if (!row) return null;

  const nowMs = Date.parse(nowIso);
  const lastUsedMs = row.last_used ? Date.parse(row.last_used) : 0;
  if (!row.last_used || !Number.isFinite(lastUsedMs) || nowMs - lastUsedMs > API_KEY_LAST_USED_THROTTLE_MS) {
    await driver.run('UPDATE api_keys SET last_used = ? WHERE id = ?', [
      nowIso,
      row.api_key_id,
    ]);
  }

  return {
    user: {
      id: Number(row.id),
      username: row.username,
      email: row.email,
      role: (Number(row.role) === UserRole.ADMIN ? UserRole.ADMIN : UserRole.USER) as UserRole,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    apiKeyId: row.api_key_id,
    boundDeviceId: row.bound_device_id ?? null,
  };
}

export async function authenticateApiKey(
  driver: SqlDriver,
  rawKey: string,
  nowIso: string = new Date().toISOString(),
): Promise<AuthUser | null> {
  const res = await authenticateApiKeyWithScope(driver, rawKey, nowIso);
  return res ? res.user : null;
}

function getRequestHostCandidates(c: Context): string[] {
  const hosts = new Set<string>();
  const xfh = c.req.header('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase();
  if (xfh) hosts.add(xfh);
  const host = c.req.header('host')?.trim().toLowerCase();
  if (host) hosts.add(host);
  try {
    const urlHost = new URL(c.req.url).host.toLowerCase();
    if (urlHost) hosts.add(urlHost);
  } catch {
    // ignore malformed URL
  }
  const publicBaseUrl = (c.get('config') as AppConfig | undefined)?.publicBaseUrl;
  if (publicBaseUrl) {
    try {
      const publicHost = new URL(publicBaseUrl).host.toLowerCase();
      if (publicHost) hosts.add(publicHost);
    } catch {
      // ignore malformed publicBaseUrl
    }
  }
  return [...hosts];
}

function verifyCsrf(c: Context): boolean {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  const requestHosts = getRequestHostCandidates(c);
  const origin = c.req.header('origin');
  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      return requestHosts.includes(originHost);
    } catch {
      return false;
    }
  }

  const referer = c.req.header('referer');
  if (referer) {
    try {
      const refererHost = new URL(referer).host.toLowerCase();
      return requestHosts.includes(refererHost);
    } catch {
      return false;
    }
  }

  const contentType = (c.req.header('content-type') || '').toLowerCase();
  return contentType.includes('application/json');
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const driver = c.get('driver');
  const nowIso = new Date().toISOString();

  const apiKeyHeader = c.req.header('x-api-key')?.trim();
  const authHeader = c.req.header('authorization')?.trim();
  const bearerToken = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';

  if (apiKeyHeader || bearerToken.startsWith('ak_')) {
    const rawKey = apiKeyHeader || bearerToken;
    const authRes = await authenticateApiKeyWithScope(driver, rawKey, nowIso);
    if (!authRes) {
      return fail(c, ErrorCode.UNAUTHORIZED, 'Invalid API key', 401);
    }
    if (authRes.boundDeviceId) {
      return fail(
        c,
        ErrorCode.FORBIDDEN,
        'Device-scoped API key cannot access management APIs',
        403,
      );
    }
    c.set('user', authRes.user);
    c.set('authMethod', 'api_key');
    return next();
  }

  let sessionToken = '';
  let authMethod: AuthMethod = 'cookie';

  if (bearerToken) {
    sessionToken = bearerToken;
    authMethod = 'bearer';
  } else {
    const cookies = parseCookies(c.req.header('cookie'));
    sessionToken = cookies[SESSION_COOKIE_NAME] || cookies[LEGACY_SESSION_COOKIE_NAME] || '';
    authMethod = 'cookie';
  }

  if (!sessionToken) {
    return fail(c, ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
  }

  const tokenHash = await sha256Hex(sessionToken);
  const row = await driver.get<AuthUser & { expires_at: string }>(
    'SELECT u.id, u.username, u.email, u.role, u.created_at, u.updated_at, s.expires_at FROM sessions s INNER JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? LIMIT 1',
    [tokenHash],
  );

  if (!row || row.expires_at <= nowIso) {
    if (row && row.expires_at <= nowIso) {
      await driver.run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash]);
    }
    return fail(c, ErrorCode.UNAUTHORIZED, 'Session expired or invalid', 401);
  }

  if (authMethod === 'cookie' && !verifyCsrf(c)) {
    return fail(c, ErrorCode.FORBIDDEN, 'CSRF check failed', 403);
  }

  c.set('user', {
    id: Number(row.id),
    username: row.username,
    email: row.email,
    role: (Number(row.role) === UserRole.ADMIN ? UserRole.ADMIN : UserRole.USER) as UserRole,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
  c.set('authMethod', authMethod);
  c.set('sessionTokenHash', tokenHash);

  return next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user || user.role !== UserRole.ADMIN) {
    return fail(c, ErrorCode.FORBIDDEN, 'Admin privilege required', 403);
  }
  return next();
};
