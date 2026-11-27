/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandSourceBadge, commandSourceMeta, healthTimelineHtml, osBadge, statusBadge, uptimeDotsHtml } from '../src/components/badges';
import { networkBarChartHtml, singleBarChartHtml } from '../src/components/charts';
import { paramsFromCreateResponse } from '../src/components/install-modal';
import { hTr, ipCopyHtml } from '../src/components/ui';
import { derivePollHealth, derivePollHealthSlots } from '../src/views/devices';
import {
  applyTheme,
  clearCachedDeployKey,
  clearHostTabs,
  closeHostTab,
  DEPLOY_KEY_STORE,
  getTelemetrySeries,
  loadCachedDeployKey,
  loadTimezonePref,
  openHostTab,
  pushTelemetrySample,
  resolveDisplayTimeZone,
  resolveTheme,
  saveCachedDeployKey,
  setTimezonePref,
  state,
  syncActiveTimeZone,
  TIMEZONE_PREF_KEY,
  toggleTheme,
} from '../src/state';
import {
  buildInstallCommands,
  buildNoCurlInstallCommands,
  clampPercent,
  computeDiffLines,
  cronLabel,
  deviceGroupIds,
  esc,
  formatBytes,
  formatDate,
  formatDuration,
  formatMemory,
  formatRelativeTime,
  formatRelativeZh,
  getActiveTimeZone,
  isValidTimeZone,
  platformMeta,
  setActiveTimeZone,
  stripAnsi,
  substituteInstallTokens,
  TIMEZONE_PRESETS,
} from '../src/utils';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');

