import type { DeviceDTO, DeviceMetrics, GroupDTO, UserDTO } from '../../shared/types';
import { clampPercent, esc, getMemoryPercent } from './utils';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';
export type ToastKind = 'ok' | 'err' | 'warn' | 'info';

export interface HostTab {
  id: string;
  name: string;
  platform: string;
  status?: string;
}

export interface TelemetrySample {
  ts: number;
  cpu: number;
  memPct: number;
  memUsed: number;
  netIn: number;
  netOut: number;
  disk: number;
  seeded?: boolean;
}

export interface AppState {
  user: UserDTO | null;
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  mobileMenuOpen: boolean;
  devicesCache: DeviceDTO[];
  groupsCache: GroupDTO[];
  mintedKeys: Record<string, string>;
  hostTabs: HostTab[];
}

const THEME_KEY = 'cslite_theme';
const TABS_KEY = 'cslite_host_tabs';
export const DEPLOY_KEY_STORE = 'cslite_deploy_key_v1';
const MAX_HOST_TABS = 6;
const MAX_TELEMETRY_POINTS = 40;

export interface CachedDeployKey {
  id: string;
  key: string;
  userId?: number;
}

function store(fn: (s: Storage) => string | null | void, ses = false): string | null {
  try {
    const s = ses
      ? typeof sessionStorage !== 'undefined'
        ? sessionStorage
        : null
      : typeof localStorage !== 'undefined'
        ? localStorage
        : null;
    return s ? (fn(s) ?? null) : null;
  } catch {
    return null;
  }
}

const readStorage = (key: string): string | null => store((s) => s.getItem(key));
const writeStorage = (key: string, val: string): void => {
  store((s) => s.setItem(key, val));
};
const removeStorage = (key: string): void => {
  store((s) => s.removeItem(key));
};

/** Load cached deploy API key from localStorage, scoped by userId when available. */
export function loadCachedDeployKey(userId?: number): { id: string; key: string } | null {
  const raw = readStorage(DEPLOY_KEY_STORE);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<CachedDeployKey> | null;
    if (!p || typeof p.id !== 'string' || !p.id.trim() || typeof p.key !== 'string' || !p.key.trim()) return null;
    if (userId !== undefined && p.userId !== undefined && p.userId !== userId) return null;
    return { id: p.id, key: p.key };
  } catch {
    return null;
  }
}

/** Persist reusable deploy API key in localStorage for future host bindings. */
export function saveCachedDeployKey(id: string, key: string, userId?: number): void {
  if (!id.trim() || !key.trim()) return;
  writeStorage(DEPLOY_KEY_STORE, JSON.stringify({ id, key, userId }));
}

/** Clear cached deploy API key from localStorage (e.g. on logout or revocation). */
export function clearCachedDeployKey(): void {
  removeStorage(DEPLOY_KEY_STORE);
}

const readSession = (key: string): string | null => store((s) => s.getItem(key), true);
const writeSession = (key: string, val: string): void => {
  store((s) => s.setItem(key, val), true);
};

function parseThemeMode(raw: string | null): ThemeMode {
  if (raw === 'light' || raw === 'system' || raw === 'dark') return raw;
  return 'dark';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
  } catch {
    /* ignore */
  }
  return 'dark';
}

export function themeLabel(mode: ThemeMode): string {
  if (mode === 'light') return '浅色';
  if (mode === 'system') return '跟随系统';
  return '深色';
}

export function loadHostTabs(): HostTab[] {
  const raw = readSession(TABS_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is HostTab =>
          Boolean(x) && typeof x === 'object' && typeof x.id === 'string' && typeof x.name === 'string',
      )
      .slice(-MAX_HOST_TABS);
  } catch {
    return [];
  }
}

const initialTheme = parseThemeMode(readStorage(THEME_KEY));

export const state: AppState = {
  user: null,
  theme: initialTheme,
  resolvedTheme: resolveTheme(initialTheme),
  mobileMenuOpen: false,
  devicesCache: [],
  groupsCache: [],
  mintedKeys: {},
  hostTabs: loadHostTabs(),
};

const hostTabListeners = new Set<() => void>();

export function onHostTabsChange(fn: () => void): () => void {
  hostTabListeners.add(fn);
  return () => hostTabListeners.delete(fn);
}

