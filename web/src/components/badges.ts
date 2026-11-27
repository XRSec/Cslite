import type { HealthBucketStatus, HealthHistoryBucketDTO } from '../../../shared/types';
import { icons } from '../icons';
import { clampPercent, esc, platformMeta } from '../utils';

const STATUS_LABELS: Record<string, string> = {
  online: '在线',
  offline: '当前已离线',
  busy: '执行中',
  completed: '已完成',
  ok: '正常',
  running: '运行中',
  queued: '排队中',
  pending: '等待中',
  failed: '失败',
  timeout: '超时',
  paused: '已暂停',
  cancelled: '已取消',
};

export function statusBadge(status: string, extraText?: string): string {
  const s = (status || 'unknown').toLowerCase();
  let cls = 'bd-m';
  let pulse = false;
  if (s === 'online' || s === 'completed' || s === 'ok') {
    cls = 'bd-ok';
    pulse = s === 'online';
  } else if (s === 'busy' || s === 'running' || s === 'queued' || s === 'pending') {
    cls = 'bd-wn';
    pulse = s === 'running' || s === 'busy';
  } else if (s === 'offline' || s === 'failed' || s === 'timeout') {
    cls = 'bd-er';
  } else if (s === 'paused' || s === 'cancelled') {
    cls = 'bd-m';
  }
  const lbl = STATUS_LABELS[s] ?? s;
  const suffix = extraText ? ` · ${esc(extraText)}` : '';
  return `<span class="bdg ${cls}"><span class="dot ${pulse ? 'dot-pulse' : ''}"></span>${esc(lbl)}${suffix}</span>`;
}

export function osBadge(platform?: string | null, size: 'sm' | 'md' = 'md'): string {
  const meta = platformMeta(platform);
  return `<span class="os-badge os-${meta.key}${size === 'sm' ? ' os-sm' : ''}" title="${esc(meta.label)}">${icons.platform(meta.key)}</span>`;
}

export function platformBadge(platform?: string | null, arch?: string | null): string {
  const meta = platformMeta(platform);
  const archHtml = arch ? ` <span class="arch-tag">${esc(arch)}</span>` : '';
  return `<span class="plat-pill plat-${meta.key}">${osBadge(platform, 'sm')}<span>${esc(meta.label)}</span>${archHtml}</span>`;
}

export function metricBar(pct: number, customTone?: 'accent' | 'cyan' | 'ok' | 'warn' | 'err'): string {
  const val = clampPercent(pct);
  const tone = customTone ?? (val >= 90 ? 'err' : val >= 75 ? 'warn' : 'accent');
  return `<div class="mbar"><div class="mbar-fill mbar-${tone}" style="width:${val.toFixed(1)}%"></div></div>`;
}

export function logDownloadUrl(resultId?: string | null, logUrl?: string | null): string | null {
  if (resultId) {
    return `/api/logs/download/${encodeURIComponent(resultId)}`;
  }
  if (logUrl && (logUrl.startsWith('/api/') || logUrl.startsWith('http://') || logUrl.startsWith('https://'))) {
    return logUrl;
  }
  return null;
}

export function exitCodeBadge(code: number | undefined | null, status?: string): string {
  if (status === 'queued' || status === 'running' || code === undefined || code === null) {
    return '<span class="bdg bd-m">exit --</span>';
  }
  const cls = code === 0 ? 'bd-ok' : 'bd-er';
  return `<span class="bdg ${cls}">exit ${esc(code)}</span>`;
}

/** Map command type and name prefix into a concise Chinese source label and tone class. */
export function commandSourceMeta(
  type?: string | null,
  name?: string | null,
): { label: string; cls: string } {
  if (type === 'cron') return { label: 'Cron 周期', cls: 'tag-accent' };
  if (type === 'once') return { label: '一次性预约', cls: 'tag-warn' };
  const n = (name ?? '').trim();
  if (n.startsWith('quick:')) return { label: '在线终端', cls: 'tag-accent' };
  if (n.startsWith('fleet:')) return { label: '批量执行', cls: 'tag-clay' };
  if (n.startsWith('health-probe:')) return { label: '健康检测', cls: 'tag-ok' };
  if (n.startsWith('agent-upgrade:')) return { label: '探针升级', cls: 'tag-accent' };
  if (n.startsWith('diag-')) return { label: '系统诊断', cls: '' };
  return { label: '即时指令', cls: '' };
}

