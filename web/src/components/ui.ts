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

export const hRow = (body: string, cls = 'gxs'): string => `<div class="row ${cls}">${body}</div>`;
export const hRw = (body: string, cls = 'gxs'): string => `<div class="row ${cls} wrap">${body}</div>`;
export const hRb = (body: string, cls = 'wrap gsm'): string => `<div class="rb ${cls}">${body}</div>`;
export const hMut = (text: string, cls = 'txs'): string => `<div class="mut ${cls}">${text}</div>`;
export const hMs = (text: string, cls = 'txs'): string => `<span class="mut ${cls}">${text}</span>`;
export const hTag = (text: string, cls = ''): string => `<span class="tag${cls ? ` ${cls}` : ''}">${text}</span>`;
export const hMono = (text: string, cls = ''): string => `<span class="mono${cls ? ` ${cls}` : ''}">${text}</span>`;
export const hEmp = (msg: string, cls = 'emp-i mut'): string => `<div class="${cls}">${msg}</div>`;
export const hCard = (body: string, cls = ''): string => `<div class="card${cls ? ` ${cls}` : ''}">${body}</div>`;
export const hStk = (body: string, cls = 'sxs'): string => `<div class="${cls}">${body}</div>`;
export const hLnk = (href: string, label: string, cls = 'bsm bg', attrs = ''): string =>
  `<a class="btn ${cls}" href="${esc(href)}"${attrs ? ` ${attrs}` : ''}>${label}</a>`;
export const hInp = (id: string, type = 'text', attrs = '', cls = 'input'): string =>
  `<input id="${esc(id)}" class="${cls}" type="${type}"${attrs ? ` ${attrs}` : ''}>`;
export const hThTr = (label = '操作'): string => `<span class="tr" style="display:block">${esc(label)}</span>`;
export const hPre = (body: string, cls = 'term-pre host-pre'): string => `<pre class="${cls}">${body}</pre>`;
export type TrCell = string | [string, string?, string?];
export const hTr = (cells: TrCell[], labels?: string[], trAttrs = ''): string =>
  `<tr${trAttrs ? ` ${trAttrs}` : ''}>${cells
    .map((c, i) => {
      const [body, cls, lbl] = Array.isArray(c) ? c : [c, ''];
      const dl = lbl ?? labels?.[i] ?? '';
      return `<td${cls ? ` class="${cls}"` : ''}${dl ? ` data-lbl="${esc(dl)}"` : ''}>${body}</td>`;
    })
    .join('')}</tr>`;

export function copyBtnHtml(raw: string, cls = 'b2x bg', title = '复制'): string {
  return btn(icons.copy(), `data-copy-text="${esc(raw)}" title="${esc(title)}"`, cls);
}

export function ipCopyHtml(ip: string, cls = '', tipPrefix = '点击或双击复制'): string {
  const clean = (ip ?? '').trim();
  if (!clean || clean === '—') return '<span class="mut">—</span>';
  return `<button type="button" class="ip-t ip-cp mono${cls ? ` ${cls}` : ''}" data-copy-ip="${esc(clean)}" title="${esc(`${tipPrefix} ${clean}`)}">${esc(clean)}</button>`;
}

let ipCopyReady = false;
export function initIpCopyHandler(): void {
  if (ipCopyReady || typeof document === 'undefined') return;
  ipCopyReady = true;
  const locks = new WeakMap<HTMLElement, number>();
  let lastIp = '';
  let lastAt = 0;

  const handle = (ev: MouseEvent) => {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-copy-ip]');
    if (!el) return;
    const ip = el.dataset.copyIp?.trim() ?? '';
    if (!ip) return;
    ev.stopPropagation();
    if (ev.type === 'dblclick') ev.preventDefault();
    const now = Date.now();
    if (now - (locks.get(el) ?? 0) < 800 || (ip === lastIp && now - lastAt < 800)) return;
    locks.set(el, now);
    lastIp = ip;
    lastAt = now;
    el.classList.add('is-copied');
    setTimeout(() => {
      if (el.isConnected) el.classList.remove('is-copied');
    }, 900);
    void copyText(ip, `已复制：${ip}`, 'ip-copy');
  };

  document.addEventListener('click', handle, true);
  document.addEventListener('dblclick', handle, true);
}

export function dlBtnHtml(url: string | null, cls = 'b2x bg', title = '下载日志'): string {
  return url ? `<a class="btn ${cls}" href="${esc(url)}" download title="${esc(title)}">${icons.download()}</a>` : '';
}

export function bindChange(root: ParentNode, entries: Array<[string, (v: string) => void]>): void {
  for (const [sel, fn] of entries) {
    on(root, sel, (el) => fn((el as HTMLSelectElement | HTMLInputElement).value), 'change');
  }
}

