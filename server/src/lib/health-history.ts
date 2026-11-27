import type {
  DeviceHealthSummaryDTO,
  HealthBucketStatus,
  HealthHistoryBucketDTO,
  HealthHistoryRange,
  HealthHistoryResponse,
} from '../../../shared/types';
import type { AppConfig } from '../config';
import type { SqlDriver } from '../db/driver';

export interface HealthHistoryDeviceInput {
  id: string;
  last_seen: string;
  created_at: string;
}

interface InternalBucket {
  startMs: number;
  endMs: number;
  label: string;
  ymd?: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ymd: string;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = dtfCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(timeZone, fmt);
  }
  return fmt;
}

function getZonedParts(ms: number, fmt: Intl.DateTimeFormat): ZonedParts {
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    parts[p.type] = p.value;
  }
  const hourRaw = parts.hour === '24' ? '00' : (parts.hour ?? '00');
  const monthStr = (parts.month ?? '01').padStart(2, '0');
  const dayStr = (parts.day ?? '01').padStart(2, '0');
  return {
    year: Number.parseInt(parts.year ?? '1970', 10),
    month: Number.parseInt(monthStr, 10),
    day: Number.parseInt(dayStr, 10),
    hour: Number.parseInt(hourRaw, 10),
    minute: Number.parseInt(parts.minute ?? '00', 10),
    second: Number.parseInt(parts.second ?? '00', 10),
    ymd: `${parts.year}-${monthStr}-${dayStr}`,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function zonedMidnightToUtcMs(
  year: number,
  month: number,
  day: number,
  fmt: Intl.DateTimeFormat,
): number {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = getZonedParts(guess, fmt);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
    const diff = target - wall;
    guess += diff;
    if (diff === 0) break;
  }
  return guess;
}

function isOnlineAt(lastSeen: string | null | undefined, nowMs: number, thresholdMs: number): boolean {
  if (!lastSeen) return false;
  const ts = Date.parse(lastSeen);
  return Number.isFinite(ts) && ts > 0 && nowMs - ts <= thresholdMs;
}

export function isValidHealthRange(value: string): value is HealthHistoryRange {
  return value === '1h' || value === '24h' || value === '7d' || value === '30d';
}

function buildBuckets(
  range: HealthHistoryRange,
  nowMs: number,
  fmt: Intl.DateTimeFormat,
): {
  granularity: '5m' | 'hour' | 'day';
  bucketSeconds: number;
  buckets: InternalBucket[];
} {
  if (range === '1h') {
    const stepMs = 300_000;
    const curStart = Math.floor(nowMs / stepMs) * stepMs;
    const buckets: InternalBucket[] = [];
    for (let i = 0; i < 12; i++) {
      const startMs = curStart - (11 - i) * stepMs;
      const p = getZonedParts(startMs, fmt);
      buckets.push({
        startMs,
        endMs: startMs + stepMs,
        label: `${pad2(p.hour)}:${pad2(p.minute)}`,
      });
    }
    return { granularity: '5m', bucketSeconds: 300, buckets };
  }

  if (range === '24h') {
    const stepMs = 3_600_000;
    const curStart = Math.floor(nowMs / stepMs) * stepMs;
    const buckets: InternalBucket[] = [];
    for (let i = 0; i < 24; i++) {
      const startMs = curStart - (23 - i) * stepMs;
      const p = getZonedParts(startMs, fmt);
      buckets.push({
        startMs,
        endMs: startMs + stepMs,
        label: `${pad2(p.hour)}:${p.minute === 0 ? '00' : pad2(p.minute)}`,
      });
    }
    return { granularity: 'hour', bucketSeconds: 3600, buckets };
  }

  const days = range === '7d' ? 7 : 30;
  const today = getZonedParts(nowMs, fmt);
  const buckets: InternalBucket[] = [];
  for (let i = 0; i < days; i++) {
    const offsetDays = days - 1 - i;
    const curUtc = new Date(Date.UTC(today.year, today.month - 1, today.day - offsetDays));
    const y = curUtc.getUTCFullYear();
    const m = curUtc.getUTCMonth() + 1;
    const d = curUtc.getUTCDate();
    const nextUtc = new Date(Date.UTC(y, m - 1, d + 1));
    const startMs = zonedMidnightToUtcMs(y, m, d, fmt);
    const endMs = zonedMidnightToUtcMs(
      nextUtc.getUTCFullYear(),
      nextUtc.getUTCMonth() + 1,
      nextUtc.getUTCDate(),
      fmt,
    );
    const mStr = pad2(m);
    const dStr = pad2(d);
    buckets.push({
      startMs,
      endMs,
      label: `${mStr}-${dStr}`,
      ymd: `${y}-${mStr}-${dStr}`,
    });
  }
  return { granularity: 'day', bucketSeconds: 86400, buckets };
}

