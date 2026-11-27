import type { ExecutionDeviceResultDTO } from '../../../shared/types';
import { api, ApiError } from '../api';
import { icons } from '../icons';
import { copyText, openModal, setManagedInterval, toast } from '../state';
import { computeDiffLines, esc, formatElapsed, stripAnsi } from '../utils';
import { exitCodeBadge, logDownloadUrl, statusBadge } from './badges';

export const SHELL_OPTS: Array<[string, string]> = [
  ['auto', 'auto / sh'],
  ['sh', 'sh'],
  ['bash', 'bash'],
  ['ash', 'ash'],
  ['cmd', 'cmd'],
  ['powershell', 'powershell'],
  ['pwsh', 'pwsh'],
];

export const PLAT_OPTS: Array<[string, string]> = [
  ['linux', 'Linux'],
  ['openwrt', 'OpenWrt'],
  ['macos', 'macOS'],
  ['windows', 'Windows'],
  ['android', 'Android'],
];

export const ADD_PLAT_OPTS: Array<[string, string]> = [
  ['unix', 'UNIX (Linux / OpenWrt / macOS)'],
  ['windows', 'Windows'],
  ['android', 'Android'],
];

export function isTerminalExecStatus(s: string): boolean {
  return s === 'completed' || s === 'failed' || s === 'timeout' || s === 'cancelled';
}

export function on(
  root: ParentNode,
  sel: string,
  fn: (el: HTMLElement, ev: Event) => void,
  ev = 'click',
): void {
  const el = root.querySelector(sel) as HTMLElement | null;
  el?.addEventListener(ev, (e) => fn(el, e));
}

export function onAll(
  root: ParentNode,
  sel: string,
  fn: (el: HTMLElement, ev: Event) => void,
  ev = 'click',
): void {
  root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
    el.addEventListener(ev, (e) => fn(el, e));
  });
}

export function val(root: ParentNode, sel: string): string {
  const el = root.querySelector(sel) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
  return el ? el.value.trim() : '';
}

export function btn(label: string, attrs = '', cls = 'bsm bg'): string {
  return `<button type="button" class="btn ${cls}"${attrs ? ` ${attrs}` : ''}>${label}</button>`;
}

export function cardHtml(title: string, bodyHtml: string, rightHtml = '', cls = ''): string {
  return `<section class="card${cls ? ` ${cls}` : ''}"><div class="card-head"><h3>${title}</h3>${rightHtml}</div>${bodyHtml}</section>`;
}

export function infoGridHtml(items: Array<[string, string]>): string {
  return `<div class="info-grid">${items.map(([k, v]) => `<div><span class="mut t2xs">${k}</span><div class="mt-1">${v}</div></div>`).join('')}</div>`;
}

export function pageHeadHtml(title: string, subtitle: string, actionsHtml = ''): string {
  return `<div class="page-head"><div><h2 class="page-title">${esc(title)}</h2><div class="mut txs mt-1">${subtitle}</div></div>${
    actionsHtml ? `<div class="row gsm wrap">${actionsHtml}</div>` : ''
  }</div>`;
}

export function fieldHtml(id: string, label: string, controlHtml: string): string {
  return `<div class="field"><label for="${esc(id)}">${esc(label)}</label>${controlHtml}</div>`;
}

export function kpiCardHtml(label: string, valHtml: string, subHtml: string, midHtml = ''): string {
  return `<div class="kpi-card"><div class="kpi-label">${esc(label)}</div><div class="kpi-val num">${valHtml}</div>${midHtml}<div class="kpi-sub mut">${subHtml}</div></div>`;
}

export function tabsHtml(
  items: Array<[string, string]>,
  active: string,
  attr: string,
  sm = false,
): string {
  return `<div class="tabs${sm ? ' tabs-sm' : ''}">${items
    .map(
      ([k, l]) =>
        `<button type="button" class="tab-btn${k === active ? ' active' : ''}" ${attr}="${esc(k)}">${esc(l)}</button>`,
    )
    .join('')}</div>`;
}

