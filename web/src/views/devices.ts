import type { DeviceDTO, GroupDTO, PlatformType } from '../../../shared/types';
import { api, ApiError } from '../api';
import { metricBar, osBadge, statusBadge, uptimeDotsHtml, type PollSlotState } from '../components/badges';
export type { PollSlotState };
import { paramsFromCreateResponse, showInstallModal } from '../components/install-modal';
import {
  ADD_PLAT_OPTS,
  bindChange,
  bindCopyButtons,
  bindSearchInput,
  btn,
  confirmModal,
  fieldHtml,
  formModal,
  hEmp,
  hInp,
  hLnk,
  hMono,
  hMs,
  hMut,
  hRb,
  hRow,
  hRw,
  hStk,
  hTag,
  hThTr,
  hTr,
  ipCopyHtml,
  on,
  onAll,
  PLAT_OPTS,
  selectHtml,
  tableHtml,
  tabsHtml,
  val,
} from '../components/ui';
import { icons } from '../icons';
import { navigate, type RouteContext } from '../router';
import { copyText, openHostTab, openModal, registerCleanup, state, syncHostTabs, syncActiveTimeZone, toast } from '../state';
import {
  clampPercent,
  deviceGroupIds,
  deviceIps,
  esc,
  formatDate,
  formatDuration,
  formatMemory,
  formatRate,
  formatRelativeZh,
  getMemoryPercent,
  platformMeta,
} from '../utils';

const GRP_TONES = ['b', 'g', 'c', 'w'] as const;

/** Deterministic 4-tone pill class per group ID so multi-group badges remain visually distinct. */
export function groupToneClass(gid: string): string {
  let h = 0;
  for (let i = 0; i < gid.length; i++) h = (h * 31 + gid.charCodeAt(i)) >>> 0;
  return `grp-pill-${GRP_TONES[h % 4]}`;
}

/** Render up to max clickable group pills plus a +N overflow badge with full tooltip. */
export function groupPillsHtml(
  gids: string[],
  groupNameFn: (gid: string) => string,
  max = 2,
): string {
  if (!gids.length) return '';
  const shown = gids.slice(0, max);
  const rest = gids.slice(max);
  const pills = shown
    .map((gid) => {
      const name = groupNameFn(gid);
      return `<button type="button" class="grp-pill ${groupToneClass(gid)}" data-filter-grp="${esc(gid)}" title="按分组筛选: ${esc(name)}"><span class="grp-pill-txt">${esc(name)}</span></button>`;
    })
    .join('');
  const more = rest.length
    ? `<span class="grp-pill grp-more" title="${esc(rest.map((gid) => groupNameFn(gid)).join(', '))}">+${rest.length}</span>`
    : '';
  return `<div class="grp-stack">${pills}${more}</div>`;
}

export interface PollHealth {
  score: number;
  label: string;
  tone: 'ok' | 'warn' | 'err';
  badgeCls: 'bd-ok' | 'bd-wn' | 'bd-er';
  textCls: 'tok' | 'twn' | 'ter';
}

const pollResult = (score: number, label: string, tone: PollHealth['tone']): PollHealth => ({
  score,
  label,
  tone,
  badgeCls: tone === 'ok' ? 'bd-ok' : tone === 'warn' ? 'bd-wn' : 'bd-er',
  textCls: tone === 'ok' ? 'tok' : tone === 'warn' ? 'twn' : 'ter',
});

export interface PollSchedule {
  pollInterval?: number;
  heartbeatInterval?: number;
}

/** Format interval seconds concisely (e.g. 60 -> "1m", 300 -> "5m", 15 -> "15s"). */
export function formatCadence(sec?: number): string {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '--';
  if (n >= 60) return n % 60 === 0 ? `${n / 60}m` : `${Math.round((n / 60) * 10) / 10}m`;
  return `${Math.round(n)}s`;
}

function resolvePollThresholds(schedule?: PollSchedule) {
  const pollSec = Math.max(5, Number(schedule?.pollInterval) || 60);
  const hbSec = Math.max(pollSec, Number(schedule?.heartbeatInterval) || Math.max(300, pollSec * 5));
  const healthyMaxSec = Math.max(Math.round(pollSec * 1.5 + 15), 30);
  const warnMaxSec = Math.max(Math.round(pollSec * 3.5), hbSec);
  return { pollSec, hbSec, healthyMaxSec, warnMaxSec };
}

/** Derive passive agent health from device status, last activity, and configured poll/heartbeat schedule. */
export function derivePollHealth(
  device: Pick<DeviceDTO, 'status' | 'last_seen'>,
  nowMs = Date.now(),
  schedule?: PollSchedule,
): PollHealth {
  if (device.status !== 'online' && device.status !== 'busy') {
    return pollResult(0, '离线 · 无轮询请求', 'err');
  }
  const { healthyMaxSec, warnMaxSec } = resolvePollThresholds(schedule);
  const lastMs = device.last_seen ? Date.parse(device.last_seen) : Number.NaN;
  const ageSec = Number.isNaN(lastMs) ? Number.POSITIVE_INFINITY : Math.max(0, (nowMs - lastMs) / 1000);
  if (ageSec <= healthyMaxSec) return pollResult(100, '健康 · 轮询活跃', 'ok');
  if (ageSec <= warnMaxSec) return pollResult(65, '延迟 · 轮询变慢', 'warn');
  return pollResult(25, '超时 · 久未轮询', 'err');
}

