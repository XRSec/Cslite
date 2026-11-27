import type { CommandDTO, DeviceDTO, HealthHistoryRange, HealthHistoryResponse } from '../../../shared/types';
import { api } from '../api';
import { bindUptimeTooltips, commandSourceBadge, healthTimelineHtml, metricBar, osBadge, statusBadge } from '../components/badges';
import { btn, cardHtml, hEmp, hLnk, hMs, hRow, hStk, hTr, ipCopyHtml, kpiCardHtml, on, onAll, pageHeadHtml, tableHtml, tabsHtml } from '../components/ui';
import { icons } from '../icons';
import { navigate, type RouteContext } from '../router';
import { openHostTab, state, syncActiveTimeZone, syncHostTabs, toast } from '../state';
import {
  clampPercent,
  cronLabel,
  deviceIps,
  esc,
  formatMemory,
  formatRelativeZh,
  getActiveTimeZone,
  getMemoryPercent,
  platformMeta,
  type CanonicalPlatform,
} from '../utils';
import { formatCadence, showDeviceIpsModal } from './devices';

const HEALTH_RANGE_KEY = 'cslite_health_range';
const HEALTH_RANGES: ReadonlyArray<readonly [HealthHistoryRange, string, string]> = [
  ['1h', '1小时', '5m/格'],
  ['24h', '24小时', '1h/格'],
  ['7d', '7天', '1d/格'],
  ['30d', '30天', '1d/格'],
];

function loadSavedHealthRange(): HealthHistoryRange {
  try {
    const raw = localStorage.getItem(HEALTH_RANGE_KEY);
    if (raw === '1h' || raw === '24h' || raw === '7d' || raw === '30d') return raw;
  } catch { /* ignore */ }
  return '24h';
}

function saveHealthRange(range: HealthHistoryRange): void {
  try { localStorage.setItem(HEALTH_RANGE_KEY, range); } catch { /* ignore */ }
}

