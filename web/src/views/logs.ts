import {
  UserRole,
  type AuditLogDTO,
  type CommandLogDTO,
  type DeviceDTO,
  type DeviceLogDTO,
} from '../../../shared/types';
import { api, ApiError } from '../api';
import { commandSourceBadge, exitCodeBadge, logDownloadUrl, statusBadge } from '../components/badges';
import { bindChange, btn, fieldHtml, formModal, hInp, hMono, hMs, hMut, hRb, hRw, hStk, hTag, hTr, ipCopyHtml, on, onAll, pageHeadHtml, preOutputHtml, selectHtml, tableHtml, tabsHtml, val } from '../components/ui';
import { icons } from '../icons';
import type { RouteContext } from '../router';
import { copyText, openModal, state, syncActiveTimeZone, toast } from '../state';
import { clampPercent, esc, formatDate, formatMemory, formatRate, getMemoryPercent, stripAnsi } from '../utils';

type LogTab = 'terminal' | 'health' | 'scheduled' | 'device' | 'audit';
type HealthLogMode = 'heartbeat' | 'probe';

const LOGS_PP_KEY = 'cslite_logs_pp';
const ALLOWED_PP = new Set([10, 25, 50, 100]);

function loadSavedPerPage(): number {
  try {
    const n = Number(localStorage.getItem(LOGS_PP_KEY));
    if (ALLOWED_PP.has(n)) return n;
  } catch { /* ignore */ }
  return 25;
}

