import type {
  AuditLogDTO,
  CommandLogDTO,
  DeviceDTO,
  DeviceLogDTO,
} from '../../../shared/types';
import { api, ApiError } from '../api';
import { exitCodeBadge, logDownloadUrl, statusBadge } from '../components/badges';
import { btn, on, onAll, pageHeadHtml, preOutputHtml, selectHtml, tableHtml, tabsHtml } from '../components/ui';
import { icons } from '../icons';
import type { RouteContext } from '../router';
import { copyText, openModal, toast } from '../state';
import { esc, formatDate, stripAnsi } from '../utils';

type LogTab = 'command' | 'device' | 'audit';

export async function renderLogs(ctx: RouteContext): Promise<void> {
  let tab: LogTab = 'command';
  let page = 1;
  const perPage = 25;
  let deviceId = '';
  let commandId = '';
  let statusFilter = '';
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
      if (tab === 'command') {
        const res = await api.listCommandLogs({
          device_id: deviceId || undefined,
          command_id: commandId.trim() || undefined,
          status: statusFilter || undefined,
          page,
          per_page: perPage,
        });
        if (ctx.isStale()) return;
        cmdLogs = res.logs ?? [];
        total = res.total ?? cmdLogs.length;
      } else if (tab === 'device') {
        const res = await api.listDeviceLogs({ device_id: deviceId || undefined, page, per_page: perPage });
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

  const paint = () => {
    const dMap = devNameMap();
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const devOpts: Array<[string, string]> = [['', '全部主机'], ...devices.map((d): [string, string] => [d.id, d.name])];
    const stOpts: Array<[string, string]> = [['', '全部状态'], ['completed', '已完成'], ['failed', '失败'], ['timeout', '超时'], ['running', '运行中']];

    const bodyTable =
      tab === 'command'
        ? tableHtml(
            ['任务 / 指令', '目标主机', '状态', '退出码', '输出预览', '开始时间', ''],
            cmdLogs
              .map((l, idx) => {
                const dl = logDownloadUrl(l.result_id, l.log_url);
                return `<tr><td><strong>${esc(l.command_name || l.command_id || '—')}</strong><div class="mut t2xs mono">${esc(l.execution_id)}</div></td><td>${esc(l.device_name || dMap.get(l.device_id) || l.device_id)}</td><td>${statusBadge(l.status)}</td><td>${exitCodeBadge(l.exit_code, l.status)}</td><td class="mono txs truncate max-w-260">${esc(stripAnsi(l.output_preview || ''))}</td><td class="txs mut num">${esc(formatDate(l.started_at))}</td><td class="tr"><div class="re gxs">${btn(icons.eye(), `data-preview="${idx}" title="查看详情"`, 'bxs bg')}${dl ? `<a class="btn bxs bg" href="${esc(dl)}" download title="下载完整日志">${icons.download()}</a>` : ''}</div></td></tr>`;
              })
              .join(''),
            '暂无命令执行日志。',
          )
        : tab === 'device'
          ? tableHtml(
              ['时间', '主机', '事件类型', '详情'],
              devLogs
                .map(
                  (l) =>
                    `<tr><td class="txs mut mono num">${esc(formatDate(l.timestamp))}</td><td><strong>${esc(dMap.get(l.device_id) || l.device_id)}</strong></td><td><span class="tag">${esc(l.type)}</span></td><td class="tsm">${esc(l.message)}</td></tr>`,
                )
                .join(''),
              '暂无设备状态事件日志。',
            )
          : tableHtml(
              ['时间', '操作者', '动作', '目标对象', '来源 IP', '详情'],
              auditLogs
                .map(
                  (l) =>
                    `<tr><td class="txs mut mono num">${esc(formatDate(l.timestamp))}</td><td><strong>${esc(l.username || `uid:${l.user_id}`)}</strong></td><td><span class="tag">${esc(l.action)}</span></td><td class="mono txs">${esc(l.target_id || '—')}</td><td class="mono txs">${esc(l.ip || '—')}</td><td class="txs mut">${esc(l.detail || '—')}</td></tr>`,
                )
                .join(''),
              '暂无用户审计日志。',
            );

    ctx.root.innerHTML =
      pageHeadHtml(
        '日志与审计',
        '命令输出、设备事件与操作审计',
        btn(`${icons.refresh()} 刷新`, 'id="logs-refresh"'),
      ) +
      `<div class="card tb-c ssm"><div class="rb wrap gsm">${tabsHtml([['command', '命令日志'], ['device', '设备事件'], ['audit', '审计日志']], tab, 'data-ltab')}<span class="mut txs num">共 ${esc(total)} 条</span></div>` +
      (tab !== 'audit'
        ? `<div class="toolbar">${selectHtml('l-dev', devOpts, deviceId)}${
            tab === 'command'
              ? `<input id="l-cmd" class="input ism mono" type="text" placeholder="按 Command ID 筛选…" value="${esc(commandId)}">${selectHtml('l-status', stOpts, statusFilter)}`
              : ''
          }</div>`
        : '') +
      `</div><div class="card card-tbl mt-3">${bodyTable}<div class="pager">${btn('← 上一页', `id="pg-prev"${page <= 1 ? ' disabled' : ''}`, 'bxs bg')}<span class="mut txs num">第 ${page} / ${totalPages} 页</span>${btn('下一页 →', `id="pg-next"${page >= totalPages ? ' disabled' : ''}`, 'bxs bg')}</div></div>`;

    on(ctx.root, '#logs-refresh', () => void load());
    onAll(ctx.root, '[data-ltab]', (b) => {
      tab = b.dataset.ltab as LogTab;
      page = 1;
      void load();
    });
    on(ctx.root, '#l-dev', (el) => {
      deviceId = (el as HTMLSelectElement).value;
      page = 1;
      void load();
    }, 'change');
    on(ctx.root, '#l-status', (el) => {
      statusFilter = (el as HTMLSelectElement).value;
      page = 1;
      void load();
    }, 'change');
    on(ctx.root, '#l-cmd', (el) => {
      commandId = (el as HTMLInputElement).value;
      page = 1;
      void load();
    }, 'change');
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
      openModal({
        title: `日志预览 — ${log.command_name || log.execution_id}`,
        wide: true,
        bodyHtml: `<div class="ssm"><div class="row gsm wrap">${statusBadge(log.status)}${exitCodeBadge(log.exit_code, log.status)}<span class="mut txs num">${esc(formatDate(log.started_at))}</span></div>${preOutputHtml(log.output_preview || '', '(无预览文本)')}</div>`,
        footerHtml: `${btn(`${icons.copy()} 复制`, 'id="lp-copy"', 'bsm bg')}${dl ? `<a class="btn bsm ba" href="${esc(dl)}" download>${icons.download()} 下载完整日志</a>` : ''}${btn('关闭', 'data-close', 'bsm bp')}`,
        onMount(panel, close) {
          on(panel, '[data-close]', close);
          on(panel, '#lp-copy', () => void copyText(text, '已复制输出'));
        },
      });
    });
  };

  await load();
}
