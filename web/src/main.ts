import { UserRole } from '../../shared/types';
import { api, setUnauthorizedHandler } from './api';
import { osBadge } from './components/badges';
import { on } from './components/ui';
import { icons } from './icons';
import { navigate, parseHash, startRouter, type RouteMatch } from './router';
import {
  applyTheme,
  clearCachedDeployKey,
  clearHostTabs,
  closeHostTab,
  initThemeWatcher,
  onHostTabsChange,
  state,
  themeLabel,
  toast,
  toggleTheme,
} from './state';
import { esc } from './utils';
import { renderCommands } from './views/commands';
import { renderConsole } from './views/console';
import { renderDashboard } from './views/dashboard';
import { renderDeviceDetail } from './views/device-detail';
import { renderDevices } from './views/devices';
import { renderGroups } from './views/groups';
import { renderLogin } from './views/login';
import { renderLogs } from './views/logs';
import { renderSettings } from './views/settings';

const NAV_ITEMS: Array<[string, string, () => string]> = [
  ['/overview', '总览', icons.overview],
  ['/console', '批量执行', icons.console],
  ['/groups', '分组', icons.groups],
  ['/commands', '定时任务', icons.commands],
  ['/logs', '日志', icons.logs],
  ['/settings', '设置', icons.settings],
];

function resolveRoute(path: string): RouteMatch {
  if (path === '/login') return { handler: renderLogin, params: {}, isPublic: true };
  if (path === '/overview') return { handler: renderDashboard, params: {} };
  if (path === '/devices') return { handler: renderDevices, params: {} };
  if (path.startsWith('/devices/')) return { handler: renderDeviceDetail, params: { id: decodeURIComponent(path.slice(9)) } };
  if (path === '/console') return { handler: renderConsole, params: {} };
  if (path === '/groups') return { handler: renderGroups, params: {} };
  if (path === '/commands') return { handler: renderCommands, params: {} };
  if (path === '/logs') return { handler: renderLogs, params: {} };
  if (path === '/settings') return { handler: renderSettings, params: {} };
  return { handler: renderDevices, params: {} };
}

function activeDeviceIdFromPath(path: string): string {
  return path.startsWith('/devices/') ? decodeURIComponent(path.slice(9)) : '';
}

function themeIcon(): string {
  if (state.theme === 'light') return icons.sun();
  if (state.theme === 'system') return icons.monitor();
  return icons.moon();
}

const navLinksHtml = (list: Array<[string, string, () => string]>) =>
  list.map(([p, l, ic]) => `<a href="#${p}" class="tnav-link" data-nav="${p}">${ic()}<span>${esc(l)}</span></a>`).join('');

