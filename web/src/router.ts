import { api } from './api';
import { closeModal, runCleanups, state, syncActiveTimeZone } from './state';

export interface RouteContext {
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  root: HTMLElement;
  isStale: () => boolean;
}

export type ViewHandler = (ctx: RouteContext) => void | Promise<void>;

export interface RouteMatch {
  handler: ViewHandler;
  params: Record<string, string>;
  isPublic?: boolean;
}

export function parseHash(hashStr = window.location.hash): {
  path: string;
  query: URLSearchParams;
} {
  const raw = hashStr.startsWith('#') ? hashStr.slice(1) : hashStr;
  const qIdx = raw.indexOf('?');
  const rawPath = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const query = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '');
  return { path: normalized || '/', query };
}

export function navigate(target: string): void {
  const nextHash = target.startsWith('#') ? target : `#${target.startsWith('/') ? target : `/${target}`}`;
  if (window.location.hash === nextHash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = nextHash;
}

export function startRouter(opts: {
  root: HTMLElement;
  resolve: (path: string) => RouteMatch;
  onBeforeRender: (path: string) => void;
}): void {
  let renderSeq = 0;
  let authChecked = false;

  const handle = async () => {
    const seq = ++renderSeq;
    runCleanups();
    closeModal();
    state.mobileMenuOpen = false;

    const { path, query } = parseHash();
    const match = opts.resolve(path);

    if (!state.user && !authChecked) {
      authChecked = true;
      try {
        state.user = await api.getMe(true);
      } catch {
        state.user = null;
      }
      if (seq !== renderSeq) return;
    }

    if (!state.user && !match.isPublic) {
      opts.onBeforeRender('/login');
      navigate('/login');
      return;
    }

    if (state.user && path === '/login') {
      navigate('/');
      return;
    }

    opts.onBeforeRender(path);
    opts.root.innerHTML =
      '<div class="ld-skel" aria-busy="true" aria-label="加载中"><div class="skel-bar" style="width:180px;height:24px"></div><div class="skel-grid"><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div></div><div class="skel-card" style="height:220px"></div></div>';

    try {
      if (state.user && !state.systemInfo) {
        const sys = await api.getSystemInfo().catch(() => null);
        if (seq !== renderSeq) return;
        if (sys) {
          state.systemInfo = sys;
          syncActiveTimeZone();
        }
      }
      await match.handler({
        path,
        query,
        params: match.params,
        root: opts.root,
        isStale: () => seq !== renderSeq,
      });
    } catch (err) {
      if (seq !== renderSeq) return;
      const msg = err instanceof Error ? err.message : 'Unexpected render error';
      opts.root.innerHTML = `<div class="emp-c"><h3>View Error</h3><p class="mut" id="route-err-msg"></p></div>`;
      const p = opts.root.querySelector('#route-err-msg');
      if (p) p.textContent = msg;
    }
  };

  window.addEventListener('hashchange', () => {
    void handle();
  });

  if (!window.location.hash) {
    window.location.hash = '#/';
  } else {
    void handle();
  }
}
