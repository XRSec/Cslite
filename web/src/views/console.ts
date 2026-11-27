import type {
  DeviceDTO,
  ExecutionDeviceResultDTO,
  GroupDTO,
  TargetType,
} from '../../../shared/types';
import { api, ApiError } from '../api';
import { platformBadge } from '../components/badges';
import {
  bindCopyButtons,
  btn,
  diffPreHtml,
  hostCardHtml,
  isTerminalExecStatus,
  on,
  onAll,
  pageHeadHtml,
  preOutputHtml,
  shellSelectHtml,
  startCommandPolling,
  tabsHtml,
  targetItemHtml,
  val,
} from '../components/ui';
import { icons } from '../icons';
import type { RouteContext } from '../router';
import { registerCleanup, toast } from '../state';
import { computeDiffLines, esc, platformMeta, stripAnsi } from '../utils';

export async function renderConsole(ctx: RouteContext): Promise<void> {
  let devices: DeviceDTO[] = [];
  let groups: GroupDTO[] = [];

  try {
    const fleet = await api.fetchFleet();
    if (ctx.isStale()) return;
    devices = fleet.devices;
    groups = fleet.groups;
  } catch (err) {
    if (ctx.isStale()) return;
    toast(err instanceof ApiError ? err.message : '加载目标主机失败', 'err');
  }

  const qDevices = (ctx.query.get('devices') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const qGroup = (ctx.query.get('group') ?? '').trim();

  let targetType: TargetType = qGroup ? 'groups' : 'devices';
  const selectedDevices = new Set<string>(qDevices);
  const selectedGroups = new Set<string>(qGroup ? [qGroup] : []);
  let targetSearch = '';

  let activeCmdId = '';
  let activeCmdContent = '';
  let results: ExecutionDeviceResultDTO[] = [];
  let viewMode: 'cards' | 'diff' = 'cards';
  let resultFilter: 'all' | 'active' | 'ok' | 'err' = 'all';
  const collapsedCards = new Set<string>();
  let stopPoll: (() => void) | null = null;
  let polling = false;

  const haltPoll = () => {
    stopPoll?.();
    stopPoll = null;
    polling = false;
  };
  registerCleanup(haltPoll);

  const devMap = () => new Map(devices.map((d) => [d.id, d]));

  const countOnlineSelected = (): { total: number; online: number } => {
    if (targetType === 'devices') {
      const list = devices.filter((d) => selectedDevices.has(d.id));
      return { total: list.length, online: list.filter((d) => d.status === 'online').length };
    }
    const list = groups.filter((g) => selectedGroups.has(g.id));
    const memberIds = new Set<string>();
    for (const g of list) for (const id of g.device_ids ?? []) memberIds.add(id);
    for (const d of devices) if (d.group_id && selectedGroups.has(d.group_id)) memberIds.add(d.id);
    const members = devices.filter((d) => memberIds.has(d.id));
    return {
      total: members.length || list.reduce((acc, g) => acc + (g.device_count || 0), 0),
      online: members.filter((d) => d.status === 'online').length,
    };
  };

  ctx.root.innerHTML =
    pageHeadHtml('批量执行', '多机并行命令与输出 Diff', '<div id="con-online-badge"></div>') +
    `<div class="c-lay"><aside class="card c-tgt"><div class="rb mb-2">${tabsHtml([['devices', '按主机'], ['groups', '按分组']], targetType, 'data-tmode', true)}<span class="mut txs num" id="con-sel-count">已选 0</span></div>` +
    `<div id="con-quick-picks" class="row gxs wrap mb-2">${['online:在线', 'linux:Linux', 'openwrt:OpenWrt', 'macos:macOS', 'windows:Windows', 'android:Android', 'clear:清空']
      .map((s) => {
        const [k, l] = s.split(':');
        return `<button type="button" class="chip" data-pick="${k}">${l}</button>`;
      })
      .join('')}</div><input id="con-search" class="input ism mb-2" type="search" placeholder="筛选目标…"><div id="con-target-list" class="target-list"></div></aside>` +
    `<div class="c-mn smd"><section class="card"><form id="con-form" class="ssm"><div class="row gsm wrap"><input id="con-name" class="input ism flex-1" type="text" placeholder="任务名称 (可选)">${shellSelectHtml('con-shell', 'auto', 'input ism w-130')}<div class="row gxs"><label class="txs mut" for="con-timeout">超时(s)</label><input id="con-timeout" class="input ism w-70 mono" type="number" min="5" max="3600" value="60"></div></div>` +
    `<div class="preset-bar"><span class="mut t2xs">预设:</span>${['uname -a', 'ubus call system board', 'df -h', 'uptime', 'ip addr']
      .map((c) => `<button type="button" class="chip" data-con-preset="${esc(c)}">${esc(c === 'ubus call system board' ? 'ubus board' : c)}</button>`)
      .join('')}</div><textarea id="con-cmd" class="input mono t-ta" rows="3" placeholder="输入命令或脚本 (Ctrl/Cmd + Enter 执行)"></textarea>` +
    `<div class="rb wrap gsm"><span class="mut txs">就绪</span><div class="row gsm">${btn(`${icons.stop()} 停止`, 'id="con-stop"', 'bsm be hidden')}<button type="submit" class="btn bsm bp" id="con-run">${icons.play()} 下发执行</button></div></div></form></section>` +
    `<section class="card" id="con-results-card"><div class="emp-i mut">选择左侧主机或分组，输入命令下发即可实时查看输出。</div></section></div></div>`;

  const paintTargetSidebar = () => {
    const counts = countOnlineSelected();
    const badgeEl = ctx.root.querySelector('#con-online-badge');
    if (badgeEl) {
      badgeEl.innerHTML = `<span class="bdg ${counts.online > 0 ? 'bd-ok' : 'bd-m'} num"><span class="dot ${
        counts.online > 0 ? 'dot-pulse' : ''
      }"></span>目标在线 ${counts.online} / ${counts.total}</span>`;
    }
    const selEl = ctx.root.querySelector('#con-sel-count');
    if (selEl) {
      const n = targetType === 'devices' ? selectedDevices.size : selectedGroups.size;
      selEl.textContent = `已选 ${n} ${targetType === 'devices' ? '台' : '组'}`;
    }

    ctx.root.querySelectorAll<HTMLElement>('[data-tmode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tmode === targetType);
    });
    ctx.root.querySelector('#con-quick-picks')?.classList.toggle('hidden', targetType !== 'devices');

    const listEl = ctx.root.querySelector('#con-target-list') as HTMLElement;
    const q = targetSearch.trim().toLowerCase();
    const set = targetType === 'devices' ? selectedDevices : selectedGroups;

    const items =
      targetType === 'devices'
        ? devices
            .filter((d) => !q || `${d.name} ${d.hostname ?? ''} ${d.ip_address ?? ''} ${d.platform}`.toLowerCase().includes(q))
            .map((d) => {
              const dotCls = d.status === 'online' ? 'dot-ok dot-pulse' : d.status === 'busy' ? 'dot-warn' : 'dot-err';
              return {
                id: d.id,
                name: d.name,
                right: `<span class="dot ${dotCls}"></span>`,
                sub: `${platformMeta(d.platform).label} · ${d.ip_address || d.hostname || d.id}`,
              };
            })
        : groups
            .filter((g) => !q || g.name.toLowerCase().includes(q))
            .map((g) => ({
              id: g.id,
              name: g.name,
              right: `<span class="tag num">${esc(g.device_count)}</span>`,
              sub: g.description || '暂无描述',
            }));

    listEl.innerHTML = !items.length
      ? `<div class="mut txs p-2">无匹配的${targetType === 'devices' ? '主机' : '分组'}</div>`
      : items
          .map((it) =>
            targetItemHtml(
              it.id,
              'con-chk',
              set.has(it.id),
              `<div class="target-item-info"><div class="rb gxs"><strong class="truncate tsm">${esc(it.name)}</strong>${it.right}</div><div class="mut t2xs mono truncate">${esc(it.sub)}</div></div>`,
            ),
          )
          .join('');

    onAll(listEl, '.con-chk', (el) => {
      const chk = el as HTMLInputElement;
      const id = chk.dataset.id;
      if (!id) return;
      chk.checked ? set.add(id) : set.delete(id);
      paintTargetSidebar();
    }, 'change');
  };

  const paintResults = () => {
    const card = ctx.root.querySelector('#con-results-card') as HTMLElement;
    if (!activeCmdId) return;

    const dMap = devMap();
    const total = results.length;
    const doneOk = results.filter((r) => r.status === 'completed').length;
    const doneErr = results.filter((r) => r.status === 'failed' || r.status === 'timeout' || r.status === 'cancelled').length;
    const active = results.filter((r) => r.status === 'queued' || r.status === 'running').length;
    const pct = total > 0 ? ((doneOk + doneErr) / total) * 100 : 0;

    const filteredResults = results.filter((r) => {
      if (resultFilter === 'active') return r.status === 'queued' || r.status === 'running';
      if (resultFilter === 'ok') return r.status === 'completed';
      if (resultFilter === 'err') return r.status === 'failed' || r.status === 'timeout' || r.status === 'cancelled';
      return true;
    });

    const baseRes = results.find((r) => r.status === 'completed') ?? results.find((r) => isTerminalExecStatus(r.status)) ?? results[0];
    const baseName = baseRes ? baseRes.device_name || dMap.get(baseRes.device_id)?.name || baseRes.device_id : '';

    const listHtml = !filteredResults.length
      ? `<div class="emp-i mut">${results.length === 0 ? '正在等待探针拉取执行…' : '当前筛选下无匹配结果。'}</div>`
      : viewMode === 'cards'
        ? `<div class="ssm">${filteredResults
            .map((r) => {
              const dev = dMap.get(r.device_id);
              return hostCardHtml(r, {
                hostLabel: r.device_name || dev?.name || r.device_id,
                extraHtml: dev ? platformBadge(dev.platform, dev.arch) : '',
                collapsible: true,
                collapsed: collapsedCards.has(r.device_id),
              });
            })
            .join('')}</div>`
        : `<div class="ssm"><div class="mut txs">对比基准: <strong>${esc(baseName)}</strong></div>${filteredResults
            .map((r) => {
              const dev = dMap.get(r.device_id);
              const isBase = Boolean(baseRes && r.device_id === baseRes.device_id);
              const diff = computeDiffLines(baseRes?.output ?? '', r.output ?? '');
              const badge = isBase
                ? '<span class="tag">基准</span>'
                : diff.identical
                  ? '<span class="bdg bd-ok">一致</span>'
                  : '<span class="bdg bd-wn">有差异</span>';
              const customBodyHtml =
                isBase || diff.identical
                  ? preOutputHtml(r.output ?? '', '(无输出)')
                  : diffPreHtml(baseRes?.output ?? '', r.output ?? '');
              return hostCardHtml(r, { hostLabel: r.device_name || dev?.name || r.device_id, extraHtml: badge, customBodyHtml });
            })
            .join('')}</div>`;

    card.innerHTML =
      `<div class="ssm"><div class="rb wrap gsm"><div><div class="row gxs wrap"><strong>执行结果</strong><span class="tag mono">${esc(activeCmdId)}</span>${polling ? '<span class="bdg bd-wn"><span class="dot dot-pulse"></span>轮询中</span>' : ''}</div><div class="mut txs mono mt-1 truncate max-w-460">$ ${esc(activeCmdContent)}</div></div>${tabsHtml([['cards', '主机卡片'], ['diff', '输出 Diff']], viewMode, 'data-vmode', true)}</div>` +
      `<div class="seg-bar"><div class="seg-ok" style="width:${total ? ((doneOk / total) * 100).toFixed(1) : 0}%"></div><div class="seg-warn" style="width:${total ? ((active / total) * 100).toFixed(1) : 0}%"></div><div class="seg-err" style="width:${total ? ((doneErr / total) * 100).toFixed(1) : 0}%"></div></div>` +
      `<div class="rb wrap gsm"><div class="row gxs wrap">${[['all', `全部 (${total})`], ['active', `运行中 (${active})`], ['ok', `成功 (${doneOk})`], ['err', `异常 (${doneErr})`]]
        .map(([k, l]) => `<button type="button" class="chip num${resultFilter === k ? ' active' : ''}" data-rfilter="${k}">${l}</button>`)
        .join('')}</div><div class="row gxs"><span class="mut txs num">${Math.round(pct)}%</span>${
        viewMode === 'cards' && results.length
          ? btn('全部展开', 'id="con-expand-all"', 'b2x bg') + btn('全部折叠', 'id="con-collapse-all"', 'b2x bg')
          : ''
      }</div></div>${listHtml}</div>`;

    onAll(card, '[data-vmode]', (b) => {
      viewMode = b.dataset.vmode as 'cards' | 'diff';
      paintResults();
    });
    onAll(card, '[data-rfilter]', (b) => {
      resultFilter = b.dataset.rfilter as 'all' | 'active' | 'ok' | 'err';
      paintResults();
    });
    on(card, '#con-expand-all', () => {
      collapsedCards.clear();
      paintResults();
    });
    on(card, '#con-collapse-all', () => {
      for (const r of results) collapsedCards.add(r.device_id);
      paintResults();
    });
    onAll(card, '[data-toggle-host]', (h, ev) => {
      if ((ev.target as HTMLElement).closest('button, a')) return;
      const id = h.dataset.toggleHost;
      if (!id) return;
      collapsedCards.has(id) ? collapsedCards.delete(id) : collapsedCards.add(id);
      paintResults();
    });
    bindCopyButtons(card);
  };

  paintTargetSidebar();

  onAll(ctx.root, '[data-tmode]', (b) => {
    targetType = b.dataset.tmode as TargetType;
    paintTargetSidebar();
  });
  on(ctx.root, '#con-search', (el) => {
    targetSearch = (el as HTMLInputElement).value;
    paintTargetSidebar();
  }, 'input');
  onAll(ctx.root, '[data-pick]', (b) => {
    const mode = b.dataset.pick;
    if (mode === 'clear') selectedDevices.clear();
    else if (mode === 'online') {
      selectedDevices.clear();
      devices.filter((d) => d.status === 'online').forEach((d) => selectedDevices.add(d.id));
    } else if (mode) {
      devices.filter((d) => platformMeta(d.platform).key === mode).forEach((d) => selectedDevices.add(d.id));
    }
    paintTargetSidebar();
  });

  const cmdTextarea = ctx.root.querySelector('#con-cmd') as HTMLTextAreaElement;
  const runBtn = ctx.root.querySelector('#con-run') as HTMLButtonElement;
  const stopBtn = ctx.root.querySelector('#con-stop') as HTMLButtonElement;
  const form = ctx.root.querySelector('#con-form') as HTMLFormElement;

  onAll(ctx.root, '[data-con-preset]', (b) => {
    cmdTextarea.value = b.dataset.conPreset ?? '';
    cmdTextarea.focus();
  });

  cmdTextarea.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      form.requestSubmit();
    }
  });

  on(ctx.root, '#con-stop', () => {
    haltPoll();
    stopBtn.classList.add('hidden');
    paintResults();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const targetIds = Array.from(targetType === 'devices' ? selectedDevices : selectedGroups);
    if (!targetIds.length) {
      toast(`请至少选择一个${targetType === 'devices' ? '目标主机' : '目标分组'}`, 'warn');
      return;
    }
    const content = cmdTextarea.value.trim();
    if (!content) {
      toast('指令内容不能为空', 'warn');
      return;
    }

    const nameVal = val(ctx.root, '#con-name');
    const shellVal = val(ctx.root, '#con-shell');
    const timeoutVal = Math.max(5, Math.min(3600, Number(val(ctx.root, '#con-timeout')) || 60));

    haltPoll();
    runBtn.disabled = true;
    runBtn.textContent = '下发中…';

    try {
      const cmd = await api.createCommand({
        name: nameVal || `fleet: ${content.split('\n')[0].slice(0, 40)}`,
        type: 'immediate',
        content,
        target_type: targetType,
        target_ids: targetIds,
        timeout: timeoutVal,
        shell: shellVal === 'auto' ? undefined : shellVal,
      });
      if (ctx.isStale()) return;

      activeCmdId = cmd.id;
      activeCmdContent = content;
      results = [];
      collapsedCards.clear();
      polling = true;
      stopBtn.classList.remove('hidden');
      paintResults();

      stopPoll = startCommandPolling({
        cmdId: cmd.id,
        isStale: ctx.isStale,
        onUpdate(list, allDone) {
          results = list;
          if (allDone) {
            haltPoll();
            stopBtn.classList.add('hidden');
          }
          paintResults();
        },
      });
      toast('指令已批量下发', 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '指令下发失败', 'err');
    } finally {
      runBtn.disabled = false;
      runBtn.innerHTML = `${icons.play()} 下发执行`;
    }
  });
}