function emitHostTabs(): void {
  writeSession(TABS_KEY, JSON.stringify(state.hostTabs));
  for (const fn of Array.from(hostTabListeners)) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

export function openHostTab(tab: HostTab): HostTab[] {
  const next = state.hostTabs.slice();
  const idx = next.findIndex((t) => t.id === tab.id);
  if (idx >= 0) {
    next[idx] = { ...next[idx], ...tab };
  } else {
    if (next.length >= MAX_HOST_TABS) next.shift();
    next.push(tab);
  }
  state.hostTabs = next;
  emitHostTabs();
  return next;
}

export function closeHostTab(id: string): HostTab[] {
  state.hostTabs = state.hostTabs.filter((t) => t.id !== id);
  emitHostTabs();
  return state.hostTabs;
}

export function syncHostTabs(devices: DeviceDTO[]): void {
  if (!state.hostTabs.length || !devices.length) return;
  const map = new Map(devices.map((d) => [d.id, d]));
  let changed = false;
  const next = state.hostTabs.map((t) => {
    const dev = map.get(t.id);
    if (!dev) return t;
    if (t.name !== dev.name || t.platform !== dev.platform || t.status !== dev.status) {
      changed = true;
      return { id: dev.id, name: dev.name, platform: dev.platform, status: dev.status };
    }
    return t;
  });
  if (changed) {
    state.hostTabs = next;
    emitHostTabs();
  }
}

export function clearHostTabs(): void {
  state.hostTabs = [];
  emitHostTabs();
}

export function applyTheme(theme: ThemeMode): void {
  state.theme = theme;
  state.resolvedTheme = resolveTheme(theme);
  writeStorage(THEME_KEY, theme);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = state.resolvedTheme;
  }
}

export function toggleTheme(): ThemeMode {
  const order: ThemeMode[] = ['dark', 'light', 'system'];
  const next = order[(order.indexOf(state.theme) + 1) % order.length] ?? 'dark';
  applyTheme(next);
  return next;
}

let themeWatcherBound = false;
export function initThemeWatcher(onChange?: () => void): void {
  if (themeWatcherBound) return;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  themeWatcherBound = true;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => {
    if (state.theme === 'system') {
      applyTheme('system');
      onChange?.();
    }
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler);
}

// ============================================================================
// Rolling 40-Sample Telemetry Ring Buffer
// ============================================================================

const telemetryRing = new Map<string, TelemetrySample[]>();

function toSample(m: DeviceMetrics, ts = Date.now(), seeded = false): TelemetrySample {
  return {
    ts,
    cpu: clampPercent(m.cpu_usage),
    memPct: getMemoryPercent(m),
    memUsed: Math.max(0, Number(m.memory_used) || 0),
    netIn: Math.max(0, Number(m.network_in) || 0),
    netOut: Math.max(0, Number(m.network_out) || 0),
    disk: clampPercent(m.disk_usage),
    seeded,
  };
}

export function pushTelemetrySample(deviceId: string, metrics?: DeviceMetrics | null, ts = Date.now()): TelemetrySample[] {
  const buf = telemetryRing.get(deviceId) ?? [];
  if (!metrics) return buf;
  const next = buf.slice();
  next.push(toSample(metrics, ts, false));
  if (next.length > MAX_TELEMETRY_POINTS) {
    next.splice(0, next.length - MAX_TELEMETRY_POINTS);
  }
  telemetryRing.set(deviceId, next);
  return next;
}

export function getTelemetrySeries(deviceId: string, current?: DeviceMetrics | null): TelemetrySample[] {
  const real = telemetryRing.get(deviceId) ?? [];
  const list = real.length > 0 ? real : current ? [toSample(current, Date.now(), false)] : [];
  if (list.length >= MAX_TELEMETRY_POINTS) return list.slice(-MAX_TELEMETRY_POINTS);

  const padLen = MAX_TELEMETRY_POINTS - list.length;
  const base = list[0];
  const padded: TelemetrySample[] = [];
  const anchorTs = base ? base.ts : Date.now();

  for (let i = 0; i < padLen; i++) {
    const ts = anchorTs - (padLen - i) * 5000;
    if (!base) {
      padded.push({ ts, cpu: 0, memPct: 0, memUsed: 0, netIn: 0, netOut: 0, disk: 0, seeded: true });
      continue;
    }
    const r = i / Math.max(padLen, 1);
    const wave = 0.72 + 0.22 * r + 0.05 * Math.sin(i * 0.65);
    const ms = 0.94 + 0.05 * r;
    padded.push({
      ts,
      cpu: clampPercent(base.cpu * wave),
      memPct: clampPercent(base.memPct * ms),
      memUsed: Math.round(base.memUsed * ms),
      netIn: Math.max(0, Math.round(base.netIn * wave)),
      netOut: Math.max(0, Math.round(base.netOut * wave)),
      disk: base.disk,
      seeded: true,
    });
  }
  return [...padded, ...list];
}

