export type RuntimeKind = 'node' | 'cloudflare-worker' | 'scf';

export interface AppConfig {
  runtime: RuntimeKind;
  version: string;
  adminUsername: string;
  adminPassword: string;
  allowRegistration: boolean;
  heartbeatInterval: number;
  pollInterval: number;
  sessionTtlSeconds: number;
  cookieSecure?: boolean;
  publicBaseUrl?: string;
  defaultTimeoutSeconds: number;
  maxPayloadBytes: number;
  maxOutputBytes: number;
}

function parsePositiveInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = Number.parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalBool(val: string | undefined): boolean | undefined {
  if (val === undefined || val === '') return undefined;
  const lower = val.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return undefined;
}

/**
 * Builds runtime-independent configuration from environment bindings.
 */
export function buildConfig(
  env: Record<string, string | undefined>,
  runtime: RuntimeKind,
): AppConfig {
  const allowReg = parseOptionalBool(env.CSLITE_ALLOW_REGISTRATION);
  const publicBaseUrl =
    (env.PUBLIC_BASE_URL?.trim() || env.CSLITE_PUBLIC_BASE_URL?.trim() || '').replace(/\/+$/, '') ||
    undefined;
  return {
    runtime,
    version: env.CSLITE_VERSION || '4.0.0',
    adminUsername: env.CSLITE_ADMIN_USERNAME || 'admin',
    adminPassword: env.CSLITE_ADMIN_PASSWORD || 'admin',
    allowRegistration: allowReg ?? true,
    heartbeatInterval: parsePositiveInt(env.CSLITE_HEARTBEAT_INTERVAL, 60),
    pollInterval: parsePositiveInt(env.CSLITE_POLL_INTERVAL, 10),
    sessionTtlSeconds: parsePositiveInt(env.CSLITE_SESSION_TTL, 7 * 24 * 3600),
    cookieSecure: parseOptionalBool(env.CSLITE_COOKIE_SECURE),
    publicBaseUrl,
    defaultTimeoutSeconds: parsePositiveInt(env.CSLITE_DEFAULT_TIMEOUT, 1800),
    maxPayloadBytes: 1024 * 1024,
    maxOutputBytes: 256 * 1024,
  };
}