export function targetItemHtml(
  id: string,
  cls: string,
  checked: boolean,
  bodyHtml: string,
  attr = 'data-id',
): string {
  return `<label class="target-item${checked ? ' selected' : ''}"><input type="checkbox" class="${cls}" ${attr}="${esc(id)}"${
    checked ? ' checked' : ''
  }>${bodyHtml}</label>`;
}

export function selectHtml(
  id: string,
  options: Array<[string, string]>,
  current: string,
  cls = 'input ism',
): string {
  return `<select id="${esc(id)}" class="${esc(cls)}">${options
    .map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`)
    .join('')}</select>`;
}

export function shellSelectHtml(id: string, current = 'auto', cls = 'input ism'): string {
  return selectHtml(id, SHELL_OPTS, current, `${cls} mono`);
}

export function tableHtml(headers: string[], rowsHtml: string, emptyMsg: string): string {
  if (!rowsHtml) return `<div class="emp-i mut">${emptyMsg}</div>`;
  return `<div class="table-wrap"><table class="tbl"><thead><tr>${headers
    .map((h) => `<th>${h}</th>`)
    .join('')}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
}

export function formModal(opts: {
  title: string;
  formId: string;
  fieldsHtml: string;
  submitLabel: string;
  wide?: boolean;
  onMount?: (panel: HTMLElement, close: () => void) => void | (() => void);
  onSubmit: (panel: HTMLElement, close: () => void) => Promise<void>;
}): void {
  openModal({
    title: opts.title,
    wide: opts.wide,
    bodyHtml: `<form id="${opts.formId}" class="smd">${opts.fieldsHtml}</form>`,
    footerHtml: `${btn('取消', 'data-cancel', 'bg')}<button type="submit" form="${opts.formId}" class="btn bp" data-sub>${esc(opts.submitLabel)}</button>`,
    onMount(panel, close) {
      on(panel, '[data-cancel]', close);
      const userCleanup = opts.onMount?.(panel, close);
      const sb = panel.querySelector('[data-sub]') as HTMLButtonElement | null;
      on(panel, `#${opts.formId}`, async (_el, ev) => {
        ev.preventDefault();
        if (sb) sb.disabled = true;
        try {
          await opts.onSubmit(panel, close);
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '操作失败', 'err');
        } finally {
          if (sb) sb.disabled = false;
        }
      }, 'submit');
      return userCleanup;
    },
  });
}

export function confirmModal(opts: {
  title: string;
  bodyHtml: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
}): void {
  openModal({
    title: opts.title,
    bodyHtml: opts.bodyHtml,
    footerHtml:
      btn('取消', 'data-cancel', 'bg') +
      btn(esc(opts.confirmLabel), 'data-confirm', opts.danger ? 'be' : 'bp'),
    onMount(panel, close) {
      on(panel, '[data-cancel]', close);
      on(panel, '[data-confirm]', async (el) => {
        const b = el as HTMLButtonElement;
        b.disabled = true;
        try {
          await opts.onConfirm();
          close();
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '操作失败', 'err');
          b.disabled = false;
        }
      });
    },
  });
}

export function bindSearchInput(
  root: HTMLElement,
  selector: string,
  getValue: () => string,
  onChange: (nextVal: string) => void,
): void {
  const el = root.querySelector(selector) as HTMLInputElement | null;
  el?.addEventListener('input', () => {
    const v = el.value;
    const pos = el.selectionStart ?? v.length;
    onChange(v);
    const nextEl = root.querySelector(selector) as HTMLInputElement | null;
    if (nextEl) {
      nextEl.focus();
      nextEl.setSelectionRange(pos, pos);
    }
  });
  if (el && el.value !== getValue()) el.value = getValue();
}

export function preOutputHtml(raw: string, emptyMsg = '(无输出)', cls = 'term-pre host-pre'): string {
  const clean = stripAnsi(raw);
  return `<pre class="${cls}">${clean ? esc(clean) : `<span class="mut">${emptyMsg}</span>`}</pre>`;
}

