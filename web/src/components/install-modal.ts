import type { CreateDeviceResponse, PlatformType } from '../../../shared/types';
import { api, ApiError } from '../api';
import { icons } from '../icons';
import { navigate } from '../router';
import { copyText, openModal, registerCleanup, toast } from '../state';
import {
  buildInstallCommands,
  buildNoCurlInstallCommands,
  esc,
  formatDate,
  platformMeta,
  type InstallTabId,
} from '../utils';
import {
  btn,
  codeBoxHtml,
  hMono,
  hMs,
  hMut,
  hRb,
  hRow,
  hRw,
  hStk,
  hTag,
  infoGridHtml,
  on,
  onAll,
  tabsHtml,
} from './ui';

export interface InstallModalParams {
  deviceId: string;
  name: string;
  platform: PlatformType;
  apiKey?: string;
  apiKeyPrefix?: string;
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

  const pk = platformMeta(params.platform).key;
  let activeTab: InstallTabId = pk === 'windows' ? 'windows' : pk === 'android' ? 'android' : 'unix';
  let fetchMethod: 'curl' | 'wget' = 'curl';
  let activeKey = params.apiKey?.trim() || '';
  let activeKeyPrefix = params.apiKeyPrefix?.trim() || (activeKey ? `${activeKey.slice(0, 12)}...` : '');
  let currentServerCommands = params.installCommands;
  let confirmRotate = false;
  let rotating = false;
  let autoKeyError = '';
  let showNoCurl = false;
  let detectedOnline = false;
  let checkingOnline = false;
  const waitMsg = '待连接探针';
  let footStatus = waitMsg;

  const resolveDeviceKey = async (rotate = false): Promise<void> => {
    autoKeyError = '';
    if (!rotate && activeKey) return;
    rotating = rotate;
    try {
      const dk = await api.getDeviceDeployKey(params.deviceId, rotate ? { rotate: true } : {});
      activeKey = dk.api_key;
      activeKeyPrefix = dk.key_prefix?.trim() || (activeKey ? `${activeKey.slice(0, 12)}...` : '');
      currentServerCommands = dk.install_commands;
    } catch (err) {
      if (!rotate) activeKey = '';
      autoKeyError = err instanceof ApiError ? err.message : '自动获取部署密钥失败，请重试';
    } finally {
      if (rotate) rotating = false;
    }
  };

