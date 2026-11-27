import type { CommandLogDTO, DeviceDTO, ExecutionDeviceResultDTO, GroupDTO, HealthHistoryRange, HealthHistoryResponse } from '../../../shared/types';
import { api, ApiError } from '../api';
import { bindUptimeTooltips, commandSourceBadge, exitCodeBadge, healthTimelineHtml, logDownloadUrl, metricBar, osBadge, statusBadge, uptimeDotsHtml } from '../components/badges';
import { bindChartTooltips, networkBarChartHtml, singleBarChartHtml, type NetChartMode } from '../components/charts';
import { showInstallModal } from '../components/install-modal';
import { bindChange, bindCopyButtons, btn, copyBtnHtml, diffPreHtml, dlBtnHtml, hCard, hEmp, hInp, hLnk, hMono, hMs, hMut, hPre, hRb, hRow, hRw, hStk, hTag, ipCopyHtml, isTerminalExecStatus, on, onAll, preOutputHtml, selectHtml, shellSelectHtml, startCommandPolling, tabsHtml } from '../components/ui';
import { icons } from '../icons';
import type { RouteContext } from '../router';
import { copyText, getTelemetrySeries, openHostTab, pushTelemetrySample, registerCleanup, state, syncActiveTimeZone, toast } from '../state';
import { clampPercent, deviceGroupIds, deviceIps, esc, formatDate, formatDuration, formatElapsed, formatMemory, formatRate, formatRelativeZh, getActiveTimeZone, getMemoryPercent, platformMeta, stripAnsi, type CanonicalPlatform } from '../utils';
import { derivePollHealth, derivePollHealthSlots, formatCadence, groupToneClass, openUpgradeDevicesModal, showDeviceIpsModal, type PollSchedule } from './devices';

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

interface ProbeTaskState {
  running: boolean;
  status: string;
  exitCode: number | null;
  output: string;
  updatedAt: string;
  stopPoll: (() => void) | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

interface DiagState extends ProbeTaskState {
  id: 'proc' | 'net' | 'disk' | 'log';
  title: string;
}

type HealthProbeState = ProbeTaskState;

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
      state.systemInfo
        ? Promise.resolve(state.systemInfo)
        : api
            .getSystemInfo()
            .then((s) => {
              state.systemInfo = s;
              syncActiveTimeZone();
              return s;
            })
            .catch(() => null),
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

  const diags: DiagState[] = (
    [['proc', '进程信息'], ['net', '网络端口'], ['disk', '磁盘挂载'], ['log', '系统日志']] as const
  ).map(([id, title]) => ({
    id,
    title,
    running: false,
    status: '',
    exitCode: null,
    output: '',
    updatedAt: '',
    stopPoll: null,
  }));

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
  let taskFilter: 'all' | 'immediate' | 'health' | 'scheduled' = 'all';
  let healthRange: 'live' | HealthHistoryRange = 'live';
  let healthCache: Partial<Record<HealthHistoryRange, HealthHistoryResponse>> = {};
  let healthLoading = false;
  let healthReqSeq = 0;
  let lastUserScrollAt = 0;
  let termPinned = true;

