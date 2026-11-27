import type {
  CommandAction,
  CommandDTO,
  CommandType,
  DeviceDTO,
  GroupDTO,
  TargetType,
} from '../../../shared/types';
import { api, ApiError } from '../api';
import { commandSourceBadge, statusBadge } from '../components/badges';
import {
  bindChange,
  bindCopyButtons,
  bindSearchInput,
  btn,
  fieldHtml,
  formModal,
  hostCardHtml,
  hInp,
  hMs,
  hMut,
  hRb,
  hRow,
  hRw,
  hStk,
  hThTr,
  hTr,
  infoGridHtml,
  on,
  onAll,
  pageHeadHtml,
  selectHtml,
  shellSelectHtml,
  tableHtml,
  tabsHtml,
  targetItemHtml,
  val,
} from '../components/ui';
import { icons } from '../icons';
import type { RouteContext } from '../router';
import { openModal, state, toast } from '../state';
import { cronLabel, esc, formatDate, formatElapsed, formatRelativeZh } from '../utils';

const CRON_PRESETS = [
  ['每 5 分钟', '*/5 * * * *'],
  ['每 15 分钟', '*/15 * * * *'],
  ['每小时', '0 * * * *'],
  ['每日 03:00', '0 3 * * *'],
  ['每周日 02:00', '0 2 * * 0'],
];

