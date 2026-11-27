import type { DeviceMetrics } from '../../shared/types';

const ESC_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape untrusted text for safe insertion into HTML templates and attributes. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => ESC_MAP[ch] ?? ch);
}

/** Strip ANSI CSI/OSC escape sequences and normalize CRLF line endings. */
export function stripAnsi(text: string): string {
  if (!text) return '';
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/** Clamp a numeric percentage into [0, 100]. */
export function clampPercent(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/** Format raw byte counts into human-readable B/KB/MB/GB/TB strings. */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  const decimals = idx === 0 ? 0 : val >= 100 ? 0 : val >= 10 ? 1 : 2;
  return `${Number(val.toFixed(decimals))} ${units[idx]}`;
}

/** Format memory values reported in MB (or fallback bytes if > 1048576). */
export function formatMemory(val: number | null | undefined): string {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) return '--';
  if (val >= 1048576) return formatBytes(val);
  if (val >= 1024) {
    const gb = val / 1024;
    return `${Number(gb.toFixed(gb >= 10 ? 1 : 2))} GB`;
  }
  return `${Math.round(val)} MB`;
}

/** Compute memory usage percentage from DeviceMetrics. */
export function getMemoryPercent(metrics?: DeviceMetrics | null): number {
  if (!metrics) return 0;
  if (typeof metrics.memory_percent === 'number' && Number.isFinite(metrics.memory_percent)) {
    return clampPercent(metrics.memory_percent);
  }
  if (
    typeof metrics.memory_used === 'number' &&
    typeof metrics.memory_total === 'number' &&
    metrics.memory_total > 0
  ) {
    return clampPercent((metrics.memory_used / metrics.memory_total) * 100);
  }
  return 0;
}

/** Format network throughput rate (KB/s baseline). */
export function formatRate(kbps: number | null | undefined): string {
  if (typeof kbps !== 'number' || !Number.isFinite(kbps) || kbps < 0) return '--';
  if (kbps >= 1024) return `${(kbps / 1024).toFixed(1)} MB/s`;
  return `${Math.round(kbps)} KB/s`;
}

/** Format elapsed seconds into compact human-readable duration. */
export function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '--';
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/** Format elapsed duration between two ISO timestamps. */
export function formatElapsed(startIso?: string | null, endIso?: string | null): string {
  if (!startIso) return '--';
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return '--';
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(end)) return '--';
  const diffMs = Math.max(0, end - start);
  if (diffMs < 1000) return `${diffMs}ms`;
  if (diffMs < 60000) return `${(diffMs / 1000).toFixed(1)}s`;
  return formatDuration(diffMs / 1000);
}

export const TIMEZONE_PRESETS: ReadonlyArray<readonly [string, string]> = [
  ['Asia/Shanghai', 'Asia/Shanghai (UTC+8)'],
  ['Asia/Hong_Kong', 'Asia/Hong_Kong (UTC+8)'],
  ['Asia/Taipei', 'Asia/Taipei (UTC+8)'],
  ['Asia/Singapore', 'Asia/Singapore (UTC+8)'],
  ['Asia/Tokyo', 'Asia/Tokyo (UTC+9)'],
  ['UTC', 'UTC (UTC+0)'],
  ['Europe/London', 'Europe/London'],
  ['Europe/Berlin', 'Europe/Berlin'],
  ['America/New_York', 'America/New_York'],
  ['America/Los_Angeles', 'America/Los_Angeles'],
];

const dtfCache = new Map<string, Intl.DateTimeFormat>();
let activeTimeZone: string | null = null;

function getDtf(tz: string): Intl.DateTimeFormat | null {
  const clean = tz.trim();
  if (!clean) return null;
  let fmt = dtfCache.get(clean);
  if (fmt) return fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: clean,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(clean, fmt);
    return fmt;
  } catch {
    return null;
  }
}

/** Check whether a string is a valid IANA time zone supported by Intl. */
export function isValidTimeZone(tz: string): boolean {
  return typeof tz === 'string' && Boolean(getDtf(tz));
}

/** Set global display timezone for formatDate (null resets to browser local). */
export function setActiveTimeZone(tz: string | null): void {
  const clean = tz?.trim() || null;
  activeTimeZone = clean && clean !== 'browser' && isValidTimeZone(clean) ? clean : null;
}

/** Get current global display timezone (null means browser local). */
export function getActiveTimeZone(): string | null {
  return activeTimeZone;
}

