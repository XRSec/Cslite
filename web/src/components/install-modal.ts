import type { ApiKeyDTO, CreateDeviceResponse, PlatformType } from '../../../shared/types';
import { api, ApiError } from '../api';
import { icons } from '../icons';
import { navigate } from '../router';
import {
  clearCachedDeployKey,
  copyText,
  loadCachedDeployKey,
  openModal,
  registerCleanup,
  saveCachedDeployKey,
  state,
  toast,
} from '../state';
import {
  buildInstallCommands,
  buildNoCurlInstallCommands,
  esc,
  formatDate,
  platformMeta,
  substituteInstallTokens,
  type InstallTabId,
} from '../utils';
import { btn, codeBoxHtml, infoGridHtml, on, onAll, selectHtml, tabsHtml } from './ui';

export interface InstallModalParams {
  deviceId: string;
  name: string;
  platform: PlatformType;
  installCommand?: string;
  installCommands?: Record<string, string>;
  expiresAt?: string;
}

const TABS: Array<{ id: InstallTabId; label: string; note: string }> = [
  { id: 'unix', label: 'UNIX (Linux / OpenWrt / macOS)', note: '自动识别 OS/Init，小闪存自动切 Lite。' },
  { id: 'windows', label: 'Windows (PowerShell)', note: '自动识别架构，部署探针或 Lite 计划任务。' },
  { id: 'android', label: 'Android (Termux / Root)', note: '自动识别 Termux 与 Root 后台启动。' },
];

