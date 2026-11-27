import type { AppConfig } from '../config';
import type { SqlDriver } from '../db/driver';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getTzValidator(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz });
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

/**
 * Validates an IANA timezone identifier without Node-specific imports (Cloudflare Worker safe).
 */
export function isValidTimeZone(tz: string): boolean {
  const trimmed = tz.trim();
  if (!trimmed || trimmed.length > 64) return false;
  try {
    getTzValidator(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes a timezone string, returning its canonical trimmed form if valid, else null.
 */
export function normalizeTimeZone(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return isValidTimeZone(trimmed) ? trimmed : null;
}

export interface ResolvedTimeZone {
  timezone: string;
  source: 'setting' | 'env' | 'default';
  envTimezone: string | null;
  settingTimezone: string | null;
}

/**
 * Resolves effective server timezone: DB system_settings > CSLITE_TIMEZONE/TZ env > UTC.
 */
export async function resolveEffectiveTimeZone(
  driver: SqlDriver,
  config: AppConfig,
): Promise<ResolvedTimeZone> {
  const envTimezone = normalizeTimeZone(config.timezone) ?? null;
  let settingTimezone: string | null = null;

  try {
    const row = await driver.get<{ value: string }>(
      "SELECT value FROM system_settings WHERE key_name = 'timezone' LIMIT 1",
    );
    settingTimezone = normalizeTimeZone(row?.value);
  } catch {
    settingTimezone = null;
  }

  if (settingTimezone) {
    return { timezone: settingTimezone, source: 'setting', envTimezone, settingTimezone };
  }
  if (envTimezone) {
    return { timezone: envTimezone, source: 'env', envTimezone, settingTimezone: null };
  }
  return { timezone: 'UTC', source: 'default', envTimezone: null, settingTimezone: null };
}