/** Derive chronological (oldest->newest) N-slot polling history states for Uptime-style strip. */
export function derivePollHealthSlots(
  device: Pick<DeviceDTO, 'status' | 'last_seen' | 'created_at'>,
  count = 12,
  nowMs = Date.now(),
  windowSec = 60,
  heartbeatSec?: number,
): PollSlotState[] {
  const { pollSec: winSec, healthyMaxSec, warnMaxSec } = resolvePollThresholds({
    pollInterval: windowSec,
    heartbeatInterval: heartbeatSec,
  });
  const slots: PollSlotState[] = Array.from({ length: count }, () => 'empty');
  const lastMs = device.last_seen ? Date.parse(device.last_seen) : Number.NaN;
  const hasLast = Number.isFinite(lastMs);
  if (device.status === 'offline' && !hasLast) return slots;

  const createdMs = device.created_at ? Date.parse(device.created_at) : Number.NaN;
  const lifetime = Number.isFinite(createdMs)
    ? Math.min(count, Math.max(1, Math.ceil((nowMs - createdMs) / (winSec * 1000))))
    : count;
  const start = count - lifetime;
  for (let i = start; i < count; i++) slots[i] = 'ok';

  const ageSec = hasLast ? Math.max(0, (nowMs - lastMs) / 1000) : Number.POSITIVE_INFINITY;
  if (device.status === 'offline') {
    const missed = Math.min(lifetime, Math.max(1, Math.ceil(ageSec / winSec)));
    for (let i = count - missed; i < count; i++) slots[i] = 'err';
    return slots;
  }

  if (ageSec <= healthyMaxSec) return slots;
  if (ageSec <= warnMaxSec) {
    const missed = Math.min(lifetime, Math.max(1, Math.floor((ageSec - winSec) / winSec)));
    for (let i = count - missed; i < count; i++) slots[i] = 'warn';
    return slots;
  }

  const missed = Math.min(lifetime, Math.max(3, Math.floor(ageSec / winSec)));
  const errStart = count - missed;
  for (let i = errStart; i < count; i++) slots[i] = 'err';
  if (lifetime > missed && errStart - 1 >= start) slots[errStart - 1] = 'warn';
  return slots;
}

/** Show searchable modal listing all reported IPs of a host (for 50+ IP hosts). */
export function showDeviceIpsModal(name: string, ips: string[]): void {
  const v4Cnt = ips.filter((ip) => !ip.includes(':')).length;
  const v6Cnt = ips.length - v4Cnt;
  const hasBoth = v4Cnt > 0 && v6Cnt > 0;
  let fam: 'all' | 'v4' | 'v6' = 'all';
  let q = '';

  const getMatched = () => {
    const f = q.trim().toLowerCase();
    return ips.filter((ip) => {
      const isV6 = ip.includes(':');
      if (fam === 'v4' && isV6) return false;
      if (fam === 'v6' && !isV6) return false;
      return !f || ip.toLowerCase().includes(f);
    });
  };
  const renderList = (list: string[]) =>
    list.length
      ? list
          .map(
            (ip) =>
              `<button type="button" class="ip-m-chip mono" data-copy-ip="${esc(ip)}" title="点击或双击复制 ${esc(ip)}"><span class="ip-m-txt">${esc(ip)}</span></button>`,
          )
          .join('')
      : '<span class="mut txs">无匹配 IP 地址</span>';

  const famTabs = hasBoth
    ? `<div class="row rb wrap gxs">${tabsHtml(
        [
          ['all', `全部 ${ips.length}`],
          ['v4', `IPv4 ${v4Cnt}`],
          ['v6', `IPv6 ${v6Cnt}`],
        ],
        'all',
        'data-ip-fam',
        true,
      )}<span class="mut t2xs num" id="ips-cnt">显示 ${ips.length} / ${ips.length}</span></div>`
    : `<div class="row re"><span class="mut t2xs num" id="ips-cnt">显示 ${ips.length} / ${ips.length}</span></div>`;

  openModal({
    title: `${name} — IP 地址列表 (${ips.length})`,
    wide: true,
    bodyHtml: `<div class="ssm"><div class="search-wrap">${icons.search()}${hInp('ips-q', 'search', 'placeholder="筛选 IPv4 / IPv6..."', 'input input-pill ism')}</div>${famTabs}<div class="ip-modal-list mono" id="ips-list">${renderList(ips)}</div></div>`,
    footerHtml: `${btn(`${icons.copy()} 复制当前 (<span id="ips-copy-n">${ips.length}</span>)`, 'id="ips-copy-all"', 'bsm bg')}${btn('关闭', 'data-close', 'bsm bp')}`,
    onMount(panel, close) {
      const listEl = panel.querySelector<HTMLElement>('#ips-list');
      const cntEl = panel.querySelector<HTMLElement>('#ips-cnt');
      const copyNEl = panel.querySelector<HTMLElement>('#ips-copy-n');
      const refresh = () => {
        const list = getMatched();
        if (listEl) listEl.innerHTML = renderList(list);
        if (cntEl) cntEl.textContent = `显示 ${list.length} / ${ips.length}`;
        if (copyNEl) copyNEl.textContent = String(list.length);
      };
      on(panel, '[data-close]', close);
      on(panel, '#ips-copy-all', () => {
        const list = getMatched();
        if (list.length) void copyText(list.join('\n'), `已复制 ${list.length} 个 IP`);
      });
      onAll(panel, '[data-ip-fam]', (b) => {
        fam = (b.dataset.ipFam as 'all' | 'v4' | 'v6') || 'all';
        panel.querySelectorAll('[data-ip-fam]').forEach((el) => el.classList.toggle('active', el === b));
        refresh();
      });
      on(panel, '#ips-q', (el) => {
        q = (el as HTMLInputElement).value;
        refresh();
      }, 'input');
    },
  });
}

