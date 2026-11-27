import { api, ApiError } from '../api';
import { fieldHtml } from '../components/ui';
import { icons } from '../icons';
import { navigate, type RouteContext } from '../router';
import { state, themeLabel, toast, toggleTheme } from '../state';

function themeBtnHtml(): string {
  const ic = state.theme === 'light' ? icons.sun() : state.theme === 'system' ? icons.monitor() : icons.moon();
  return `${ic}<span class="t2xs">${themeLabel(state.theme)}</span>`;
}

export function renderLogin(ctx: RouteContext): void {
  ctx.root.innerHTML =
    `<div class="login-wrap"><div class="login-card"><div class="login-top"><div class="brand-row"><span class="brand-mark">${icons.brand()}</span><div><h1 class="login-title">Cslite</h1><div class="mut txs">轻量多平台主机与边缘设备控制台</div></div></div><button type="button" class="theme-pill" id="login-theme-btn" title="切换主题">${themeBtnHtml()}</button></div>` +
    `<div class="alert alert-err hidden" id="login-err"></div>` +
    `<form id="login-form" class="smd">${fieldHtml('login-user', '用户名', '<input id="login-user" class="input" type="text" autocomplete="username" required placeholder="admin" autofocus>')}${fieldHtml('login-pass', '密码', '<input id="login-pass" class="input" type="password" autocomplete="current-password" required placeholder="••••••••">')}<button type="submit" class="btn bp bbl" id="login-submit">登录控制台</button></form>` +
    `<div class="login-foot mut txs"><span>默认账号: <code class="mono">admin</code> / <code class="mono">admin</code></span><button type="button" class="link-btn txs" id="fill-demo">一键填充</button></div></div></div>`;

  const themeBtn = ctx.root.querySelector('#login-theme-btn') as HTMLButtonElement | null;
  themeBtn?.addEventListener('click', () => {
    toggleTheme();
    themeBtn.innerHTML = themeBtnHtml();
  });

  const userEl = ctx.root.querySelector('#login-user') as HTMLInputElement;
  const passEl = ctx.root.querySelector('#login-pass') as HTMLInputElement;
  const errEl = ctx.root.querySelector('#login-err') as HTMLElement;
  const submitBtn = ctx.root.querySelector('#login-submit') as HTMLButtonElement;

  ctx.root.querySelector('#fill-demo')?.addEventListener('click', () => {
    userEl.value = 'admin';
    passEl.value = 'admin';
    passEl.focus();
  });

  ctx.root.querySelector('#login-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = '登录中…';
    try {
      const res = await api.login({ username: userEl.value.trim(), password: passEl.value });
      state.user = res.user;
      toast(`欢迎回来，${res.user.username}`, 'ok');
      navigate('/');
    } catch (err) {
      errEl.textContent = err instanceof ApiError ? err.message : '登录失败';
      errEl.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = '登录控制台';
    }
  });
}
