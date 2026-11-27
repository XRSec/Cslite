import type { CommandLogDTO, DeviceDTO, ExecutionDeviceResultDTO, GroupDTO } from '../../../shared/types';
import { api, ApiError } from '../api';
import { exitCodeBadge, logDownloadUrl, metricBar, osBadge, statusBadge } from '../components/badges';
import { bindChartTooltips, networkBarChartHtml, singleBarChartHtml, type NetChartMode } from '../components/charts';
import { showInstallModal } from '../components/install-modal';
import { bindCopyButtons, btn, diffPreHtml, isTerminalExecStatus, on, onAll, preOutputHtml, shellSelectHtml, startCommandPolling, tabsHtml } from '../components/ui';
import { icons } from '../icons';
import type { RouteContext } from '../router';
import { copyText, getTelemetrySeries, openHostTab, pushTelemetrySample, registerCleanup, state, toast } from '../state';
import { clampPercent, esc, formatDate, formatDuration, formatElapsed, formatMemory, formatRate, formatRelativeZh, getMemoryPercent, platformMeta, stripAnsi, type CanonicalPlatform } from '../utils';
import { derivePollHealth } from './devices';

type DetailTab = 'metrics' | 'terminal' | 'status' | 'tasks';
type TermTheme = 'dracula' | 'midnight' | 'light';

interface TerminalEntry {
  commandText: string;
  shell: string;
  sentAt: string;
  status: string;
  exitCode: number | null;
  output: string;
  startedAt: string | null;
  completedAt: string | null;
  resultId?: string;
  logUrl?: string;
}

interface TermTab {
  id: string;
  title: string;
  shell: string;
  timeout: number;
  entries: TerminalEntry[];
  running: boolean;
  stopPoll: (() => void) | null;
}

interface DiagState {
  id: 'proc' | 'net' | 'disk' | 'log';
  title: string;
  running: boolean;
  status: string;
  exitCode: number | null;
  output: string;
  updatedAt: string;
  stopPoll: (() => void) | null;
}

interface HealthProbeState {
  running: boolean;
  status: string;
  exitCode: number | null;
  output: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  stopPoll: (() => void) | null;
}