/** Open single or bulk self-upgrade modal calling POST /api/devices/:id/upgrade. */
export function openUpgradeDevicesModal(targets: DeviceDTO[], onDone?: () => void): void {
  if (!targets.length) return;
  const title = targets.length === 1 ? `升级探针 — ${targets[0].name}` : `批量升级探针 (${targets.length} 台)`;
  formModal({
    title,
    formId: 'upg-dev-form',
    submitLabel: '下发升级指令',
    fieldsHtml:
      `<div class="alert alert-warn">在目标主机后台静默拉取升级脚本并平滑重启探针，保留原有绑定密钥与配置。</div>` +
      fieldHtml('upg-ver', '目标版本 (Tag)', hInp('upg-ver', 'text', 'value="latest" required placeholder="latest 或 v1.1.0"', 'input mono')) +
      fieldHtml('upg-url', '自定义下载地址 (可选)', hInp('upg-url', 'url', 'placeholder="留空自动从 GitHub Release / 服务端拉取"', 'input mono')) +
      `<label class="row gxs txs"><input type="checkbox" id="upg-lite"> 强制使用轻量脚本模式 (Lite)</label>`,
    async onSubmit(panel, close) {
      const version = val(panel, '#upg-ver') || 'latest';
      const bin_url = val(panel, '#upg-url') || undefined;
      const lite = Boolean((panel.querySelector('#upg-lite') as HTMLInputElement | null)?.checked);
      const results = await Promise.allSettled(
        targets.map((d) => api.upgradeDevice(d.id, { version, bin_url, lite })),
      );
      const okCnt = results.filter((r) => r.status === 'fulfilled').length;
      const failCnt = results.length - okCnt;
      close();
      if (okCnt > 0) toast(`已向 ${okCnt} 台主机下发升级指令 (${version})${failCnt ? `，${failCnt} 台失败` : ''}`, failCnt ? 'warn' : 'ok');
      else toast('升级指令下发失败', 'err');
      onDone?.();
    },
  });
}

type OptCol = 'ip' | 'groups' | 'metrics';
const DEV_COLS_KEY = 'cslite_dev_cols';
const VALID_OPT_COLS = new Set<OptCol>(['ip', 'groups', 'metrics']);

function loadDevCols(): Set<OptCol> {
  try {
    const raw = JSON.parse(localStorage.getItem(DEV_COLS_KEY) || '[]') as unknown[];
    if (Array.isArray(raw)) return new Set(raw.filter((c): c is OptCol => VALID_OPT_COLS.has(c as OptCol)));
  } catch { /* ignore */ }
  return new Set<OptCol>();
}

function saveDevCols(cols: Set<OptCol>): void {
  try { localStorage.setItem(DEV_COLS_KEY, JSON.stringify(Array.from(cols))); } catch { /* ignore */ }
}

