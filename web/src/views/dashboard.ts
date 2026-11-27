import type { CommandDTO, DeviceDTO } from '../../../shared/types';
import { api } from '../api';
import { metricBar, osBadge, platformBadge, statusBadge } from '../components/badges';
import { btn, cardHtml, kpiCardHtml, on, onAll, pageHeadHtml, tableHtml } from '../components/ui';
import { icons } from '../icons';
import { navigate, type RouteContext } from '../router';
import { openHostTab, state, syncHostTabs, toast } from '../state';
import {
  clampPercent,
  cronLabel,
  esc,
  formatMemory,
  formatRelativeZh,
  getMemoryPercent,
  platformMeta,
  type CanonicalPlatform,
} from '../utils';

export async function renderDashboard(ctx: RouteContext): Promise<void> {
  const loadAndPaint = async (silent = false) => {
    try {
      const [fleet, cmdRes] = await Promise.all([
        api.fetchFleet(),
        api.listCommands({ per_page: 8 }),
      ]);
      if (ctx.isStale()) return;
      const devices = fleet.devices;
      const commands = cmdRes.commands ?? [];
      state.devicesCache = devices;
      state.groupsCache = fleet.groups;
      syncHostTabs(devices);
      paint(ctx.root, devices, fleet.total, commands, cmdRes.total ?? commands.length, () => {
        void loadAndPaint(false);
      });
    } catch (err) {
      if (!silent && !ctx.isStale()) toast(err instanceof Error ? err.message : '加载总览数据失败', 'err');
    }
  };

  await loadAndPaint(false);
}

function paint(
  root: HTMLElement,
  devices: DeviceDTO[],
  totalDevices: number,
  commands: CommandDTO[],
  totalCommands: number,
  onRefresh: () => void,
): void {
  const online = devices.filter((d) => d.status === 'online').length;
  const busy = devices.filter((d) => d.status === 'busy').length;
  const offline = devices.filter((d) => d.status === 'offline').length;
  const denom = Math.max(devices.length, 1);

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
    ? '<div class="emp-i mut">暂无绑定主机。<a href="#/">前往绑定第一台主机</a></div>'
    : `<div class="sxs">${topDevices
        .map((d) => {
          const cpu = clampPercent(d.metrics?.cpu_usage ?? 0);
          const memPct = getMemoryPercent(d.metrics);
          return `<div class="node-mini" data-go-device="${esc(d.id)}"><div class="row gxs node-mini-left">${osBadge(d.platform, 'sm')}<div class="min-w-0 flex-1"><div class="row gxs"><strong class="truncate">${esc(d.name)}</strong>${statusBadge(d.status)}</div><div class="mut t2xs mono truncate">${esc(d.ip_address || d.hostname || d.id)} · ${platformBadge(d.platform, d.arch)}</div></div></div><div class="node-mini-metrics"><div class="mini-m"><span class="t2xs mut num">CPU ${d.metrics ? `${cpu.toFixed(0)}%` : '—'}</span>${metricBar(cpu)}</div><div class="mini-m"><span class="t2xs mut num">内存 ${d.metrics ? (memPct ? `${memPct.toFixed(0)}%` : formatMemory(d.metrics.memory_used)) : '—'}</span>${metricBar(memPct, 'ok')}</div></div></div>`;
        })
        .join('')}</div>`;

  const cmdRows = commands
    .map(
      (c) =>
        `<tr><td><strong>${esc(c.name)}</strong></td><td><span class="tag">${esc(c.type)}</span></td><td class="mono txs">${
          c.type === 'cron' ? esc(cronLabel(c.schedule)) : esc(c.schedule || '—')
        }</td><td>${statusBadge(c.status)}</td><td class="txs mut" title="${esc(c.created_at)}">${esc(
          formatRelativeZh(c.created_at),
        )}</td><td class="tr"><a class="btn bxs bg" href="#/commands?inspect=${encodeURIComponent(c.id)}">详情</a></td></tr>`,
    )
    .join('');

  const healthBody = `<div class="ssm"><div class="seg-bar"><div class="seg-ok" style="width:${((online / denom) * 100).toFixed(1)}%"></div><div class="seg-warn" style="width:${((busy / denom) * 100).toFixed(1)}%"></div><div class="seg-err" style="width:${((offline / denom) * 100).toFixed(1)}%"></div></div><div class="rb txs mut num"><span><span class="dot dot-ok"></span> 在线 ${online}</span><span><span class="dot dot-warn"></span> 执行中 ${busy}</span><span><span class="dot dot-err"></span> 离线 ${offline}</span></div><div class="divider"></div><div class="sxs">${platRows
    .map(([k, l]) => `<div class="dist-row"><span class="dist-lbl">${osBadge(k, 'sm')} ${l}</span><div class="dist-bar">${metricBar((platCounts[k] / denom) * 100, 'accent')}</div><span class="dist-num mono num">${platCounts[k]}</span></div>`)
    .join('')}</div></div>`;

  root.innerHTML =
    pageHeadHtml(
      '集群总览',
      '节点状态、平台分布与近期任务',
      `${btn(`${icons.refresh()} 刷新`, 'id="dash-refresh"')}<a href="#/console" class="btn bsm ba">${icons.console()} 批量执行</a><a href="#/" class="btn bsm bp">${icons.devices()} 主机列表</a>`,
    ) +
    `<div class="kpi-grid">${kpiCardHtml('纳管主机总数', esc(totalDevices), `${esc(state.groupsCache.length)} 个分组`)}${kpiCardHtml('在线主机', `<span class="tok">${esc(online)}</span>`, `在线率 ${Math.round((online / denom) * 100)}%`)}${kpiCardHtml('任务执行中', `<span class="twn">${esc(busy)}</span>`, '正在处理指令')}${kpiCardHtml('已离线', `<span class="ter">${esc(offline)}</span>`, `累计 ${esc(totalCommands)} 条任务`)}</div>` +
    `<div class="grid-2 mt-3">${cardHtml('集群健康与平台分布', healthBody, `<span class="mut txs num">${esc(devices.length)} 台主机</span>`)}${cardHtml('负载前列主机', topHtml, '<a href="#/" class="link-btn txs">查看全部 →</a>')}</div>` +
    cardHtml(
      '最近任务与下发记录',
      tableHtml(['任务名称', '类型', '调度', '状态', '创建时间', ''], cmdRows, '暂无命令记录，前往 <a href="#/console">批量执行</a>。'),
      '<a href="#/commands" class="link-btn txs">全部任务 →</a>',
      'mt-3',
    );

  on(root, '#dash-refresh', onRefresh);
  onAll(root, '[data-go-device]', (el) => {
    const id = el.dataset.goDevice;
    if (!id) return;
    const dev = devices.find((d) => d.id === id);
    if (dev) openHostTab({ id: dev.id, name: dev.name, platform: dev.platform, status: dev.status });
    navigate(`/devices/${encodeURIComponent(id)}`);
  });
}