export function cardHtml(title: string, bodyHtml: string, rightHtml = '', cls = ''): string {
  return `<section class="card${cls ? ` ${cls}` : ''}"><div class="card-head"><h3>${title}</h3>${rightHtml}</div>${bodyHtml}</section>`;
}

export function infoGridHtml(items: Array<[string, string]>): string {
  return `<div class="info-grid">${items.map(([k, v]) => `<div>${hMs(k, 't2xs')}<div class="mt-1">${v}</div></div>`).join('')}</div>`;
}

export function pageHeadHtml(title: string, subtitle: string, actionsHtml = ''): string {
  return `<div class="page-head"><div><h2 class="page-title">${esc(title)}</h2>${subtitle ? hMut(subtitle, 'txs mt-1') : ''}</div>${
    actionsHtml ? hRw(actionsHtml, 'gsm') : ''
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
  const activeLbl = options.find(([v]) => v === current)?.[1] ?? options[0]?.[1] ?? '';
  const wCls = cls.includes('ixs') ? 'csel-xs' : cls.includes('ism') ? 'csel-sm' : 'csel-full';
  return `<div class="csel ${wCls}"><select id="${esc(id)}" class="csel-nat" tabindex="-1" aria-hidden="true">${options
    .map(([v, l]) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(l)}</option>`)
    .join('')}</select><button type="button" class="${esc(cls)} csel-btn" data-csel-for="${esc(id)}" aria-haspopup="listbox" aria-expanded="false"><span class="csel-lbl truncate">${esc(activeLbl)}</span><span class="csel-ico">${icons.chevronDown()}</span></button></div>`;
}

export function syncSelectUi(sel: HTMLSelectElement | null): void {
  const lbl = sel?.closest('.csel')?.querySelector<HTMLElement>('.csel-lbl');
  if (lbl && sel) lbl.textContent = sel.selectedOptions[0]?.textContent ?? sel.value;
}

let cselReady = false;
export function initCustomSelects(): void {
  if (cselReady || typeof document === 'undefined') return;
  cselReady = true;
  const pop = document.createElement('div');
  pop.id = 'csel-pop';
  pop.className = 'csel-pop hidden';
  pop.setAttribute('role', 'listbox');
  document.body.appendChild(pop);

  let activeSel: HTMLSelectElement | null = null;
  let activeBtn: HTMLButtonElement | null = null;
  let focIdx = -1;

  const focusOpt = (idx: number, focusEl = false) => {
    const opts = pop.querySelectorAll<HTMLButtonElement>('[data-cidx]');
    if (!opts.length) return;
    focIdx = ((idx % opts.length) + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle('is-foc', i === focIdx));
    const cur = opts[focIdx];
    cur?.scrollIntoView({ block: 'nearest' });
    if (focusEl) cur?.focus();
  };

  const close = (restoreFocus = false) => {
    const trigger = activeBtn;
    pop.classList.add('hidden');
    pop.innerHTML = '';
    trigger?.setAttribute('aria-expanded', 'false');
    activeSel = null;
    activeBtn = null;
    focIdx = -1;
    if (restoreFocus && trigger && trigger.isConnected) trigger.focus();
  };

  const commitOpt = (idx: number, restoreFocus: boolean) => {
    if (Number.isInteger(idx) && activeSel && activeSel.options[idx]) {
      const sel = activeSel;
      sel.selectedIndex = idx;
      syncSelectUi(sel);
      close(restoreFocus);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      close(restoreFocus);
    }
  };

  const openPop = (btnEl: HTMLButtonElement, sel: HTMLSelectElement, fromKey = false, startLast = false) => {
    close(false);
    activeSel = sel;
    activeBtn = btnEl;
    btnEl.setAttribute('aria-expanded', 'true');
    pop.innerHTML = Array.from(sel.options)
      .map(
        (o, idx) =>
          `<button type="button" class="csel-opt${o.selected ? ' active' : ''}" role="option" aria-selected="${o.selected ? 'true' : 'false'}" data-cidx="${idx}"><span class="truncate">${esc(o.textContent ?? o.value)}</span>${o.selected ? '<span class="csel-chk">✓</span>' : ''}</button>`,
      )
      .join('');
    const rect = btnEl.getBoundingClientRect();
    pop.style.minWidth = `${Math.max(Math.round(rect.width), 140)}px`;
    pop.style.maxWidth = `${Math.min(360, window.innerWidth - 16)}px`;
    pop.style.visibility = 'hidden';
    pop.classList.remove('hidden');
    const pw = pop.offsetWidth || 150;
    const ph = Math.min(pop.offsetHeight || 220, 260);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - pw - 8));
    const top = rect.bottom + 5 + ph <= window.innerHeight - 8 ? rect.bottom + 5 : Math.max(8, rect.top - 5 - ph);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.visibility = '';
    const n = sel.options.length;
    const idx = sel.selectedIndex >= 0 ? sel.selectedIndex : startLast ? n - 1 : 0;
    focusOpt(idx, fromKey);
  };

  pop.addEventListener('click', (ev) => {
    const opt = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-cidx]');
    if (!opt || !activeSel) return;
    ev.stopPropagation();
    commitOpt(Number(opt.dataset.cidx), false);
  });

  document.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement | null;
    const btnEl = t?.closest<HTMLButtonElement>('[data-csel-for]');
    if (!btnEl) {
      if (!t?.closest('#csel-pop')) close(false);
      return;
    }
    ev.stopPropagation();
    const sel = btnEl.parentElement?.querySelector<HTMLSelectElement>('select.csel-nat');
    if (!sel) return;
    if (activeBtn === btnEl && !pop.classList.contains('hidden')) {
      close(false);
      return;
    }
    openPop(btnEl, sel, false);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (pop.classList.contains('hidden')) {
      const btnEl = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-csel-for]');
      if (!btnEl || !['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(ev.key)) return;
      const sel = btnEl.parentElement?.querySelector<HTMLSelectElement>('select.csel-nat');
      if (!sel) return;
      ev.preventDefault();
      openPop(btnEl, sel, true, ev.key === 'ArrowUp');
      return;
    }
    const opts = pop.querySelectorAll<HTMLButtonElement>('[data-cidx]');
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close(true);
    } else if (ev.key === 'Tab') {
      close(false);
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      focusOpt(focIdx + 1, true);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      focusOpt(focIdx - 1, true);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      focusOpt(0, true);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      if (opts.length) focusOpt(opts.length - 1, true);
    } else if ((ev.key === 'Enter' || ev.key === ' ') && focIdx >= 0) {
      ev.preventDefault();
      ev.stopPropagation();
      commitOpt(focIdx, true);
    }
  });
  window.addEventListener('resize', () => close(false));
  window.addEventListener('scroll', (ev) => {
    if (!pop.classList.contains('hidden') && ev.target !== pop && !pop.contains(ev.target as Node | null)) close(false);
  }, true);
}

