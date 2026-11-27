import type { DeviceDTO, GroupDTO, PlatformType } from '../../../shared/types';
import { api, ApiError } from '../api';
import { metricBar, osBadge, statusBadge } from '../components/badges';
import { paramsFromCreateResponse, showInstallModal } from '../components/install-modal';
import {
  ADD_PLAT_OPTS,
  bindSearchInput,
  btn,
  confirmModal,
  fieldHtml,
  formModal,
  on,
  onAll,
  PLAT_OPTS,
  selectHtml,
  tableHtml,
  val,
} from '../components/ui';
import { icons } from '../icons';
import { navigate, type RouteContext } from '../router';
import { openHostTab, registerCleanup, state, syncHostTabs, toast } from '../state';
import {
  clampPercent,
  esc,
  formatDuration,
  formatMemory,
  formatRelativeZh,
  getMemoryPercent,
  platformMeta,
} from '../utils';

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

/** Derive passive agent health from device status and last poll/heartbeat activity. */
export function derivePollHealth(
  device: Pick<DeviceDTO, 'status' | 'last_seen'>,
  nowMs = Date.now(),
): PollHealth {
  if (device.status !== 'online' && device.status !== 'busy') {
    return pollResult(0, '离线 · 无轮询请求', 'err');
  }
  const lastMs = device.last_seen ? Date.parse(device.last_seen) : Number.NaN;
  const ageSec = Number.isNaN(lastMs) ? Number.POSITIVE_INFINITY : Math.max(0, (nowMs - lastMs) / 1000);
  if (ageSec <= 90) return pollResult(100, '健康 · 轮询活跃', 'ok');
  if (ageSec <= 300) return pollResult(65, '延迟 · 轮询变慢', 'warn');
  return pollResult(25, '超时 · 久未轮询', 'err');
}