/** Return deduplicated group IDs from device.group_ids falling back to [device.group_id]. */
export function deviceGroupIds(d: { group_id?: string | null; group_ids?: string[] }): string[] {
  const src = d.group_ids?.length ? d.group_ids : d.group_id ? [d.group_id] : [];
  return Array.from(new Set(src.filter(Boolean)));
}

/** Return deduplicated primary + reported interface IPs for a device. */
export function deviceIps(d: {
  ip_address?: string;
  metrics?: { ip_addresses?: string[] } | null;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (ip?: string) => {
    const clean = ip?.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  };
  push(d.ip_address);
  for (const ip of d.metrics?.ip_addresses ?? []) push(ip);
  return out;
}

/** Format an ISO-8601 date string cleanly (YYYY-MM-DD HH:MM:SS) in explicit/active timezone or local time. */
export function formatDate(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return '--';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '--';
  const d = new Date(ms);
  const tz = timeZone !== undefined ? timeZone : activeTimeZone;
  const fmt = tz && tz !== 'browser' ? getDtf(tz) : null;
  if (fmt) {
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
    const hr = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day} ${hr}:${parts.minute}:${parts.second}`;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function relTime(iso: string | null | undefined, nowMs: number, zh: boolean): string {
  if (!iso) return zh ? '从未' : 'never';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return zh ? '从未' : 'never';
  const d = Math.floor((nowMs - ms) / 1000);
  if (d < 0) {
    const a = Math.abs(d);
    const u = a < 60 ? [a, 's', '秒'] : a < 3600 ? [Math.floor(a / 60), 'm', '分钟'] : a < 86400 ? [Math.floor(a / 3600), 'h', '小时'] : [Math.floor(a / 86400), 'd', '天'];
    return zh ? `${u[0]}${u[2]}后` : `in ${u[0]}${u[1]}`;
  }
  if (d < 10) return zh ? '刚刚' : 'just now';
  const u = d < 60 ? [d, 's', '秒'] : d < 3600 ? [Math.floor(d / 60), 'm', '分钟'] : d < 86400 ? [Math.floor(d / 3600), 'h', '小时'] : [Math.floor(d / 86400), 'd', '天'];
  return zh ? `${u[0]}${u[2]}前` : `${u[0]}${u[1]} ago`;
}

/** Format a timestamp as relative time against nowMs. */
export function formatRelativeTime(iso: string | null | undefined, nowMs = Date.now()): string {
  return relTime(iso, nowMs, false);
}

/** Format a timestamp as concise Chinese relative time against nowMs. */
export function formatRelativeZh(iso: string | null | undefined, nowMs = Date.now()): string {
  return relTime(iso, nowMs, true);
}

/** Convert standard 5-field cron expression into a concise human label. */
export function cronLabel(expr: string | null | undefined): string {
  if (!expr) return '--';
  const clean = expr.trim().replace(/\s+/g, ' ');
  if (!clean) return '--';
  const presets: Record<string, string> = {
    '* * * * *': 'Every minute',
    '*/5 * * * *': 'Every 5 minutes',
    '*/10 * * * *': 'Every 10 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '*/30 * * * *': 'Every 30 minutes',
    '0 * * * *': 'Hourly (at :00)',
    '0 0 * * *': 'Daily at 00:00',
    '0 3 * * *': 'Daily at 03:00',
    '0 2 * * 0': 'Weekly (Sun 02:00)',
  };
  if (presets[clean]) return presets[clean];

  const parts = clean.split(' ');
  if (parts.length !== 5) return clean;
  const [min, hour, dom, mon, dow] = parts;

  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const step = Number(min.slice(2));
    if (Number.isInteger(step) && step > 0) return `Every ${step} minutes`;
  }
  if (/^\d+$/.test(min) && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') {
    const step = Number(hour.slice(2));
    if (Number.isInteger(step) && step > 0) {
      return `Every ${step}h at :${min.padStart(2, '0')}`;
    }
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    const hhmm = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    if (dow === '*') return `Daily at ${hhmm}`;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayIdx = Number(dow);
    if (Number.isInteger(dayIdx) && dayIdx >= 0 && dayIdx <= 6) {
      return `Weekly (${days[dayIdx]} ${hhmm})`;
    }
  }
  return clean;
}

export type CanonicalPlatform =
  | 'linux'
  | 'openwrt'
  | 'macos'
  | 'windows'
  | 'android'
  | 'unix'
  | 'other';

/** Normalize platform string (e.g. "linux/amd64", "darwin", "android", "unix") to canonical category. */
export function platformMeta(platform?: string | null): { key: CanonicalPlatform; label: string } {
  const p = (platform ?? '').toLowerCase();
  if (p.includes('openwrt')) return { key: 'openwrt', label: 'OpenWrt' };
  if (p.includes('android')) return { key: 'android', label: 'Android' };
  if (p.includes('mac') || p.includes('darwin')) return { key: 'macos', label: 'macOS' };
  if (p.includes('win')) return { key: 'windows', label: 'Windows' };
  if (p.includes('linux')) return { key: 'linux', label: 'Linux' };
  if (p.includes('unix')) return { key: 'unix', label: 'UNIX' };
  return { key: 'other', label: platform ? platform : 'Other' };
}

export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

export type InstallTabId = 'unix' | 'windows' | 'android';

export interface InstallCommandInput {
  deviceId: string;
  name: string;
  origin: string;
  apiKey?: string;
  serverCommands?: Record<string, string>;
}

/** Substitute API key and server origin placeholders without mangling quotes or flags. */
export function substituteInstallTokens(
  raw: string,
  origin: string,
  apiKey?: string,
): string {
  const key = (apiKey ?? '').trim() || 'YOUR_API_KEY';
  return raw
    .replace(/<YOUR_API_KEY>|<API_KEY>|YOUR_API_KEY/g, () => key)
    .replace(/<SERVER_URL>|https?:\/\/your-server(?::\d+)?/g, () => origin);
}

/** Build 3-family auto-detect install commands for UNIX (Linux/OpenWrt/macOS), Windows, and Android. */
export function buildInstallCommands(input: InstallCommandInput): Record<InstallTabId, string> {
  const { deviceId, origin, apiKey, serverCommands } = input;
  const srv = serverCommands ?? {};
  const sub = (raw?: string): string | null =>
    raw ? substituteInstallTokens(raw, origin, apiKey) : null;

  return {
    unix:
      sub(srv.unix) ??
      substituteInstallTokens(
        `curl -fsSL ${origin}/i | sh -s -- YOUR_API_KEY ${deviceId}`,
        origin,
        apiKey,
      ),
    windows:
      sub(srv.windows) ??
      substituteInstallTokens(
        `$k="YOUR_API_KEY";$d="${deviceId}";irm ${origin}/i.ps1|iex`,
        origin,
        apiKey,
      ),
    android:
      sub(srv.android) ??
      substituteInstallTokens(
        `curl -fsSL ${origin}/ia | sh -s -- YOUR_API_KEY ${deviceId}`,
        origin,
        apiKey,
      ),
  };
}

export interface NoCurlInstallCommand {
  tool: 'wget' | 'uclient-fetch';
  command: string;
}

/** Build 1-line fallback install commands for UNIX/Android hosts without curl (e.g. OpenWrt). */
export function buildNoCurlInstallCommands(
  tab: InstallTabId,
  origin: string,
  deviceId: string,
  apiKey?: string,
): NoCurlInstallCommand[] {
  if (tab === 'windows') return [];
  const key = (apiKey ?? '').trim() || 'YOUR_API_KEY';
  const route = tab === 'android' ? 'ia' : 'i';
  const list: NoCurlInstallCommand[] = [
    { tool: 'wget', command: `wget -qO- ${origin}/${route} | sh -s -- ${key} ${deviceId}` },
  ];
  if (tab === 'unix') {
    list.push({
      tool: 'uclient-fetch',
      command: `uclient-fetch -qO- ${origin}/${route} | sh -s -- ${key} ${deviceId}`,
    });
  }
  return list;
}

/** Compute lightweight line-by-line comparison between baseline and target outputs. */
export function computeDiffLines(
  baseline: string,
  target: string,
): { identical: boolean; lines: DiffLine[] } {
  const a = stripAnsi(baseline);
  const b = stripAnsi(target);
  if (a === b) {
    return {
      identical: true,
      lines: b ? b.split('\n').map((text) => ({ kind: 'same' as const, text })) : [],
    };
  }
  const aLines = a ? a.split('\n') : [];
  const bLines = b ? b.split('\n') : [];
  const lines: DiffLine[] = [];
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    const al = aLines[i];
    const bl = bLines[i];
    if (al === bl && al !== undefined) {
      lines.push({ kind: 'same', text: bl });
    } else {
      if (al !== undefined) lines.push({ kind: 'del', text: al });
      if (bl !== undefined) lines.push({ kind: 'add', text: bl });
    }
  }
  return { identical: false, lines };
}