/** Aggregate persistent heartbeat history from device_logs over 1h / 24h / 7d / 30d windows. */
export async function buildDeviceHealthHistory(
  driver: SqlDriver,
  config: AppConfig,
  devices: HealthHistoryDeviceInput[],
  opts: {
    range: HealthHistoryRange;
    timeZone: string;
    nowMs?: number;
  },
): Promise<HealthHistoryResponse> {
  const nowMs = opts.nowMs ?? Date.now();
  const fmt = getFormatter(opts.timeZone);
  const { granularity, bucketSeconds, buckets: internalBuckets } = buildBuckets(
    opts.range,
    nowMs,
    fmt,
  );
  const bucketCount = internalBuckets.length;

  if (devices.length === 0) {
    return {
      range: opts.range,
      granularity,
      bucket_seconds: bucketSeconds,
      timezone: opts.timeZone,
      heartbeat_interval: config.heartbeatInterval,
      poll_interval: config.pollInterval,
      generated_at: new Date(nowMs).toISOString(),
      overall_uptime_pct: null,
      buckets: internalBuckets.map((b) => ({
        start: new Date(b.startMs).toISOString(),
        end: new Date(b.endMs).toISOString(),
        label: b.label,
        status: 'empty',
        uptime_pct: null,
        online_devices: 0,
        healthy_devices: 0,
        total_devices: 0,
        samples: 0,
        expected: 0,
      })),
      devices: [],
    };
  }

  const deviceIds = devices.map((d) => d.id);
  const devClause =
    deviceIds.length === 1
      ? 'device_id = ?'
      : `device_id IN (${deviceIds.map(() => '?').join(', ')})`;
  const devCounts = new Map<string, number[]>();
  for (const id of deviceIds) {
    devCounts.set(id, new Array<number>(bucketCount).fill(0));
  }

  const sinceIso = new Date(internalBuckets[0]!.startMs).toISOString();
  const minRow = await driver.get<{ min_ts: string | null }>(
    `SELECT MIN(timestamp) AS min_ts FROM device_logs WHERE type IN ('heartbeat', 'health_online') AND ${devClause}`,
    deviceIds,
  );
  const parsedMinTs = minRow?.min_ts ? Date.parse(minRow.min_ts) : Number.NaN;
  const earliestTelemetryMs = Number.isFinite(parsedMinTs) ? parsedMinTs : null;

  if (opts.range === '1h') {
    const firstStartMs = internalBuckets[0]!.startMs;
    const rows = await driver.all<{ device_id: string; timestamp: string }>(
      `SELECT device_id, timestamp FROM device_logs WHERE type IN ('heartbeat', 'health_online') AND timestamp >= ? AND ${devClause}`,
      [sinceIso, ...deviceIds],
    );
    for (const r of rows) {
      const ts = Date.parse(r.timestamp);
      if (!Number.isFinite(ts)) continue;
      const idx = Math.floor((ts - firstStartMs) / 300_000);
      if (idx >= 0 && idx < bucketCount) {
        const arr = devCounts.get(r.device_id);
        if (arr) arr[idx] = (arr[idx] ?? 0) + 1;
      }
    }
  } else if (opts.range === '24h') {
    const firstStartMs = internalBuckets[0]!.startMs;
    const rows = await driver.all<{ device_id: string; bkey: string; cnt: number }>(
      `SELECT device_id, SUBSTR(timestamp, 1, 13) AS bkey, COUNT(*) AS cnt FROM device_logs WHERE type IN ('heartbeat', 'health_online') AND timestamp >= ? AND ${devClause} GROUP BY device_id, SUBSTR(timestamp, 1, 13)`,
      [sinceIso, ...deviceIds],
    );
    for (const r of rows) {
      const hourMs = Date.parse(`${r.bkey}:00:00.000Z`);
      if (!Number.isFinite(hourMs)) continue;
      const idx = Math.floor((hourMs - firstStartMs) / 3_600_000);
      if (idx >= 0 && idx < bucketCount) {
        const arr = devCounts.get(r.device_id);
        if (arr) arr[idx] = (arr[idx] ?? 0) + Number(r.cnt || 0);
      }
    }
  } else {
    const dayIdxByYmd = new Map<string, number>();
    internalBuckets.forEach((b, idx) => {
      if (b.ymd) dayIdxByYmd.set(b.ymd, idx);
    });
    const rows = await driver.all<{ device_id: string; bkey: string; cnt: number }>(
      `SELECT device_id, SUBSTR(timestamp, 1, 13) AS bkey, COUNT(*) AS cnt FROM device_logs WHERE type IN ('heartbeat', 'health_online') AND timestamp >= ? AND ${devClause} GROUP BY device_id, SUBSTR(timestamp, 1, 13)`,
      [sinceIso, ...deviceIds],
    );
    for (const r of rows) {
      const midMs = Date.parse(`${r.bkey}:30:00.000Z`);
      if (!Number.isFinite(midMs)) continue;
      const idx = dayIdxByYmd.get(getZonedParts(midMs, fmt).ymd);
      if (idx !== undefined) {
        const arr = devCounts.get(r.device_id);
        if (arr) arr[idx] = (arr[idx] ?? 0) + Number(r.cnt || 0);
      }
    }
  }

  const hbSec = Math.max(10, config.heartbeatInterval);
  const onlineThresholdMs = Math.max(config.heartbeatInterval * 3, 90) * 1000;

  const deviceSlotStatuses = new Map<string, HealthBucketStatus[]>();
  const devicePctSums = new Map<string, { sum: number; count: number }>();
  for (const d of devices) {
    deviceSlotStatuses.set(d.id, new Array<HealthBucketStatus>(bucketCount).fill('empty'));
    devicePctSums.set(d.id, { sum: 0, count: 0 });
  }

  const outBuckets: HealthHistoryBucketDTO[] = [];
  let overallPctSum = 0;
  let overallPctWeight = 0;

  for (let i = 0; i < bucketCount; i++) {
    const b = internalBuckets[i]!;
    const isLast = i === bucketCount - 1;
    let totalDevices = 0;
    let healthyDevices = 0;
    let onlineDevices = 0;
    let errDevices = 0;
    let sumPct = 0;
    let totalSamples = 0;
    let totalExpected = 0;

    for (const d of devices) {
      const actual = devCounts.get(d.id)?.[i] ?? 0;
      const createdMsRaw = d.created_at ? Date.parse(d.created_at) : Number.NaN;
      const createdMs = Number.isFinite(createdMsRaw) ? createdMsRaw : b.startMs;
      const trackingStartMs =
        earliestTelemetryMs !== null ? Math.max(createdMs, earliestTelemetryMs) : createdMs;
      const lastSeenMs = d.last_seen ? Date.parse(d.last_seen) : Number.NaN;
      const hasLastSeen = Number.isFinite(lastSeenMs) && lastSeenMs > 0;
      const currentlyOnline = isOnlineAt(d.last_seen, nowMs, onlineThresholdMs);

      const shouldBeEmpty =
        actual === 0 &&
        (!hasLastSeen ||
          (earliestTelemetryMs === null && !isLast) ||
          b.endMs <= trackingStartMs);

      if (shouldBeEmpty) {
        deviceSlotStatuses.get(d.id)![i] = 'empty';
        continue;
      }

      const effEnd = Math.min(b.endMs, nowMs);
      const effStart = trackingStartMs < effEnd ? Math.max(b.startMs, trackingStartMs) : b.startMs;
      const elapsedSec = Math.max(0, (effEnd - effStart) / 1000);
      const expected = Math.max(1, Math.round(elapsedSec / hbSec));

      let effectiveActual = actual;
      let slotStatus: HealthBucketStatus;

      if (isLast && actual === 0) {
        if (currentlyOnline && (elapsedSec < hbSec * 1.5 || earliestTelemetryMs === null)) {
          effectiveActual = 1;
          slotStatus = 'ok';
        } else {
          slotStatus = currentlyOnline ? 'warn' : 'err';
        }
      } else {
        const ratio = Math.min(1, effectiveActual / expected);
        if (isLast && !currentlyOnline) {
          slotStatus = effectiveActual > 0 ? 'warn' : 'err';
        } else if (ratio >= 0.8 || (expected <= 4 && effectiveActual >= Math.max(1, expected - 1))) {
          slotStatus = 'ok';
        } else if (effectiveActual > 0) {
          slotStatus = 'warn';
        } else {
          slotStatus = 'err';
        }
      }

      const ratioForPct =
        isLast && slotStatus === 'ok' && actual === 0 && earliestTelemetryMs === null
          ? 1
          : Math.min(1, effectiveActual / expected);
      const devPct = Math.round(ratioForPct * 1000) / 10;

      deviceSlotStatuses.get(d.id)![i] = slotStatus;
      const agg = devicePctSums.get(d.id)!;
      agg.sum += devPct;
      agg.count += 1;

      totalDevices += 1;
      if (slotStatus === 'ok') healthyDevices += 1;
      if (slotStatus === 'ok' || slotStatus === 'warn') onlineDevices += 1;
      if (slotStatus === 'err') errDevices += 1;
      sumPct += devPct;
      totalSamples += actual;
      totalExpected += expected;
    }

    if (totalDevices === 0) {
      outBuckets.push({
        start: new Date(b.startMs).toISOString(),
        end: new Date(b.endMs).toISOString(),
        label: b.label,
        status: 'empty',
        uptime_pct: null,
        online_devices: 0,
        healthy_devices: 0,
        total_devices: 0,
        samples: 0,
        expected: 0,
      });
    } else {
      const uptimePct = Math.round((sumPct / totalDevices) * 10) / 10;
      const status: HealthBucketStatus =
        errDevices === 0 && (healthyDevices === totalDevices || uptimePct >= 95)
          ? 'ok'
          : onlineDevices > 0
            ? 'warn'
            : 'err';
      overallPctSum += sumPct;
      overallPctWeight += totalDevices;
      outBuckets.push({
        start: new Date(b.startMs).toISOString(),
        end: new Date(b.endMs).toISOString(),
        label: b.label,
        status,
        uptime_pct: uptimePct,
        online_devices: onlineDevices,
        healthy_devices: healthyDevices,
        total_devices: totalDevices,
        samples: totalSamples,
        expected: totalExpected,
      });
    }
  }

  const deviceSummaries: DeviceHealthSummaryDTO[] = devices.map((d) => {
    const agg = devicePctSums.get(d.id)!;
    return {
      device_id: d.id,
      uptime_pct: agg.count > 0 ? Math.round((agg.sum / agg.count) * 10) / 10 : null,
      slots: deviceSlotStatuses.get(d.id)!,
    };
  });

  return {
    range: opts.range,
    granularity,
    bucket_seconds: bucketSeconds,
    timezone: opts.timeZone,
    heartbeat_interval: config.heartbeatInterval,
    poll_interval: config.pollInterval,
    generated_at: new Date(nowMs).toISOString(),
    overall_uptime_pct:
      overallPctWeight > 0 ? Math.round((overallPctSum / overallPctWeight) * 10) / 10 : null,
    buckets: outBuckets,
    devices: deviceSummaries,
  };
}