const HIST_KEY = 'cslite_term_history';
const TERM_THEME_KEY = 'cslite_term_theme';

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadHistory(): string[] {
  try {
    const p = JSON.parse(readPref(HIST_KEY) || '[]');
    return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function getPresets(plat: CanonicalPlatform): Array<[string, string, string?]> {
  return plat === 'windows'
    ? [
        ['系统信息', 'systeminfo', 'cmd'],
        ['磁盘空间', 'Get-PSDrive -PSProvider FileSystem', 'powershell'],
        ['内存占用', 'Get-CimInstance Win32_OperatingSystem | Select FreePhysicalMemory,TotalVisibleMemorySize', 'powershell'],
        ['网络监听', 'Get-NetTCPConnection -State Listen | Select -First 30 LocalAddress,LocalPort,OwningProcess', 'powershell'],
        ['系统服务', 'Get-Service | Select -First 25 Status,Name', 'powershell'],
      ]
    : [
        ['系统信息', plat === 'openwrt' ? 'ubus call system board || uname -a' : 'uname -a'],
        ['磁盘空间', 'df -h'],
        ['内存占用', 'free -m 2>/dev/null || vm_stat 2>/dev/null || head -n 6 /proc/meminfo'],
        ['网络监听', 'ss -tulnp 2>/dev/null || netstat -tuln 2>/dev/null || ip addr'],
        ['OpenWrt 服务', 'ls /etc/init.d 2>/dev/null || systemctl list-units --type=service --state=running | head -n 20'],
      ];
}

function getDiagCommand(id: DiagState['id'], plat: CanonicalPlatform): { cmd: string; shell?: string } {
  if (plat === 'windows') {
    const m: Record<DiagState['id'], string> = {
      proc: 'Get-Process | Sort CPU -Desc | Select -First 40 Name,Id,CPU,WS | ft -a',
      net: 'Get-NetTCPConnection -State Listen | Select -First 50 LocalAddress,LocalPort,OwningProcess | ft -a',
      disk: 'Get-PSDrive -PSProvider FileSystem | Select Name,Used,Free,Root | ft -a',
      log: 'Get-EventLog -LogName System -Newest 40 | ft -a TimeGenerated,EntryType,Source,Message',
    };
    return { cmd: m[id], shell: 'powershell' };
  }
  const cmds: Record<DiagState['id'], string> = {
    proc: 'ps aux 2>/dev/null | head -n 60 || ps w 2>/dev/null | head -n 60 || ps',
    net: plat === 'macos' ? 'lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null | head -n 60 || netstat -an -p tcp | head -n 60' : 'ss -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null || netstat -an | head -n 60',
    disk: 'df -h',
    log: plat === 'openwrt' ? 'logread | tail -n 80' : plat === 'macos' ? 'log show --last 10m --style compact 2>/dev/null | tail -n 80 || dmesg | tail -n 80' : plat === 'android' ? 'logcat -d -t 80 2>/dev/null || dmesg | tail -n 80' : 'journalctl -n 80 --no-pager 2>/dev/null || dmesg | tail -n 80 || tail -n 80 /var/log/messages',
  };
  return { cmd: cmds[id] };
}

export async function renderDeviceDetail(ctx: RouteContext): Promise<void> {
  const deviceId = ctx.params.id;
  if (!deviceId) {
    ctx.root.innerHTML = '<div class="emp-c">缺少主机 ID</div>';
    return;
  }

  let device: DeviceDTO;
  let groups: GroupDTO[] = state.groupsCache;
  let recentLogs: CommandLogDTO[] = [];
  try {
    const [dev, logsRes, grpRes] = await Promise.all([
      api.getDevice(deviceId),
      api.listCommandLogs({ device_id: deviceId, per_page: 25 }).catch(() => ({ logs: [] as CommandLogDTO[] })),
      groups.length ? Promise.resolve(groups) : api.listGroups().catch(() => [] as GroupDTO[]),
    ]);
    if (ctx.isStale()) return;
    device = dev;
    recentLogs = logsRes.logs ?? [];
    groups = grpRes;
    state.groupsCache = groups;
  } catch (err) {
    if (ctx.isStale()) return;
    ctx.root.innerHTML = `<div class="emp-c"><h3>未找到主机</h3><p class="mut">${esc(err instanceof Error ? err.message : '加载失败')}</p><a href="#/" class="btn bsm bg mt-2">${icons.back()} 返回列表</a></div>`;
    return;
  }

  openHostTab({ id: device.id, name: device.name, platform: device.platform, status: device.status });
  if (device.metrics) pushTelemetrySample(device.id, device.metrics);

  const rawTab = ctx.query.get('tab');
  const shouldAutoProbe = ctx.query.get('probe') === '1';
  let activeTab: DetailTab = rawTab === 'terminal' || rawTab === 'status' || rawTab === 'tasks' ? rawTab : 'metrics';
  let netMode: NetChartMode = 'both';
  const savedTheme = readPref(TERM_THEME_KEY);
  let termTheme: TermTheme = savedTheme === 'midnight' || savedTheme === 'light' ? savedTheme : 'dracula';

  const platKey = platformMeta(device.platform).key;
  const defaultShell = platKey === 'windows' ? 'powershell' : 'auto';
  const cmdHistory = loadHistory();
  let histIdx = -1;
  let tabSeq = 1;

  const termTabs: TermTab[] = [
    { id: 't1', title: '默认终端', shell: defaultShell, timeout: 60, entries: [], running: false, stopPoll: null },
  ];
  let activeTermId = 't1';

  const diags: DiagState[] = [
    { id: 'proc', title: '进程信息', running: false, status: '', exitCode: null, output: '', updatedAt: '', stopPoll: null },
    { id: 'net', title: '网络端口', running: false, status: '', exitCode: null, output: '', updatedAt: '', stopPoll: null },
    { id: 'disk', title: '磁盘挂载', running: false, status: '', exitCode: null, output: '', updatedAt: '', stopPoll: null },
    { id: 'log', title: '系统日志', running: false, status: '', exitCode: null, output: '', updatedAt: '', stopPoll: null },
  ];

  const healthProbe: HealthProbeState = {
    running: false,
    status: '',
    exitCode: null,
    output: '',
    startedAt: null,
    completedAt: null,
    updatedAt: '',
    stopPoll: null,
  };

  let expandedLogIdx: number | null = null;
  let diffLogIdx: number | null = null;

  registerCleanup(() => {
    healthProbe.stopPoll?.();
    healthProbe.stopPoll = null;
    healthProbe.running = false;
    for (const t of termTabs) { t.stopPoll?.(); t.stopPoll = null; t.running = false; }
    for (const d of diags) { d.stopPoll?.(); d.stopPoll = null; d.running = false; }
  });

  const currentTerm = (): TermTab => termTabs.find((t) => t.id === activeTermId) ?? termTabs[0];
  const groupName = (gid?: string | null): string => (gid ? groups.find((g) => g.id === gid)?.name ?? gid : '');

  const dispatchHostCmd = async (opts: {
    name: string;
    content: string;
    timeout?: number;
    shell?: string;
    onResult: (dr: ExecutionDeviceResultDTO | undefined, done: boolean) => void;
    onStopRef: (stop: () => void) => void;
    onError: (msg: string) => void;
  }) => {
    try {
      const cmd = await api.execDeviceCommand(device.id, opts);
      if (ctx.isStale()) return;
      opts.onStopRef(
        startCommandPolling({
          cmdId: cmd.id,
          isStale: ctx.isStale,
          onUpdate(list, allDone) {
            opts.onResult(list.find((r) => r.device_id === device.id) ?? list[0], allDone);
          },
        }),
      );
    } catch (err) {
      opts.onError(err instanceof ApiError ? err.message : '指令下发失败');
    }
  };

  ctx.root.innerHTML =
    `<div class="host-hero card" id="dd-hero"></div>` +
    `<div class="ws-layout mt-3"><aside class="ws-nav card" id="dd-subnav"></aside><section class="ws-body" id="dd-panel"></section></div>`;

  const paintHero = () => {
    const hero = ctx.root.querySelector('#dd-hero');
    if (!hero) return;
    const m = device.metrics;
    const meta = platformMeta(device.platform);
    const gName = groupName(device.group_id);
    const memPct = getMemoryPercent(m);
    const health = derivePollHealth(device);
    const stHtml =
      device.status === 'online'
        ? statusBadge('online', m?.uptime ? `已开机 ${formatDuration(m.uptime)}` : undefined)
        : device.status === 'busy'
          ? statusBadge('busy')
          : statusBadge('offline', `最后在线 ${formatRelativeZh(device.last_seen)}`);

    const stats: Array<[string, string]> = [
      ['IP / 主机名', `${esc(device.ip_address || '—')} <span class="mut">${device.hostname ? `(${esc(device.hostname)})` : ''}</span>`],
      ['CPU / 负载', `${m ? `${clampPercent(m.cpu_usage).toFixed(1)}%` : '—'} <span class="mut">${m?.load_avg ? `(${esc(m.load_avg)})` : ''}</span>`],
      ['内存使用', esc(m ? (m.memory_total ? `${formatMemory(m.memory_used)} / ${formatMemory(m.memory_total)} (${memPct.toFixed(0)}%)` : formatMemory(m.memory_used)) : '—')],
      ['网络速率', m ? `↓ ${formatRate(m.network_in)} · ↑ ${formatRate(m.network_out)}` : '—'],
    ];

    hero.innerHTML =
      `<div class="rb wrap gsm"><div class="row gsm wrap">${osBadge(device.platform, 'md')}<div class="sxs"><div class="row gxs wrap"><h2 class="page-title">${esc(device.name)}</h2>${stHtml}<span class="bdg ${health.badgeCls} num"><span class="dot"></span>轮询健康值 ${health.score}% · ${esc(health.label)}</span><span class="id-pill">最近轮询 ${esc(formatRelativeZh(device.last_seen))}</span>${gName ? `<span class="grp-pill">${esc(gName)}</span>` : ''}<span class="id-pill mono">${esc(device.id)}</span></div><div class="mut txs mono">${esc([meta.label, device.os_version, device.arch, device.agent_version && `v${device.agent_version.replace(/^v/, '')}`].filter(Boolean).join(' · '))}</div></div></div>` +
      `<div class="row gxs wrap">${btn(healthProbe.running ? '检测中…' : `${icons.activity()} 健康检测`, `id="dd-health-probe"${healthProbe.running ? ' disabled' : ''}`, 'bsm bp')}${btn(`${icons.refresh()} 刷新快照`, 'id="dd-refresh"', 'bsm bg')}${btn(`${icons.key()} 安装指令`, 'id="dd-install"', 'bsm bg')}<a href="#/console?devices=${encodeURIComponent(device.id)}" class="btn bsm ba">${icons.console()} 批量执行</a></div></div>` +
      `<div class="hero-stats mt-2">${stats.map(([k, v]) => `<div class="hero-stat"><span class="mut t2xs">${k}</span><strong class="mono tsm num">${v}</strong></div>`).join('')}</div>`;

    on(hero, '#dd-health-probe', () => void runHealthProbe());
    on(hero, '#dd-install', () => void showInstallModal({ deviceId: device.id, name: device.name, platform: device.platform }));
    on(hero, '#dd-refresh', () => void refreshDevice(false));
  };

  const paintSubNav = () => {
    const nav = ctx.root.querySelector('#dd-subnav');
    if (!nav) return;
    const items: Array<[DetailTab, string, () => string]> = [
      ['metrics', '资源负载', icons.activity],
      ['terminal', '在线终端', icons.console],
      ['status', '系统状态', icons.cpu],
      ['tasks', '任务记录', icons.logs],
    ];
    nav.innerHTML = items.map(([k, l, ic]) => `<button type="button" class="ws-nav-item${activeTab === k ? ' active' : ''}" data-ws-tab="${k}">${ic()}<span>${l}</span></button>`).join('');
    onAll(nav, '[data-ws-tab]', (b) => {
      const next = b.dataset.wsTab as DetailTab;
      if (!next || next === activeTab) return;
      activeTab = next;
      window.history?.replaceState?.(null, '', `#/devices/${encodeURIComponent(device.id)}?tab=${next}`);
      paintSubNav();
      paintPanel();
    });
  };

  const paintMetricsPanel = (panel: HTMLElement) => {
    const m = device.metrics;
    const series = getTelemetrySeries(device.id, m);
    const realSamples = series.filter((s) => !s.seeded).length;
    const sampleSub = realSamples > 1 ? `手动采样 ${realSamples} 点` : '最新快照';
    const cpu = clampPercent(m?.cpu_usage ?? 0);
    const memPct = getMemoryPercent(m);
    const disk = clampPercent(m?.disk_usage ?? 0);
    const health = derivePollHealth(device);
    const lastPollAt = device.last_seen ? formatDate(device.last_seen) : '--';
    const sysRows: Array<[string, string]> = [
      ['主机名', esc(device.hostname || device.name)],
      ['操作系统', esc(device.os_version || platformMeta(device.platform).label)],
      ['CPU 架构', `<span class="mono">${esc(device.arch || '—')}</span>`],
      ['开机时长', `<span class="mono num">${esc(formatDuration(m?.uptime))}</span>`],
      ['探针版本', `<span class="mono">${esc(device.agent_version || '—')}</span>`],
      ['最近轮询请求', esc(formatRelativeZh(device.last_seen))],
    ];

    const passiveHeadHtml =
      `<div class="card sxs mb-2"><div class="rb wrap gsm">` +
      `<div><div class="row gxs wrap"><h3 class="card-title">资源概览</h3><span class="bdg ${health.badgeCls} num"><span class="dot"></span>轮询健康值 ${health.score}% · ${esc(health.label)}</span></div>` +
      `<div class="mut txs mt-1">被动轮询模式 · 最近轮询请求：${esc(formatRelativeZh(device.last_seen))}${lastPollAt !== '--' ? ` (${esc(lastPollAt)})` : ''} · 人工点击触发检测</div></div>` +
      `<div class="row gxs wrap">${btn(`${icons.refresh()} 刷新快照`, 'data-metrics-refresh', 'bsm bg')}${btn(healthProbe.running ? '检测中…' : `${icons.activity()} 健康检测`, `data-health-probe${healthProbe.running ? ' disabled' : ''}`, 'bsm bp')}</div>` +
      `</div>${metricBar(health.score, health.tone)}</div>`;

    const hasProbe = healthProbe.running || Boolean(healthProbe.status) || Boolean(healthProbe.output);
    const probeBodyHtml = healthProbe.output
      ? `<pre class="term-pre host-pre">${esc(healthProbe.output)}</pre>`
      : `<pre class="term-pre host-pre"><span class="mut">${healthProbe.running ? '正在等待探针下次轮询执行并回传健康检测结果…' : '(无输出)'}</span></pre>`;
    const probeCardHtml = hasProbe
      ? `<div class="card sxs mb-2"><div class="rb wrap gxs"><div class="row gxs wrap"><strong>主动健康检测结果</strong>${healthProbe.status ? statusBadge(healthProbe.status) : ''}${healthProbe.exitCode !== null ? exitCodeBadge(healthProbe.exitCode, healthProbe.status) : ''}</div><div class="row gxs wrap"><span class="mut t2xs mono num">${esc(formatElapsed(healthProbe.startedAt, healthProbe.completedAt))}</span>${healthProbe.updatedAt ? `<span class="mut t2xs">${esc(formatRelativeZh(healthProbe.updatedAt))}</span>` : ''}${healthProbe.output ? btn(icons.copy(), `data-copy-text="${esc(healthProbe.output)}" title="复制"`, 'bxs bg') : ''}</div></div>${probeBodyHtml}</div>`
      : `<div class="card mb-2"><div class="rb wrap gsm"><div><strong>主动健康检测结果</strong><div class="mut txs mt-1">本次会话尚未执行主动健康检测，点击按钮下发轻量只读健康检查并同步主机状态。</div></div>${btn(`${icons.activity()} 立即执行健康检测`, 'data-health-probe', 'bsm ba')}</div></div>`;

    const mCard = (lbl: string, valTxt: string, rightTop: string, chart: string) =>
      `<div class="card metric-card"><div class="rb"><div><div class="mut txs">${lbl}</div><div class="metric-big num">${valTxt}</div></div><div class="tr"><span class="tag mono num">${rightTop}</span><div class="mut t2xs mt-1">${sampleSub}</div></div></div>${chart}</div>`;

    panel.innerHTML =
      passiveHeadHtml +
      probeCardHtml +
      `<div class="grid-2">` +
      mCard('CPU 负载', m ? `${cpu.toFixed(1)}%` : '—', `Load ${esc(m?.load_avg || '—')}`, singleBarChartHtml({ samples: series, pick: (s) => s.cpu, label: 'CPU' })) +
      mCard('内存占用', m ? `${memPct.toFixed(1)}%` : '—', m ? `${formatMemory(m.memory_used)}${m.memory_total ? `/${formatMemory(m.memory_total)}` : ''}` : '—', singleBarChartHtml({ samples: series, pick: (s) => s.memPct, label: '内存', tone: 'mint' })) +
      `<div class="card metric-card"><div class="rb wrap gxs"><div><div class="mut txs">网络吞吐</div><div class="row gxs mt-1"><span class="net-pill net-tx num">↑ ${m ? formatRate(m.network_out) : '—'}</span><span class="net-pill net-rx num">↓ ${m ? formatRate(m.network_in) : '—'}</span></div></div>${tabsHtml([['both', '双向'], ['tx', '上传'], ['rx', '下载']], netMode, 'data-net-mode', true)}</div>${networkBarChartHtml(series, netMode)}</div>` +
      `<div class="card metric-card ssm"><div class="rb"><div><div class="mut txs">磁盘与系统</div><div class="metric-big num">${m ? `${disk.toFixed(1)}%` : '—'}</div></div><span class="tag mono">${m?.disk_total ? `总计 ${formatMemory(m.disk_total)}` : '根分区'}</span></div>${metricBar(disk)}<div class="sys-kv">${sysRows.map(([k, v]) => `<div><span class="mut t2xs">${k}</span><div class="tsm truncate">${v}</div></div>`).join('')}</div></div>` +
      `</div>`;

    bindChartTooltips(panel);
    bindCopyButtons(panel);
    on(panel, '[data-metrics-refresh]', () => void refreshDevice(false));
    onAll(panel, '[data-health-probe]', () => void runHealthProbe());
    onAll(panel, '[data-net-mode]', (b) => {
      netMode = (b.dataset.netMode as NetChartMode) || 'both';
      paintMetricsPanel(panel);
    });
  };

  const paintTerminalPanel = (panel: HTMLElement) => {
    const active = currentTerm();
    const presets = getPresets(platKey);
    const tabStrip =
      termTabs
        .map((t) => `<div class="term-tab${t.id === active.id ? ' active' : ''}" data-term-tab="${esc(t.id)}">${t.running ? '<span class="dot dot-warn dot-pulse"></span>' : ''}<span>${esc(t.title)}</span>${termTabs.length > 1 ? `<button type="button" class="htab-x" data-term-close="${esc(t.id)}">×</button>` : ''}</div>`)
        .join('') +
      (termTabs.length < 5 ? `<button type="button" class="term-add" id="term-new-tab">${icons.plus()} 新建</button>` : '');

    panel.innerHTML =
      `<section class="card t-card t-theme-${termTheme}">` +
      `<div class="t-tabs-bar"><div class="t-tabs-strip">${tabStrip}</div><div class="row gxs"><label class="t2xs mut" for="term-theme">配色</label><select id="term-theme" class="input ixs"><option value="dracula"${termTheme === 'dracula' ? ' selected' : ''}>Dracula</option><option value="midnight"${termTheme === 'midnight' ? ' selected' : ''}>Midnight</option><option value="light"${termTheme === 'light' ? ' selected' : ''}>Light</option></select></div></div>` +
      `<div class="t-hd"><div class="row gxs wrap"><span class="term-dots"><i></i><i></i><i></i></span><strong class="mono tsm">${esc(device.hostname || device.name)}</strong></div><div class="row gxs wrap"><label class="t2xs mut" for="term-shell">Shell</label>${shellSelectHtml('term-shell', active.shell, 'input ixs')}<label class="t2xs mut" for="term-timeout">超时(s)</label><input id="term-timeout" class="input ixs mono w-70" type="number" min="5" max="3600" value="${active.timeout}">${btn('复制全部', 'id="term-copy-all"', 'bxs bg')}${btn('清空', 'id="term-clear"', 'bxs bg')}</div></div>` +
      `<div class="preset-bar"><span class="mut t2xs">快捷指令:</span>${presets.map(([l, c, sh]) => `<button type="button" class="chip" data-preset="${esc(c)}" data-pshell="${esc(sh ?? '')}">${esc(l)}</button>`).join('')}</div>` +
      `<div class="t-scr" id="term-output"></div>` +
      `<form id="term-form" class="t-prm"><span class="prompt-sig mono">$</span><input id="term-input" class="term-input mono" type="text" placeholder="输入命令 (↑/↓ 历史，Enter 执行)…" autocomplete="off" spellcheck="false">${btn(`${icons.stop()} 停止`, 'id="term-stop"', `bxs be${active.running ? '' : ' hidden'}`)}<button type="submit" class="btn bsm bp" id="term-run"${active.running ? ' disabled' : ''}>${icons.play()} 执行</button></form></section>`;

    const screen = panel.querySelector('#term-output') as HTMLElement;
    const renderScreen = () => {
      const cur = currentTerm();
      if (!cur.entries.length) {
        screen.innerHTML = '<div class="t-wlc mut">就绪。选择快捷指令或输入命令按 Enter 执行。</div>';
        return;
      }
      screen.innerHTML = cur.entries
        .map((e) => {
          const dl = logDownloadUrl(e.resultId, e.logUrl);
          const cleanOut = stripAnsi(e.output);
          return `<div class="te"><div class="te-hd"><div class="row gxs wrap"><span class="prompt-sig mono">$</span><code class="mono term-cmd">${esc(e.commandText)}</code>${e.shell !== 'auto' ? `<span class="tag">${esc(e.shell)}</span>` : ''}</div><div class="row gxs wrap">${statusBadge(e.status)}${exitCodeBadge(e.exitCode, e.status)}<span class="mut t2xs mono num">${esc(formatElapsed(e.startedAt ?? e.sentAt, e.completedAt))} · ${esc(formatDate(e.sentAt).slice(11))}</span>${btn(icons.copy(), `data-copy-text="${esc(cleanOut)}" title="复制"`, 'b2x bg')}${dl ? `<a class="btn b2x bg" href="${esc(dl)}" download>${icons.download()}</a>` : ''}</div></div>${preOutputHtml(e.output, isTerminalExecStatus(e.status) ? '(无输出)' : '等待探针执行…', 'term-pre')}</div>`;
        })
        .join('');
      bindCopyButtons(screen);
      screen.scrollTop = screen.scrollHeight;
    };
    renderScreen();

    const inputEl = panel.querySelector('#term-input') as HTMLInputElement;
    const shellEl = panel.querySelector('#term-shell') as HTMLSelectElement;
    const timeoutEl = panel.querySelector('#term-timeout') as HTMLInputElement;

    on(panel, '#term-theme', (el) => {
      termTheme = (el as HTMLSelectElement).value as TermTheme;
      try { localStorage.setItem(TERM_THEME_KEY, termTheme); } catch { /* ignore */ }
      paintTerminalPanel(panel);
    }, 'change');
    on(panel, '#term-new-tab', () => {
      if (termTabs.length >= 5) return;
      const id = `t${Date.now()}_${++tabSeq}`;
      termTabs.push({ id, title: `终端 ${tabSeq}`, shell: defaultShell, timeout: 60, entries: [], running: false, stopPoll: null });
      activeTermId = id;
      paintTerminalPanel(panel);
    });
    onAll(panel, '[data-term-tab]', (el, ev) => {
      if ((ev.target as HTMLElement).closest('[data-term-close]')) return;
      const id = el.dataset.termTab;
      if (id && id !== activeTermId) { activeTermId = id; paintTerminalPanel(panel); }
    });
    onAll(panel, '[data-term-close]', (b, ev) => {
      ev.stopPropagation();
      const id = b.dataset.termClose;
      if (!id || termTabs.length <= 1) return;
      const idx = termTabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      termTabs[idx].stopPoll?.();
      termTabs.splice(idx, 1);
      if (activeTermId === id) activeTermId = termTabs[Math.max(0, idx - 1)].id;
      paintTerminalPanel(panel);
    });
    shellEl.addEventListener('change', () => { active.shell = shellEl.value; });
    timeoutEl.addEventListener('change', () => { active.timeout = Math.max(5, Math.min(3600, Number(timeoutEl.value) || 60)); });
    on(panel, '#term-clear', () => { active.entries.length = 0; renderScreen(); });
    on(panel, '#term-copy-all', () => void copyText(active.entries.map((e) => `$ ${e.commandText}\n${stripAnsi(e.output)}`).join('\n\n') || '(空)', '已复制终端输出'));
    on(panel, '#term-stop', () => { active.stopPoll?.(); active.stopPoll = null; active.running = false; paintTerminalPanel(panel); });
    onAll(panel, '[data-preset]', (b) => {
      inputEl.value = b.dataset.preset ?? '';
      if (b.dataset.pshell) { shellEl.value = b.dataset.pshell; active.shell = b.dataset.pshell; }
      inputEl.focus();
    });
    inputEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowUp' && cmdHistory.length) { ev.preventDefault(); histIdx = Math.min(histIdx + 1, cmdHistory.length - 1); inputEl.value = cmdHistory[histIdx] ?? ''; }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); histIdx <= 0 ? ((histIdx = -1), (inputEl.value = '')) : (inputEl.value = cmdHistory[--histIdx] ?? ''); }
    });

    on(panel, '#term-form', async (_el, ev) => {
      ev.preventDefault();
      const targetTab = currentTerm();
      if (targetTab.running) return;
      const content = inputEl.value.trim();
      if (!content) return;
      targetTab.shell = shellEl.value;
      targetTab.timeout = Math.max(5, Math.min(3600, Number(timeoutEl.value) || 60));
      if (cmdHistory[0] !== content) {
        cmdHistory.unshift(content);
        try { localStorage.setItem(HIST_KEY, JSON.stringify(cmdHistory.slice(0, 50))); } catch { /* ignore */ }
      }
      histIdx = -1;
      inputEl.value = '';
      targetTab.running = true;

      const entry: TerminalEntry = { commandText: content, shell: targetTab.shell, sentAt: new Date().toISOString(), status: 'queued', exitCode: null, output: '', startedAt: null, completedAt: null };
      targetTab.entries.push(entry);
      paintTerminalPanel(panel);

      await dispatchHostCmd({
        name: `quick: ${content.slice(0, 48)}`,
        content,
        timeout: targetTab.timeout,
        shell: targetTab.shell,
        onStopRef: (s) => { targetTab.stopPoll = s; },
        onResult(dr, allDone) {
          if (dr) {
            entry.status = dr.status;
            entry.exitCode = dr.exit_code;
            entry.output = dr.output ?? '';
            entry.startedAt = dr.started_at ?? entry.sentAt;
            entry.completedAt = dr.completed_at ?? null;
            entry.resultId = dr.result_id ?? dr.id;
            entry.logUrl = dr.log_url;
            if (activeTab === 'terminal' && activeTermId === targetTab.id) renderScreen();
          }
          if (allDone) {
            targetTab.stopPoll?.();
            targetTab.stopPoll = null;
            targetTab.running = false;
            if (activeTab === 'terminal') paintTerminalPanel(panel);
            api.listCommandLogs({ device_id: deviceId, per_page: 25 }).then((l) => {
              if (!ctx.isStale()) { recentLogs = l.logs ?? []; if (activeTab === 'tasks') paintTasksPanel(panel); }
            }).catch(() => {});
          }
        },
        onError(msg) {
          entry.status = 'failed';
          entry.output = msg;
          targetTab.running = false;
          if (activeTab === 'terminal') paintTerminalPanel(panel);
          toast(msg, 'err');
        },
      });
    }, 'submit');
  };

  const runDiagnostic = async (diag: DiagState) => {
    if (diag.running) return;
    diag.stopPoll?.();
    diag.running = true;
    diag.status = 'queued';
    diag.exitCode = null;
    if (activeTab === 'status') paintPanel();
    const spec = getDiagCommand(diag.id, platKey);
    await dispatchHostCmd({
      name: `diag-${diag.id}: ${device.name}`,
      content: spec.cmd,
      timeout: 45,
      shell: spec.shell,
      onStopRef: (s) => { diag.stopPoll = s; },
      onResult(dr, allDone) {
        if (dr) {
          diag.status = dr.status;
          diag.exitCode = dr.exit_code;
          diag.output = stripAnsi(dr.output ?? '');
          diag.updatedAt = dr.completed_at || dr.started_at || new Date().toISOString();
        }
        if (allDone) { diag.stopPoll?.(); diag.stopPoll = null; diag.running = false; }
        if (activeTab === 'status') paintPanel();
      },
      onError(msg) {
        diag.running = false;
        diag.status = 'failed';
        diag.output = msg;
        if (activeTab === 'status') paintPanel();
        toast(msg, 'err');
      },
    });
  };

  const paintStatusPanel = (panel: HTMLElement) => {
    const cards = diags
      .map((d) => {
        const lines = d.output ? d.output.split('\n').filter(Boolean).length : 0;
        const body = d.output
          ? `<pre class="term-pre host-pre">${esc(d.output)}</pre>`
          : d.running
            ? '<div class="ld-b"><span class="spinner"></span> 采集中…</div>'
            : `<div class="emp-i mut txs">点击“采集”获取 ${esc(d.title)}</div>`;
        return `<div class="card sxs"><div class="rb wrap gxs"><div class="row gxs"><strong>${esc(d.title)}</strong>${d.status ? statusBadge(d.status) : ''}${d.exitCode !== null ? exitCodeBadge(d.exitCode, d.status) : ''}${lines ? `<span class="tag num">${lines} 行</span>` : ''}</div><div class="row gxs">${d.updatedAt ? `<span class="mut t2xs">${esc(formatRelativeZh(d.updatedAt))}</span>` : ''}${d.output ? btn(icons.copy(), `data-copy-text="${esc(d.output)}" title="复制"`, 'bxs bg') : ''}${btn(d.running ? '采集中…' : `${icons.play()} 采集`, `data-diag-run="${d.id}"${d.running ? ' disabled' : ''}`, 'bxs ba')}</div></div>${body}</div>`;
      })
      .join('');
    panel.innerHTML = `<div class="card mb-2"><div class="rb wrap gsm"><div><h3 class="card-title">系统诊断采集</h3><div class="mut txs">平台 (${esc(platformMeta(device.platform).label)}) 安全只读命令</div></div>${btn(`${icons.play()} 全部采集`, 'id="diag-run-all"', 'bsm bp')}</div></div><div class="grid-2">${cards}</div>`;
    bindCopyButtons(panel);
    on(panel, '#diag-run-all', () => diags.forEach((d) => void runDiagnostic(d)));
    onAll(panel, '[data-diag-run]', (b) => {
      const target = diags.find((d) => d.id === b.dataset.diagRun);
      if (target) void runDiagnostic(target);
    });
  };

  const paintTasksPanel = (panel: HTMLElement) => {
    const rows = recentLogs
      .map((l, idx) => {
        const dl = logDownloadUrl(l.result_id, l.log_url);
        const cleanOut = stripAnsi(l.output_preview || '');
        const isOpen = expandedLogIdx === idx;
        const isDiff = diffLogIdx === idx;
        const prev = recentLogs[idx + 1];
        const diffHtml = isDiff && prev ? diffPreHtml(prev.output_preview ?? '', l.output_preview ?? '', '与前次输出一致。') : '';
        return `<div class="hc"><div class="hc-hd" data-task-toggle="${idx}"><div class="row gxs wrap"><span class="chev${isOpen ? '' : ' rot'}">${icons.chevronDown()}</span><strong>${esc(l.command_name || l.command_id || l.execution_id)}</strong>${statusBadge(l.status)}${exitCodeBadge(l.exit_code, l.status)}</div><div class="row gxs"><span class="mut t2xs mono num">${esc(formatElapsed(l.started_at, l.completed_at))} · ${esc(formatRelativeZh(l.started_at))}</span>${prev ? btn('对比', `data-task-diff="${idx}"`, `b2x ${isDiff ? 'bp' : 'bg'}`) : ''}${btn(icons.copy(), `data-copy-text="${esc(cleanOut)}" title="复制"`, 'b2x bg')}${dl ? `<a class="btn b2x bg" href="${esc(dl)}" download>${icons.download()}</a>` : ''}</div></div>${isOpen ? preOutputHtml(l.output_preview || '', '(无输出)') : ''}${diffHtml}</div>`;
      })
      .join('');
    panel.innerHTML = `<div class="card ssm"><div class="rb wrap gsm"><div><h3 class="card-title">任务记录</h3><div class="mut txs">最近执行状态与输出预览</div></div><div class="row gxs">${btn(`${icons.refresh()} 刷新`, 'id="tasks-refresh"', 'bsm bg')}<a href="#/logs" class="btn bsm ba">日志中心 →</a></div></div>${rows || '<div class="emp-i mut">暂无执行记录。</div>'}</div>`;
    bindCopyButtons(panel);
    on(panel, '#tasks-refresh', async () => {
      try {
        recentLogs = (await api.listCommandLogs({ device_id: deviceId, per_page: 25 })).logs ?? [];
        if (!ctx.isStale()) paintTasksPanel(panel);
      } catch (err) { toast(err instanceof ApiError ? err.message : '刷新失败', 'err'); }
    });
    onAll(panel, '[data-task-toggle]', (el, ev) => {
      if ((ev.target as HTMLElement).closest('button, a')) return;
      const idx = Number(el.dataset.taskToggle);
      expandedLogIdx = expandedLogIdx === idx ? null : idx;
      paintTasksPanel(panel);
    });
    onAll(panel, '[data-task-diff]', (b, ev) => {
      ev.stopPropagation();
      const idx = Number(b.dataset.taskDiff);
      diffLogIdx = diffLogIdx === idx ? null : idx;
      paintTasksPanel(panel);
    });
  };

  const paintPanel = () => {
    const panel = ctx.root.querySelector('#dd-panel') as HTMLElement | null;
    if (!panel) return;
    if (activeTab === 'metrics') paintMetricsPanel(panel);
    else if (activeTab === 'terminal') paintTerminalPanel(panel);
    else if (activeTab === 'status') paintStatusPanel(panel);
    else paintTasksPanel(panel);
  };

  const refreshDevice = async (silent: boolean) => {
    const [stRes, fullDev] = await Promise.all([api.getDeviceStatus(deviceId).catch(() => null), api.getDevice(deviceId).catch(() => null)]);
    if (ctx.isStale()) return;
    if (fullDev) device = fullDev;
    else if (stRes) {
      device.status = stRes.status;
      device.last_seen = stRes.last_updated;
      if (stRes.metrics) device.metrics = stRes.metrics;
    } else if (!silent) return void toast('刷新主机状态失败', 'err');
    if (device.metrics) pushTelemetrySample(device.id, device.metrics);
    openHostTab({ id: device.id, name: device.name, platform: device.platform, status: device.status });
    paintHero();
    if (activeTab === 'metrics') {
      const panel = ctx.root.querySelector('#dd-panel') as HTMLElement | null;
      if (panel) paintMetricsPanel(panel);
    }
  };

  const runHealthProbe = async () => {
    if (healthProbe.running) return;
    healthProbe.stopPoll?.();
    healthProbe.running = true;
    healthProbe.status = 'queued';
    healthProbe.exitCode = null;
    healthProbe.output = '';
    healthProbe.startedAt = new Date().toISOString();
    healthProbe.completedAt = null;
    healthProbe.updatedAt = healthProbe.startedAt;
    if (activeTab !== 'metrics') {
      activeTab = 'metrics';
      window.history?.replaceState?.(null, '', `#/devices/${encodeURIComponent(device.id)}?tab=metrics`);
      paintSubNav();
    }
    paintHero();
    paintPanel();

    const spec =
      platKey === 'windows'
        ? {
            shell: 'powershell',
            content:
              'Get-CimInstance Win32_OperatingSystem | Select CSName,LastBootUpTime,FreePhysicalMemory,TotalVisibleMemorySize | ft -a; Get-PSDrive C | ft -a',
          }
        : {
            content:
              'uname -sr && uptime && (free -m 2>/dev/null || vm_stat 2>/dev/null | head -n 6 || head -n 5 /proc/meminfo) && df -h /',
          };

    await dispatchHostCmd({
      name: `health-probe: ${device.name}`,
      content: spec.content,
      timeout: 45,
      shell: spec.shell,
      onStopRef: (s) => {
        healthProbe.stopPoll = s;
      },
      onResult(dr, allDone) {
        if (dr) {
          healthProbe.status = dr.status;
          healthProbe.exitCode = dr.exit_code;
          healthProbe.output = stripAnsi(dr.output ?? '');
          healthProbe.startedAt = dr.started_at ?? healthProbe.startedAt;
          healthProbe.completedAt = dr.completed_at ?? null;
          healthProbe.updatedAt = dr.completed_at || dr.started_at || new Date().toISOString();
        }
        if (allDone) {
          healthProbe.stopPoll?.();
          healthProbe.stopPoll = null;
          healthProbe.running = false;
          paintHero();
          if (activeTab === 'metrics') paintPanel();
          void refreshDevice(true);
          api
            .listCommandLogs({ device_id: deviceId, per_page: 25 })
            .then((l) => {
              if (!ctx.isStale()) {
                recentLogs = l.logs ?? [];
                if (activeTab === 'tasks') paintPanel();
              }
            })
            .catch(() => {});
        } else if (activeTab === 'metrics') {
          paintPanel();
        }
      },
      onError(msg) {
        healthProbe.stopPoll?.();
        healthProbe.stopPoll = null;
        healthProbe.running = false;
        healthProbe.status = 'failed';
        healthProbe.output = msg;
        healthProbe.completedAt = new Date().toISOString();
        healthProbe.updatedAt = healthProbe.completedAt;
        if (ctx.isStale()) return;
        paintHero();
        if (activeTab === 'metrics') paintPanel();
        toast(msg, 'err');
      },
    });
  };

  paintHero();
  paintSubNav();
  paintPanel();
  if (shouldAutoProbe) {
    window.history?.replaceState?.(null, '', `#/devices/${encodeURIComponent(device.id)}?tab=${activeTab}`);
    void runHealthProbe();
  }
}