export function codeBoxHtml(code: string, copyAttrs: string, codeAttrs = ''): string {
  return `<div class="code-box">${btn(`${icons.copy()} 复制`, copyAttrs, 'bxs bg code-copy')}<pre class="code-pre"><code${codeAttrs ? ` ${codeAttrs}` : ''}>${esc(code)}</code></pre></div>`;
}

export function diffPreHtml(baseline: string, target: string, sameMsg = '(与基准输出一致)'): string {
  const diff = computeDiffLines(baseline, target);
  if (diff.identical) return `<div class="mut txs p-2">${sameMsg}</div>`;
  return `<pre class="term-pre host-pre">${diff.lines
    .map((ln) => `<span class="diff-${ln.kind}">${ln.kind === 'add' ? '+ ' : ln.kind === 'del' ? '- ' : '  '}${esc(ln.text)}</span>`)
    .join('\n')}</pre>`;
}

export function hostCardHtml(
  r: ExecutionDeviceResultDTO,
  opts?: {
    hostLabel?: string;
    extraHtml?: string;
    collapsed?: boolean;
    collapsible?: boolean;
    customBodyHtml?: string;
  },
): string {
  const label = opts?.hostLabel || r.device_name || r.device_id;
  const dl = logDownloadUrl(r.result_id ?? r.id, r.log_url);
  const cleanOut = stripAnsi(r.output ?? '');
  const body =
    opts?.customBodyHtml ??
    preOutputHtml(r.output ?? '', isTerminalExecStatus(r.status) ? '(无输出)' : '等待探针返回…');

  return `<div class="hc"><div class="hc-hd"${
    opts?.collapsible ? ` data-toggle-host="${esc(r.device_id)}"` : ''
  }><div class="row gxs wrap">${
    opts?.collapsible ? `<span class="chev${opts.collapsed ? ' rot' : ''}">${icons.chevronDown()}</span>` : ''
  }<strong>${esc(label)}</strong>${opts?.extraHtml ?? ''}${statusBadge(r.status)}${exitCodeBadge(
    r.exit_code,
    r.status,
  )}</div><div class="row gxs"><span class="mut t2xs mono num">${esc(
    formatElapsed(r.started_at, r.completed_at),
  )}</span>${btn(icons.copy(), `data-copy-text="${esc(cleanOut)}" title="复制输出"`, 'b2x bg')}${
    dl ? `<a class="btn b2x bg" href="${esc(dl)}" download title="下载日志">${icons.download()}</a>` : ''
  }</div></div>${opts?.collapsed ? '' : body}</div>`;
}

export function bindCopyButtons(container: ParentNode): void {
  onAll(container, '[data-copy-text]', (el, ev) => {
    ev.stopPropagation();
    void copyText(el.dataset.copyText ?? '', '已复制输出');
  });
}

export function startCommandPolling(opts: {
  cmdId: string;
  isStale: () => boolean;
  onUpdate: (results: ExecutionDeviceResultDTO[], allDone: boolean) => void;
  intervalMs?: number;
}): () => void {
  let active = true;
  let stopTimer: (() => void) | null = null;
  const stop = () => {
    active = false;
    if (stopTimer) {
      stopTimer();
      stopTimer = null;
    }
  };
  const tick = async () => {
    if (!active || opts.isStale()) return;
    try {
      const res = await api.getCommandResults(opts.cmdId);
      if (!active || opts.isStale()) return;
      const list = res.executions?.[0]?.device_results ?? [];
      const done = list.length > 0 && list.every((r) => isTerminalExecStatus(r.status));
      if (done) stop();
      opts.onUpdate(list, done);
    } catch {
      /* retry next tick */
    }
  };
  stopTimer = setManagedInterval(() => void tick(), opts.intervalMs ?? 1200);
  void tick();
  return stop;
}