function bootstrap(): void {
  applyTheme(state.theme);
  const appRoot = document.getElementById('app');
  if (!appRoot) return;

  appRoot.innerHTML =
    `<div id="shell" class="shell">` +
    `<header id="topbar" class="topbar" aria-label="顶部导航">` +
    `<div class="tb-left"><button type="button" class="bic tb-mob-btn" id="btn-mobile-menu" aria-label="菜单">${icons.menu()}</button><a href="#/" class="brand-pill" id="nav-home">${icons.brand()}<span>Cslite · 主机管理</span></a><div class="host-tabs" id="top-host-tabs" role="tablist"></div></div>` +
    `<div class="tb-right"><nav class="top-nav" id="top-nav">${navLinksHtml(NAV_ITEMS)}</nav><button type="button" class="theme-pill" id="btn-theme" title="切换主题"></button><div class="user-pill" id="top-user"></div><button type="button" class="bic ter" id="btn-logout" title="退出">${icons.logout()}</button></div>` +
    `</header>` +
    `<div id="drawer-backdrop" class="d-bg"></div>` +
    `<aside id="mobile-drawer" class="mob-drawer"><div class="mob-hd"><div class="row gxs">${icons.brand()}<strong>Cslite</strong></div><button type="button" class="bic" id="btn-drawer-close">×</button></div><div class="mob-user" id="mob-user"></div><nav class="mob-nav">${navLinksHtml([['/', '主机管理', icons.devices], ...NAV_ITEMS])}</nav><div class="mob-tabs-wrap"><div class="mut t2xs mb-1">已打开主机</div><div class="mob-host-tabs" id="mob-host-tabs"></div></div><div class="mob-foot"><button type="button" class="btn bsm bg flex-1" id="btn-theme-mob"></button><button type="button" class="btn bsm be" id="btn-logout-mob">${icons.logout()} 退出</button></div></aside>` +
    `<main id="view-root" class="view-root"></main>` +
    `</div><div id="modal-root"></div><div id="toast-root" class="toast-root"></div>`;

  const shellEl = document.getElementById('shell') as HTMLElement;
  const viewRoot = document.getElementById('view-root') as HTMLElement;
  const topUserEl = document.getElementById('top-user') as HTMLElement;
  const mobUserEl = document.getElementById('mob-user') as HTMLElement;
  const topTabsEl = document.getElementById('top-host-tabs') as HTMLElement;
  const mobTabsEl = document.getElementById('mob-host-tabs') as HTMLElement;

  let currentPath = '/';

  const syncThemeButtons = () => {
    const html = `${themeIcon()}<span>${esc(themeLabel(state.theme))}</span>`;
    const b1 = document.getElementById('btn-theme');
    const b2 = document.getElementById('btn-theme-mob');
    if (b1) b1.innerHTML = html;
    if (b2) b2.innerHTML = html;
  };
  syncThemeButtons();
  initThemeWatcher(syncThemeButtons);

  const renderHostTabs = () => {
    const activeId = activeDeviceIdFromPath(currentPath);
    const tabs = state.hostTabs;
    const html = tabs
      .map((t) => {
        const isActive = Boolean(activeId && activeId === t.id);
        const dotCls = t.status === 'online' ? 'dot-ok dot-pulse' : t.status === 'busy' ? 'dot-warn' : 'dot-err';
        return `<div class="htab${isActive ? ' active' : ''}" data-open-host="${esc(t.id)}" role="tab" aria-selected="${isActive ? 'true' : 'false'}" title="${esc(t.name)}">${osBadge(t.platform, 'sm')}<span class="dot ${dotCls}"></span><span class="htab-name truncate">${esc(t.name)}</span><button type="button" class="htab-x" data-close-host="${esc(t.id)}" aria-label="关闭 ${esc(t.name)}">×</button></div>`;
      })
      .join('');
    topTabsEl.innerHTML = html;
    mobTabsEl.innerHTML = html || '<span class="mut t2xs">暂无已打开的主机</span>';
  };
  onHostTabsChange(renderHostTabs);

  const handleTabContainerClick = (ev: Event) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    const closeBtn = target.closest('[data-close-host]') as HTMLElement | null;
    if (closeBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const id = closeBtn.dataset.closeHost ?? '';
      if (!id) return;
      const wasActive = activeDeviceIdFromPath(parseHash().path) === id;
      closeHostTab(id);
      if (wasActive) navigate('/');
      return;
    }
    const tabEl = target.closest('[data-open-host]') as HTMLElement | null;
    if (tabEl) {
      const id = tabEl.dataset.openHost;
      if (id) {
        toggleDrawer(false);
        navigate(`/devices/${encodeURIComponent(id)}`);
      }
    }
  };
  topTabsEl.addEventListener('click', handleTabContainerClick);
  mobTabsEl.addEventListener('click', handleTabContainerClick);

  const toggleDrawer = (open: boolean) => {
    state.mobileMenuOpen = open;
    shellEl.classList.toggle('drawer-open', open);
  };

  on(appRoot, '#btn-mobile-menu', () => toggleDrawer(!state.mobileMenuOpen));
  on(appRoot, '#btn-drawer-close', () => toggleDrawer(false));
  on(appRoot, '#drawer-backdrop', () => toggleDrawer(false));

  const handleTheme = () => {
    toggleTheme();
    syncThemeButtons();
  };
  on(appRoot, '#btn-theme', handleTheme);
  on(appRoot, '#btn-theme-mob', handleTheme);

  const clearSessionState = () => {
    state.user = null;
    state.mintedKeys = {};
    clearCachedDeployKey();
    clearHostTabs();
    navigate('/login');
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    toast('已退出登录', 'info');
    clearSessionState();
  };
  on(appRoot, '#btn-logout', () => void handleLogout());
  on(appRoot, '#btn-logout-mob', () => void handleLogout());

  setUnauthorizedHandler(() => {
    if (state.user) toast('登录状态已过期，请重新登录', 'warn');
    clearSessionState();
  });

  startRouter({
    root: viewRoot,
    resolve: resolveRoute,
    onBeforeRender(path) {
      currentPath = path;
      shellEl.classList.toggle('auth-only', path === '/login');
      toggleDrawer(false);

      const userHtml = state.user
        ? `<div class="user-av">${esc(state.user.username.slice(0, 2).toUpperCase())}</div><span class="user-name truncate">${esc(state.user.username)}</span><span class="role-chip">${state.user.role === UserRole.ADMIN ? '管理员' : '成员'}</span>`
        : '';
      topUserEl.innerHTML = userHtml;
      mobUserEl.innerHTML = userHtml;

      const homeActive = path === '/' || path === '/devices';
      document.getElementById('nav-home')?.classList.toggle('active', homeActive);

      shellEl.querySelectorAll<HTMLAnchorElement>('.tnav-link').forEach((link) => {
        const navPath = link.dataset.nav ?? '/';
        const active =
          navPath === '/'
            ? homeActive
            : path === navPath || path.startsWith(`${navPath}/`);
        link.classList.toggle('active', active);
      });

      renderHostTabs();
    },
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
  else bootstrap();
}