  const resolveTzParam = (): string | undefined => {
    const active = getActiveTimeZone();
    if (active) return active;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; }
  };

  registerCleanup(() => {
    healthProbe.stopPoll?.();
    healthProbe.stopPoll = null;
    healthProbe.running = false;
    for (const t of termTabs) { t.stopPoll?.(); t.stopPoll = null; t.running = false; }
    for (const d of diags) { d.stopPoll?.(); d.stopPoll = null; d.running = false; }
  });

  const currentTerm = (): TermTab => termTabs.find((t) => t.id === activeTermId) ?? termTabs[0];
  const groupName = (gid?: string | null): string => (gid ? groups.find((g) => g.id === gid)?.name ?? gid : '');
  const refreshRecentLogs = () => {
    api
      .listCommandLogs({ device_id: deviceId, per_page: 25 })
      .then((l) => {
        if (!ctx.isStale()) {
          recentLogs = l.logs ?? [];
          if (activeTab === 'tasks') paintPanel();
        }
      })
      .catch(() => {});
  };

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

  const pollSchedule = (): PollSchedule => ({
    pollInterval: state.systemInfo?.poll_interval,
    heartbeatInterval: state.systemInfo?.heartbeat_interval,
  });

  const paintHero = () => {
    const hero = ctx.root.querySelector('#dd-hero');
    if (!hero) return;
    const m = device.metrics;
    const meta = platformMeta(device.platform);
    const grpPillsHtml = deviceGroupIds(device)
      .map((gid) => `<span class="grp-pill ${groupToneClass(gid)}">${esc(groupName(gid))}</span>`)
      .join('');
    const memPct = getMemoryPercent(m);
    const sched = pollSchedule();
    const pollSec = Math.max(5, Number(sched.pollInterval) || 60);
    const hbSec = Math.max(pollSec, Number(sched.heartbeatInterval) || Math.max(300, pollSec * 5));
    const stHtml = statusBadge(
      device.status,
      device.status === 'online'
        ? m?.uptime
          ? `已开机 ${formatDuration(m.uptime)}`
          : undefined
        : device.status === 'offline'
          ? `最后在线 ${formatRelativeZh(device.last_seen)}`
          : undefined,
    );

    const ips = deviceIps(device);
    const stats: Array<[string, string]> = [
      [
        'IP / 主机名',
        `<span class="row gxs min-w-0">${ips[0] ? ipCopyHtml(ips[0], 'tsm') : '<span class="mut">—</span>'}${ips.length > 1 ? `<button type="button" class="tag tag-accent num" id="dd-all-ips" title="共 ${ips.length} 个 IP · 点击查看">+${ips.length - 1}</button>` : ''}${device.hostname ? `<span class="mut truncate" title="${esc(device.hostname)}">(${esc(device.hostname)})</span>` : ''}</span>`,
      ],
      ['CPU / 负载', `${m ? `${clampPercent(m.cpu_usage).toFixed(1)}%` : '—'} <span class="mut">${m?.load_avg ? `(${esc(m.load_avg)})` : ''}</span>`],
      ['内存使用', esc(m ? (m.memory_total ? `${formatMemory(m.memory_used)} / ${formatMemory(m.memory_total)} (${memPct.toFixed(0)}%)` : formatMemory(m.memory_used)) : '—')],
      ['网络速率', m ? `↓ ${formatRate(m.network_in)} · ↑ ${formatRate(m.network_out)}` : '—'],
    ];

    hero.innerHTML =
      hRb(
        `<div class="row gsm ai-start min-w-0 flex-1">${osBadge(device.platform, 'md')}<div class="sxs min-w-0 flex-1">${hRw(`<h2 class="page-title">${esc(device.name)}</h2>${stHtml}<span class="tag num">调度 ${esc(formatCadence(pollSec))}/${esc(formatCadence(hbSec))}</span>${grpPillsHtml}`)}<div class="mut txs mono">${esc([device.id, meta.label, device.os_version, device.arch, device.agent_version && `v${device.agent_version.replace(/^v/, '')}`].filter(Boolean).join(' · '))}</div></div></div>` +
          hRw(
            `${btn(healthProbe.running ? '检测中…' : `${icons.activity()} 健康检测`, `id="dd-health-probe"${healthProbe.running ? ' disabled' : ''}`, 'bsm bp')}${btn(`${icons.download()} 升级`, 'id="dd-upgrade"', 'bsm bg')}${btn(`${icons.refresh()} 刷新快照`, 'id="dd-refresh"', 'bsm bg')}${btn(`${icons.key()} 安装指令`, 'id="dd-install"', 'bsm bg')}${hLnk(`#/console?devices=${encodeURIComponent(device.id)}`, `${icons.console()} 批量执行`, 'bsm ba')}`,
          ),
      ) +
      `<div class="hero-stats mt-2">${stats.map(([k, v]) => `<div class="hero-stat"><span class="mut t2xs">${k}</span><strong class="mono tsm num">${v}</strong></div>`).join('')}</div>`;

    bindCopyButtons(hero);
    on(hero, '#dd-all-ips', () => showDeviceIpsModal(device.name, ips));
    on(hero, '#dd-upgrade', () =>
      openUpgradeDevicesModal([device], () => {
        void refreshDevice(true);
        refreshRecentLogs();
      }),
    );
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
      ['tasks', '执行记录', icons.logs],
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
    const sampleSub = realSamples > 1 ? `手动采样 ${realSamples} 点` : '';
    const cpu = clampPercent(m?.cpu_usage ?? 0);
    const memPct = getMemoryPercent(m);
    const disk = clampPercent(m?.disk_usage ?? 0);
    const sched = pollSchedule();
    const pollSec = Math.max(5, Number(sched.pollInterval) || 60);
    const hbSec = Math.max(pollSec, Number(sched.heartbeatInterval) || Math.max(300, pollSec * 5));
    const health = derivePollHealth(device, Date.now(), sched);
    const lastPollAt = device.last_seen ? formatDate(device.last_seen) : '--';
    const sysRows: Array<[string, string]> = [
      ['主机 ID', hMono(esc(device.id))],
      ['探针版本', hMono(esc(device.agent_version ? `v${device.agent_version.replace(/^v/, '')}` : '—'))],
      ['调度周期', hMono(`${esc(formatCadence(pollSec))} / ${esc(formatCadence(hbSec))}`, ' num')],
      ['开机时长', hMono(esc(formatDuration(m?.uptime)), ' num')],
    ];

    const rangeMeta: Record<HealthHistoryRange, [string, string]> = {
      '1h': ['1小时', '5m/格'],
      '24h': ['24小时', '1h/格'],
      '7d': ['7天', '1d/格'],
      '30d': ['30天', '1d/格'],
    };
    const rangeTabs = tabsHtml(
      [['live', '实时'], ['1h', '1小时'], ['24h', '24小时'], ['7d', '7天'], ['30d', '30天']],
      healthRange,
      'data-dd-hrange',
      true,
    );
    const cadenceTxt = `${formatCadence(pollSec)}/${formatCadence(hbSec)}`;

    let passiveBadgeHtml = `<span class="bdg ${health.badgeCls}"><span class="dot"></span>${esc(health.label)}</span>`;
    let passiveSubHtml = `被动轮询 · 最近轮询请求：${esc(formatRelativeZh(device.last_seen))}${lastPollAt !== '--' ? ` (${esc(lastPollAt)})` : ''}`;
    let passiveBodyHtml = `<div class="up-wrap">${uptimeDotsHtml(derivePollHealthSlots(device, 24, Date.now(), pollSec, hbSec), { lg: true, label: health.label, windowSec: pollSec })}<div class="rb t2xs mut mt-1"><span>24 窗口前</span><span>${esc(formatCadence(pollSec))}/格</span><span>当前</span></div></div>`;

    if (healthRange !== 'live') {
      const [shortLbl, descLbl] = rangeMeta[healthRange];
      const hist = healthCache[healthRange];
      const pct = hist?.overall_uptime_pct ?? null;
      const pctCls = pct === null ? 'bd-m' : pct >= 98 ? 'bd-ok' : pct >= 85 ? 'bd-wn' : 'bd-er';
      passiveBadgeHtml = hist
        ? `<span class="bdg ${pctCls}"><span class="dot"></span>${shortLbl}可用率 ${pct !== null ? `${pct.toFixed(1)}%` : '--'}</span>`
        : `<span class="bdg bd-m">${healthLoading ? '加载中…' : '暂无历史'}</span>`;
      passiveSubHtml = `心跳历史${lastPollAt !== '--' ? ` · 最近轮询 ${esc(lastPollAt)}` : ''}`;
      passiveBodyHtml = hist
        ? `${healthTimelineHtml(hist.buckets, {
            leftAxis: hist.buckets[0]?.label ?? '',
            centerAxis: `${descLbl} · ${hist.timezone}`,
            rightAxis: '当前',
            label: `${device.name} 健康时间轴`,
          })}<div class="row gsm t2xs mut up-leg"><span class="row gxs"><i class="leg-dot up-ok"></i>正常</span><span class="row gxs"><i class="leg-dot up-warn"></i>波动</span><span class="row gxs"><i class="leg-dot up-err"></i>离线</span><span class="row gxs"><i class="leg-dot up-empty"></i>无记录</span></div>`
        : `<div class="mut txs p-2">${healthLoading ? '正在加载健康历史…' : '暂无该时段心跳记录'}</div>`;
    }

    const passiveHeadHtml = hCard(
      `${hRb(`<div>${hRw(`<h3 class="card-title">资源概览</h3>${passiveBadgeHtml}`)}${hMut(passiveSubHtml, 'txs mt-1')}</div>${rangeTabs}`, 'wrap gxs')}${passiveBodyHtml}`,
      'sxs mb-2',
    );

    const encId = encodeURIComponent(device.id);
    const healthLogsLink = hLnk(`#/logs?tab=health&device_id=${encId}`, '历史健康日志 →', 'bxs bg');
    const hasProbe = healthProbe.running || Boolean(healthProbe.status) || Boolean(healthProbe.output);
    const recentHealth = !hasProbe ? recentLogs.find((l) => (l.command_name ?? '').startsWith('health-probe:')) : undefined;
    const probeBodyHtml = hPre(
      healthProbe.output
        ? esc(healthProbe.output)
        : hMs(healthProbe.running ? '等待探针下次轮询回传检测结果…' : '(无输出)', ''),
    );
    const probeCardHtml = hasProbe
      ? hCard(
          `${hRb(
            `${hRw(`<strong>主动健康检测结果</strong>${healthProbe.status ? statusBadge(healthProbe.status) : ''}${healthProbe.exitCode !== null ? exitCodeBadge(healthProbe.exitCode, healthProbe.status) : ''}`)}${hRw(`${hMs(esc(formatElapsed(healthProbe.startedAt, healthProbe.completedAt)), 't2xs mono num')}${healthProbe.updatedAt ? hMs(esc(formatRelativeZh(healthProbe.updatedAt)), 't2xs') : ''}${healthProbe.output ? copyBtnHtml(healthProbe.output, 'bxs bg') : ''}${healthLogsLink}`)}`,
            'wrap gxs',
          )}${probeBodyHtml}`,
          'sxs mb-2',
        )
      : recentHealth
        ? hCard(
            hRb(
              `<div class="min-w-0 flex-1">${hRw(`<strong>主动健康检测结果</strong>${statusBadge(recentHealth.status)}${exitCodeBadge(recentHealth.exit_code, recentHealth.status)}${hMs(`上次检测 ${esc(formatRelativeZh(recentHealth.completed_at || recentHealth.started_at))}`, 't2xs')}`)}${recentHealth.output_preview ? `<div class="mut txs mono truncate max-w-460 mt-1">${esc(stripAnsi(recentHealth.output_preview))}</div>` : ''}</div>${hRw(`${btn(`${icons.activity()} 立即检测`, 'data-health-probe', 'bxs bp')}${healthLogsLink}`)}`,
              'wrap gxs',
            ),
            'mb-2',
          )
        : hCard(
            hRb(
              `<div><strong>主动健康检测结果</strong>${hMut('尚未执行主动检测', 'txs mt-1')}</div>${hRw(`${btn(`${icons.activity()} 立即检测`, 'data-health-probe', 'bsm bg')}${healthLogsLink}`)}`,
              'wrap gxs',
            ),
            'mb-2',
          );

    const mCard = (lbl: string, valTxt: string, rightTop: string, chart: string) =>
      hCard(`<div class="rb"><div>${hMut(lbl)}<div class="metric-big num">${valTxt}</div></div><div class="tr">${hTag(rightTop, 'mono num')}${sampleSub ? hMut(sampleSub, 't2xs mt-1') : ''}</div></div>${chart}`, 'metric-card');

    panel.innerHTML =
      passiveHeadHtml +
      probeCardHtml +
      `<div class="grid-2">` +
      mCard('CPU 负载', m ? `${cpu.toFixed(1)}%` : '—', `Load ${esc(m?.load_avg || '—')}`, singleBarChartHtml({ samples: series, pick: (s) => s.cpu, label: 'CPU' })) +
      mCard('内存占用', m ? `${memPct.toFixed(1)}%` : '—', m ? `${formatMemory(m.memory_used)}${m.memory_total ? `/${formatMemory(m.memory_total)}` : ''}` : '—', singleBarChartHtml({ samples: series, pick: (s) => s.memPct, label: '内存', tone: 'mint' })) +
      hCard(`${hRb(`<div>${hMut('网络吞吐')}${hRow(`<span class="net-pill net-tx num">↑ ${m ? formatRate(m.network_out) : '—'}</span><span class="net-pill net-rx num">↓ ${m ? formatRate(m.network_in) : '—'}</span>`, 'gxs mt-1')}</div>${tabsHtml([['both', '双向'], ['tx', '上传'], ['rx', '下载']], netMode, 'data-net-mode', true)}`, 'wrap gxs')}${networkBarChartHtml(series, netMode)}`, 'metric-card') +
      hCard(`<div class="rb"><div>${hMut('磁盘与系统')}<div class="metric-big num">${m ? `${disk.toFixed(1)}%` : '—'}</div></div>${hTag(m?.disk_total ? `总计 ${formatMemory(m.disk_total)}` : '根分区', 'mono')}</div>${metricBar(disk)}<div class="sys-kv">${sysRows.map(([k, v]) => `<div>${hMs(k, 't2xs')}<div class="tsm truncate">${v}</div></div>`).join('')}</div>`, 'metric-card ssm') +
      `</div>`;

    bindChartTooltips(panel);
    bindUptimeTooltips(panel);
    bindCopyButtons(panel);
    onAll(panel, '[data-dd-hrange]', (b) => {
      const next = b.dataset.ddHrange as 'live' | HealthHistoryRange | undefined;
      if (!next || next === healthRange) return;
      healthRange = next;
      if (next === 'live' || healthCache[next]) {
        paintMetricsPanel(panel);
        return;
      }
      const seq = ++healthReqSeq;
      healthLoading = true;
      paintMetricsPanel(panel);
      api
        .getHealthHistory({ range: next, device_id: device.id, tz: resolveTzParam() })
        .then((res) => {
          if (ctx.isStale() || seq !== healthReqSeq) return;
          healthCache[next] = res;
        })
        .catch(() => {})
        .finally(() => {
          if (!ctx.isStale() && seq === healthReqSeq) {
            healthLoading = false;
            const curPanel = ctx.root.querySelector('#dd-panel') as HTMLElement | null;
            if (activeTab === 'metrics' && curPanel) paintMetricsPanel(curPanel);
          }
        });
    });
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
      `<div class="t-tabs-bar"><div class="t-tabs-strip">${tabStrip}</div>${hRow(`<label class="t2xs mut" for="term-theme">配色</label>${selectHtml('term-theme', [['dracula', 'Dracula'], ['midnight', 'Midnight'], ['light', 'Light']], termTheme, 'input ixs')}`)}</div>` +
      `<div class="t-hd">${hRw(`<span class="term-dots"><i></i><i></i><i></i></span><strong class="mono tsm">${esc(device.hostname || device.name)}</strong>`)}${hRw(`<label class="t2xs mut" for="term-shell">Shell</label>${shellSelectHtml('term-shell', active.shell, 'input ixs')}<label class="t2xs mut" for="term-timeout">超时(s)</label>${hInp('term-timeout', 'number', `min="5" max="3600" value="${active.timeout}"`, 'input ixs mono w-70')}${btn('复制全部', 'id="term-copy-all"', 'bxs bg')}${btn('清空', 'id="term-clear"', 'bxs bg')}`)}</div>` +
      `<div class="preset-bar">${hMs('快捷指令:', 't2xs')}${presets.map(([l, c, sh]) => `<button type="button" class="chip" data-preset="${esc(c)}" data-pshell="${esc(sh ?? '')}">${esc(l)}</button>`).join('')}</div>` +
      `<div class="t-scr" id="term-output"></div>` +
      `<form id="term-form" class="t-prm"><span class="prompt-sig mono">$</span>${hInp('term-input', 'text', 'placeholder="输入命令 (↑/↓ 历史，Enter 执行)…" autocomplete="off" spellcheck="false"', 'term-input mono')}${btn(`${icons.stop()} 停止`, 'id="term-stop"', `bxs be${active.running ? '' : ' hidden'}`)}<button type="submit" class="btn bsm bp" id="term-run"${active.running ? ' disabled' : ''}>${icons.play()} 执行</button></form></section>`;

    const screen = panel.querySelector('#term-output') as HTMLElement;
    screen.addEventListener('scroll', () => {
      const dist = screen.scrollHeight - screen.scrollTop - screen.clientHeight;
      if (dist > 40) {
        lastUserScrollAt = Date.now();
        termPinned = false;
      } else {
        termPinned = true;
      }
    });
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
          return `<div class="te"><div class="te-hd">${hRw(`<span class="prompt-sig mono">$</span><code class="mono term-cmd">${esc(e.commandText)}</code>${e.shell !== 'auto' ? hTag(esc(e.shell)) : ''}`)}${hRw(`${statusBadge(e.status)}${exitCodeBadge(e.exitCode, e.status)}${hMs(`${esc(formatElapsed(e.startedAt ?? e.sentAt, e.completedAt))} · ${esc(formatDate(e.sentAt).slice(11))}`, 't2xs mono num')}${copyBtnHtml(cleanOut)}${dlBtnHtml(dl)}`)}</div>${preOutputHtml(e.output, isTerminalExecStatus(e.status) ? '(无输出)' : '等待探针执行…', 'term-pre')}</div>`;
        })
        .join('');
      bindCopyButtons(screen);
      if (termPinned && Date.now() - lastUserScrollAt >= 150) {
        screen.scrollTop = screen.scrollHeight;
      }
    };
    renderScreen();

    const inputEl = panel.querySelector('#term-input') as HTMLInputElement;
    const shellEl = panel.querySelector('#term-shell') as HTMLSelectElement;
    const timeoutEl = panel.querySelector('#term-timeout') as HTMLInputElement;

    bindChange(panel, [
      ['#term-theme', (v) => {
        termTheme = v as TermTheme;
        try { localStorage.setItem(TERM_THEME_KEY, termTheme); } catch { /* ignore */ }
        paintTerminalPanel(panel);
      }],
      ['#term-shell', (v) => { active.shell = v; }],
      ['#term-timeout', (v) => { active.timeout = Math.max(5, Math.min(3600, Number(v) || 60)); }],
    ]);
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
    on(panel, '#term-clear', () => { active.entries.length = 0; renderScreen(); });
    on(panel, '#term-copy-all', () => void copyText(active.entries.map((e) => `$ ${e.commandText}\n${stripAnsi(e.output)}`).join('\n\n') || '(空)', '已复制终端输出'));
    on(panel, '#term-stop', () => { active.stopPoll?.(); active.stopPoll = null; active.running = false; paintTerminalPanel(panel); });
    onAll(panel, '[data-preset]', (b) => {
      inputEl.value = b.dataset.preset ?? '';
      if (b.dataset.pshell) { shellEl.value = b.dataset.pshell; active.shell = b.dataset.pshell; }
      inputEl.focus();
    });
    inputEl.addEventListener('keydown', (ev) => {
      if (ev.isComposing || ev.keyCode === 229) {
        if (ev.key === 'Enter') ev.preventDefault();
        return;
      }
      if (ev.key === 'ArrowUp' && cmdHistory.length) { ev.preventDefault(); histIdx = Math.min(histIdx + 1, cmdHistory.length - 1); inputEl.value = cmdHistory[histIdx] ?? ''; }
      else if (ev.key === 'ArrowDown') { ev.preventDefault(); histIdx <= 0 ? ((histIdx = -1), (inputEl.value = '')) : (inputEl.value = cmdHistory[--histIdx] ?? ''); }
    });

    on(panel, '#term-form', async (_el, ev) => {
      ev.preventDefault();
      const targetTab = currentTerm();
      if (targetTab.running) return;
      const content = inputEl.value.trim();
      if (!content) return;
      termPinned = true;
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
            refreshRecentLogs();
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

  const runProbeTask = async (opts: {
    target: ProbeTaskState;
    cmdName: string;
    content: string;
    shell?: string;
    tab: DetailTab;
    onDone?: () => void;
  }) => {
    const t = opts.target;
    if (t.running) return;
    t.stopPoll?.();
    t.running = true;
    t.status = 'queued';
    t.exitCode = null;
    t.output = '';
    t.startedAt = new Date().toISOString();
    t.completedAt = null;
    t.updatedAt = t.startedAt;
    if (opts.tab === 'metrics' && activeTab !== 'metrics') {
      activeTab = 'metrics';
      window.history?.replaceState?.(null, '', `#/devices/${encodeURIComponent(device.id)}?tab=metrics`);
      paintSubNav();
    }
    if (opts.tab === 'metrics') paintHero();
    if (activeTab === opts.tab) paintPanel();
    await dispatchHostCmd({
      name: opts.cmdName,
      content: opts.content,
      timeout: 45,
      shell: opts.shell,
      onStopRef: (s) => { t.stopPoll = s; },
      onResult(dr, allDone) {
        if (dr) {
          t.status = dr.status;
          t.exitCode = dr.exit_code;
          t.output = stripAnsi(dr.output ?? '');
          t.startedAt = dr.started_at ?? t.startedAt;
          t.completedAt = dr.completed_at ?? null;
          t.updatedAt = dr.completed_at || dr.started_at || new Date().toISOString();
        }
        if (allDone) {
          t.stopPoll?.();
          t.stopPoll = null;
          t.running = false;
          if (opts.tab === 'metrics') paintHero();
          if (activeTab === opts.tab) paintPanel();
          opts.onDone?.();
        } else if (activeTab === opts.tab) {
          paintPanel();
        }
      },
      onError(msg) {
        t.stopPoll?.();
        t.stopPoll = null;
        t.running = false;
        t.status = 'failed';
        t.output = msg;
        t.completedAt = new Date().toISOString();
        t.updatedAt = t.completedAt;
        if (ctx.isStale()) return;
        if (opts.tab === 'metrics') paintHero();
        if (activeTab === opts.tab) paintPanel();
        toast(msg, 'err');
      },
    });
  };

  const runDiagnostic = (diag: DiagState) => {
    const spec = getDiagCommand(diag.id, platKey);
    return runProbeTask({
      target: diag,
      cmdName: `diag-${diag.id}: ${device.name}`,
      content: spec.cmd,
      shell: spec.shell,
      tab: 'status',
    });
  };

  const paintStatusPanel = (panel: HTMLElement) => {
    const cards = diags
      .map((d) => {
        const lines = d.output ? d.output.split('\n').filter(Boolean).length : 0;
        const body = d.output
          ? hPre(esc(d.output))
          : d.running
            ? '<div class="ld-b"><span class="spinner"></span> 采集中…</div>'
            : hEmp(`点击“采集”获取 ${esc(d.title)}`, 'emp-i mut txs');
        return hCard(
          `${hRb(`${hRow(`<strong>${esc(d.title)}</strong>${d.status ? statusBadge(d.status) : ''}${d.exitCode !== null ? exitCodeBadge(d.exitCode, d.status) : ''}${lines ? hTag(`${lines} 行`, 'num') : ''}`)}${hRow(`${d.updatedAt ? hMs(esc(formatRelativeZh(d.updatedAt)), 't2xs') : ''}${d.output ? copyBtnHtml(d.output, 'bxs bg') : ''}${btn(d.running ? '采集中…' : `${icons.play()} 采集`, `data-diag-run="${d.id}"${d.running ? ' disabled' : ''}`, 'bxs ba')}`)}`, 'wrap gxs')}${body}`,
          'sxs',
        );
      })
      .join('');
    panel.innerHTML = `${hCard(hRb(`<div><h3 class="card-title">系统诊断采集</h3>${hMut(`平台 (${esc(platformMeta(device.platform).label)}) 安全只读命令`)}</div>${btn(`${icons.play()} 全部采集`, 'id="diag-run-all"', 'bsm bp')}`), 'mb-2')}<div class="grid-2">${cards}</div>`;
    bindCopyButtons(panel);
    on(panel, '#diag-run-all', () => diags.forEach((d) => void runDiagnostic(d)));
    onAll(panel, '[data-diag-run]', (b) => {
      const target = diags.find((d) => d.id === b.dataset.diagRun);
      if (target) void runDiagnostic(target);
    });
  };

  const paintTasksPanel = (panel: HTMLElement) => {
    const filteredLogs = recentLogs.filter((l) => {
      const t = l.command_type ?? 'immediate';
      if (taskFilter === 'health') return (l.command_name ?? '').startsWith('health-probe:');
      if (taskFilter === 'immediate') return t === 'immediate';
      if (taskFilter === 'scheduled') return t === 'cron' || t === 'once';
      return true;
    });
    const rows = filteredLogs
      .map((l, idx) => {
        const dl = logDownloadUrl(l.result_id, l.log_url);
        const cleanOut = stripAnsi(l.output_preview || '');
        const isOpen = expandedLogIdx === idx;
        const isDiff = diffLogIdx === idx;
        const prev = filteredLogs[idx + 1];
        const diffHtml = isDiff && prev ? diffPreHtml(prev.output_preview ?? '', l.output_preview ?? '', '与前次输出一致。') : '';
        const cmdSnippet = l.command_content ? hMut(`$ ${esc(l.command_content)}`, 'p-2 mono t2xs cmd-bar') : '';
        return `<div class="hc"><div class="hc-hd" data-task-toggle="${idx}">${hRw(`<span class="chev${isOpen ? '' : ' rot'}">${icons.chevronDown()}</span>${commandSourceBadge(l.command_type, l.command_name)}<strong>${esc(l.command_name || l.command_id || l.execution_id)}</strong>${statusBadge(l.status)}${exitCodeBadge(l.exit_code, l.status)}`)}${hRow(`${hMs(`${esc(formatElapsed(l.started_at, l.completed_at))} · ${esc(formatRelativeZh(l.started_at))}`, 't2xs mono num')}${prev ? btn('对比', `data-task-diff="${idx}"`, `b2x ${isDiff ? 'bp' : 'bg'}`) : ''}${copyBtnHtml(cleanOut)}${dlBtnHtml(dl)}`)}</div>${isOpen ? `${cmdSnippet}${preOutputHtml(l.output_preview || '', '(无输出)')}` : ''}${diffHtml}</div>`;
      })
      .join('');
    const logsTab = taskFilter === 'health' ? 'health' : taskFilter === 'scheduled' ? 'scheduled' : 'terminal';
    panel.innerHTML = hCard(
      `${hRb(`<div><h3 class="card-title">执行记录</h3>${hMut('按来源筛选终端指令与定时任务回执')}</div>${hRw(`${tabsHtml([['all', '全部'], ['immediate', '终端与即时'], ['health', '健康检测'], ['scheduled', '定时任务']], taskFilter, 'data-task-filter', true)}${btn(`${icons.refresh()} 刷新`, 'id="tasks-refresh"', 'bsm bg')}${hLnk(`#/logs?tab=${logsTab}&device_id=${encodeURIComponent(device.id)}`, '日志中心 →', 'bsm ba')}`)}`)}${rows || hEmp('暂无匹配的命令执行记录。')}`,
      'ssm',
    );
    bindCopyButtons(panel);
    onAll(panel, '[data-task-filter]', (b) => {
      taskFilter = (b.dataset.taskFilter as 'all' | 'immediate' | 'health' | 'scheduled') || 'all';
      expandedLogIdx = null;
      diffLogIdx = null;
      paintTasksPanel(panel);
    });
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
    healthCache = {};
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
    if (healthRange !== 'live') {
      const targetRange = healthRange;
      const seq = ++healthReqSeq;
      healthLoading = true;
      api
        .getHealthHistory({ range: targetRange, device_id: device.id, tz: resolveTzParam() })
        .then((res) => {
          if (!ctx.isStale() && seq === healthReqSeq) healthCache[targetRange] = res;
        })
        .catch(() => {})
        .finally(() => {
          if (!ctx.isStale() && seq === healthReqSeq) {
            healthLoading = false;
            const p = ctx.root.querySelector('#dd-panel') as HTMLElement | null;
            if (activeTab === 'metrics' && p) paintMetricsPanel(p);
          }
        });
    }
    if (activeTab === 'metrics') {
      const panel = ctx.root.querySelector('#dd-panel') as HTMLElement | null;
      if (panel) paintMetricsPanel(panel);
    }
  };

  const runHealthProbe = () => {
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
    return runProbeTask({
      target: healthProbe,
      cmdName: `health-probe: ${device.name}`,
      content: spec.content,
      shell: spec.shell,
      tab: 'metrics',
      onDone: () => {
        void refreshDevice(true);
        refreshRecentLogs();
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