describe('web/src/utils', () => {
  it('esc escapes HTML special characters and handles nullish inputs', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(42)).toBe('42');
    expect(esc('<script>alert("xss" & \'1\')</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot; &amp; &#39;1&#39;)&lt;/script&gt;',
    );
    expect(esc('host "a" <b&c>')).toBe('host &quot;a&quot; &lt;b&amp;c&gt;');
  });

  it('stripAnsi strips CSI/OSC escapes and normalizes CRLF', () => {
    expect(stripAnsi('\x1b[32mOK\x1b[0m\r\nnext\rline')).toBe('OK\nnext\nline');
    expect(stripAnsi('\x1b]0;title\x07output')).toBe('output');
  });

  it('formatBytes and formatMemory format human-readable sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(-1)).toBe('--');
    expect(formatBytes(null)).toBe('--');

    expect(formatMemory(512)).toBe('512 MB');
    expect(formatMemory(2048)).toBe('2 GB');
    expect(formatMemory(null)).toBe('--');
  });

  it('formatDuration formats seconds into s/m/h/d', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(192)).toBe('3m 12s');
    expect(formatDuration(8100)).toBe('2h 15m');
    expect(formatDuration(90000)).toBe('1d 1h');
    expect(formatDuration(undefined)).toBe('--');
  });

  it('formatDate, timezone helpers, deviceGroupIds, and formatRelativeTime handle valid and invalid inputs', () => {
    expect(formatDate(null)).toBe('--');
    expect(formatDate('not-a-date')).toBe('--');
    const formatted = formatDate('2026-06-15T10:20:30Z');
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    expect(TIMEZONE_PRESETS.some(([z]) => z === 'Asia/Shanghai')).toBe(true);
    expect(TIMEZONE_PRESETS.some(([z]) => z === 'UTC')).toBe(true);
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('browser')).toBe(false);
    expect(isValidTimeZone('Invalid/Nowhere')).toBe(false);

    expect(formatDate('2026-06-15T10:20:30Z', 'UTC')).toBe('2026-06-15 10:20:30');
    expect(formatDate('2026-06-15T10:20:30Z', 'Asia/Shanghai')).toBe('2026-06-15 18:20:30');
    expect(formatDate('2026-06-15T10:20:30Z', 'America/New_York')).toBe('2026-06-15 06:20:30');
    expect(formatDate('2026-01-15T10:20:30Z', 'America/New_York')).toBe('2026-01-15 05:20:30');
    expect(formatDate('2026-06-15T16:00:00Z', 'Asia/Shanghai')).toBe('2026-06-16 00:00:00');

    try {
      setActiveTimeZone('Asia/Shanghai');
      expect(getActiveTimeZone()).toBe('Asia/Shanghai');
      expect(formatDate('2026-06-15T10:20:30Z')).toBe('2026-06-15 18:20:30');
      expect(formatDate('2026-06-15T10:20:30Z', 'UTC')).toBe('2026-06-15 10:20:30');
      setActiveTimeZone('Invalid/Zone');
      expect(getActiveTimeZone()).toBeNull();
    } finally {
      setActiveTimeZone(null);
      expect(getActiveTimeZone()).toBeNull();
    }

    expect(deviceGroupIds({})).toEqual([]);
    expect(deviceGroupIds({ group_id: null })).toEqual([]);
    expect(deviceGroupIds({ group_id: 'g1' })).toEqual(['g1']);
    expect(deviceGroupIds({ group_id: 'g1', group_ids: ['g2', 'g1', 'g2', ''] })).toEqual(['g2', 'g1']);
    expect(deviceGroupIds({ group_ids: ['g3', 'g3'] })).toEqual(['g3']);

    const base = Date.parse('2026-06-15T12:00:00Z');
    expect(formatRelativeTime('2026-06-15T11:59:55Z', base)).toBe('just now');
    expect(formatRelativeTime('2026-06-15T11:59:30Z', base)).toBe('30s ago');
    expect(formatRelativeTime('2026-06-15T11:45:00Z', base)).toBe('15m ago');
    expect(formatRelativeTime('2026-06-15T09:00:00Z', base)).toBe('3h ago');
    expect(formatRelativeTime('2026-06-13T12:00:00Z', base)).toBe('2d ago');
    expect(formatRelativeTime('', base)).toBe('never');

    expect(formatRelativeZh('2026-06-15T11:59:55Z', base)).toBe('刚刚');
    expect(formatRelativeZh('2026-06-15T11:45:00Z', base)).toBe('15分钟前');
    expect(formatRelativeZh('', base)).toBe('从未');
  });

  it('cronLabel produces human-readable descriptions for cron expressions', () => {
    expect(cronLabel('* * * * *')).toBe('Every minute');
    expect(cronLabel('*/5 * * * *')).toBe('Every 5 minutes');
    expect(cronLabel('*/10 * * * *')).toBe('Every 10 minutes');
    expect(cronLabel('0 * * * *')).toBe('Hourly (at :00)');
    expect(cronLabel('0 3 * * *')).toBe('Daily at 03:00');
    expect(cronLabel('0 2 * * 0')).toBe('Weekly (Sun 02:00)');
    expect(cronLabel('30 */2 * * *')).toBe('Every 2h at :30');
    expect(cronLabel('15 4 * * 1')).toBe('Weekly (Mon 04:15)');
    expect(cronLabel(null)).toBe('--');
  });

  it('platformMeta, clampPercent, and computeDiffLines behave cleanly', () => {
    expect(platformMeta('linux/amd64').key).toBe('linux');
    expect(platformMeta('openwrt-23.05').key).toBe('openwrt');
    expect(platformMeta('darwin/arm64').key).toBe('macos');
    expect(platformMeta('windows').key).toBe('windows');
    expect(platformMeta('android').key).toBe('android');
    expect(platformMeta('android').label).toBe('Android');
    expect(platformMeta('linux/android').key).toBe('android');
    expect(platformMeta('unix').key).toBe('unix');
    expect(platformMeta('unix').label).toBe('UNIX');

    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(120)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);

    expect(computeDiffLines('a\nb', 'a\nb').identical).toBe(true);
    const diff = computeDiffLines('a\nb', 'a\nc');
    expect(diff.identical).toBe(false);
    expect(diff.lines.some((l) => l.kind === 'del' && l.text === 'b')).toBe(true);
    expect(diff.lines.some((l) => l.kind === 'add' && l.text === 'c')).toBe(true);
  });

  it('buildInstallCommands generates compact 3-family script commands, no-curl fallbacks, and substitutes API keys cleanly', () => {
    const origin = 'https://ctrl.example.com';
    const base = buildInstallCommands({
      deviceId: 'dev_123',
      name: "edge 'router' \"01\"",
      origin,
    });

    expect(Object.keys(base).sort()).toEqual(['android', 'unix', 'windows']);
    expect(base.unix).toBe(`curl -fsSL ${origin}/i | sh -s -- YOUR_API_KEY dev_123`);
    expect(base.windows).toBe(`$k="YOUR_API_KEY";$d="dev_123";irm ${origin}/i.ps1|iex`);
    expect(base.android).toBe(`curl -fsSL ${origin}/ia | sh -s -- YOUR_API_KEY dev_123`);
    for (const cmd of Object.values(base)) {
      expect(cmd).not.toContain('(');
      expect(cmd).not.toContain(')');
    }

    const keyed = buildInstallCommands({
      deviceId: 'dev_123',
      name: 'node-01',
      origin,
      apiKey: 'ak_live_$99abc',
    });
    expect(keyed.unix).toBe(`curl -fsSL ${origin}/i | sh -s -- ak_live_$99abc dev_123`);
    expect(keyed.windows).toBe(`$k="ak_live_$99abc";$d="dev_123";irm ${origin}/i.ps1|iex`);
    expect(keyed.android).toBe(`curl -fsSL ${origin}/ia | sh -s -- ak_live_$99abc dev_123`);

    const fromServer = buildInstallCommands({
      deviceId: 'dev_123',
      name: 'node-01',
      origin,
      apiKey: 'ak_live_srv',
      serverCommands: {
        unix: base.unix,
        windows: base.windows,
        android: base.android,
      },
    });
    expect(fromServer.unix).toBe(`curl -fsSL ${origin}/i | sh -s -- ak_live_srv dev_123`);
    expect(fromServer.windows).toBe(`$k="ak_live_srv";$d="dev_123";irm ${origin}/i.ps1|iex`);
    expect(fromServer.android).toBe(`curl -fsSL ${origin}/ia | sh -s -- ak_live_srv dev_123`);

    const unixAlts = buildNoCurlInstallCommands('unix', origin, 'dev_123', 'ak_live_$99abc');
    expect(unixAlts.map((x) => x.command)).toEqual([
      `wget -qO- ${origin}/i | sh -s -- ak_live_$99abc dev_123`,
      `uclient-fetch -qO- ${origin}/i | sh -s -- ak_live_$99abc dev_123`,
    ]);
    const androidAlts = buildNoCurlInstallCommands('android', origin, 'dev_123');
    expect(androidAlts.map((x) => x.command)).toEqual([
      `wget -qO- ${origin}/ia | sh -s -- YOUR_API_KEY dev_123`,
    ]);
    expect(buildNoCurlInstallCommands('windows', origin, 'dev_123')).toEqual([]);

    expect(
      substituteInstallTokens(
        'cslite-agent install --server "<SERVER_URL>" --key <YOUR_API_KEY>',
        origin,
        'ak_live_xyz',
      ),
    ).toBe(`cslite-agent install --server "${origin}" --key ak_live_xyz`);
  });

  it('Collie state helpers manage theme, max-6 host tabs, and 40-bar telemetry ring buffer', () => {
    expect(resolveTheme('dark')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('system')).toBe('dark');

    applyTheme('dark');
    expect(state.theme).toBe('dark');
    expect(toggleTheme()).toBe('light');
    expect(toggleTheme()).toBe('system');
    expect(toggleTheme()).toBe('dark');

    clearHostTabs();
    for (let i = 1; i <= 7; i++) {
      openHostTab({ id: `dev_${i}`, name: `host-${i}`, platform: 'linux', status: 'online' });
    }
    expect(state.hostTabs.length).toBe(6);
    expect(state.hostTabs[0].id).toBe('dev_2');
    expect(state.hostTabs[5].id).toBe('dev_7');

    openHostTab({ id: 'dev_3', name: 'host-3-updated', platform: 'openwrt', status: 'offline' });
    expect(state.hostTabs.length).toBe(6);
    expect(state.hostTabs.find((t) => t.id === 'dev_3')?.name).toBe('host-3-updated');

    closeHostTab('dev_3');
    expect(state.hostTabs.length).toBe(5);
    expect(state.hostTabs.some((t) => t.id === 'dev_3')).toBe(false);
    clearHostTabs();

    const sampleMetrics = {
      cpu_usage: 42,
      memory_used: 512,
      memory_total: 2048,
      disk_usage: 35,
      network_in: 120,
      network_out: 45,
    };
    const initialSeries = getTelemetrySeries('dev_ring_test', sampleMetrics);
    expect(initialSeries.length).toBe(40);
    expect(initialSeries.filter((s) => !s.seeded).length).toBe(1);

    for (let i = 0; i < 45; i++) {
      pushTelemetrySample('dev_ring_test', { ...sampleMetrics, cpu_usage: i }, 1000 + i * 5000);
    }
    const fullSeries = getTelemetrySeries('dev_ring_test');
    expect(fullSeries.length).toBe(40);
    expect(fullSeries.every((s) => !s.seeded)).toBe(true);
    expect(fullSeries[0].cpu).toBe(5);
    expect(fullSeries[39].cpu).toBe(44);
  });

  it('Collie timezone preference resolves browser, server, and IANA overrides cleanly', () => {
    const prevDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const prevSys = state.systemInfo;
    const prevPref = state.timezonePref;
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, String(v));
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });
    try {
      state.systemInfo = {
        version: '1.0.0',
        runtime: 'node',
        db_dialect: 'sqlite',
        allow_registration: false,
        heartbeat_interval: 300,
        poll_interval: 60,
        timezone: 'Asia/Shanghai',
        server_time: '2026-06-15T10:20:30Z',
      };
      setTimezonePref('server');
      expect(resolveDisplayTimeZone()).toBe('Asia/Shanghai');
      expect(syncActiveTimeZone()).toBe('Asia/Shanghai');
      expect(formatDate('2026-06-15T10:20:30Z')).toBe('2026-06-15 18:20:30');

      setTimezonePref('browser');
      expect(resolveDisplayTimeZone()).toBeNull();
      expect(getActiveTimeZone()).toBeNull();

      setTimezonePref('America/New_York');
      expect(loadTimezonePref()).toBe('America/New_York');
      expect(resolveDisplayTimeZone()).toBe('America/New_York');
      expect(formatDate('2026-06-15T10:20:30Z')).toBe('2026-06-15 06:20:30');

      store.set(TIMEZONE_PREF_KEY, 'Invalid/TZ');
      expect(loadTimezonePref()).toBe('server');
    } finally {
      state.systemInfo = prevSys;
      state.timezonePref = prevPref;
      setActiveTimeZone(null);
      if (prevDesc) {
        Object.defineProperty(globalThis, 'localStorage', prevDesc);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });

  it('deploy key cache persists per userId and clears cleanly', () => {
    const prevDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, String(v));
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });
    try {
      expect(loadCachedDeployKey(1)).toBeNull();

      saveCachedDeployKey('key_1', 'ak_live_abc123', 1);
      expect(loadCachedDeployKey(1)).toEqual({ id: 'key_1', key: 'ak_live_abc123' });
      expect(loadCachedDeployKey()).toEqual({ id: 'key_1', key: 'ak_live_abc123' });
      expect(loadCachedDeployKey(2)).toBeNull();

      globalThis.localStorage.setItem(DEPLOY_KEY_STORE, '{bad-json');
      expect(loadCachedDeployKey(1)).toBeNull();
      globalThis.localStorage.setItem(DEPLOY_KEY_STORE, JSON.stringify({ id: '', key: 'ak_x' }));
      expect(loadCachedDeployKey(1)).toBeNull();

      saveCachedDeployKey('key_2', 'ak_live_xyz789', 1);
      expect(loadCachedDeployKey(1)).toEqual({ id: 'key_2', key: 'ak_live_xyz789' });

      clearCachedDeployKey();
      expect(loadCachedDeployKey(1)).toBeNull();
    } finally {
      if (prevDesc) {
        Object.defineProperty(globalThis, 'localStorage', prevDesc);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });

  it('deploy key paramsFromCreateResponse forwards bound apiKey and apiKeyPrefix', () => {
    const params = paramsFromCreateResponse(
      {
        id: 'dev_bound_1',
        name: 'edge-01',
        platform: 'unix',
        api_key: 'ak_live_bound_secret',
        api_key_id: 'key_bound_1',
        api_key_prefix: 'ak_live_boun...',
        install_command: 'curl -fsSL https://ctrl.example.com/i | sh -s -- ak_live_bound_secret dev_bound_1',
        install_commands: {
          unix: 'curl -fsSL https://ctrl.example.com/i | sh -s -- ak_live_bound_secret dev_bound_1',
        },
        expires_at: '2026-12-01T00:00:00Z',
      },
      'edge-01',
      'unix',
    );
    expect(params).toEqual({
      deviceId: 'dev_bound_1',
      name: 'edge-01',
      platform: 'unix',
      apiKey: 'ak_live_bound_secret',
      apiKeyPrefix: 'ak_live_boun...',
      installCommand: 'curl -fsSL https://ctrl.example.com/i | sh -s -- ak_live_bound_secret dev_bound_1',
      installCommands: {
        unix: 'curl -fsSL https://ctrl.example.com/i | sh -s -- ak_live_bound_secret dev_bound_1',
      },
      expiresAt: '2026-12-01T00:00:00Z',
    });
  });

  it('Collie chart and badge renderers produce 40-bar SVG and escape XSS payloads', () => {
    const samples = getTelemetrySeries('dev_chart_test', {
      cpu_usage: 55,
      memory_used: 1024,
      memory_total: 4096,
      disk_usage: 20,
      network_in: 200,
      network_out: 80,
    });
    const cpuSvg = singleBarChartHtml({ samples, pick: (s) => s.cpu, label: '<CPU>' });
    expect((cpuSvg.match(/class="cbar-slot"/g) ?? []).length).toBe(40);
    expect(cpuSvg).toContain('&lt;CPU&gt;');

    const netBoth = networkBarChartHtml(samples, 'both');
    expect((netBoth.match(/class="cbar-slot"/g) ?? []).length).toBe(40);
    const netTx = networkBarChartHtml(samples, 'tx');
    expect((netTx.match(/class="cbar-slot"/g) ?? []).length).toBe(40);

    expect(osBadge('openwrt')).toContain('os-openwrt');
    expect(statusBadge('<script>')).toContain('&lt;script&gt;');

    expect(commandSourceMeta('cron', 'nightly')).toMatchObject({ label: 'Cron 周期' });
    expect(commandSourceMeta('once', 'oneoff')).toMatchObject({ label: '一次性预约' });
    expect(commandSourceMeta('immediate', 'quick: ls')).toMatchObject({ label: '在线终端' });
    expect(commandSourceMeta('immediate', 'fleet: df -h')).toMatchObject({ label: '批量执行' });
    expect(commandSourceMeta('immediate', 'health-probe: router')).toMatchObject({ label: '健康检测' });
    expect(commandSourceMeta('immediate', 'diag-net: router')).toMatchObject({ label: '系统诊断' });
    expect(commandSourceMeta('immediate', 'custom')).toMatchObject({ label: '即时指令' });
    expect(commandSourceBadge('cron', 'test')).toContain('Cron 周期');
  });

  it('derivePollHealth aligns passive polling activity thresholds cleanly', () => {
    const now = Date.parse('2026-06-15T12:00:00Z');
    const active = derivePollHealth({ status: 'online', last_seen: '2026-06-15T11:58:35Z' }, now);
    expect(active).toMatchObject({ score: 100, label: '健康 · 轮询活跃', tone: 'ok' });

    const busyActive = derivePollHealth({ status: 'busy', last_seen: '2026-06-15T11:59:50Z' }, now);
    expect(busyActive).toMatchObject({ score: 100, label: '健康 · 轮询活跃', tone: 'ok' });

    const slow = derivePollHealth({ status: 'online', last_seen: '2026-06-15T11:57:00Z' }, now);
    expect(slow).toMatchObject({ score: 65, label: '延迟 · 轮询变慢', tone: 'warn' });

    const stale = derivePollHealth({ status: 'online', last_seen: '2026-06-15T11:50:00Z' }, now);
    expect(stale).toMatchObject({ score: 25, label: '超时 · 久未轮询', tone: 'err' });

    const offline = derivePollHealth({ status: 'offline', last_seen: '2026-06-15T11:59:59Z' }, now);
    expect(offline).toMatchObject({ score: 0, label: '离线 · 无轮询请求', tone: 'err' });
  });

  it('derivePollHealthSlots and uptimeDotsHtml render N-capsule Uptime-style strips', () => {
    const now = Date.parse('2026-06-15T12:00:00Z');

    const fresh = derivePollHealthSlots(
      { status: 'online', last_seen: '2026-06-15T11:59:30Z', created_at: '2026-06-15T11:57:30Z' },
      12,
      now,
    );
    expect(fresh).toHaveLength(12);
    expect(fresh.slice(0, 9).every((s) => s === 'empty')).toBe(true);
    expect(fresh.slice(9).every((s) => s === 'ok')).toBe(true);

    const full24 = derivePollHealthSlots(
      { status: 'online', last_seen: '2026-06-15T11:59:45Z', created_at: '2026-06-15T10:00:00Z' },
      24,
      now,
    );
    expect(full24).toHaveLength(24);
    expect(full24.every((s) => s === 'ok')).toBe(true);

    const delayed = derivePollHealthSlots(
      { status: 'online', last_seen: '2026-06-15T11:57:00Z' },
      12,
      now,
    );
    expect(delayed.slice(0, 10).every((s) => s === 'ok')).toBe(true);
    expect(delayed.slice(10).every((s) => s === 'warn')).toBe(true);

    const offSeen = derivePollHealthSlots(
      { status: 'offline', last_seen: '2026-06-15T11:57:30Z' },
      12,
      now,
    );
    expect(offSeen.slice(0, 9).every((s) => s === 'ok')).toBe(true);
    expect(offSeen.slice(9).every((s) => s === 'err')).toBe(true);

    const offNever = derivePollHealthSlots({ status: 'offline', last_seen: '' }, 12, now);
    expect(offNever).toHaveLength(12);
    expect(offNever.every((s) => s === 'empty')).toBe(true);

    const strip12 = uptimeDotsHtml(delayed, { label: '状态 <script>' });
    expect((strip12.match(/class="up-dot /g) ?? []).length).toBe(12);
    expect(strip12).toContain('role="img"');
    expect(strip12).toContain('aria-label="状态 &lt;script&gt;"');

    const strip24 = uptimeDotsHtml(full24, { lg: true, label: '近24分钟' });
    expect((strip24.match(/class="up-dot /g) ?? []).length).toBe(24);
    expect(strip24).toContain('up-strip up-lg');
  });

  it('derivePollHealth and derivePollHealthSlots adapt thresholds to server poll/heartbeat schedule', () => {
    const now = Date.parse('2026-06-15T12:00:00Z');
    const seen400sAgo = '2026-06-15T11:53:20Z';
    const seen900sAgo = '2026-06-15T11:45:00Z';

    // Under 1m/5m (60s/300s), 400s stale is err
    expect(
      derivePollHealth({ status: 'online', last_seen: seen400sAgo }, now, { pollInterval: 60, heartbeatInterval: 300 }),
    ).toMatchObject({ tone: 'err', score: 25 });

    // Under 5m/15m (300s/900s), 400s stale is still healthy (< 465s), and 900s is warn
    expect(
      derivePollHealth({ status: 'online', last_seen: seen400sAgo }, now, { pollInterval: 300, heartbeatInterval: 900 }),
    ).toMatchObject({ tone: 'ok', score: 100 });
    expect(
      derivePollHealth({ status: 'online', last_seen: seen900sAgo }, now, { pollInterval: 300, heartbeatInterval: 900 }),
    ).toMatchObject({ tone: 'warn', score: 65 });

    const slots5m = derivePollHealthSlots({ status: 'online', last_seen: seen400sAgo }, 12, now, 300);
    expect(slots5m.every((s) => s === 'ok')).toBe(true);

    const dots5m = uptimeDotsHtml(slots5m, { windowSec: 300 });
    expect(dots5m).toContain('约 5 分钟前');
    expect(dots5m).toContain('约 55 分钟前');

    // Asymmetric 1m/10m (60s/600s): 350s stale must stay 'warn' in both derivePollHealth and derivePollHealthSlots
    const seen350sAgo = '2026-06-15T11:54:10Z';
    expect(
      derivePollHealth({ status: 'online', last_seen: seen350sAgo }, now, { pollInterval: 60, heartbeatInterval: 600 }),
    ).toMatchObject({ tone: 'warn', score: 65 });
    const slotsAsym = derivePollHealthSlots({ status: 'online', last_seen: seen350sAgo }, 12, now, 60, 600);
    expect(slotsAsym.includes('err')).toBe(false);
    expect(slotsAsym.at(-1)).toBe('warn');

    // Shorter custom heartbeat (60s/180s): 250s stale must be 'err' in BOTH derivePollHealth and derivePollHealthSlots
    const seen250sAgo = '2026-06-15T11:55:50Z';
    expect(
      derivePollHealth({ status: 'online', last_seen: seen250sAgo }, now, { pollInterval: 60, heartbeatInterval: 180 }),
    ).toMatchObject({ tone: 'err', score: 25 });
    const slotsShortHb = derivePollHealthSlots({ status: 'online', last_seen: seen250sAgo }, 12, now, 60, 180);
    expect(slotsShortHb.at(-1)).toBe('err');
  });

  it('hTr inherits data-lbl for string and 2-tuple cells while honoring 3-tuple overrides and suppression', () => {
    const labels = ['状态', '主机', '输出', '操作 "X"', ''];
    const html = hTr(
      [
        '<span>online</span>',
        ['node-01', 'nw'],
        ['hidden-label', 'txs', ''],
        ['custom', 'mono', '自定义 <标签>'],
        ['<button>详情</button>', 'tr'],
      ],
      labels,
    );

    expect(html).toBe(
      '<tr>' +
        '<td data-lbl="状态"><span>online</span></td>' +
        '<td class="nw" data-lbl="主机">node-01</td>' +
        '<td class="txs">hidden-label</td>' +
        '<td class="mono" data-lbl="自定义 &lt;标签&gt;">custom</td>' +
        '<td class="tr"><button>详情</button></td>' +
        '</tr>',
    );
    expect(hTr(['plain', ['styled', 'cls']])).toBe('<tr><td>plain</td><td class="cls">styled</td></tr>');
  });

  it('ipCopyHtml and healthTimelineHtml render direct copy targets and timeline tooltips with XSS escaping', () => {
    expect(ipCopyHtml('')).toBe('<span class="mut">—</span>');
    expect(ipCopyHtml('—')).toBe('<span class="mut">—</span>');
    const ipv6 = '2001:db8:85a3::8a2e:370:7334" onclick="xss()';
    const ipBtn = ipCopyHtml(ipv6, 'tsm');
    expect(ipBtn).toContain('class="ip-t ip-cp mono tsm"');
    expect(ipBtn).toContain('data-copy-ip="2001:db8:85a3::8a2e:370:7334&quot; onclick=&quot;xss()"');
    expect(ipBtn).not.toContain('onclick="xss()"');

    const tl = healthTimelineHtml(
      [
        {
          start: '2026-11-28T00:00:00Z',
          end: '2026-11-28T01:00:00Z',
          label: '08:00',
          status: 'ok',
          uptime_pct: 100,
          online_devices: 2,
          healthy_devices: 2,
          total_devices: 2,
          samples: 10,
          expected: 10,
        },
        {
          start: '2026-11-28T01:00:00Z',
          end: '2026-11-28T02:00:00Z',
          label: '09:00',
          status: 'warn',
          uptime_pct: 50,
          online_devices: 1,
          healthy_devices: 1,
          total_devices: 2,
          samples: 5,
          expected: 10,
        },
      ],
      { fleet: true, leftAxis: '08:00', centerAxis: '近 24 小时 <script>', rightAxis: '当前', label: '集群健康' },
    );
    expect(tl).toContain('class="up-wrap"');
    expect(tl).toContain('data-up-tip="08:00 · 正常 · 可用率 100.0% · 2/2 在线 · 10/10 心跳"');
    expect(tl).toContain('data-up-tip="09:00 · 波动 · 可用率 50.0% · 1/2 在线 · 5/10 心跳"');
    expect(tl).toContain('&lt;script&gt;');
  });
});

describe('build artifacts', () => {
  it('produces self-contained web/dist/index.html, synced ui-bundle.ts, and synced scripts-bundle.ts', async () => {
    const htmlPath = path.join(rootDir, 'web', 'dist', 'index.html');
    const bundlePath = path.join(rootDir, 'server', 'src', 'ui-bundle.ts');
    const scriptsBundlePath = path.join(rootDir, 'server', 'src', 'scripts-bundle.ts');

    expect(fs.existsSync(htmlPath)).toBe(true);
    expect(fs.existsSync(bundlePath)).toBe(true);
    expect(fs.existsSync(scriptsBundlePath)).toBe(true);

    const html = fs.readFileSync(htmlPath, 'utf8');
    const sizeBytes = Buffer.byteLength(html, 'utf8');

    expect(html).toContain('<title>CSLite');
    expect(html).toContain('CSLite');
    expect(html).not.toContain('>Cslite<');
    expect(html).not.toContain('Cslite · ');
    expect(html).toContain('OpenWrt without curl?');
    expect(html).toContain('ssh root@router');
    expect(html).toContain('轮询健康值');
    expect(html).toContain('最近轮询请求');
    expect(html).toContain('健康检测');
    expect(html).toContain('检测上线状态');
    expect(html).not.toContain('选择 API Key');
    expect(html).not.toContain('inst-key-pick');
    expect(html).not.toContain('更换 / 自定义密钥');
    expect(html).not.toContain('已智能填充');
    expect(html).toContain('单机绑定');
    expect(html).toContain('轮换密钥');
    expect(html).toContain('终端与即时指令');
    expect(html).toContain('健康日志');
    expect(html).toContain('定时任务日志');
    expect(html).toContain('全部定时任务');
    expect(html).toContain('系统时区');
    expect(html).toContain('.ip-t');
    expect(html).toContain('.exp-b');
    expect(html).toContain('.csel-pop');
    expect(html).toContain('.ip-modal-list');
    expect(html).toContain('.col-pick');
    expect(html).toContain('scrollbar-gutter:stable');
    expect(html).toContain('tbl-slim');
    expect(html).toContain('表头');
    expect(html).toContain('清理日志');
    expect(html).toContain('展开全部');
    expect(html).toContain('自定义设置');
    expect(html).toContain('心跳健康上报');
    expect(html).toContain('条/页');
    expect(html).toContain('升级探针');
    expect(html).toContain('position:fixed');
    expect(html).toContain('data-copy-ip');
    expect(html).toContain('health-history');
    expect(html).toContain('#111110');
    expect(html).toContain('#f9f9f7');
    expect(html).toContain('#c6613f');
    expect(html).toContain('#d97757');
    expect(html).toContain('#184f95');
    expect(html).toContain('#6da7ec');
    expect(html).toContain('#0d0d0c');
    expect(html).not.toContain('#111936');
    expect(html).not.toContain('#7267EF');
    expect(html).not.toContain('#7635DC');
    expect(html).not.toContain('#F4F6F8');
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i);
    expect(html).not.toMatch(/https?:\/\/[^"'\s>]+(?:fonts\.googleapis|cdn\.|unpkg|jsdelivr)/i);

    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/i);
    expect(scriptMatch).not.toBeNull();
    const scriptBody = scriptMatch?.[1] ?? '';
    expect(scriptBody).not.toMatch(/<\/script/i);
    expect(scriptBody).not.toContain('<!--');

    expect(sizeBytes).toBeLessThan(190 * 1024);

    const mod = (await import('../../server/src/ui-bundle')) as { UI_HTML: string };
    expect(mod.UI_HTML).toBe(html);

    const scriptsMod = (await import('../../server/src/scripts-bundle')) as Record<string, string>;
    expect(scriptsMod.INSTALL_UNIX_SH).toBe(
      fs.readFileSync(path.join(rootDir, 'agent/scripts/install.sh'), 'utf8'),
    );
    expect(scriptsMod.INSTALL_WINDOWS_PS1).toBe(
      fs.readFileSync(path.join(rootDir, 'agent/scripts/install.ps1'), 'utf8'),
    );
    expect(scriptsMod.INSTALL_ANDROID_SH).toBe(
      fs.readFileSync(path.join(rootDir, 'agent/scripts/install-android.sh'), 'utf8'),
    );
    expect(scriptsMod.UPGRADE_UNIX_SH).toBe(
      fs.readFileSync(path.join(rootDir, 'agent/scripts/upgrade.sh'), 'utf8'),
    );
    expect(scriptsMod.UPGRADE_WINDOWS_PS1).toBe(
      fs.readFileSync(path.join(rootDir, 'agent/scripts/upgrade.ps1'), 'utf8'),
    );
    const agentVer = fs.readFileSync(path.join(rootDir, 'agent/VERSION'), 'utf8').trim();
    expect(scriptsMod.AGENT_LITE_SH).toBe(
      fs.readFileSync(path.join(rootDir, 'agent/openwrt/cslite-agent-lite.sh'), 'utf8'),
    );
    expect(scriptsMod.AGENT_LITE_SH).toContain(`VERSION="${agentVer}"`);
    expect(scriptsMod.AGENT_LITE_PS1).toBe(
      fs.readFileSync(path.join(rootDir, 'agent/scripts/cslite-agent-lite.ps1'), 'utf8'),
    );
    expect(scriptsMod.AGENT_LITE_PS1).toContain(`$Version = "${agentVer}"`);
    expect(scriptsMod.OPENWRT_INIT_SH).toBe(
      fs.readFileSync(path.join(rootDir, 'agent/openwrt/cslite-agent.init'), 'utf8'),
    );
  });

  it('has zero idle background polling intervals in passive views and install modal', () => {
    const guardedFiles = [
      'web/src/views/devices.ts',
      'web/src/views/dashboard.ts',
      'web/src/views/device-detail.ts',
      'web/src/components/install-modal.ts',
    ];
    for (const relPath of guardedFiles) {
      const src = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
      expect(src).not.toMatch(/\bsetManagedInterval\s*\(/);
      expect(src).not.toMatch(/\bsetInterval\s*\(/);
    }
  });
});