export function shellSelectHtml(id: string, current = 'auto', cls = 'input ism'): string {
  return selectHtml(id, SHELL_OPTS, current, `${cls} mono`);
}

export function tableHtml(
  headers: Array<string | [string, string?]>,
  rowsHtml: string,
  emptyMsg: string,
  cls = '',
): string {
  return rowsHtml
    ? `<div class="table-wrap"><table class="tbl${cls ? ` ${cls}` : ''}"><thead><tr>${headers
        .map((h) => {
          const [lbl, thCls] = Array.isArray(h) ? h : [h, ''];
          return `<th${thCls ? ` class="${thCls}"` : ''}>${lbl}</th>`;
        })
        .join('')}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`
    : hEmp(emptyMsg);
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
  return hPre(clean ? esc(clean) : `<span class="mut">${emptyMsg}</span>`, cls);
}

export function codeBoxHtml(code: string, copyAttrs: string, codeAttrs = ''): string {
  return `<div class="code-box">${btn(`${icons.copy()} 复制`, copyAttrs, 'bxs bg code-copy')}<pre class="code-pre"><code${codeAttrs ? ` ${codeAttrs}` : ''}>${esc(code)}</code></pre></div>`;
}

export function diffPreHtml(baseline: string, target: string, sameMsg = '(与基准输出一致)'): string {
  const diff = computeDiffLines(baseline, target);
  if (diff.identical) return hMut(sameMsg, 'txs p-2');
  return hPre(
    diff.lines
      .map((ln) => `<span class="diff-${ln.kind}">${ln.kind === 'add' ? '+ ' : ln.kind === 'del' ? '- ' : '  '}${esc(ln.text)}</span>`)
      .join('\n'),
  );
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
  }>${hRw(
    `${opts?.collapsible ? `<span class="chev${opts.collapsed ? ' rot' : ''}">${icons.chevronDown()}</span>` : ''}<strong>${esc(label)}</strong>${opts?.extraHtml ?? ''}${statusBadge(r.status)}${exitCodeBadge(r.exit_code, r.status)}`,
  )}${hRow(
    `${hMs(esc(formatElapsed(r.started_at, r.completed_at)), 't2xs mono num')}${copyBtnHtml(cleanOut, 'b2x bg', '复制输出')}${dlBtnHtml(dl)}`,
  )}</div>${opts?.collapsed ? '' : body}</div>`;
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
