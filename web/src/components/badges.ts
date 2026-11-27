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