export async function renderDevices(ctx: RouteContext): Promise<void> {
  let devices: DeviceDTO[] = [];
  let groups: GroupDTO[] = [];
  let search = '';
  let statusFilter = '';
  let platformFilter = '';
  let groupFilter = '';
  let bulkGroupTarget = '';
  let colsOpen = false;
  const visCols = loadDevCols();
  const selected = new Set<string>();
  const expandedIds = new Set<string>();

  const closeCols = (refocus = false) => {
    if (!colsOpen) return;
    colsOpen = false;
    ctx.root.querySelector('#dev-cols-pop')?.classList.add('hidden');
    const btnEl = ctx.root.querySelector<HTMLElement>('#dev-cols-btn');
    btnEl?.setAttribute('aria-expanded', 'false');
    if (refocus) btnEl?.focus();
  };
  const onDocClick = (ev: Event) => {
    if (!colsOpen) return;
    const t = ev.target as HTMLElement | null;
    if (!t?.closest('#dev-cols-pop') && !t?.closest('#dev-cols-btn')) closeCols(false);
  };
  const onDocKey = (ev: KeyboardEvent) => {
    if (colsOpen && ev.key === 'Escape' && !ev.isComposing && ev.keyCode !== 229) closeCols(true);
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);
  registerCleanup(() => {
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onDocKey);
  });

  const loadData = async (silent = false) => {
    try {
      const [fleet] = await Promise.all([
        api.fetchFleet(),
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
      devices = fleet.devices;
      groups = fleet.groups;
      state.devicesCache = devices;
      state.groupsCache = groups;
      syncHostTabs(devices);
      const validIds = new Set(devices.map((d) => d.id));
      for (const id of Array.from(selected)) if (!validIds.has(id)) selected.delete(id);
      for (const id of Array.from(expandedIds)) if (!validIds.has(id)) expandedIds.delete(id);
      renderView();
    } catch (err) {
      if (!silent && !ctx.isStale()) toast(err instanceof ApiError ? err.message : '加载主机列表失败', 'err');
    }
  };

  const getFiltered = (): DeviceDTO[] => {
    const q = search.trim().toLowerCase();
    return devices.filter((d) => {
      if (statusFilter && d.status !== statusFilter) return false;
      if (platformFilter && platformMeta(d.platform).key !== platformFilter) return false;
      const gids = deviceGroupIds(d);
      if (groupFilter === '__none__' && gids.length > 0) return false;
      if (groupFilter && groupFilter !== '__none__' && !gids.includes(groupFilter)) return false;
      if (q && !`${d.name} ${d.hostname ?? ''} ${deviceIps(d).join(' ')} ${d.id}`.toLowerCase().includes(q)) return false;
      return true;
    });
  };

  const groupName = (gid?: string | null): string => (gid ? groups.find((g) => g.id === gid)?.name ?? gid : '');
  const groupOpts = (head: string, extra?: [string, string]): Array<[string, string]> => [
    ['', head],
    ...(extra ? [extra] : []),
    ...groups.map((g): [string, string] => [g.id, g.name]),
  ];

  const getSched = (): PollSchedule => ({
    pollInterval: state.systemInfo?.poll_interval,
    heartbeatInterval: state.systemInfo?.heartbeat_interval,
  });

  const buildRowCtx = (d: DeviceDTO) => {
    const meta = platformMeta(d.platform);
    const subOs = [d.os_version || meta.label, d.arch].filter(Boolean).join(' · ');
    const sched = getSched();
    const { pollSec: pollWinSec, hbSec: hbWinSec } = resolvePollThresholds(sched);
    const cadenceHint = state.systemInfo
      ? `${formatCadence(sched.pollInterval)}/${formatCadence(sched.heartbeatInterval)}`
      : '';
    const health = derivePollHealth(d, Date.now(), sched);
    const ips = deviceIps(d);
    const encId = encodeURIComponent(d.id);
    return { meta, subOs, sched, pollWinSec, hbWinSec, cadenceHint, health, ips, encId };
  };

  const renderExpandedRow = (
    d: DeviceDTO,
    health: PollHealth,
    cadenceHint: string,
    subOs: string,
    ips: string[],
    encId: string,
  ): string => {
    const m = d.metrics;
    const cpu = clampPercent(m?.cpu_usage ?? 0);
    const memPct = getMemoryPercent(m);
    const disk = clampPercent(m?.disk_usage ?? 0);
    const verUp = [d.agent_version ? `v${d.agent_version.replace(/^v/, '')}` : '', m?.uptime ? `开机 ${formatDuration(m.uptime)}` : ''].filter(Boolean).join(' · ') || '—';
    const ek = (l: string, v: string) => `<div class="exp-k"><span class="mut nw">${l}</span>${v}</div>`;
    const em = (l: string, pct: number, valStr: string, tone?: 'ok') =>
      `<div class="exp-m"><span class="mut">${l}</span>${metricBar(pct, tone)}${hMono(valStr, ' num')}</div>`;
    const resHtml = m
      ? em('CPU', cpu, `${cpu.toFixed(1)}%`) +
        (m.load_avg ? ek('负载', `<span class="mono num">${esc(m.load_avg)}</span>`) : '') +
        em('内存', memPct, m.memory_total ? `${formatMemory(m.memory_used)}/${formatMemory(m.memory_total)}` : `${memPct.toFixed(0)}%`, 'ok') +
        em('磁盘', disk, `${disk.toFixed(0)}%`) +
        ek('网络', `<span class="mono num">↓ ${formatRate(m.network_in)} · ↑ ${formatRate(m.network_out)}</span>`)
      : hMs('暂无遥测快照');
    const netHtml =
      ek(
        '主 IP',
        `<span class="row gxs min-w-0">${
          ips[0] ? ipCopyHtml(ips[0]) : '<span class="mut">—</span>'
        }${
          ips.length > 1
            ? `<button type="button" class="tag tag-accent num" data-show-ips="${esc(d.id)}" title="共 ${ips.length} 个 IP · 点击查看全部">+${ips.length - 1}</button>`
            : ''
        }</span>`,
      ) +
      ek('主机名', `<span class="mono truncate" title="${esc(d.hostname || '')}">${esc(d.hostname || '—')}</span>`) +
      ek('系统/架构', `<span class="truncate" title="${esc(subOs)}">${esc(subOs || '—')}</span>`) +
      ek('探针/运行', `<span class="mono num">${esc(verUp)}</span>`);
    const healthHtml =
      ek('状态', statusBadge(d.status)) +
      ek('轮询健康', `<span class="${health.textCls}">${esc(health.label)}</span>`) +
      ek('调度周期', `<span class="mono num">${esc(cadenceHint || '—')}</span>`) +
      ek('最近轮询', `<span class="mono num">${esc(formatDate(d.last_seen))}</span>`) +
      ek('主机 ID', `<span class="mono truncate" title="${esc(d.id)}">${esc(d.id)}</span>`);
    const footHtml =
      `${hLnk(`#/devices/${encId}?tab=metrics&probe=1`, `${icons.activity()} 健康检测`, 'bxs bg', `data-open-dev="${esc(d.id)}"`)}` +
      `${hLnk(`#/devices/${encId}?tab=terminal`, `${icons.console()} 在线终端`, 'bxs bg', `data-open-dev="${esc(d.id)}"`)}` +
      `${hLnk(`#/logs?tab=health&device_id=${encId}`, `${icons.logs()} 健康日志`, 'bxs bg')}` +
      `${btn(`${icons.download()} 升级探针`, `data-upg="${esc(d.id)}"`, 'bxs ba')}` +
      `${btn(`${icons.key()} 安装命令`, `data-deploy="${esc(d.id)}"`, 'bxs bg')}` +
      `${btn(`${icons.edit()} 编辑主机`, `data-edit="${esc(d.id)}"`, 'bxs bg')}` +
      `${btn(`${icons.trash()} 删除主机`, `data-del="${esc(d.id)}"`, 'bxs bg ter')}`;
    const colSpan = 4 + (visCols.has('ip') ? 1 : 0) + (visCols.has('groups') ? 1 : 0) + (visCols.has('metrics') ? 1 : 0);
    return `<tr class="exp-tr" data-exp-detail="${esc(d.id)}"><td colspan="${colSpan}"><div class="exp-b"><div class="exp-g"><div class="exp-s">${hMut('资源监控', 't2xs')}${resHtml}</div><div class="exp-s">${hMut('网络与系统', 't2xs')}${netHtml}</div><div class="exp-s">${hMut('轮询与健康', 't2xs')}${healthHtml}</div></div><div class="row wrap exp-f">${footHtml}</div></div></td></tr>`;
  };

  const renderView = () => {
    const filtered = getFiltered();
    const allChecked = filtered.length > 0 && filtered.every((d) => selected.has(d.id));
    const allExp = filtered.length > 0 && filtered.every((d) => expandedIds.has(d.id));
    const onlineCount = devices.filter((d) => d.status === 'online').length;
    const sched = getSched();
    const { pollSec: pollWinSec, hbSec: hbWinSec } = resolvePollThresholds(sched);
    const showIp = visCols.has('ip');
    const showGrp = visCols.has('groups');
    const showMet = visCols.has('metrics');
    const isSlim = !showIp && !showGrp && !showMet;
    const devLabels = [
      '',
      '主机',
      '轮询健康值',
      ...(showIp ? ['IP'] : []),
      ...(showGrp ? ['分组'] : []),
      ...(showMet ? ['资源负载'] : []),
      '',
    ];
    const cadenceHint = state.systemInfo
      ? `${formatCadence(sched.pollInterval)}/${formatCadence(sched.heartbeatInterval)}`
      : '';
    const nowMs = Date.now();

    const rowsHtml = filtered
      .map((d) => {
        const meta = platformMeta(d.platform);
        const subOs = [d.os_version || meta.label, d.arch].filter(Boolean).join(' · ');
        const health = derivePollHealth(d, nowMs, sched);
        const slots = derivePollHealthSlots(d, 60, nowMs, pollWinSec, hbWinSec);
        const activeSlots = slots.filter((s) => s !== 'empty');
        const availTxt = activeSlots.length
          ? `${Math.round((activeSlots.filter((s) => s === 'ok').length / activeSlots.length) * 100)}%`
          : '--';
        const dots = uptimeDotsHtml(slots, {
          label: `${health.label}${cadenceHint ? ` · 调度 ${cadenceHint}` : ''} (${formatRelativeZh(d.last_seen)})`,
          windowSec: pollWinSec,
        });
        const sDot = d.status === 'online' ? 'dot-ok dot-pulse' : d.status === 'busy' ? 'dot-warn dot-pulse' : 'dot-err';
        const sTxt = d.status === 'online' ? '在线' : d.status === 'busy' ? '执行中' : '离线';
        const healthCell = hStk(
          `${hRb(`<span class="row gxs"><span class="dot ${sDot}"></span><span class="${health.textCls} t2xs">${sTxt}</span>${hMs(esc(formatRelativeZh(d.last_seen)), 't2xs num')}</span>${hMs(`近 ${esc(formatCadence(60 * pollWinSec))} · ${availTxt}`, 't2xs num')}`, 'gxs')}${dots}`,
          'sxs',
        );

        const ips = deviceIps(d);
        const fullIpTip = ips.length > 1
          ? `${ips.slice(0, 10).join(', ')}${ips.length > 10 ? ` (+${ips.length - 10})` : ''}`
          : [d.ip_address, d.hostname].filter(Boolean).join(' · ') || '—';
        const ipCell = hRow(
          `${ips[0] ? ipCopyHtml(ips[0], 'tsm', `${fullIpTip} · 点击或双击复制`) : `<span class="ip-t mono tsm" title="${esc(fullIpTip)}">${esc(d.hostname || '—')}</span>`}${
            ips.length > 1
              ? `<button type="button" class="tag tag-accent num" data-show-ips="${esc(d.id)}" title="共 ${ips.length} 个 IP · 点击查看">${`+${ips.length - 1}`}</button>`
              : ''
          }`,
          'gxs',
        );

        const gids = deviceGroupIds(d);
        const grpCell = gids.length ? groupPillsHtml(gids, groupName) : hMs('—');
        const m = d.metrics;
        const metCell = m
          ? hMono(`CPU ${clampPercent(m.cpu_usage).toFixed(0)}% · 内存 ${getMemoryPercent(m).toFixed(0)}%`, 'txs num')
          : hMs('—');
        const hostTip = [d.id, subOs].filter(Boolean).join(' · ');
        const encId = encodeURIComponent(d.id);
        const isExp = expandedIds.has(d.id);

        const cells: Array<string | [string, string?]> = [
          [
            `<input type="checkbox" class="row-chk" data-id="${esc(d.id)}"${selected.has(d.id) ? ' checked' : ''} aria-label="选择 ${esc(d.name)}">`,
            'col-chk',
          ],
          [
            hRow(
              `<button type="button" class="exp-btn chev${isExp ? '' : ' rot'}" data-exp-btn="${esc(d.id)}" aria-expanded="${isExp ? 'true' : 'false'}" title="${isExp ? '收起详情' : '展开详情'}">${icons.chevronDown()}</button><a href="#/devices/${encId}" data-open-dev="${esc(d.id)}" title="${esc(hostTip)}">${osBadge(d.platform, 'sm')}</a><a href="#/devices/${encId}" class="node-link truncate max-w-260" data-open-dev="${esc(d.id)}" title="${esc(hostTip)}"><strong>${esc(d.name)}</strong></a>`,
              'gxs min-w-0',
            ),
            'col-host',
          ],
          [healthCell, 'col-health'],
          ...(showIp ? [[ipCell, 'col-ip'] as [string, string]] : []),
          ...(showGrp ? [grpCell] : []),
          ...(showMet ? [metCell] : []),
          [
            `<div class="re gxs">${hLnk(`#/devices/${encId}`, icons.cog(), 'bxs ba', `data-open-dev="${esc(d.id)}" title="管理主机" aria-label="管理"`)}${hLnk(`#/devices/${encId}?tab=terminal`, icons.console(), 'bxs bg', `data-open-dev="${esc(d.id)}" title="在线终端" aria-label="终端"`)}</div>`,
            'col-act tr',
          ],
        ];
        const mainTr = hTr(
          cells,
          devLabels,
          `class="dev-row${isExp ? ' is-exp' : ''}" data-exp-row="${esc(d.id)}"`,
        );
        return isExp ? mainTr + renderExpandedRow(d, health, cadenceHint, subOs, ips, encId) : mainTr;
      })
      .join('');

    const statusOpts: Array<[string, string]> = [['', '全部状态'], ['online', '在线'], ['busy', '执行中'], ['offline', '已离线']];
    const platOpts: Array<[string, string]> = [['', '全部平台'], ...PLAT_OPTS];
    const grpOpts = groupOpts('全部分组', ['__none__', '未分组']);
    const bulkGrpOpts = groupOpts('加入分组…', ['__none__', '清空所有分组']);
    const colOptsHtml = [
      '<label class="col-opt dis"><input type="checkbox" checked disabled><span>主机</span></label>',
      '<label class="col-opt dis"><input type="checkbox" checked disabled><span>轮询健康值</span></label>',
      ...([['ip', 'IP 地址'], ['groups', '分组'], ['metrics', '资源负载']] as Array<[OptCol, string]>).map(
        ([k, lbl]) => `<label class="col-opt"><input type="checkbox" class="col-vis-chk" value="${k}"${visCols.has(k) ? ' checked' : ''}><span>${lbl}</span></label>`,
      ),
      '<label class="col-opt dis"><input type="checkbox" checked disabled><span>操作</span></label>',
    ].join('');

    const emptyHtml = hEmp(
      devices.length === 0
        ? `<div class="emp-ico">${icons.devices()}</div><h3>暂无纳管主机</h3><p class="mut tsm">绑定首台设备，开启实时监控与远程终端。</p><div class="mt-3">${btn(`${icons.plus()} 绑定主机`, 'id="emp-add-device"', 'bp')}</div>`
        : `<h3>无匹配主机</h3><p class="mut tsm">请调整搜索或筛选条件。</p><div class="mt-2">${btn('清除筛选', 'id="emp-clear-filter"', 'bsm bg')}</div>`,
      'emp-box',
    );

    ctx.root.innerHTML =
      `<div class="card tb-c"><div class="toolbar"><div class="search-wrap">${icons.search()}${hInp('f-search', 'search', `placeholder="搜索主机名 / IP / ID..." value="${esc(search)}"`, 'input input-pill ism')}</div>${selectHtml('f-platform', platOpts, platformFilter)}${selectHtml('f-group', grpOpts, groupFilter)}${selectHtml('f-status', statusOpts, statusFilter)}<span class="count-pill num">共 ${esc(filtered.length)}${filtered.length !== devices.length ? ` / ${esc(devices.length)}` : ''} 台主机 · <span class="tok">${esc(onlineCount)} 在线</span></span>${hRow(`${filtered.length ? btn(allExp ? '收起全部' : '展开全部', 'id="dev-toggle-all"', 'bsm bg') : ''}<div class="col-pick">${btn(`${icons.settings()} 表头`, `id="dev-cols-btn" aria-haspopup="true" aria-expanded="${colsOpen ? 'true' : 'false'}" title="自定义显示列"`, 'bsm bg')}<div id="dev-cols-pop" class="csel-pop col-pop${colsOpen ? '' : ' hidden'}"><div class="col-pop-hd">自定义表头列</div>${colOptsHtml}</div></div>${btn(`${icons.refresh()} 刷新`, 'id="dev-refresh" title="刷新列表"', 'bsm bg')}${btn(`${icons.plus()} 绑定主机`, 'id="btn-add-device"', 'bsm bp')}`, 'gxs ml-auto')}</div>` +
      (selected.size > 0
        ? `<div class="bulk-bar"><span class="tsm">已选 <strong class="num">${selected.size}</strong> 台主机</span>${hRw(`${selectHtml('bulk-grp-sel', bulkGrpOpts, bulkGroupTarget, 'input ixs')}${btn('应用分组', 'id="bulk-grp-apply"', 'bxs bg')}${btn(`${icons.console()} 批量执行`, 'id="bulk-console"', 'bxs ba')}${btn(`${icons.download()} 批量升级`, 'id="bulk-upgrade"', 'bxs bg')}${btn(`${icons.trash()} 批量删除`, 'id="bulk-delete"', 'bxs be')}${btn('清空', 'id="bulk-clear"', 'bxs bg')}`)}</div>`
        : '') +
      `</div>` +
      `<div class="card card-tbl mt-3">${
        rowsHtml
          ? tableHtml(
              [
                [`<input type="checkbox" id="chk-all"${allChecked ? ' checked' : ''} aria-label="全选">`, 'col-chk'],
                ['主机', 'col-host'],
                ['轮询健康值', 'col-health'],
                ...(showIp ? [['IP', 'col-ip'] as [string, string]] : []),
                ...(showGrp ? ['分组'] : []),
                ...(showMet ? ['资源负载'] : []),
                [hThTr(), 'col-act'],
              ],
              rowsHtml,
              '',
              `tbl-r${isSlim ? ' tbl-slim' : ''}`,
            )
          : emptyHtml
      }</div>`;

    bindEvents(filtered);
  };

  const bindExpRowEvents = (scope: ParentNode) => {
    bindCopyButtons(scope);
    onAll(scope, '[data-show-ips]', (el, ev) => {
      ev.stopPropagation();
      const dev = devices.find((d) => d.id === el.dataset.showIps);
      if (dev) showDeviceIpsModal(dev.name, deviceIps(dev));
    });
    onAll(scope, '[data-open-dev]', (el) => {
      const id = el.dataset.openDev;
      const dev = devices.find((d) => d.id === id);
      if (dev) openHostTab({ id: dev.id, name: dev.name, platform: dev.platform, status: dev.status });
    });
    onAll(scope, '[data-upg]', (el) => {
      const dev = devices.find((d) => d.id === el.dataset.upg);
      if (dev) openUpgradeDevicesModal([dev]);
    });
    onAll(scope, '[data-deploy]', (el) => {
      const dev = devices.find((d) => d.id === el.dataset.deploy);
      if (dev) void showInstallModal({ deviceId: dev.id, name: dev.name, platform: dev.platform });
    });
    onAll(scope, '[data-edit]', (el) => {
      const dev = devices.find((d) => d.id === el.dataset.edit);
      if (dev) openEditDeviceModal(dev);
    });
    onAll(scope, '[data-del]', (el) => {
      const dev = devices.find((d) => d.id === el.dataset.del);
      if (!dev) return;
      confirmModal({
        title: '删除主机',
        bodyHtml: `<p>确定移除主机 <strong>${esc(dev.name)}</strong> (<span class="mono">${esc(dev.id)}</span>) 吗？</p>`,
        confirmLabel: '确认删除',
        danger: true,
        async onConfirm() {
          await api.deleteDevice(dev.id);
          selected.delete(dev.id);
          toast(`已删除主机 ${dev.name}`, 'ok');
          await loadData(false);
        },
      });
    });
  };

  const bindEvents = (filtered: DeviceDTO[]) => {
    const r = ctx.root;
    bindExpRowEvents(r);
    const syncToggleAllBtn = () => {
      const b = r.querySelector('#dev-toggle-all');
      if (b) {
        const allNow = filtered.length > 0 && filtered.every((d) => expandedIds.has(d.id));
        b.textContent = allNow ? '收起全部' : '展开全部';
      }
    };
    const setRowExpanded = (id: string, nextOpen: boolean) => {
      const tr = Array.from(r.querySelectorAll<HTMLElement>('[data-exp-row]')).find(
        (el) => el.dataset.expRow === id,
      );
      if (!tr) return;
      const existingExp =
        tr.nextElementSibling?.matches('tr.exp-tr') &&
        (tr.nextElementSibling as HTMLElement).dataset.expDetail === id
          ? (tr.nextElementSibling as HTMLElement)
          : null;
      const expBtn = tr.querySelector<HTMLElement>('.exp-btn');
      if (nextOpen) {
        expandedIds.add(id);
        tr.classList.add('is-exp');
        expBtn?.classList.remove('rot');
        expBtn?.setAttribute('aria-expanded', 'true');
        if (expBtn) expBtn.title = '收起详情';
        if (!existingExp) {
          const dev = devices.find((d) => d.id === id);
          if (dev) {
            const c = buildRowCtx(dev);
            tr.insertAdjacentHTML('afterend', renderExpandedRow(dev, c.health, c.cadenceHint, c.subOs, c.ips, c.encId));
            const inserted = tr.nextElementSibling;
            if (inserted) bindExpRowEvents(inserted);
          }
        }
      } else {
        expandedIds.delete(id);
        tr.classList.remove('is-exp');
        expBtn?.classList.add('rot');
        expBtn?.setAttribute('aria-expanded', 'false');
        if (expBtn) expBtn.title = '展开详情';
        existingExp?.remove();
      }
    };
    const toggleExpand = (id?: string) => {
      if (!id) return;
      setRowExpanded(id, !expandedIds.has(id));
      syncToggleAllBtn();
    };
    on(r, '#dev-toggle-all', () => {
      const allNow = filtered.length > 0 && filtered.every((d) => expandedIds.has(d.id));
      for (const d of filtered) setRowExpanded(d.id, !allNow);
      syncToggleAllBtn();
    });
    onAll(r, '[data-exp-btn]', (el, ev) => {
      ev.stopPropagation();
      toggleExpand(el.dataset.expBtn);
    });
    onAll(r, '[data-exp-row]', (el, ev) => {
      if ((ev.target as HTMLElement | null)?.closest('a,button,input,label')) return;
      toggleExpand(el.dataset.expRow);
    });
    on(r, '#dev-cols-btn', (el, ev) => {
      ev.stopPropagation();
      colsOpen = !colsOpen;
      r.querySelector('#dev-cols-pop')?.classList.toggle('hidden', !colsOpen);
      el.setAttribute('aria-expanded', colsOpen ? 'true' : 'false');
    });
    onAll(r, '.col-vis-chk', (el) => {
      const c = el as HTMLInputElement;
      const k = c.value as OptCol;
      c.checked ? visCols.add(k) : visCols.delete(k);
      saveDevCols(visCols);
      renderView();
    }, 'change');
    on(r, '#dev-refresh', () => void loadData(false));
    on(r, '#btn-add-device', openAddDeviceModal);
    on(r, '#emp-add-device', openAddDeviceModal);
    on(r, '#emp-clear-filter', () => {
      search = '';
      statusFilter = '';
      platformFilter = '';
      groupFilter = '';
      renderView();
    });

    bindSearchInput(r, '#f-search', () => search, (v) => {
      search = v;
      renderView();
    });

    bindChange(r, [
      ['#f-status', (v) => { statusFilter = v; renderView(); }],
      ['#f-platform', (v) => { platformFilter = v; renderView(); }],
      ['#f-group', (v) => { groupFilter = v; renderView(); }],
      ['#bulk-grp-sel', (v) => { bulkGroupTarget = v; }],
    ]);

    on(r, '#chk-all', (el) => {
      const checked = (el as HTMLInputElement).checked;
      for (const d of filtered) checked ? selected.add(d.id) : selected.delete(d.id);
      renderView();
    }, 'change');

    onAll(r, '.row-chk', (el) => {
      const chk = el as HTMLInputElement;
      const id = chk.dataset.id;
      if (!id) return;
      chk.checked ? selected.add(id) : selected.delete(id);
      renderView();
    }, 'change');

    onAll(r, '[data-filter-grp]', (b) => {
      const gid = b.dataset.filterGrp ?? '';
      groupFilter = groupFilter === gid ? '' : gid;
      renderView();
    });

    on(r, '#bulk-clear', () => {
      selected.clear();
      renderView();
    });
    on(r, '#bulk-grp-apply', async () => {
      const ids = Array.from(selected);
      if (!ids.length) return;
      const gid = val(r, '#bulk-grp-sel') || bulkGroupTarget;
      if (!gid) {
        toast('请先选择目标分组', 'warn');
        return;
      }
      try {
        if (gid === '__none__') {
          await Promise.all(ids.map((id) => api.updateDevice(id, { group_ids: [] })));
          toast(`已清空 ${ids.length} 台主机的分组`, 'ok');
        } else {
          await api.assignGroupDevices(gid, ids);
          toast(`已将 ${ids.length} 台主机加入分组`, 'ok');
        }
        bulkGroupTarget = '';
        await loadData(false);
      } catch (err) {
        toast(err instanceof ApiError ? err.message : '分组分配失败', 'err');
      }
    });
    on(r, '#bulk-console', () => navigate(`/console?devices=${encodeURIComponent(Array.from(selected).join(','))}`));
    on(r, '#bulk-upgrade', () => {
      const list = devices.filter((d) => selected.has(d.id));
      openUpgradeDevicesModal(list);
    });
    on(r, '#bulk-delete', () => {
      const ids = Array.from(selected);
      if (!ids.length) return;
      confirmModal({
        title: '确认批量删除',
        bodyHtml: `<p>确定删除已选的 <strong>${ids.length}</strong> 台主机吗？此操作不可撤销。</p>`,
        confirmLabel: `删除 ${ids.length} 台主机`,
        danger: true,
        async onConfirm() {
          await api.batchDeleteDevices(ids);
          selected.clear();
          toast(`已删除 ${ids.length} 台主机`, 'ok');
          await loadData(false);
        },
      });
    });
  };

  const renderGroupPicker = (chosen: Set<string>): string => {
    if (!groups.length) return '<div class="grp-picker"><span class="mut txs">暂无分组（可在“分组”页创建）</span></div>';
    return `<div class="grp-picker">${groups
      .map(
        (g) =>
          `<label class="grp-opt${chosen.has(g.id) ? ' selected' : ''}"><input type="checkbox" class="grp-pchk" value="${esc(g.id)}"${chosen.has(g.id) ? ' checked' : ''}><span>${esc(g.name)}</span></label>`,
      )
      .join('')}</div>`;
  };

  const bindGroupPicker = (panel: HTMLElement, chosen: Set<string>) => {
    onAll(panel, '.grp-pchk', (el) => {
      const chk = el as HTMLInputElement;
      if (chk.checked) chosen.add(chk.value);
      else chosen.delete(chk.value);
      chk.closest('.grp-opt')?.classList.toggle('selected', chk.checked);
    }, 'change');
  };

  const openAddDeviceModal = () => {
    const chosen = new Set<string>();
    formModal({
      title: '绑定主机',
      formId: 'add-dev-form',
      submitLabel: '创建并获取安装指令',
      fieldsHtml:
        fieldHtml('dev-name', '主机名称', '<input id="dev-name" class="input" type="text" required maxlength="100" placeholder="例如 openwrt-edge-01">') +
        fieldHtml('dev-plat', '目标平台家族', selectHtml('dev-plat', ADD_PLAT_OPTS, 'unix', 'input')) +
        `<div class="field"><label>所属分组 (可多选)</label>${renderGroupPicker(chosen)}</div>`,
      onMount(panel) {
        bindGroupPicker(panel, chosen);
      },
      async onSubmit(panel, close) {
        const name = val(panel, '#dev-name');
        const platform = val(panel, '#dev-plat') as PlatformType;
        const group_ids = Array.from(chosen);
        if (!name) return;
        const res = await api.createDevice({
          name,
          platform,
          group_ids: group_ids.length ? group_ids : undefined,
        });
        close();
        toast(`主机 "${name}" 已创建`, 'ok');
        await loadData(true);
        await showInstallModal(paramsFromCreateResponse(res, name, platform));
      },
    });
  };

  const openEditDeviceModal = (dev: DeviceDTO) => {
    const platKey = platformMeta(dev.platform).key;
    const platOpts: Array<[string, string]> = [...PLAT_OPTS, ['unix', 'UNIX'], ['other', 'Other']];
    const chosen = new Set<string>(deviceGroupIds(dev));
    formModal({
      title: `编辑主机 — ${dev.name}`,
      formId: 'edit-dev-form',
      submitLabel: '保存修改',
      fieldsHtml:
        fieldHtml('ed-name', '主机名称', `<input id="ed-name" class="input" type="text" required value="${esc(dev.name)}">`) +
        fieldHtml('ed-plat', '平台类型', selectHtml('ed-plat', platOpts, platKey, 'input')) +
        `<div class="field"><label>所属分组 (可多选)</label>${renderGroupPicker(chosen)}</div>`,
      onMount(panel) {
        bindGroupPicker(panel, chosen);
      },
      async onSubmit(panel, close) {
        await api.updateDevice(dev.id, {
          name: val(panel, '#ed-name'),
          platform: val(panel, '#ed-plat') as PlatformType,
          group_ids: Array.from(chosen),
        });
        close();
        toast('主机信息已更新', 'ok');
        await loadData(false);
      },
    });
  };

  await loadData(false);
}