  await resolveDeviceKey();

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
      serverCommands: currentServerCommands,
    })[activeTab];
  };

  const getSshPushCmd = (): string =>
    `curl -fsSL ${origin}/i | ssh root@router 'sh -s -- ${activeKey.trim() || 'YOUR_API_KEY'} ${params.deviceId}'`;

  const detectorBarHtml = () =>
    hRow(
      detectedOnline
        ? '<span class="bdg bd-ok"><span class="dot dot-pulse"></span>已检测到上线</span>'
        : `<span class="bdg bd-wn"><span class="dot"></span>${checkingOnline ? '正在检测上线…' : '等待主机上线…'}</span>`,
    ) +
    hRow(
      detectedOnline
        ? btn('进入主机管理 →', 'data-enter-host', 'bsm bp')
        : btn(checkingOnline ? '检测中…' : `${icons.refresh()} 检测上线状态`, `data-check-online${checkingOnline ? ' disabled' : ''}`, 'bsm ba'),
    );

  const renderInner = () => {
    const activeMeta = TABS.find((t) => t.id === activeTab) ?? TABS[0];
    const altCmds = noCurlCmds();
    const altHtml = altCmds.length
      ? hStk(
          `<button type="button" class="link-btn txs" data-toggle-nocurl>${
            showNoCurl ? '收起备用命令' : 'OpenWrt without curl?'
          }</button>${
            showNoCurl
              ? altCmds.map((alt, i) => codeBoxHtml(alt.command, `data-copy-alt="${i}"`, `data-alt-code="${i}"`)).join('') +
                (activeTab === 'unix'
                  ? hStk(`${hMut('无 HTTPS 路由器 SSH 推送：', 't2xs')}${codeBoxHtml(getSshPushCmd(), 'data-copy-ssh-push', 'data-ssh-push-code')}`, 'sxs mt-1')
                  : '')
              : ''
          }`,
        )
      : '';

    const keyAlertHtml = autoKeyError
      ? `<div class="alert alert-warn row rb wrap gxs"><span>${esc(autoKeyError)}</span>${btn(`${icons.refresh()} ${activeKey ? '重试轮换' : '重试自动获取密钥'}`, 'data-retry-auto-key', 'bxs ba')}</div>`
      : '';

    const rotateAlertHtml = confirmRotate
      ? `<div class="alert alert-warn row rb wrap gxs"><span>轮换后该主机旧密钥将立即失效，不影响其他主机</span>${hRow(`${btn(rotating ? '轮换中…' : '确认轮换', `data-confirm-rotate${rotating ? ' disabled' : ''}`, 'bxs be')}${btn('取消', 'data-cancel-rotate', 'bxs bg')}`)}</div>`
      : '';

    const keyLabel = activeKeyPrefix || (activeKey ? `${activeKey.slice(0, 12)}...` : '获取中…');
    const metaPairs: Array<[string, string]> = [
      ['主机 ID', hMono(esc(params.deviceId))],
      ['主机名称', esc(params.name)],
      ['服务端', hMono(esc(origin))],
      [
        '专属密钥',
        hRw(
          `${hMono(esc(keyLabel))}${hTag('单机绑定')}${btn('轮换密钥', `data-ask-rotate${rotating ? ' disabled' : ''}`, 'b2x bg')}`,
          'gxs',
        ),
      ],
    ];
    if (params.expiresAt) metaPairs.push(['Token 过期', esc(formatDate(params.expiresAt))]);

    return hStk(
      `<div class="row rb wrap gxs card card-inset" id="inst-detector-bar">${detectorBarHtml()}</div>${infoGridHtml(metaPairs)}${rotateAlertHtml}${keyAlertHtml}${tabsHtml(TABS.map((t) => [t.id, t.label]), activeTab, 'data-tab')}${hRb(`${hMs(esc(activeMeta.note))}${activeTab !== 'windows' ? tabsHtml([['curl', 'curl'], ['wget', 'wget']], fetchMethod, 'data-fetch-method', true) : ''}`, 'wrap gxs')}${codeBoxHtml(getCmd(), 'data-copy-cmd', 'data-cmd-code')}${altHtml}`,
      'ssm',
    );
  };

  openModal({
    title: `绑定主机 / 部署探针 — ${params.name}`,
    wide: true,
    bodyHtml: '<div id="inst-modal-wrap"></div>',
    footerHtml: hRb(`<span id="inst-foot-status" class="txs mut">${esc(footStatus)}</span>${hRow(`${btn('进入主机管理', 'data-enter-host-ft', 'bsm ba')}${btn('完成', 'data-modal-done', 'bsm bg')}`)}`, 'flex-1 wrap gxs'),
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
        on(wrap, '[data-ask-rotate]', () => {
          if (rotating) return;
          autoKeyError = '';
          confirmRotate = true;
          paint();
        });
        on(wrap, '[data-cancel-rotate]', () => {
          if (rotating) return;
          confirmRotate = false;
          paint();
        });
        on(wrap, '[data-confirm-rotate]', async () => {
          if (rotating) return;
          rotating = true;
          paint();
          await resolveDeviceKey(true);
          confirmRotate = false;
          rotating = false;
          if (closed) return;
          paint();
          if (!autoKeyError) toast('已轮换该主机专属密钥', 'ok');
        });
        on(wrap, '[data-retry-auto-key]', async (el) => {
          const b = el as HTMLButtonElement;
          b.disabled = true;
          const wasRotate = Boolean(activeKey);
          await resolveDeviceKey(wasRotate);
          if (closed) return;
          paint();
          if (wasRotate && !autoKeyError) toast('已轮换该主机专属密钥', 'ok');
        });
        on(wrap, '[data-enter-host]', enterHost);
        on(wrap, '[data-check-online]', () => void pollOnline(true));
        on(wrap, '[data-copy-cmd]', () => void copyText(getCmd(), '已复制命令'));
        on(wrap, '[data-copy-ssh-push]', () => void copyText(getSshPushCmd(), '已复制 SSH 命令'));
        onAll(wrap, '[data-copy-alt]', (el) => {
          const alt = noCurlCmds()[Number(el.dataset.copyAlt ?? '-1')];
          if (alt) void copyText(alt.command, `已复制 ${alt.tool} 命令`);
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
    apiKey: res.api_key,
    apiKeyPrefix: res.api_key_prefix,
    installCommand: res.install_command,
    installCommands: res.install_commands,
    expiresAt: res.expires_at,
  };
}
