/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { osBadge, statusBadge } from '../src/components/badges';
import { networkBarChartHtml, singleBarChartHtml } from '../src/components/charts';
import { derivePollHealth } from '../src/views/devices';
import {
  applyTheme,
  clearCachedDeployKey,
  clearHostTabs,
  closeHostTab,
  DEPLOY_KEY_STORE,
  getTelemetrySeries,
  loadCachedDeployKey,
  openHostTab,
  pushTelemetrySample,
  resolveTheme,
  saveCachedDeployKey,
  state,
  toggleTheme,
} from '../src/state';
import {
  buildInstallCommands,
  buildNoCurlInstallCommands,
  clampPercent,
  computeDiffLines,
  cronLabel,
  esc,
  formatBytes,
  formatDate,
  formatDuration,
  formatMemory,
  formatRelativeTime,
  formatRelativeZh,
  platformMeta,
  stripAnsi,
  substituteInstallTokens,
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

  it('formatDate and formatRelativeTime handle valid and invalid dates', () => {
    expect(formatDate(null)).toBe('--');
    expect(formatDate('not-a-date')).toBe('--');
    const formatted = formatDate('2026-06-15T10:20:30Z');
    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

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

    expect(html).toContain('<title>Cslite');
    expect(html).toContain('OpenWrt without curl?');
    expect(html).toContain('ssh root@router');
    expect(html).toContain('轮询健康值');
    expect(html).toContain('最近轮询请求');
    expect(html).toContain('健康检测');
    expect(html).toContain('检测上线状态');
    expect(html).toContain('已智能填充');
    expect(html).toContain('#111936');
    expect(html).toContain('#7267EF');
    expect(html).toContain('#02BFA5');
    expect(html).toContain('#F4F6F8');
    expect(html).toContain('#7635DC');
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).not.toMatch(/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i);
    expect(html).not.toMatch(/https?:\/\/[^"'\s>]+(?:fonts\.googleapis|cdn\.|unpkg|jsdelivr)/i);

    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/i);
    expect(scriptMatch).not.toBeNull();
    const scriptBody = scriptMatch?.[1] ?? '';
    expect(scriptBody).not.toMatch(/<\/script/i);
    expect(scriptBody).not.toContain('<!--');

    expect(sizeBytes).toBeLessThan(130 * 1024);

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
    expect(scriptsMod.AGENT_LITE_SH).toBe(
      fs.readFileSync(path.join(rootDir, 'agent/openwrt/cslite-agent-lite.sh'), 'utf8'),
    );
    expect(scriptsMod.AGENT_LITE_PS1).toBe(
      fs.readFileSync(path.join(rootDir, 'agent/scripts/cslite-agent-lite.ps1'), 'utf8'),
    );
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