export async function showInstallModal(params: InstallModalParams): Promise<void> {
  const origin = window.location.origin;
  const keys = await api.listApiKeys().catch(() => [] as ApiKeyDTO[]);

  const pk = platformMeta(params.platform).key;
  let activeTab: InstallTabId = pk === 'windows' ? 'windows' : pk === 'android' ? 'android' : 'unix';
  let fetchMethod: 'curl' | 'wget' = 'curl';
  let selectedKeyId = keys.find((k) => Boolean(state.mintedKeys[k.id]))?.id ?? '';
  let activeKey = selectedKeyId ? state.mintedKeys[selectedKeyId] ?? '' : '';
  let keyStatusNote = '';
  let showKeyOptions = false;
  let showNoCurl = false;
  let detectedOnline = false;
  let checkingOnline = false;
  const waitMsg = '部署后点击“检测上线状态”';
  let footStatus = waitMsg;

  const cached = loadCachedDeployKey(state.user?.id);
  if (cached) {
    if (keys.some((k) => k.id === cached.id)) {
      state.mintedKeys[cached.id] = cached.key;
      if (!activeKey) {
        selectedKeyId = cached.id;
        activeKey = cached.key;
      }
    } else {
      clearCachedDeployKey();
    }
  }

  const mintKey = async (name: string): Promise<void> => {
    const minted = await api.createApiKey({ name });
    state.mintedKeys[minted.id] = minted.api_key;
    saveCachedDeployKey(minted.id, minted.api_key, state.user?.id);
    keys.unshift(minted);
    selectedKeyId = minted.id;
    activeKey = minted.api_key;
  };

  if (activeKey) {
    keyStatusNote = '已复用当前密钥';
    if (!cached) saveCachedDeployKey(selectedKeyId, activeKey, state.user?.id);
  } else {
    try {
      await mintKey('default-deploy-key');
      keyStatusNote = '已自动生成';
    } catch {
      showKeyOptions = true;
      keyStatusNote = '请粘贴或重生成';
    }
  }

  const keyStatusHtml = (): string => {
    const c = activeKey.trim();
    const p = c
      ? (selectedKeyId && state.mintedKeys[selectedKeyId] === c ? keys.find((x) => x.id === selectedKeyId)?.key_prefix : '') ||
        (c.length > 12 ? `${c.slice(0, 12)}…` : c)
      : '';
    return `接入密钥：${p ? `<strong class="mono">已智能填充 (${esc(p)})</strong>` : '<strong>尚未配置密钥</strong>'}`;
  };

  const noCurlCmds = () => buildNoCurlInstallCommands(activeTab, origin, params.deviceId, activeKey);

  const getCmd = (): string => {
    if (activeTab !== 'windows' && fetchMethod === 'wget') {
      const alt = noCurlCmds().find((x) => x.tool === 'wget');
      if (alt) return alt.command;
    }
    return buildInstallCommands({
      deviceId: params.deviceId,
      name: params.name,
      origin,
      apiKey: activeKey,
      serverCommands: params.installCommands,
    })[activeTab];
  };

  const getSshPushCmd = (): string =>
    `curl -fsSL ${origin}/i | ssh root@router 'sh -s -- ${activeKey.trim() || 'YOUR_API_KEY'} ${params.deviceId}'`;

  const detectorBarHtml = () =>
    `<div class="row gxs">${
      detectedOnline
        ? '<span class="bdg bd-ok"><span class="dot dot-pulse"></span>已检测到上线</span>'
        : `<span class="bdg bd-wn"><span class="dot"></span>${checkingOnline ? '正在检测上线…' : '等待主机上线…'}</span>`
    }</div><div class="row gxs">${
      detectedOnline
        ? btn('进入主机管理 →', 'data-enter-host', 'bsm bp')
        : btn(checkingOnline ? '检测中…' : `${icons.refresh()} 检测上线状态`, `data-check-online${checkingOnline ? ' disabled' : ''}`, 'bsm ba')
    }</div>`;

  const renderInner = () => {
    const activeMeta = TABS.find((t) => t.id === activeTab) ?? TABS[0];
    const altCmds = noCurlCmds();
    const altHtml = altCmds.length
      ? `<div class="sxs"><button type="button" class="link-btn txs" data-toggle-nocurl>${
          showNoCurl ? '收起备用命令' : 'OpenWrt without curl?'
        }</button>${
          showNoCurl
            ? altCmds.map((alt, i) => codeBoxHtml(alt.command, `data-copy-alt="${i}"`, `data-alt-code="${i}"`)).join('') +
              (activeTab === 'unix'
                ? `<div class="sxs mt-1"><div class="mut t2xs">无 HTTPS 路由器 SSH 推送：</div>${codeBoxHtml(getSshPushCmd(), 'data-copy-ssh-push', 'data-ssh-push-code')}</div>`
                : '')
            : ''
        }</div>`
      : '';

    const keyOpts: Array<[string, string]> = [
      ['', '选择 API Key…'],
      ...keys.map((k): [string, string] => [k.id, `${k.name} (${k.key_prefix ?? k.id.slice(0, 8)})${state.mintedKeys[k.id] ? ' ★' : ''}`]),
    ];

    const keyPanelHtml = `<div class="card card-inset sxs"><div class="row rb wrap gxs"><span class="txs" id="inst-key-status">${keyStatusHtml()}</span>${btn(
      showKeyOptions ? '收起' : '更换 / 自定义密钥',
      'data-toggle-keys',
      'bxs bg',
    )}</div>${
      showKeyOptions
        ? `<div class="row wrap gxs">${selectHtml('inst-key-pick', keyOpts, selectedKeyId)}<input id="inst-api-key" class="input ism mono flex-1" type="text" placeholder="粘贴 ak_live_..." value="${esc(activeKey)}">${btn(`${icons.key()} 重新生成密钥`, 'data-mint-key', 'bsm ba')}</div>${
            keyStatusNote ? `<div class="mut t2xs">${esc(keyStatusNote)}</div>` : ''
          }`
        : ''
    }</div>`;

    const metaPairs: Array<[string, string]> = [
      ['主机 ID', `<span class="mono">${esc(params.deviceId)}</span>`],
      ['主机名称', esc(params.name)],
      ['服务端', `<span class="mono">${esc(origin)}</span>`],
    ];
    if (params.expiresAt) metaPairs.push(['Token 过期', esc(formatDate(params.expiresAt))]);

    return `<div class="ssm"><div class="row rb wrap gxs card card-inset" id="inst-detector-bar">${detectorBarHtml()}</div>${infoGridHtml(metaPairs)}${keyPanelHtml}${tabsHtml(TABS.map((t) => [t.id, t.label]), activeTab, 'data-tab')}<div class="row rb wrap gxs"><span class="mut txs">${esc(activeMeta.note)}</span>${activeTab !== 'windows' ? tabsHtml([['curl', 'curl'], ['wget', 'wget']], fetchMethod, 'data-fetch-method', true) : ''}</div>${codeBoxHtml(getCmd(), 'data-copy-cmd', 'data-cmd-code')}${altHtml}${
      params.installCommand ? `<div class="mut t2xs">默认: <code class="mono" data-default-cmd>${esc(substituteInstallTokens(params.installCommand, origin, activeKey))}</code></div>` : ''
    }</div>`;
  };

  openModal({
    title: `绑定主机 / 部署探针 — ${params.name}`,
    wide: true,
    bodyHtml: '<div id="inst-modal-wrap"></div>',
    footerHtml: `<div class="row rb flex-1 wrap gxs"><span id="inst-foot-status" class="txs mut">${esc(footStatus)}</span><div class="row gxs">${btn('进入主机管理', 'data-enter-host-ft', 'bsm ba')}${btn('完成', 'data-modal-done', 'bsm bg')}</div></div>`,
    onMount(panel, close) {
      const wrap = panel.querySelector('#inst-modal-wrap') as HTMLElement;
      let closed = false;
      const unreg = registerCleanup(() => {
        closed = true;
      });
      const enterHost = () => {
        unreg();
        close();
        navigate(`/devices/${encodeURIComponent(params.deviceId)}`);
      };

      on(panel, '[data-modal-done]', close);
      on(panel, '[data-enter-host-ft]', enterHost);

      const syncFooter = (customMsg?: string) => {
        footStatus = detectedOnline
          ? '已检测到上线'
          : checkingOnline
            ? '正在检测上线…'
            : (customMsg ?? waitMsg);
        const ftSt = panel.querySelector('#inst-foot-status');
        const ftBtn = panel.querySelector('[data-enter-host-ft]');
        if (ftSt) ftSt.textContent = footStatus;
        if (ftBtn) ftBtn.className = `btn bsm ${detectedOnline ? 'bp' : 'ba'}`;
      };

      const syncDetector = (customMsg?: string) => {
        syncFooter(customMsg);
        const bar = wrap.querySelector('#inst-detector-bar');
        if (bar) {
          bar.innerHTML = detectorBarHtml();
          on(bar, '[data-enter-host]', enterHost);
          on(bar, '[data-check-online]', () => void pollOnline(true));
        }
      };

      const pollOnline = async (manual = false) => {
        if (closed || detectedOnline || checkingOnline) return;
        if (manual) {
          checkingOnline = true;
          syncDetector();
        }
        try {
          const dev = await api.getDevice(params.deviceId);
          if (closed) return;
          checkingOnline = false;
          if (dev.status === 'online' || dev.status === 'busy') {
            detectedOnline = true;
            syncDetector();
            toast(`主机 "${dev.name}" 已上线`, 'ok');
          } else {
            syncDetector(manual ? '暂未检测到上线，请确认脚本已执行' : undefined);
            if (manual) toast('暂未检测到上线', 'info');
          }
        } catch (err) {
          if (closed) return;
          checkingOnline = false;
          if (manual) {
            syncDetector('检测失败，请重试');
            toast(err instanceof ApiError ? err.message : '检测失败', 'err');
          }
        }
      };

      const paint = () => {
        wrap.innerHTML = renderInner();
        syncFooter();
        const keyInput = wrap.querySelector('#inst-api-key') as HTMLInputElement | null;
        const refreshCode = () => {
          const keySt = wrap.querySelector('#inst-key-status');
          if (keySt) keySt.innerHTML = keyStatusHtml();
          const codeEl = wrap.querySelector('[data-cmd-code]');
          if (codeEl) codeEl.textContent = getCmd();
          noCurlCmds().forEach((alt, i) => {
            const el = wrap.querySelector(`[data-alt-code="${i}"]`);
            if (el) el.textContent = alt.command;
          });
          const sshEl = wrap.querySelector('[data-ssh-push-code]');
          if (sshEl) sshEl.textContent = getSshPushCmd();
          const defEl = wrap.querySelector('[data-default-cmd]');
          if (defEl && params.installCommand) defEl.textContent = substituteInstallTokens(params.installCommand, origin, activeKey);
        };
        keyInput?.addEventListener('input', () => {
          activeKey = keyInput.value;
          if (selectedKeyId && state.mintedKeys[selectedKeyId] !== activeKey) selectedKeyId = '';
          refreshCode();
        });
        on(wrap, '#inst-key-pick', (el) => {
          selectedKeyId = (el as HTMLSelectElement).value;
          const known = state.mintedKeys[selectedKeyId];
          if (known) {
            activeKey = known;
            saveCachedDeployKey(selectedKeyId, known, state.user?.id);
            keyStatusNote = '已复用当前密钥';
            if (keyInput) keyInput.value = known;
            refreshCode();
          } else if (selectedKeyId) {
            toast('明文 Key 仅创建时可见，请粘贴或重生成', 'info');
          }
        }, 'change');
        on(wrap, '[data-toggle-keys]', () => {
          showKeyOptions = !showKeyOptions;
          paint();
        });
        onAll(wrap, '[data-tab]', (b) => {
          activeTab = b.dataset.tab as InstallTabId;
          paint();
        });
        onAll(wrap, '[data-fetch-method]', (b) => {
          fetchMethod = b.dataset.fetchMethod === 'wget' ? 'wget' : 'curl';
          paint();
        });
        on(wrap, '[data-toggle-nocurl]', () => {
          showNoCurl = !showNoCurl;
          paint();
        });
        on(wrap, '[data-enter-host]', enterHost);
        on(wrap, '[data-check-online]', () => void pollOnline(true));
        on(wrap, '[data-copy-cmd]', () => void copyText(getCmd(), '已复制命令'));
        on(wrap, '[data-copy-ssh-push]', () => void copyText(getSshPushCmd(), '已复制 SSH 命令'));
        onAll(wrap, '[data-copy-alt]', (el) => {
          const alt = noCurlCmds()[Number(el.dataset.copyAlt ?? '-1')];
          if (alt) void copyText(alt.command, `已复制 ${alt.tool} 命令`);
        });
        on(wrap, '[data-mint-key]', async (el) => {
          const b = el as HTMLButtonElement;
          b.disabled = true;
          try {
            await mintKey(`agent-${params.name.slice(0, 24)}`);
            keyStatusNote = '已生成新密钥';
            toast('已生成 API Key', 'ok');
            paint();
          } catch (err) {
            toast(err instanceof ApiError ? err.message : '生成 Key 失败', 'err');
            b.disabled = false;
          }
        });
      };
      paint();
      void pollOnline(false);

      return unreg;
    },
  });
}

export function paramsFromCreateResponse(res: CreateDeviceResponse, name: string, platform: PlatformType): InstallModalParams {
  return {
    deviceId: res.id,
    name,
    platform,
    installCommand: res.install_command,
    installCommands: res.install_commands,
    expiresAt: res.expires_at,
  };
}