// ============================================================================
// Lifecycle Cleanup Registry (prevents leaked polling intervals on route leave)
// ============================================================================

const cleanups = new Set<() => void>();

export function registerCleanup(fn: () => void): () => void {
  cleanups.add(fn);
  return () => {
    cleanups.delete(fn);
    try {
      fn();
    } catch {
      /* ignore */
    }
  };
}

export function runCleanups(): void {
  for (const fn of Array.from(cleanups)) {
    cleanups.delete(fn);
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

export function setManagedInterval(fn: () => void, ms: number): () => void {
  const id = setInterval(fn, ms);
  return registerCleanup(() => clearInterval(id));
}

// ============================================================================
// Toast Notifications (XSS-safe escaped rendering)
// ============================================================================

export function toast(message: string, kind: ToastKind = 'info'): void {
  if (typeof document === 'undefined') return;
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.className = 'toast-root';
    document.body.appendChild(root);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="toast-msg">${esc(message)}</span><button type="button" class="toast-close" aria-label="关闭">×</button>`;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    el.classList.add('toast-leave');
    setTimeout(() => el.remove(), 160);
  };
  (el.lastChild as HTMLElement).addEventListener('click', dismiss);

  root.appendChild(el);
  timer = setTimeout(dismiss, kind === 'err' ? 5000 : 3200);
}

// ============================================================================
// Modal Manager
// ============================================================================

let activeModalClose: (() => void) | null = null;

export interface ModalOptions {
  title: string;
  bodyHtml: string;
  footerHtml?: string;
  wide?: boolean;
  onMount?: (panel: HTMLElement, close: () => void) => void | (() => void) | Promise<void>;
}

export function closeModal(): void {
  if (activeModalClose) {
    const fn = activeModalClose;
    activeModalClose = null;
    fn();
  }
}

export function openModal(opts: ModalOptions): void {
  closeModal();
  const root = document.getElementById('modal-root');
  if (!root) return;

  root.innerHTML =
    `<div class="m-bg" data-modal-backdrop><div class="m-pan ${opts.wide ? 'm-wd' : ''}" role="dialog" aria-modal="true"><div class="m-hd"><h3 class="m-ttl">${esc(opts.title)}</h3><button type="button" class="bic" data-modal-close aria-label="关闭">×</button></div><div class="m-bd">${opts.bodyHtml}</div>${opts.footerHtml ? `<div class="m-ft">${opts.footerHtml}</div>` : ''}</div></div>`;

  const panel = root.querySelector('.m-pan') as HTMLElement;
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') closeModal();
  };

  let mountCleanup: unknown;
  const cleanup = () => {
    removeEventListener('keydown', onKey);
    if (typeof mountCleanup === 'function') {
      try {
        (mountCleanup as () => void)();
      } catch {
        /* ignore */
      }
      mountCleanup = undefined;
    }
    root.innerHTML = '';
  };
  activeModalClose = cleanup;

  addEventListener('keydown', onKey);
  root.querySelector('[data-modal-close]')?.addEventListener('click', closeModal);
  root.querySelector('[data-modal-backdrop]')?.addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) closeModal();
  });

  if (opts.onMount && panel) {
    mountCleanup = opts.onMount(panel, closeModal);
  }
}

// ============================================================================
// Clipboard Helper
// ============================================================================

export async function copyText(text: string, label = '已复制到剪贴板'): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      toast(label, 'ok');
      return;
    }
  } catch {
    /* fallback below */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    toast(label, 'ok');
  } catch {
    toast('复制失败，请手动复制', 'err');
  } finally {
    ta.remove();
  }
}
