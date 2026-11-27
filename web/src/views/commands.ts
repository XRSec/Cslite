import type {
  CommandAction,
  CommandDTO,
  CommandType,
  DeviceDTO,
  GroupDTO,
  TargetType,
} from '../../../shared/types';
import { api, ApiError } from '../api';
import { statusBadge } from '../components/badges';
import {
  bindCopyButtons,
  bindSearchInput,
  btn,
  fieldHtml,
  formModal,
  hostCardHtml,
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
import { openModal, toast } from '../state';
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
        api.listCommands({ status: statusFilter || undefined, type: typeFilter || undefined, per_page: 100 }),
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
      if (statusFilter && c.status !== statusFilter) return false;
      if (typeFilter && c.type !== typeFilter) return false;
      if (q && !`${c.name} ${c.id} ${c.content ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });

    const rowsHtml = filtered
      .map((c) => {
        const canPause = c.status === 'pending' || c.status === 'running';
        const canResume = c.status === 'paused';
        const canCancel = canPause || canResume;
        const schedHtml =
          c.type === 'cron'
            ? `<div>${esc(cronLabel(c.schedule))}</div><div class="mono mut t2xs">${esc(c.schedule)}</div>`
            : `<span class="mono mut">${esc(c.schedule || '—')}</span>`;

        return `<tr><td><strong>${esc(c.name)}</strong><div class="mut t2xs mono">${esc(c.id)}</div></td><td><span class="tag">${esc(c.type)}</span></td><td class="txs">${schedHtml}</td><td>${statusBadge(c.status)}</td><td class="txs mut">${c.next_run ? esc(formatRelativeZh(c.next_run)) : '—'}</td><td class="txs mut" title="${esc(c.created_at)}">${esc(formatRelativeZh(c.created_at))}</td><td class="tr"><div class="re gxs">${btn(`${icons.eye()} 详情`, `data-inspect="${esc(c.id)}"`, 'bxs ba')}${
          canPause ? btn(icons.pause(), `data-act="pause" data-cid="${esc(c.id)}" title="暂停"`, 'bxs bg') : ''
        }${canResume ? btn(icons.play(), `data-act="resume" data-cid="${esc(c.id)}" title="恢复"`, 'bxs bg tok') : ''}${
          canCancel ? btn(icons.stop(), `data-act="cancel" data-cid="${esc(c.id)}" title="取消"`, 'bxs bg ter') : ''
        }</div></td></tr>`;
      })
      .join('');

    const typeOpts: Array<[string, string]> = [['', '全部类型'], ['immediate', '立即执行'], ['once', '定时一次'], ['cron', 'Cron 周期']];
    const statusOpts: Array<[string, string]> = [['', '全部状态'], ['pending', '等待中'], ['running', '运行中'], ['completed', '已完成'], ['failed', '失败'], ['paused', '已暂停'], ['cancelled', '已取消']];

    ctx.root.innerHTML =
      pageHeadHtml(
        '定时任务',
        '立即、一次性预约与 Cron 周期任务',
        btn(`${icons.refresh()} 刷新`, 'id="cmd-refresh"') + btn(`${icons.plus()} 新建任务`, 'id="cmd-new"', 'bsm bp'),
      ) +
      `<div class="card tb-c"><div class="toolbar"><div class="search-wrap">${icons.search()}<input id="c-search" class="input input-pill ism" type="search" placeholder="搜索任务…" value="${esc(search)}"></div>${selectHtml('c-type', typeOpts, typeFilter)}${selectHtml('c-status', statusOpts, statusFilter)}</div></div>` +
      `<div class="card card-tbl mt-3">${tableHtml(
        ['任务', '类型', '调度', '状态', '下次执行', '创建时间', '<span class="tr" style="display:block">操作</span>'],
        rowsHtml,
        '暂无匹配任务。',
      )}</div>`;

    on(ctx.root, '#cmd-refresh', () => void load());
    on(ctx.root, '#cmd-new', openCreateModal);

    bindSearchInput(ctx.root, '#c-search', () => search, (v) => {
      search = v;
      paint();
    });

    on(ctx.root, '#c-type', (el) => {
      typeFilter = (el as HTMLSelectElement).value;
      void load();
    }, 'change');
    on(ctx.root, '#c-status', (el) => {
      statusFilter = (el as HTMLSelectElement).value;
      void load();
    }, 'change');

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
      title: '新建任务',
      formId: 'ct-form',
      submitLabel: '创建',
      wide: true,
      fieldsHtml:
        `<div class="grid-2">${fieldHtml('ct-name', '任务名称', '<input id="ct-name" class="input" type="text" required maxlength="100" placeholder="夜间磁盘巡检">')}${fieldHtml('ct-type', '类型', '<select id="ct-type" class="input"><option value="cron" selected>Cron 周期</option><option value="once">定时一次</option><option value="immediate">立即执行</option></select>')}</div>` +
        `<div id="ct-cron-box" class="card card-inset sxs"><div class="rb wrap gsm"><label class="label-sm" for="ct-schedule">Cron (5 段 UTC)</label><span class="bdg bd-m" id="ct-cron-preview">${esc(cronLabel('*/5 * * * *'))}</span></div><input id="ct-schedule" class="input mono" type="text" value="*/5 * * * *"><div class="row gxs wrap">${CRON_PRESETS.map(([l, e]) => `<button type="button" class="chip" data-cpre="${esc(e)}">${esc(l)}</button>`).join('')}</div></div>` +
        `<div id="ct-once-box" class="hidden">${fieldHtml('ct-once-at', '执行时间 (ISO UTC)', '<input id="ct-once-at" class="input mono" type="text" placeholder="2026-12-01T03:00:00Z">')}</div>` +
        `<div class="grid-2">${fieldHtml('ct-shell', 'Shell', shellSelectHtml('ct-shell', 'auto', 'input'))}${fieldHtml('ct-timeout', '超时(s)', '<input id="ct-timeout" class="input mono" type="number" min="5" max="7200" value="300">')}</div>` +
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
            : `<div class="ssm">${execs
                .map((ex) => {
                  const drHtml = ex.device_results?.length
                    ? `<div class="sxs mt-1">${ex.device_results.map((dr) => hostCardHtml(dr)).join('')}</div>`
                    : '';
                  return `<div class="card card-inset sxs"><div class="rb wrap gxs"><div class="row gxs"><span class="mono txs">${esc(ex.id)}</span>${statusBadge(ex.status)}</div><span class="mut txs num">${esc(formatDate(ex.started_at))} · ${esc(formatElapsed(ex.started_at, ex.completed_at))}</span></div>${drHtml}</div>`;
                })
                .join('')}</div>`;

          body.innerHTML =
            `<div class="smd">${infoGridHtml([
              ['任务名称', `<strong>${esc(detail.name)}</strong>`],
              ['类型 / 状态', `<div class="row gxs">${esc(detail.type)} ${statusBadge(detail.status)}</div>`],
              ['调度计划', `<span class="mono txs">${detail.type === 'cron' ? esc(cronLabel(detail.schedule)) : esc(detail.schedule || '—')}</span>`],
              ['超时 / Shell', `<span class="mono txs">${esc(detail.timeout)}s · ${esc(detail.shell || 'auto')}</span>`],
            ])}<div><div class="mut txs mb-1">命令脚本</div><pre class="code-pre"><code>${esc(detail.content)}</code></pre></div><div><div class="mut txs mb-1">执行历史 (${execs.length})</div>${execHtml}</div></div>`;
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