export async function renderDevices(ctx: RouteContext): Promise<void> {
  let devices: DeviceDTO[] = [];
  let groups: GroupDTO[] = [];
  let search = '';
  let statusFilter = '';
  let platformFilter = '';
  let groupFilter = '';
  let bulkGroupTarget = '';
  let openMenuId = '';
  const selected = new Set<string>();

  const onDocClick = (ev: Event) => {
    if (!openMenuId) return;
    if (!(ev.target as HTMLElement | null)?.closest('.more-wrap')) {
      openMenuId = '';
      ctx.root.querySelectorAll('.more-menu.open').forEach((m) => m.classList.remove('open'));
    }
  };
  document.addEventListener('click', onDocClick);
  registerCleanup(() => document.removeEventListener('click', onDocClick));

  const loadData = async (silent = false) => {
    try {
      const fleet = await api.fetchFleet();
      if (ctx.isStale()) return;
      devices = fleet.devices;
      groups = fleet.groups;
      state.devicesCache = devices;
      state.groupsCache = groups;
      syncHostTabs(devices);
      const validIds = new Set(devices.map((d) => d.id));
      for (const id of Array.from(selected)) if (!validIds.has(id)) selected.delete(id);
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
      if (groupFilter === '__none__' && d.group_id) return false;
      if (groupFilter && groupFilter !== '__none__' && (d.group_id ?? '') !== groupFilter) return false;
      if (q && !`${d.name} ${d.hostname ?? ''} ${d.ip_address ?? ''} ${d.id}`.toLowerCase().includes(q)) return false;
      return true;
    });
  };

  const groupName = (gid?: string | null): string => (gid ? groups.find((g) => g.id === gid)?.name ?? gid : '');

  const renderView = () => {
    const filtered = getFiltered();
    const allChecked = filtered.length > 0 && filtered.every((d) => selected.has(d.id));
    const onlineCount = devices.filter((d) => d.status === 'online').length;

    const rowsHtml = filtered
      .map((d) => {
        const meta = platformMeta(d.platform);
        const m = d.metrics;
        const cpu = clampPercent(m?.cpu_usage ?? 0);
        const memPct = getMemoryPercent(m);
        const subOs = [d.os_version || meta.label, d.arch].filter(Boolean).join(' · ');

        const statusCell =
          d.status === 'online'
            ? `<div class="sxs">${statusBadge('online')}${
                m?.uptime ? `<div class="t2xs mut num">已开机 ${esc(formatDuration(m.uptime))}</div>` : ''
              }</div>`
            : d.status === 'busy'
              ? `<div class="sxs">${statusBadge('busy')}<div class="t2xs mut">任务运行中</div></div>`
              : `<div class="sxs">${statusBadge('offline')}<div class="t2xs mut">最后在线 ${esc(
                  formatRelativeZh(d.last_seen),
                )}</div></div>`;

        const health = derivePollHealth(d);
        const healthCell = `<div class="tel-m"><div class="tm-row"><span class="mono num ${health.textCls}">${health.score}%</span>${metricBar(health.score, health.tone)}<span class="t2xs mut truncate">${esc(formatRelativeZh(d.last_seen))}</span></div><div class="t2xs ${health.textCls}">${esc(health.label)}</div></div>`;

        const configCell = m
          ? `<div class="tel-m"><div class="tm-row"><span class="mut">CPU</span>${metricBar(cpu)}<span class="mono num">${cpu.toFixed(0)}%</span></div><div class="tm-row"><span class="mut">内存</span>${metricBar(memPct, 'ok')}<span class="mono num">${
              m.memory_total ? `${formatMemory(m.memory_used)}/${formatMemory(m.memory_total)}` : `${memPct.toFixed(0)}%`
            }</span></div></div>`
          : '<span class="mut txs">—</span>';

        const ipCell = `<div class="sxs"><div class="mono tsm">${esc(d.ip_address || d.hostname || '—')}</div><div class="row gxs wrap">${
          d.hostname && d.ip_address ? `<span class="mut t2xs truncate max-w-160">${esc(d.hostname)}</span>` : ''
        }${d.agent_version ? `<span class="tag mono t2xs">v${esc(d.agent_version.replace(/^v/, ''))}</span>` : ''}</div></div>`;

        const gName = groupName(d.group_id);
        const grpCell = gName ? `<span class="grp-pill">${esc(gName)}</span>` : '<span class="mut txs">—</span>';

        return `<tr class="host-row" data-row-id="${esc(d.id)}">` +
          `<td class="col-chk"><input type="checkbox" class="row-chk" data-id="${esc(d.id)}"${selected.has(d.id) ? ' checked' : ''} aria-label="选择 ${esc(d.name)}"></td>` +
          `<td><div class="row gsm"><a href="#/devices/${encodeURIComponent(d.id)}" class="host-link-wrap" data-open-dev="${esc(d.id)}">${osBadge(d.platform, 'md')}</a><div class="sxs min-w-0"><div class="row gxs wrap"><a href="#/devices/${encodeURIComponent(d.id)}" class="node-link" data-open-dev="${esc(d.id)}"><strong>${esc(d.name)}</strong></a><span class="id-pill mono">${esc(d.id)}</span></div><div class="mut t2xs truncate max-w-260" title="${esc(subOs)}">${esc(subOs || '未知系统')}</div></div></div></td>` +
          `<td>${statusCell}</td>` +
          `<td>${healthCell}</td>` +
          `<td>${configCell}</td>` +
          `<td>${ipCell}</td>` +
          `<td>${grpCell}</td>` +
          `<td class="tr"><div class="re gxs"><a class="btn bxs ba" href="#/devices/${encodeURIComponent(d.id)}" data-open-dev="${esc(d.id)}">管理</a><a class="btn bxs bg" href="#/devices/${encodeURIComponent(d.id)}?tab=terminal" data-open-dev="${esc(d.id)}">终端</a><div class="more-wrap">${btn(`${icons.more()} 更多`, `data-more-btn="${esc(d.id)}"`, 'bxs bg')}<div class="more-menu${openMenuId === d.id ? ' open' : ''}" data-more-menu="${esc(d.id)}"><a class="more-item" href="#/devices/${encodeURIComponent(d.id)}?tab=metrics&probe=1" data-open-dev="${esc(d.id)}">${icons.activity()} 健康检测</a><button type="button" class="more-item" data-deploy="${esc(d.id)}">${icons.key()} 安装命令</button><button type="button" class="more-item" data-edit="${esc(d.id)}">${icons.edit()} 编辑主机</button><button type="button" class="more-item ter" data-del="${esc(d.id)}">${icons.trash()} 删除主机</button></div></div></div></td>` +
          `</tr>`;
      })
      .join('');

    const statusOpts: Array<[string, string]> = [['', '全部状态'], ['online', '在线'], ['busy', '执行中'], ['offline', '已离线']];
    const platOpts: Array<[string, string]> = [['', '全部平台'], ...PLAT_OPTS];
    const grpOpts: Array<[string, string]> = [
      ['', '全部分组'],
      ['__none__', '未分组'],
      ...groups.map((g): [string, string] => [g.id, g.name]),
    ];
    const bulkGrpOpts: Array<[string, string]> = [
      ['', '移入分组…'],
      ['__none__', '移出分组 (未分组)'],
      ...groups.map((g): [string, string] => [g.id, g.name]),
    ];

    const emptyHtml =
      devices.length === 0
        ? `<div class="emp-box"><div class="emp-ico">${icons.devices()}</div><h3>暂无纳管主机</h3><p class="mut tsm">绑定你的第一台设备，开启实时监控与远程终端。</p><div class="mt-3">${btn(`${icons.plus()} 绑定主机`, 'id="emp-add-device"', 'bp')}</div></div>`
        : `<div class="emp-box"><h3>无匹配主机</h3><p class="mut tsm">请调整搜索或筛选条件。</p><div class="mt-2">${btn('清除筛选', 'id="emp-clear-filter"', 'bsm bg')}</div></div>`;

    ctx.root.innerHTML =
      `<div class="card tb-c"><div class="toolbar"><div class="search-wrap">${icons.search()}<input id="f-search" class="input input-pill ism" type="search" placeholder="搜索主机名 / IP / ID..." value="${esc(search)}"></div>${selectHtml('f-platform', platOpts, platformFilter)}${selectHtml('f-group', grpOpts, groupFilter)}${selectHtml('f-status', statusOpts, statusFilter)}<span class="count-pill num">共 ${esc(filtered.length)}${filtered.length !== devices.length ? ` / ${esc(devices.length)}` : ''} 台主机 · <span class="tok">${esc(onlineCount)} 在线</span></span><div class="row gxs ml-auto">${btn(`${icons.refresh()} 刷新`, 'id="dev-refresh" title="刷新列表"', 'bsm bg')}${btn(`${icons.plus()} 绑定主机`, 'id="btn-add-device"', 'bsm bp')}</div></div>` +
      (selected.size > 0
        ? `<div class="bulk-bar"><span class="tsm">已选 <strong class="num">${selected.size}</strong> 台主机</span><div class="row gxs wrap">${selectHtml('bulk-grp-sel', bulkGrpOpts, bulkGroupTarget, 'input ixs')}${btn('应用分组', 'id="bulk-grp-apply"', 'bxs bg')}${btn(`${icons.console()} 批量执行`, 'id="bulk-console"', 'bxs ba')}${btn(`${icons.trash()} 批量删除`, 'id="bulk-delete"', 'bxs be')}${btn('清空', 'id="bulk-clear"', 'bxs bg')}</div></div>`
        : '') +
      `</div>` +
      `<div class="card card-tbl mt-3">${
        rowsHtml
          ? tableHtml(
              [
                `<input type="checkbox" id="chk-all"${allChecked ? ' checked' : ''} aria-label="全选">`,
                '主机',
                '状态',
                '轮询健康值',
                '配置',
                'IP / 区域',
                '分组',
                '<span class="tr" style="display:block">操作</span>',
              ],
              rowsHtml,
              '',
            )
          : emptyHtml
      }</div>`;

    bindEvents(filtered);
  };

  const bindEvents = (filtered: DeviceDTO[]) => {
    const r = ctx.root;
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

    on(r, '#f-status', (el) => {
      statusFilter = (el as HTMLSelectElement).value;
      renderView();
    }, 'change');
    on(r, '#f-platform', (el) => {
      platformFilter = (el as HTMLSelectElement).value;
      renderView();
    }, 'change');
    on(r, '#f-group', (el) => {
      groupFilter = (el as HTMLSelectElement).value;
      renderView();
    }, 'change');

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

    onAll(r, '[data-open-dev]', (el) => {
      openMenuId = '';
      const id = el.dataset.openDev;
      const dev = devices.find((d) => d.id === id);
      if (dev) openHostTab({ id: dev.id, name: dev.name, platform: dev.platform, status: dev.status });
    });

    on(r, '#bulk-clear', () => {
      selected.clear();
      renderView();
    });
    on(r, '#bulk-grp-sel', (el) => {
      bulkGroupTarget = (el as HTMLSelectElement).value;
    }, 'change');
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
          await Promise.all(ids.map((id) => api.updateDevice(id, { group_id: null })));
          toast(`已将 ${ids.length} 台主机移出分组`, 'ok');
        } else {
          await api.assignGroupDevices(gid, ids);
          toast(`已将 ${ids.length} 台主机分配到分组`, 'ok');
        }
        bulkGroupTarget = '';
        await loadData(false);
      } catch (err) {
        toast(err instanceof ApiError ? err.message : '分组分配失败', 'err');
      }
    });
    on(r, '#bulk-console', () => navigate(`/console?devices=${encodeURIComponent(Array.from(selected).join(','))}`));
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

    onAll(r, '[data-more-btn]', (b, ev) => {
      ev.stopPropagation();
      const id = b.dataset.moreBtn ?? '';
      openMenuId = openMenuId === id ? '' : id;
      r.querySelectorAll('.more-menu').forEach((m) => {
        m.classList.toggle('open', (m as HTMLElement).dataset.moreMenu === openMenuId);
      });
    });

    onAll(r, '[data-deploy]', (el) => {
      openMenuId = '';
      const dev = devices.find((d) => d.id === el.dataset.deploy);
      if (dev) void showInstallModal({ deviceId: dev.id, name: dev.name, platform: dev.platform });
    });
    onAll(r, '[data-edit]', (el) => {
      openMenuId = '';
      const dev = devices.find((d) => d.id === el.dataset.edit);
      if (dev) openEditDeviceModal(dev);
    });
    onAll(r, '[data-del]', (el) => {
      openMenuId = '';
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

  const openAddDeviceModal = () => {
    const grpOpts: Array<[string, string]> = [['', '不分组'], ...groups.map((g): [string, string] => [g.id, g.name])];
    formModal({
      title: '绑定主机',
      formId: 'add-dev-form',
      submitLabel: '创建并获取安装指令',
      fieldsHtml:
        fieldHtml('dev-name', '主机名称', '<input id="dev-name" class="input" type="text" required maxlength="100" placeholder="例如 openwrt-edge-01">') +
        fieldHtml('dev-plat', '目标平台家族', selectHtml('dev-plat', ADD_PLAT_OPTS, 'unix', 'input')) +
        fieldHtml('dev-grp', '所属分组 (可选)', selectHtml('dev-grp', grpOpts, '', 'input')),
      async onSubmit(panel, close) {
        const name = val(panel, '#dev-name');
        const platform = val(panel, '#dev-plat') as PlatformType;
        const group_id = val(panel, '#dev-grp') || undefined;
        if (!name) return;
        const res = await api.createDevice({ name, platform, group_id });
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
    const grpOpts: Array<[string, string]> = [['', '不分组'], ...groups.map((g): [string, string] => [g.id, g.name])];
    formModal({
      title: `编辑主机 — ${dev.name}`,
      formId: 'edit-dev-form',
      submitLabel: '保存修改',
      fieldsHtml:
        fieldHtml('ed-name', '主机名称', `<input id="ed-name" class="input" type="text" required value="${esc(dev.name)}">`) +
        fieldHtml('ed-plat', '平台类型', selectHtml('ed-plat', platOpts, platKey, 'input')) +
        fieldHtml('ed-grp', '所属分组', selectHtml('ed-grp', grpOpts, dev.group_id ?? '', 'input')),
      async onSubmit(panel, close) {
        await api.updateDevice(dev.id, {
          name: val(panel, '#ed-name'),
          platform: val(panel, '#ed-plat') as PlatformType,
          group_id: val(panel, '#ed-grp') || null,
        });
        close();
        toast('主机信息已更新', 'ok');
        await loadData(false);
      },
    });
  };

  await loadData(false);
}