/** Render a semantic source/type pill for scheduled tasks and command logs. */
export function commandSourceBadge(type?: string | null, name?: string | null): string {
  const m = commandSourceMeta(type, name);
  return `<span class="tag${m.cls ? ` ${m.cls}` : ''}">${esc(m.label)}</span>`;
}

export type PollSlotState = 'ok' | 'warn' | 'err' | 'empty';

const SLOT_LABELS: Record<PollSlotState, string> = {
  ok: '轮询正常',
  warn: '轮询延迟',
  err: '未收到轮询',
  empty: '尚未记录',
};

/** Render Uptime-style N-capsule polling status strip with relative window tooltips. */
export function uptimeDotsHtml(
  slots: PollSlotState[],
  opts?: { lg?: boolean; label?: string; windowSec?: number },
): string {
  const winSec = Math.max(5, Number(opts?.windowSec) || 60);
  const n = slots.length;
  const dots = slots
    .map((s, idx) => {
      const ago = n - 1 - idx;
      const sec = ago * winSec;
      const when = ago === 0 ? '最近轮询窗口' : sec >= 60 ? `约 ${Math.round(sec / 60)} 分钟前` : `约 ${sec} 秒前`;
      return `<i class="up-dot up-${s}" title="${esc(`${when} · ${SLOT_LABELS[s]}`)}"></i>`;
    })
    .join('');
  return `<div class="up-strip${opts?.lg ? ' up-lg' : ''}" role="img" aria-label="${esc(opts?.label ?? '轮询健康状态')}">${dots}</div>`;
}

const BUCKET_LABELS: Record<HealthBucketStatus, string> = {
  ok: '正常',
  warn: '波动',
  err: '离线',
  empty: '无记录',
};

/** Render full-width interactive health timeline from historical heartbeat buckets. */
export function healthTimelineHtml(
  buckets: HealthHistoryBucketDTO[],
  opts: {
    fleet?: boolean;
    leftAxis: string;
    centerAxis: string;
    rightAxis: string;
    label?: string;
  },
): string {
  const dots = buckets
    .map((b) => {
      const pctTxt = b.uptime_pct === null ? '无样本' : `可用率 ${b.uptime_pct.toFixed(1)}%`;
      const fleetTxt = opts.fleet && b.total_devices > 0 ? ` · ${b.online_devices}/${b.total_devices} 在线` : '';
      const hbTxt = b.expected > 0 ? ` · ${b.samples}/${b.expected} 心跳` : '';
      const tip = `${b.label} · ${BUCKET_LABELS[b.status]} · ${pctTxt}${fleetTxt}${hbTxt}`;
      return `<i class="up-dot up-${b.status}" tabindex="0" data-up-tip="${esc(tip)}" title="${esc(tip)}"></i>`;
    })
    .join('');
  return `<div class="up-wrap"><div class="up-strip up-lg" role="img" aria-label="${esc(opts.label ?? '健康状态时间轴')}">${dots}</div><div class="chart-tip up-tip hidden"></div><div class="rb t2xs mut mt-1"><span>${esc(opts.leftAxis)}</span><span>${esc(opts.centerAxis)}</span><span>${esc(opts.rightAxis)}</span></div></div>`;
}

/** Bind hover/focus/tap tooltip positioning on `.up-wrap` health timeline strips. */
export function bindUptimeTooltips(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.up-wrap').forEach((wrap) => {
    const tipEl = wrap.querySelector<HTMLElement>('.up-tip');
    if (!tipEl) return;
    const showFor = (dot: HTMLElement | null) => {
      const text = dot?.getAttribute('data-up-tip');
      if (!text) return tipEl.classList.add('hidden');
      const rect = wrap.getBoundingClientRect();
      const dRect = dot!.getBoundingClientRect();
      const cx = dRect.left + dRect.width / 2 - rect.left;
      tipEl.textContent = text;
      tipEl.classList.remove('hidden');
      const half = Math.ceil((tipEl.offsetWidth || 160) / 2) + 6;
      const minX = Math.min(half, rect.width / 2);
      tipEl.style.left = `${Math.round(Math.max(minX, Math.min(rect.width - minX, cx)))}px`;
    };
    const hide = () => tipEl.classList.add('hidden');
    wrap.addEventListener('mousemove', (ev) => {
      showFor((ev.target as Element | null)?.closest<HTMLElement>('[data-up-tip]') ?? null);
    });
    wrap.addEventListener('focusin', (ev) => {
      showFor((ev.target as Element | null)?.closest<HTMLElement>('[data-up-tip]') ?? null);
    });
    wrap.addEventListener('mouseleave', hide);
    wrap.addEventListener('focusout', hide);
  });
}