export async function renderLogs(ctx: RouteContext): Promise<void> {
  const isAdmin = Number(state.user?.role) === UserRole.ADMIN;
  const rawTab = ctx.query.get('tab');
  let tab: LogTab =
    rawTab === 'health' || rawTab === 'scheduled' || rawTab === 'device' || (rawTab === 'audit' && isAdmin)
      ? rawTab
      : 'terminal';
  let healthMode: HealthLogMode = ctx.query.get('mode') === 'probe' ? 'probe' : 'heartbeat';
  let page = 1;
  let perPage = loadSavedPerPage();
  let deviceId = ctx.query.get('device_id') ?? '';
  let commandId = ctx.query.get('command_id') ?? '';
  let statusFilter = '';
  let eventType = '';
  let devices: DeviceDTO[] = [];

  let cmdLogs: CommandLogDTO[] = [];
  let devLogs: DeviceLogDTO[] = [];
  let auditLogs: AuditLogDTO[] = [];
  let total = 0;

  try {
    devices = (await api.listDevices({ per_page: 200 })).devices ?? [];
    if (ctx.isStale()) return;
  } catch {
    devices = [];
  }

  const devNameMap = () => new Map(devices.map((d) => [d.id, d.name]));

  const load = async () => {
    try {
      if (tab === 'terminal' || tab === 'scheduled' || (tab === 'health' && healthMode === 'probe')) {
        const res = await api.listCommandLogs({
          type: tab === 'terminal' ? 'immediate' : tab === 'scheduled' ? 'cron,once' : undefined,
          source: tab === 'health' ? 'health' : undefined,
          device_id: deviceId || undefined,
          command_id: commandId.trim() || undefined,
          status: statusFilter || undefined,
          page,
          per_page: perPage,
        });
        if (ctx.isStale()) return;
        cmdLogs = res.logs ?? [];
        total = res.total ?? cmdLogs.length;
      } else if (tab === 'health') {
        const res = await api.listDeviceLogs({
          device_id: deviceId || undefined,
          type: 'heartbeat,health_online',
          page,
          per_page: perPage,
        });
        if (ctx.isStale()) return;
        devLogs = res.logs ?? [];
        total = res.total ?? devLogs.length;
      } else if (tab === 'device') {
        const res = await api.listDeviceLogs({
          device_id: deviceId || undefined,
          type: eventType || undefined,
          exclude_type: eventType ? undefined : 'heartbeat',
          page,
          per_page: perPage,
        });
        if (ctx.isStale()) return;
        devLogs = res.logs ?? [];
        total = res.total ?? devLogs.length;
      } else {
        const res = await api.listAuditLogs({ page, per_page: perPage });
        if (ctx.isStale()) return;
        auditLogs = res.logs ?? [];
        total = res.total ?? auditLogs.length;
      }
      paint();
    } catch (err) {
      if (!ctx.isStale()) toast(err instanceof ApiError ? err.message : '加载日志失败', 'err');
    }
  };

  const renderCommandTable = (dMap: Map<string, string>, curTab: 'terminal' | 'health' | 'scheduled'): string => {
    const firstLbl = curTab === 'scheduled' ? '定时任务 / 指令' : curTab === 'health' ? '健康探针 / 名称' : '指令 / 来源';
    const labels = [firstLbl, '目标主机', '状态', '退出码', '输出预览', '开始时间'];
    const rows = cmdLogs
      .map((l, idx) => {
        const typeBadge = commandSourceBadge(curTab === 'scheduled' ? l.command_type : l.command_type ?? 'immediate', l.command_name);
        const rawName = (l.command_name ?? '').trim();
        const rawContent = (l.command_content ?? '').trim();
        const hideTitle = !rawName || (Boolean(rawContent) && (rawName.startsWith('quick:') || rawName === rawContent));
        const titleText = hideTitle ? rawContent || l.command_id || l.execution_id : rawName;
        const subCmd = !hideTitle ? rawContent || l.execution_id : '';
        const outTxt = esc(stripAnsi(l.output_preview || ''));
        return hTr(
          [
            hStk(
              `${hRw(`${typeBadge}<strong class="tsm${hideTitle ? ' mono truncate max-w-260' : ''}" title="${esc(titleText)}">${esc(titleText)}</strong>`)}${
                subCmd ? `<div class="mut t2xs mono truncate max-w-260" title="${esc(subCmd)}">${esc(subCmd)}</div>` : ''
              }`,
              'sxs',
            ),
            [esc(l.device_name || dMap.get(l.device_id) || l.device_id), 'nw'],
            statusBadge(l.status),
            exitCodeBadge(l.exit_code, l.status),
            `<div class="mono txs truncate max-w-260" title="${outTxt}">${outTxt}</div>`,
            [esc(formatDate(l.started_at)), 'txs mut num nw'],
          ],
          labels,
          `class="log-row" data-preview="${idx}" title="点击查看完整日志预览"`,
        );
      })
      .join('');
    const emptyMsg =
      curTab === 'health'
        ? '暂无主动健康检测日志，可在主机详情页点击“健康检测”触发。'
        : curTab === 'terminal'
          ? '暂无终端与即时指令执行记录。'
          : '暂无定时任务执行日志。';
    return tableHtml(labels, rows, emptyMsg, 'tbl-r');
  };

  const formatTelemetrySummary = (l: DeviceLogDTO): string => {
    const m = (l.metadata?.metrics ?? null) as {
      cpu_usage?: number;
      memory_used?: number;
      memory_total?: number;
      memory_percent?: number;
      disk_usage?: number;
      network_in?: number;
      network_out?: number;
      load_avg?: string;
    } | null;
    if (!m || typeof m !== 'object') return esc(l.message);
    const parts: string[] = [];
    if (typeof m.cpu_usage === 'number') parts.push(`CPU ${clampPercent(m.cpu_usage).toFixed(1)}%`);
    if (m.memory_total || m.memory_percent !== undefined) {
      const pct = getMemoryPercent(m as never);
      parts.push(m.memory_total ? `内存 ${formatMemory(m.memory_used)}/${formatMemory(m.memory_total)} (${pct.toFixed(0)}%)` : `内存 ${pct.toFixed(1)}%`);
    }
    if (typeof m.disk_usage === 'number') parts.push(`磁盘 ${clampPercent(m.disk_usage).toFixed(0)}%`);
    if (m.load_avg) parts.push(`Load ${m.load_avg}`);
    if (typeof m.network_in === 'number' && typeof m.network_out === 'number') {
      parts.push(`网络 ↓${formatRate(m.network_in)} ↑${formatRate(m.network_out)}`);
    }
    return parts.length ? `<span class="mono txs num">${esc(parts.join(' · '))}</span>` : esc(l.message);
  };

  const renderHealthTelemetryTable = (dMap: Map<string, string>): string => {
    const hdrs = ['时间', '主机', '类型', '健康与资源摘要', '来源 IP'];
    const rows = devLogs
      .map((l, idx) => {
        const ip = typeof l.metadata?.ip_address === 'string' && l.metadata.ip_address ? l.metadata.ip_address : '—';
        const badge = l.type === 'health_online' ? hTag('恢复上线', 'tag-accent') : hTag('心跳上报', 'tag-ok');
        return hTr(
          [
            [esc(formatDate(l.timestamp)), 'txs mut mono num nw'],
            [`<strong>${esc(dMap.get(l.device_id) || l.device_id)}</strong>`, 'nw'],
            badge,
            formatTelemetrySummary(l),
            ip !== '—' ? ipCopyHtml(ip, 'txs') : hMs('—'),
          ],
          hdrs,
          `class="log-row" data-dev-preview="${idx}" title="点击查看明细"`,
        );
      })
      .join('');
    return tableHtml(hdrs, rows, '暂无周期性心跳健康上报记录（探针下次上报心跳后将自动记录）。', 'tbl-r');
  };

  const paint = () => {
    const dMap = devNameMap();
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const devOpts: Array<[string, string]> = [['', '全部主机'], ...devices.map((d): [string, string] => [d.id, d.name])];
    const stOpts: Array<[string, string]> = [['', '全部状态'], ['completed', '已完成'], ['failed', '失败'], ['timeout', '超时'], ['running', '运行中']];
    const evTypeOpts: Array<[string, string]> = [
      ['', '全部事件'],
      ['register', '探针注册'],
      ['command_result', '命令回执'],
      ['health_online', '探针恢复上线'],
      ['command_timeout', '命令超时'],
      ['heartbeat', '心跳上报'],
    ];

    const tabItems: Array<[LogTab, string]> = [
      ['terminal', '终端与即时指令'],
      ['health', '健康日志'],
      ['scheduled', '定时任务日志'],
      ['device', '设备事件'],
    ];
    if (isAdmin) tabItems.push(['audit', '审计日志']);

    const devHdrs = ['时间', '主机', '事件类型', '详情'];
    const audHdrs = ['时间', '操作者', '动作', '目标对象', '来源 IP', '详情'];
    const bodyTable =
      tab === 'terminal' || tab === 'scheduled' || (tab === 'health' && healthMode === 'probe')
        ? renderCommandTable(dMap, tab)
        : tab === 'health'
          ? renderHealthTelemetryTable(dMap)
          : tab === 'device'
          ? tableHtml(
              devHdrs,
              devLogs
                .map((l, idx) =>
                  hTr(
                    [
                      [esc(formatDate(l.timestamp)), 'txs mut mono num nw'],
                      [`<strong>${esc(dMap.get(l.device_id) || l.device_id)}</strong>`, 'nw'],
                      hTag(esc(l.type)),
                      [esc(l.message), 'tsm'],
                    ],
                    devHdrs,
                    `class="log-row" data-dev-preview="${idx}" title="点击查看详情"`,
                  ),
                )
                .join(''),
              '暂无设备状态事件日志。',
              'tbl-r',
            )
          : tableHtml(
              audHdrs,
              auditLogs
                .map((l, idx) =>
                  hTr(
                    [
                      [esc(formatDate(l.timestamp)), 'txs mut mono num nw'],
                      [`<strong>${esc(l.username || `uid:${l.user_id}`)}</strong>`, 'nw'],
                      hTag(esc(l.action)),
                      [esc(l.target_id || '—'), 'mono txs'],
                      [l.ip ? ipCopyHtml(l.ip, 'txs') : '—', 'nw'],
                      [esc(l.detail || '—'), 'txs mut'],
                    ],
                    audHdrs,
                    `class="log-row" data-aud-preview="${idx}" title="点击查看详情"`,
                  ),
                )
                .join(''),
              '暂无用户审计日志。',
              'tbl-r',
            );

    const filterHtml =
      tab === 'health'
        ? `<div class="toolbar">${tabsHtml([['heartbeat', '心跳健康上报'], ['probe', '主动健康检测']], healthMode, 'data-hmode', true)}${selectHtml('l-dev', devOpts, deviceId)}${
            healthMode === 'probe'
              ? `${hInp('l-cmd', 'text', `placeholder="按 Command ID 筛选…" value="${esc(commandId)}"`, 'input ism mono')}${selectHtml('l-status', stOpts, statusFilter)}`
              : ''
          }</div>`
        : tab === 'terminal' || tab === 'scheduled'
          ? `<div class="toolbar">${selectHtml('l-dev', devOpts, deviceId)}${hInp('l-cmd', 'text', `placeholder="按 Command ID 筛选…" value="${esc(commandId)}"`, 'input ism mono')}${selectHtml('l-status', stOpts, statusFilter)}</div>`
          : tab === 'device'
            ? `<div class="toolbar">${selectHtml('l-dev', devOpts, deviceId)}${selectHtml('l-evtype', evTypeOpts, eventType)}</div>`
            : '';

    const ppOpts: Array<[string, string]> = [['10', '10 条/页'], ['25', '25 条/页'], ['50', '50 条/页'], ['100', '100 条/页']];
    ctx.root.innerHTML =
      pageHeadHtml(
        '日志中心',
        '',
        `${isAdmin ? btn(`${icons.trash()} 清理日志`, 'id="logs-cleanup"', 'bsm bg ter') : ''}${btn(`${icons.refresh()} 刷新`, 'id="logs-refresh"')}`,
      ) +
      `<div class="card tb-c ssm">${hRb(`${tabsHtml(tabItems, tab, 'data-ltab')}${hMs(`共 ${esc(total)} 条`, 'txs num')}`)}${filterHtml}</div>` +
      `<div class="card card-tbl mt-3">${bodyTable}<div class="pager">${selectHtml('pg-size', ppOpts, String(perPage), 'input ixs')}${btn('← 上一页', `id="pg-prev"${page <= 1 ? ' disabled' : ''}`, 'bxs bg')}${hMs(`第 ${page} / ${totalPages} 页`, 'txs num')}${btn('下一页 →', `id="pg-next"${page >= totalPages ? ' disabled' : ''}`, 'bxs bg')}</div></div>`;

    on(ctx.root, '#logs-refresh', () => void load());
    on(ctx.root, '#logs-cleanup', async () => {
      if (!state.systemInfo) {
        try {
          state.systemInfo = await api.getSystemInfo();
          syncActiveTimeZone();
        } catch { /* ignore */ }
      }
      const curRet = Math.max(1, Number(state.systemInfo?.log_retention_days) || 30);
      formModal({
        title: '清理历史日志',
        formId: 'logs-clean-form',
        submitLabel: '确认清理',
        fieldsHtml:
          `<div class="alert alert-warn">清理指定天数以前的已完结指令记录、设备事件、审计日志与过期会话（保留 Cron 定时任务定义）。</div>` +
          fieldHtml('clean-days', '保留最近天数 (1–3650)', hInp('clean-days', 'number', `min="1" max="3650" step="1" required value="${curRet}"`, 'input mono num')) +
          `<div class="row gxs wrap">${[1, 7, 14, 30, 90].map((n) => `<button type="button" class="chip t2xs" data-clean-pre="${n}">保留 ${n} 天</button>`).join('')}</div>`,
        onMount(panel) {
          onAll(panel, '[data-clean-pre]', (chip) => {
            const inp = panel.querySelector<HTMLInputElement>('#clean-days');
            if (inp) inp.value = chip.dataset.cleanPre ?? String(curRet);
          });
        },
        async onSubmit(panel, close) {
          const daysRaw = val(panel, '#clean-days');
          if (!/^\d+$/.test(daysRaw) || Number(daysRaw) < 1 || Number(daysRaw) > 3650) {
            toast('请输入 1–3650 之间的保留天数', 'warn');
            return;
          }
          const res = await api.runSystemCleanup({ retention_days: Number(daysRaw) });
          const delCnt = Object.values(res.deleted ?? {}).reduce((a, n) => a + (Number(n) || 0), 0);
          close();
          toast(`已清理超过 ${res.retention_days} 天的 ${delCnt} 条日志`, 'ok');
          await load();
        },
      });
    });
    onAll(ctx.root, '[data-hmode]', (b) => {
      healthMode = b.dataset.hmode === 'probe' ? 'probe' : 'heartbeat';
      page = 1;
      void load();
    });
    onAll(ctx.root, '[data-ltab]', (b) => {
      const nextTab = b.dataset.ltab as LogTab;
      if (nextTab === 'audit' && !isAdmin) return;
      tab = nextTab;
      page = 1;
      void load();
    });
    bindChange(ctx.root, [
      ['#l-dev', (v) => { deviceId = v; page = 1; void load(); }],
      ['#l-status', (v) => { statusFilter = v; page = 1; void load(); }],
      ['#l-evtype', (v) => { eventType = v; page = 1; void load(); }],
      ['#l-cmd', (v) => { commandId = v; page = 1; void load(); }],
      ['#pg-size', (v) => {
        const n = Number(v);
        if (!ALLOWED_PP.has(n)) return;
        perPage = n;
        page = 1;
        try { localStorage.setItem(LOGS_PP_KEY, String(n)); } catch { /* ignore */ }
        void load();
      }],
    ]);
    on(ctx.root, '#pg-prev', () => {
      if (page > 1) {
        page--;
        void load();
      }
    });
    on(ctx.root, '#pg-next', () => {
      if (page < totalPages) {
        page++;
        void load();
      }
    });
    onAll(ctx.root, '[data-preview]', (b) => {
      const log = cmdLogs[Number(b.dataset.preview)];
      if (!log) return;
      const dl = logDownloadUrl(log.result_id, log.log_url);
      const text = stripAnsi(log.output_preview || '');
      const cmdBlock = log.command_content
        ? `<div>${hMut('执行指令', 't2xs mb-1')}<pre class="code-pre"><code>${esc(log.command_content)}</code></pre></div>`
        : '';
      openModal({
        title: `日志预览 — ${log.command_name || log.execution_id}`,
        wide: true,
        bodyHtml: hStk(
          `${hRw(`${commandSourceBadge(log.command_type, log.command_name)}${statusBadge(log.status)}${exitCodeBadge(log.exit_code, log.status)}${hMs(esc(formatDate(log.started_at)), 'txs num')}`, 'gsm')}${cmdBlock}<div>${hMut('输出预览', 't2xs mb-1')}${preOutputHtml(log.output_preview || '', '(无预览文本)')}</div>`,
          'ssm',
        ),
        footerHtml: `${btn(`${icons.copy()} 复制输出`, 'id="lp-copy"', 'bsm bg')}${dl ? `<a class="btn bsm ba" href="${esc(dl)}" download>${icons.download()} 下载完整日志</a>` : ''}${btn('关闭', 'data-close', 'bsm bp')}`,
        onMount(panel, close) {
          on(panel, '[data-close]', close);
          on(panel, '#lp-copy', () => void copyText(text, '已复制输出'));
        },
      });
    });
    onAll(ctx.root, '[data-dev-preview]', (rowEl, ev) => {
      if ((ev.target as HTMLElement | null)?.closest('button,a')) return;
      const log = devLogs[Number(rowEl.dataset.devPreview)];
      if (!log) return;
      const dName = dMap.get(log.device_id) || log.device_id;
      const metaStr = log.metadata ? JSON.stringify(log.metadata, null, 2) : '';
      const rawTxt = `${log.message}${metaStr ? `\n\n${metaStr}` : ''}`;
      openModal({
        title: `设备健康 / 事件预览 — ${dName}`,
        wide: true,
        bodyHtml: hStk(
          `${hRw(`${hTag(esc(log.type), 'tag-accent')}${hMs(esc(formatDate(log.timestamp)), 'txs mono num')}`, 'gsm')}<div>${hMut('摘要 / 消息', 't2xs mb-1')}<pre class="code-pre"><code>${esc(log.message)}</code></pre></div>${metaStr ? `<div>${hMut('结构化元数据', 't2xs mb-1')}<pre class="code-pre"><code>${esc(metaStr)}</code></pre></div>` : ''}`,
          'ssm',
        ),
        footerHtml: `${btn(`${icons.copy()} 复制详情`, 'id="dp-copy"', 'bsm bg')}${btn('关闭', 'data-close', 'bsm bp')}`,
        onMount(panel, close) {
          on(panel, '[data-close]', close);
          on(panel, '#dp-copy', () => void copyText(rawTxt, '已复制详情'));
        },
      });
    });
    onAll(ctx.root, '[data-aud-preview]', (rowEl, ev) => {
      if ((ev.target as HTMLElement | null)?.closest('button,a')) return;
      const log = auditLogs[Number(rowEl.dataset.audPreview)];
      if (!log) return;
      const rawTxt = `${log.action} (${log.target_id || '—'})\n${log.detail || ''}`;
      openModal({
        title: `审计详情 — ${log.action}`,
        bodyHtml: hStk(
          `${hRw(`${hTag(esc(log.action))}${hMono(esc(log.username || `uid:${log.user_id}`), 'txs')}${hMs(esc(formatDate(log.timestamp)), 'txs num')}`, 'gsm')}<div>${hMut('目标 / 详情', 't2xs mb-1')}<pre class="code-pre"><code>${esc(rawTxt)}</code></pre></div>`,
          'ssm',
        ),
        footerHtml: `${btn(`${icons.copy()} 复制`, 'id="ap-copy"', 'bsm bg')}${btn('关闭', 'data-close', 'bsm bp')}`,
        onMount(panel, close) {
          on(panel, '[data-close]', close);
          on(panel, '#ap-copy', () => void copyText(rawTxt, '已复制详情'));
        },
      });
    });
  };

  await load();
}