function resolveTzParam(): string | undefined {
  const active = getActiveTimeZone();
  if (active) return active;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export async function renderDashboard(ctx: RouteContext): Promise<void> {
  let range: HealthHistoryRange = loadSavedHealthRange();
  let devices: DeviceDTO[] = [];
  let totalDevices = 0;
  let commands: CommandDTO[] = [];
  let healthHistory: HealthHistoryResponse | null = null;
  let healthLoading = false;
  let healthReqSeq = 0;

  const paintAll = () => {
    paint(ctx.root, {
      devices,
      totalDevices,
      commands,
      range,
      healthHistory,
      healthLoading,
      onRefresh: () => void loadAll(false),
      onSelectRange: (nextRange) => {
        if (nextRange === range && healthHistory) return;
        range = nextRange;
        saveHealthRange(range);
        void loadHealthOnly();
      },
    });
  };

  const loadHealthOnly = async () => {
    const seq = ++healthReqSeq;
    healthLoading = true;
    paintAll();
    try {
      const next = await api.getHealthHistory({ range, tz: resolveTzParam() });
      if (ctx.isStale() || seq !== healthReqSeq) return;
      healthHistory = next;
    } catch {
      if (ctx.isStale() || seq !== healthReqSeq) return;
    } finally {
      if (!ctx.isStale() && seq === healthReqSeq) {
        healthLoading = false;
        paintAll();
      }
    }
  };

  const loadAll = async (silent = false) => {
    const seq = ++healthReqSeq;
    try {
      const [fleet, cmdRes, _sys, hist] = await Promise.all([
        api.fetchFleet(),
        api.listCommands({ type: 'cron,once', per_page: 6 }),
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
        api.getHealthHistory({ range, tz: resolveTzParam() }).catch(() => null),
      ]);
      if (ctx.isStale()) return;
      devices = fleet.devices;
      totalDevices = fleet.total;
      commands = cmdRes.commands ?? [];
      if (seq === healthReqSeq && hist) healthHistory = hist;
      state.devicesCache = devices;
      state.groupsCache = fleet.groups;
      syncHostTabs(devices);
      paintAll();
    } catch (err) {
      if (!silent && !ctx.isStale()) toast(err instanceof Error ? err.message : '加载总览数据失败', 'err');
    }
  };

  await loadAll(false);
}

function paint(
  root: HTMLElement,
  opts: {
    devices: DeviceDTO[];
    totalDevices: number;
    commands: CommandDTO[];
    range: HealthHistoryRange;
    healthHistory: HealthHistoryResponse | null;
    healthLoading: boolean;
    onRefresh: () => void;
    onSelectRange: (r: HealthHistoryRange) => void;
  },
): void {
  const { devices, totalDevices, commands, range, healthHistory, healthLoading, onRefresh, onSelectRange } = opts;
  const online = devices.filter((d) => d.status === 'online').length;
  const busy = devices.filter((d) => d.status === 'busy').length;
  const offline = devices.filter((d) => d.status === 'offline').length;
  const denom = Math.max(devices.length, 1);

  const rangeMeta = HEALTH_RANGES.find(([k]) => k === range) ?? HEALTH_RANGES[1]!;
  const rangeShort = rangeMeta[1];
  const rangeDesc = rangeMeta[2];
  const pct = healthHistory?.overall_uptime_pct ?? null;
  const pctTxt = pct !== null ? `${pct.toFixed(1)}%` : '--';
  const pctTone = pct === null ? 'm' : pct >= 98 ? 'ok' : pct >= 85 ? 'warn' : 'err';
  const pctKpiCls = pctTone === 'm' ? 'kpi-a' : pctTone === 'ok' ? 'kpi-ok' : pctTone === 'warn' ? 'kpi-wn' : 'kpi-er';
  const pctValCls = pctTone === 'm' ? '' : pctTone === 'ok' ? 'tok' : pctTone === 'warn' ? 'twn' : 'ter';

  const platCounts: Record<CanonicalPlatform, number> = {
    linux: 0,
    openwrt: 0,
    macos: 0,
    windows: 0,
    android: 0,
    unix: 0,
    other: 0,
  };
  for (const d of devices) platCounts[platformMeta(d.platform).key]++;

  const topDevices = [...devices]
    .sort((a, b) => (b.metrics?.cpu_usage ?? -1) - (a.metrics?.cpu_usage ?? -1))
    .slice(0, 6);

  const platRows: Array<[CanonicalPlatform, string]> = [
    ['linux', 'Linux'],
    ['openwrt', 'OpenWrt'],
    ['macos', 'macOS'],
    ['windows', 'Windows'],
    ['android', 'Android'],
    ['unix', 'UNIX'],
    ['other', 'Other'],
  ];

  const topHtml = !topDevices.length
    ? hEmp('暂无绑定主机。<a href="#/">前往绑定第一台主机</a>')
    : hStk(
        topDevices
          .map((d) => {
            const cpu = clampPercent(d.metrics?.cpu_usage ?? 0);
            const memPct = getMemoryPercent(d.metrics);
            const ips = deviceIps(d);
            const ipSub = ips[0] || d.hostname || d.id;
            const ipTip = ips.length ? ips.slice(0, 12).join(', ') + (ips.length > 12 ? ` (+${ips.length - 12})` : '') : ipSub;
            const stDot = d.status === 'online' ? 'dot-ok dot-pulse' : d.status === 'busy' ? 'dot-warn dot-pulse' : 'dot-err';
            const ipHtml = ips[0]
              ? `${ipCopyHtml(ips[0], 't2xs', `${ipTip} · 点击或双击复制`)}${ips.length > 1 ? `<button type="button" class="tag tag-accent t2xs num" data-show-ips="${esc(d.id)}" title="共 ${ips.length} 个 IP · 点击查看全部">+${ips.length - 1}</button>` : ''}`
              : `<span class="ip-t mono t2xs" title="${esc(ipTip)}">${esc(ipSub)}</span>`;
            return `<div class="node-mini" data-go-device="${esc(d.id)}">${hRow(`${osBadge(d.platform, 'sm')}<div class="min-w-0 flex-1"><div class="rb gxs min-w-0">${hRow(`<span class="dot ${stDot}"></span><strong class="truncate">${esc(d.name)}</strong>`, 'gxs min-w-0')}${statusBadge(d.status)}</div><div class="rb gxs mut t2xs min-w-0 mt-1"><span class="row gxs min-w-0">${ipHtml}</span><span class="tag t2xs nw">${esc([platformMeta(d.platform).label, d.arch].filter(Boolean).join(' · '))}</span></div></div>`, 'gxs node-mini-left')}<div class="node-mini-metrics"><div class="mini-m">${hMs(`CPU ${d.metrics ? `${cpu.toFixed(0)}%` : '—'}`, 't2xs num')}${metricBar(cpu)}</div><div class="mini-m">${hMs(`内存 ${d.metrics ? (memPct ? `${memPct.toFixed(0)}%` : formatMemory(d.metrics.memory_used)) : '—'}`, 't2xs num')}${metricBar(memPct, 'ok')}</div></div></div>`;
          })
          .join(''),
      );

  const cmdLabels = ['任务名称', '类型', '调度', '状态', '创建时间'];
  const cmdRows = commands
    .map((c) =>
      hTr(
        [
          `<strong class="truncate">${esc(c.name)}</strong>`,
          commandSourceBadge(c.type, c.name),
          [c.type === 'cron' ? esc(cronLabel(c.schedule)) : esc(c.schedule || '—'), 'mono txs'],
          statusBadge(c.status),
          [esc(formatRelativeZh(c.created_at)), 'txs mut nw'],
        ],
        cmdLabels,
        `class="log-row" data-go-cmd="${esc(c.id)}"`,
      ),
    )
    .join('');

  const onlineRate = Math.round((online / denom) * 100);
  const pollSec = healthHistory?.poll_interval ?? state.systemInfo?.poll_interval ?? 60;
  const hbSec = healthHistory?.heartbeat_interval ?? state.systemInfo?.heartbeat_interval ?? 300;
  const cadenceTxt = `${formatCadence(pollSec)}/${formatCadence(hbSec)}`;

  const heroBody = healthHistory?.buckets.length
    ? healthTimelineHtml(healthHistory.buckets, {
        fleet: true,
        leftAxis: healthHistory.buckets[0]?.label ?? '',
        centerAxis: `${rangeDesc} · ${healthHistory.timezone}`,
        rightAxis: '当前',
        label: '集群健康时间轴',
      })
    : `<div class="mut txs p-2">${healthLoading ? '加载历史健康时间轴…' : '暂无历史心跳数据'}</div>`;

  const legendHtml = `<div class="rb wrap gxs t2xs mut up-leg"><span class="row gsm"><span class="row gxs"><i class="leg-dot up-ok"></i>正常</span><span class="row gxs"><i class="leg-dot up-warn"></i>波动</span><span class="row gxs"><i class="leg-dot up-err"></i>离线</span><span class="row gxs"><i class="leg-dot up-empty"></i>无记录</span></span><span>调度 ${esc(cadenceTxt)}</span></div>`;

  const statusTagsHtml = `<span class="tag tag-ok num"><span class="dot dot-ok"></span> 在线 ${online}</span>${
    busy > 0 ? `<span class="tag tag-warn num"><span class="dot dot-warn"></span> 执行 ${busy}</span>` : ''
  }${
    offline > 0 ? `<span class="tag tag-err num"><span class="dot dot-err"></span> 离线 ${offline}</span>` : ''
  }`;
  const healthHeroCard = `<section class="card mt-3 sxs" id="dash-health-card"><div class="card-head mb-1"><div class="row wrap gsm"><h3 class="card-title">集群健康状态</h3>${hRow(statusTagsHtml, 'gxs')}</div>${tabsHtml(HEALTH_RANGES.map(([k, l]) => [k, l]), range, 'data-health-range', true)}</div>${heroBody}${legendHtml}</section>`;

  const visiblePlats = devices.length ? platRows.filter(([k]) => platCounts[k] > 0) : platRows;
  const devMap = new Map(devices.map((d) => [d.id, d]));
  const availList = (healthHistory?.devices ?? devices.map((d) => ({ device_id: d.id, uptime_pct: null as number | null, slots: [] })))
    .filter((s) => devMap.has(s.device_id))
    .slice()
    .sort((a, b) => (a.uptime_pct ?? 101) - (b.uptime_pct ?? 101))
    .slice(0, 6);

  const availRowsHtml = availList.length
    ? `<div class="divider"></div><div class="rb gxs"><span class="txs mut">节点可用率 (${rangeShort})</span>${devices.length > 6 ? '<span class="t2xs mut">低可用率优先</span>' : ''}</div><div class="sxs">${availList
        .map((s) => {
          const d = devMap.get(s.device_id)!;
          const p = s.uptime_pct;
          const pCls = p === null ? 'mut' : p >= 98 ? 'tok' : p >= 85 ? 'twn' : 'ter';
          const miniDots = (s.slots.length ? s.slots.slice(-12) : [])
            .map((st) => `<i class="up-dot up-${st}"></i>`)
            .join('');
          return `<div class="avail-row" data-go-device="${esc(d.id)}"><span class="row gxs min-w-0">${osBadge(d.platform, 'sm')}<strong class="truncate txs">${esc(d.name)}</strong></span>${miniDots ? `<span class="up-strip avail-mini">${miniDots}</span>` : '<span></span>'}<span class="mono num t2xs nw ${pCls}">${p === null ? '--' : `${p.toFixed(1)}%`}</span></div>`;
        })
        .join('')}</div>`
    : '';

  const leftCardBody = hStk(
    `<div class="rb wrap gxs"><span class="tsm">实时在线率 <strong class="tok num">${onlineRate}%</strong></span>${hMs(`离线 ${offline} / 总计 ${devices.length}`, 't2xs num')}</div><div class="seg-bar"><div class="seg-ok" style="width:${((online / denom) * 100).toFixed(1)}%"></div><div class="seg-warn" style="width:${((busy / denom) * 100).toFixed(1)}%"></div><div class="seg-err" style="width:${((offline / denom) * 100).toFixed(1)}%"></div></div>${hStk(
      visiblePlats
        .map(([k, l]) => `<div class="dist-row"><span class="dist-lbl">${osBadge(k, 'sm')} ${l}</span><div class="dist-bar">${metricBar((platCounts[k] / denom) * 100, 'accent')}</div><span class="dist-num mono num">${platCounts[k]}</span></div>`)
        .join(''),
    )}${availRowsHtml}`,
    'ssm',
  );

  const kpi = (cls: string, label: string, v: string, sub: string) =>
    kpiCardHtml(label, v, sub).replace('class="kpi-card"', `class="kpi-card ${cls}"`);
  root.innerHTML =
    pageHeadHtml(
      '集群总览',
      '',
      `${btn(`${icons.refresh()} 刷新`, 'id="dash-refresh"')}${hLnk('#/console', `${icons.console()} 批量执行`, 'bsm ba')}${hLnk('#/', `${icons.devices()} 主机列表`, 'bsm bg')}`,
    ) +
    `<div class="kpi-grid">${kpi('kpi-a', '纳管主机总数', esc(totalDevices), `${esc(state.groupsCache.length)} 个分组`)}${kpi('kpi-ok', '在线主机', `<span class="tok">${esc(online)}</span>`, `实时在线率 ${onlineRate}%`)}${kpi(pctKpiCls, '周期可用率', `<span class="${pctValCls}">${pctTxt}</span>`, `${rangeShort}统计${busy ? ` · ${busy} 执行中` : ''}`)}${kpi('kpi-er', '已离线', `<span class="${offline ? 'ter' : 'tok'}">${esc(offline)}</span>`, offline ? '需排查探针或网络' : '节点均在线')}</div>` +
    healthHeroCard +
    `<div class="grid-2 mt-3">${cardHtml('平台与节点可用率', leftCardBody, hMs(`${esc(devices.length)} 台主机`, 'txs num'))}${cardHtml('负载前列主机', topHtml, '<a href="#/" class="link-btn txs">查看全部 →</a>')}</div>` +
    cardHtml(
      '近期定时任务',
      tableHtml(cmdLabels, cmdRows, '暂无定时任务，<a href="#/commands">新建定时任务</a>。', 'tbl-r'),
      '<a href="#/commands" class="link-btn txs">全部定时任务 →</a>',
      'mt-3',
    );

  on(root, '#dash-refresh', onRefresh);
  onAll(root, '[data-health-range]', (b) => {
    const next = b.dataset.healthRange as HealthHistoryRange | undefined;
    if (next) onSelectRange(next);
  });
  onAll(root, '[data-show-ips]', (el, ev) => {
    ev.stopPropagation();
    const dev = devices.find((d) => d.id === el.dataset.showIps);
    if (dev) showDeviceIpsModal(dev.name, deviceIps(dev));
  });
  onAll(root, '[data-go-device]', (el, ev) => {
    if ((ev.target as HTMLElement | null)?.closest('button,a')) return;
    const id = el.dataset.goDevice;
    if (!id) return;
    const dev = devices.find((d) => d.id === id);
    if (dev) openHostTab({ id: dev.id, name: dev.name, platform: dev.platform, status: dev.status });
    navigate(`/devices/${encodeURIComponent(id)}`);
  });
  onAll(root, '[data-go-cmd]', (el) => {
    const cid = el.dataset.goCmd;
    if (cid) navigate(`/commands?inspect=${encodeURIComponent(cid)}`);
  });
  bindUptimeTooltips(root);
}