export async function renderCommands(ctx: RouteContext): Promise<void> {
  let commands: CommandDTO[] = [];
  let devices: DeviceDTO[] = [];
  let groups: GroupDTO[] = [];
  let statusFilter = '';
  let typeFilter = '';
  let search = '';

  const load = async () => {
    try {
      const [cmdRes, fleet] = await Promise.all([
        api.listCommands({ status: statusFilter || undefined, type: typeFilter || 'cron,once', per_page: 100 }),
        api.fetchFleet().catch(() => ({ devices: [] as DeviceDTO[], groups: [] as GroupDTO[] })),
      ]);
      if (ctx.isStale()) return;
      commands = cmdRes.commands ?? [];
      devices = fleet.devices;
      groups = fleet.groups;
      paint();
    } catch (err) {
      if (!ctx.isStale()) toast(err instanceof ApiError ? err.message : '加载任务列表失败', 'err');
    }
  };

  const paint = () => {
    const q = search.trim().toLowerCase();
    const filtered = commands.filter((c) => {
      if (c.type !== 'cron' && c.type !== 'once') return false;
      if (statusFilter && c.status !== statusFilter) return false;
      if (typeFilter && c.type !== typeFilter) return false;
      if (q && !`${c.name} ${c.id} ${c.content ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });

    const cmdLabels = ['任务', '类型', '调度', '状态', '下次执行', '创建时间', ''];
    const rowsHtml = filtered
      .map((c) => {
        const canPause = c.status === 'pending' || c.status === 'running';
        const canResume = c.status === 'paused';
        const canCancel = canPause || canResume;
        const schedHtml =
          c.type === 'cron'
            ? hStk(`<div>${esc(cronLabel(c.schedule))}</div>${hMut(esc(c.schedule), 'mono t2xs')}`, 'sxs')
            : `<span class="mono mut">${esc(c.schedule ? formatDate(c.schedule) : '立即一次性')}</span>`;

        return hTr(
          [
            hStk(`<strong>${esc(c.name)}</strong>${hMut(esc(c.id), 't2xs mono')}`, 'sxs'),
            commandSourceBadge(c.type, c.name),
            [schedHtml, 'txs'],
            statusBadge(c.status),
            [c.next_run ? esc(formatRelativeZh(c.next_run)) : '—', 'txs mut'],
            [esc(formatRelativeZh(c.created_at)), 'txs mut'],
            [
              `<div class="re gxs">${
                canPause ? btn(icons.pause(), `data-act="pause" data-cid="${esc(c.id)}" title="暂停"`, 'bxs bg') : ''
              }${canResume ? btn(icons.play(), `data-act="resume" data-cid="${esc(c.id)}" title="恢复"`, 'bxs bg tok') : ''}${
                canCancel ? btn(icons.stop(), `data-act="cancel" data-cid="${esc(c.id)}" title="取消"`, 'bxs bg ter') : ''
              }${btn(`${icons.eye()} 详情`, `data-inspect="${esc(c.id)}"`, 'bxs ba')}</div>`,
              'tr',
            ],
          ],
          cmdLabels,
        );
      })
      .join('');

    const typeOpts: Array<[string, string]> = [['', '全部定时任务'], ['cron', 'Cron 周期'], ['once', '一次性预约']];
    const statusOpts: Array<[string, string]> = [['', '全部状态'], ['pending', '等待中'], ['running', '运行中'], ['completed', '已完成'], ['failed', '失败'], ['paused', '已暂停'], ['cancelled', '已取消']];

    ctx.root.innerHTML =
      pageHeadHtml(
        '定时任务',
        'Cron 周期与一次性预约调度',
        btn(`${icons.refresh()} 刷新`, 'id="cmd-refresh"') + btn(`${icons.plus()} 新建定时任务`, 'id="cmd-new"', 'bsm bp'),
      ) +
      `<div class="card tb-c"><div class="toolbar"><div class="search-wrap">${icons.search()}${hInp('c-search', 'search', `placeholder="搜索定时任务…" value="${esc(search)}"`, 'input input-pill ism')}</div>${selectHtml('c-type', typeOpts, typeFilter)}${selectHtml('c-status', statusOpts, statusFilter)}</div></div>` +
      `<div class="card card-tbl mt-3">${tableHtml(
        ['任务', '类型', '调度', '状态', '下次执行', '创建时间', hThTr()],
        rowsHtml,
        '暂无匹配的定时任务。',
        'tbl-r',
      )}</div>`;

    on(ctx.root, '#cmd-refresh', () => void load());
    on(ctx.root, '#cmd-new', openCreateModal);

    bindSearchInput(ctx.root, '#c-search', () => search, (v) => {
      search = v;
      paint();
    });

    bindChange(ctx.root, [
      ['#c-type', (v) => { typeFilter = v; void load(); }],
      ['#c-status', (v) => { statusFilter = v; void load(); }],
    ]);

    onAll(ctx.root, '[data-act]', async (el) => {
      const id = el.dataset.cid;
      const action = el.dataset.act as CommandAction | undefined;
      if (!id || !action) return;
      try {
        await api.updateCommandStatus(id, action);
        toast(`已执行操作: ${action}`, 'ok');
        await load();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : `操作失败 (${action})`, 'err');
      }
    });

    onAll(ctx.root, '[data-inspect]', (el) => {
      const id = el.dataset.inspect;
      if (id) void openInspectModal(id);
    });
  };

  const openCreateModal = () => {
    let type: CommandType = 'cron';
    let targetType: TargetType = 'devices';
    const pickedTargets = new Set<string>();

    formModal({
      title: '新建定时任务',
      formId: 'ct-form',
      submitLabel: '创建定时任务',
      wide: true,
      fieldsHtml:
        `<div class="grid-2">${fieldHtml('ct-name', '任务名称', hInp('ct-name', 'text', 'required maxlength="100" placeholder="夜间磁盘巡检"'))}${fieldHtml('ct-type', '调度类型', selectHtml('ct-type', [['cron', 'Cron 周期'], ['once', '一次性预约']], 'cron', 'input'))}</div>` +
        `<div id="ct-cron-box" class="card card-inset sxs">${hRb(`<label class="label-sm" for="ct-schedule">Cron (5 段 · ${esc(state.systemInfo?.timezone || 'UTC')})</label><span class="bdg bd-m" id="ct-cron-preview">${esc(cronLabel('*/5 * * * *'))}</span>`)}${hInp('ct-schedule', 'text', 'value="*/5 * * * *"', 'input mono')}${hRw(CRON_PRESETS.map(([l, e]) => `<button type="button" class="chip" data-cpre="${esc(e)}">${esc(l)}</button>`).join(''))}</div>` +
        `<div id="ct-once-box" class="hidden">${fieldHtml('ct-once-at', '执行时间 (ISO UTC)', hInp('ct-once-at', 'text', 'placeholder="2026-12-01T03:00:00Z"', 'input mono'))}</div>` +
        `<div class="grid-2">${fieldHtml('ct-shell', 'Shell', shellSelectHtml('ct-shell', 'auto', 'input'))}${fieldHtml('ct-timeout', '超时(s)', hInp('ct-timeout', 'number', 'min="5" max="7200" value="300"', 'input mono'))}</div>` +
        fieldHtml('ct-content', '执行脚本', '<textarea id="ct-content" class="input mono t-ta" rows="4" required placeholder="uptime && df -h"></textarea>') +
        fieldHtml('ct-env', '环境变量 (KEY=VALUE)', '<textarea id="ct-env" class="input mono" rows="2" placeholder="LANG=C.UTF-8"></textarea>') +
        `<div class="field"><div class="rb mb-1"><label>目标范围</label>${tabsHtml([['devices', '按主机'], ['groups', '按分组']], targetType, 'data-ct-scope', true)}</div><div id="ct-targets" class="target-list max-h-180"></div></div>`,
      onMount(panel) {
        const cronBox = panel.querySelector('#ct-cron-box') as HTMLElement;
        const onceBox = panel.querySelector('#ct-once-box') as HTMLElement;
        const schedEl = panel.querySelector('#ct-schedule') as HTMLInputElement;
        const previewEl = panel.querySelector('#ct-cron-preview') as HTMLElement;
        const targetsEl = panel.querySelector('#ct-targets') as HTMLElement;

        const paintTargets = () => {
          const items =
            targetType === 'devices'
              ? devices.map((d) => ({ id: d.id, label: d.name, sub: d.ip_address || d.platform }))
              : groups.map((g) => ({ id: g.id, label: g.name, sub: `${g.device_count} 台` }));

          targetsEl.innerHTML = !items.length
            ? `<div class="mut txs p-2">暂无可用${targetType === 'devices' ? '主机' : '分组'}</div>`
            : items
                .map((it) =>
                  targetItemHtml(
                    it.id,
                    'ct-tchk',
                    pickedTargets.has(it.id),
                    `<div class="rb flex-1"><strong>${esc(it.label)}</strong><span class="mut txs mono">${esc(it.sub)}</span></div>`,
                  ),
                )
                .join('');

          onAll(targetsEl, '.ct-tchk', (el) => {
            const chk = el as HTMLInputElement;
            const id = chk.dataset.id;
            if (!id) return;
            chk.checked ? pickedTargets.add(id) : pickedTargets.delete(id);
            chk.closest('.target-item')?.classList.toggle('selected', chk.checked);
          }, 'change');
        };

        paintTargets();

        on(panel, '#ct-type', (el) => {
          type = (el as HTMLSelectElement).value as CommandType;
          cronBox.classList.toggle('hidden', type !== 'cron');
          onceBox.classList.toggle('hidden', type !== 'once');
        }, 'change');
        on(panel, '#ct-schedule', () => {
          previewEl.textContent = cronLabel(schedEl.value);
        }, 'input');
        onAll(panel, '[data-cpre]', (b) => {
          schedEl.value = b.dataset.cpre ?? '';
          previewEl.textContent = cronLabel(schedEl.value);
        });
        onAll(panel, '[data-ct-scope]', (b) => {
          targetType = b.dataset.ctScope as TargetType;
          pickedTargets.clear();
          panel.querySelectorAll('[data-ct-scope]').forEach((x) => x.classList.toggle('active', x === b));
          paintTargets();
        });
      },
      async onSubmit(panel, close) {
        const targetIds = Array.from(pickedTargets);
        if (!targetIds.length) {
          toast(`请至少选择一个${targetType === 'devices' ? '主机' : '分组'}`, 'warn');
          return;
        }
        const shellVal = val(panel, '#ct-shell');
        const timeout = Math.max(5, Math.min(7200, Number(val(panel, '#ct-timeout')) || 300));
        const env_vars: Record<string, string> = {};
        for (const line of val(panel, '#ct-env').split('\n')) {
          const idx = line.indexOf('=');
          if (idx > 0) env_vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        await api.createCommand({
          name: val(panel, '#ct-name'),
          type,
          schedule: type === 'cron' ? val(panel, '#ct-schedule') : type === 'once' ? val(panel, '#ct-once-at') || undefined : undefined,
          content: val(panel, '#ct-content'),
          target_type: targetType,
          target_ids: targetIds,
          timeout,
          shell: shellVal === 'auto' ? undefined : shellVal,
          env_vars: Object.keys(env_vars).length ? env_vars : undefined,
        });
        close();
        toast('任务已创建', 'ok');
        await load();
      },
    });
  };

  const openInspectModal = async (id: string) => {
    openModal({
      title: `任务执行详情 — ${id}`,
      wide: true,
      bodyHtml: '<div class="ld-b"><span class="spinner"></span> 加载中…</div>',
      footerHtml: btn('关闭', 'data-close', 'bg'),
      async onMount(panel, close) {
        on(panel, '[data-close]', close);
        const body = panel.querySelector('.m-bd') as HTMLElement;
        try {
          const [detail, res] = await Promise.all([
            api.getCommand(id),
            api.getCommandResults(id, { per_page: 20 }).catch(() => ({ executions: [] })),
          ]);
          const execs = res.executions?.length ? res.executions : detail.execution_history ?? [];
          const execHtml = !execs.length
            ? '<div class="mut txs">暂无执行记录。</div>'
            : hStk(
                execs
                  .map((ex) => {
                    const drHtml = ex.device_results?.length
                      ? hStk(ex.device_results.map((dr) => hostCardHtml(dr)).join(''), 'sxs mt-1')
                      : '';
                    return `<div class="card card-inset sxs">${hRb(`${hRow(`<span class="mono txs">${esc(ex.id)}</span>${statusBadge(ex.status)}`)}<span class="mut txs num">${esc(formatDate(ex.started_at))} · ${esc(formatElapsed(ex.started_at, ex.completed_at))}</span>`, 'wrap gxs')}${drHtml}</div>`;
                  })
                  .join(''),
                'ssm',
              );

          body.innerHTML =
            hStk(
              infoGridHtml([
                ['任务名称', `<strong>${esc(detail.name)}</strong>`],
                ['类型 / 状态', hRow(`${commandSourceBadge(detail.type, detail.name)} ${statusBadge(detail.status)}`)],
                ['调度计划', `<span class="mono txs">${detail.type === 'cron' ? esc(cronLabel(detail.schedule)) : esc(detail.schedule ? formatDate(detail.schedule) : '立即一次性')}</span>`],
                ['超时 / Shell', `<span class="mono txs">${esc(detail.timeout)}s · ${esc(detail.shell || 'auto')}</span>`],
              ]) +
                `<div><div class="mut txs mb-1">命令脚本</div><pre class="code-pre"><code>${esc(detail.content)}</code></pre></div><div><div class="mut txs mb-1">执行历史 (${execs.length})</div>${execHtml}</div>`,
              'smd',
            );
          bindCopyButtons(body);
        } catch (err) {
          body.innerHTML = `<div class="alert alert-err">${esc(
            err instanceof ApiError ? err.message : '加载任务详情失败',
          )}</div>`;
        }
      },
    });
  };

  await load();
  if (ctx.isStale()) return;
  const inspectId = ctx.query.get('inspect');
  if (inspectId) void openInspectModal(inspectId);
}
