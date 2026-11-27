import {
  UserRole,
  type ApiKeyDTO,
  type SystemInfoDTO,
  type UserDTO,
} from '../../../shared/types';
import { api, ApiError } from '../api';
import {
  btn,
  cardHtml,
  codeBoxHtml,
  confirmModal,
  fieldHtml,
  formModal,
  hInp,
  hMono,
  hMs,
  hMut,
  hTag,
  hThTr,
  hTr,
  infoGridHtml,
  on,
  onAll,
  pageHeadHtml,
  selectHtml,
  syncSelectUi,
  tableHtml,
  val,
} from '../components/ui';
import { icons } from '../icons';
import type { RouteContext } from '../router';
import {
  clearCachedDeployKey,
  copyText,
  loadCachedDeployKey,
  openModal,
  saveCachedDeployKey,
  setTimezonePref,
  state,
  syncActiveTimeZone,
  toast,
} from '../state';
import { esc, formatDate, formatRelativeZh, getActiveTimeZone, isValidTimeZone, TIMEZONE_PRESETS } from '../utils';

export async function renderSettings(ctx: RouteContext): Promise<void> {
  const isAdmin = Number(state.user?.role) === UserRole.ADMIN;
  let keys: ApiKeyDTO[] = [];
  let users: UserDTO[] = [];
  let sysInfo: SystemInfoDTO | null = null;
  let healthOk = false;

  const load = async () => {
    try {
      const [kRes, sRes, hRes, uRes] = await Promise.all([
        api.listApiKeys().catch(() => [] as ApiKeyDTO[]),
        api.getSystemInfo().catch(() => null),
        api.getHealth().then(() => true).catch(() => false),
        isAdmin ? api.listUsers({ per_page: 100 }).catch(() => null) : Promise.resolve(null),
      ]);
      if (ctx.isStale()) return;
      keys = kRes;
      sysInfo = sRes;
      if (sRes) {
        state.systemInfo = sRes;
        syncActiveTimeZone();
      }
      healthOk = hRes;
      users = uRes?.users ?? [];
      paint();
    } catch (err) {
      if (!ctx.isStale()) toast(err instanceof ApiError ? err.message : '加载设置失败', 'err');
    }
  };

  const paint = () => {
    const keyLabels = ['名称', '作用域', '密钥前缀', '归属账号', '创建时间', '最近使用', ''];
    const keyRows = keys
      .map((k) =>
        hTr(
          [
            `<strong>${esc(k.name)}</strong>`,
            k.device_id
              ? `<a href="#/devices/${encodeURIComponent(k.device_id)}" class="tag">绑定 · ${esc(k.device_name || k.device_id)}</a>`
              : hTag('全局密钥'),
            [`${esc(k.key_prefix || k.id.slice(0, 12))}…`, 'mono txs'],
            [hTag(esc(k.owner_username || (k.user_id ? `uid:${k.user_id}` : '—'))), 'txs'],
            [esc(formatDate(k.created_at)), 'txs mut num'],
            [k.last_used ? esc(formatRelativeZh(k.last_used)) : '从未使用', 'txs mut'],
            [
              btn(
                `${icons.trash()} 吊销`,
                `data-del-key="${esc(k.id)}" data-key-device="${esc(k.device_name || k.device_id || '')}"`,
                'bxs bg ter',
              ),
              'tr',
            ],
          ],
          keyLabels,
        ),
      )
      .join('');

    const userLabels = ['ID', '用户名', '邮箱', '角色', '创建时间', ''];
    const userRows = users
      .map((u) =>
        hTr(
          [
            [esc(u.id), 'mono txs num'],
            `<strong>${esc(u.username)}</strong>`,
            [esc(u.email || '—'), 'txs mut'],
            hTag(u.role === UserRole.ADMIN ? '管理员' : '普通成员'),
            [esc(formatDate(u.created_at)), 'txs mut num'],
            [
              u.id === state.user?.id
                ? hMs('(当前账号)')
                : btn(icons.trash(), `data-del-user="${esc(u.id)}" data-uname="${esc(u.username)}" data-urole="${esc(u.role)}"`, 'bxs bg ter'),
              'tr',
            ],
          ],
          userLabels,
        ),
      )
      .join('');

    const profileCard = cardHtml(
      '个人资料与密码安全',
      `${infoGridHtml([
        ['用户名', `<strong>${esc(state.user?.username ?? '—')}</strong>`],
        ['邮箱', esc(state.user?.email || '—')],
      ])}<form id="pw-form" class="ssm mt-2">${fieldHtml('pw-old', '当前密码', hInp('pw-old', 'password', 'autocomplete="current-password" required', 'input ism'))}${fieldHtml('pw-new', '新密码', hInp('pw-new', 'password', 'autocomplete="new-password" required minlength="6"', 'input ism'))}${fieldHtml('pw-confirm', '确认新密码', hInp('pw-confirm', 'password', 'autocomplete="new-password" required minlength="6"', 'input ism'))}<button type="submit" class="btn bsm bp">更新密码</button></form>`,
      hTag(isAdmin ? '管理员' : '成员'),
    );

    const srcTag = (s?: string, hasEnv?: boolean) =>
      s === 'setting'
        ? `<span class="tag tag-accent"${hasEnv ? ' title="已覆盖环境变量"' : ''}>自定义设置</span>`
        : hTag(s === 'env' ? '环境变量' : '默认');
    const dispTz = getActiveTimeZone();
    const retDays = sysInfo?.log_retention_days ?? 0;
    const retText = retDays > 0 ? `${retDays} 天` : '不自动清理';
    const lastClean = sysInfo?.last_cleanup_at ? ` · 上次 ${formatRelativeZh(sysInfo.last_cleanup_at)}` : '';

    const sysBody = sysInfo
      ? infoGridHtml([
          ['系统版本', hMono(esc(sysInfo.version))],
          ['运行环境', hTag(esc(sysInfo.runtime))],
          ['数据库方言', hTag(esc(sysInfo.db_dialect))],
          ['探针自动注册', sysInfo.allow_registration ? '已开启' : '已关闭'],
          ['心跳间隔', hMono(`${esc(sysInfo.heartbeat_interval)}s`, ' num')],
          ['轮询间隔', hMono(`${esc(sysInfo.poll_interval)}s`, ' num')],
          ['系统时区', `${hMono(esc(sysInfo.timezone))} ${srcTag(sysInfo.timezone_source, Boolean(sysInfo.env_timezone))}`],
          ['日志保留', `${hMono(esc(retText), ' num')} ${srcTag(sysInfo.log_retention_source, sysInfo.env_log_retention_days != null)}${lastClean ? hMs(esc(lastClean), ' t2xs') : ''}${isAdmin ? ' <button type="button" class="link-btn t2xs" id="sys-go-ret">修改</button>' : ''}`],
          ['服务端时间', `${hMono(esc(formatDate(sysInfo.server_time)), ' txs num')} ${hTag(esc(dispTz || '本地时区'))}`],
        ])
      : hMut('系统运行信息暂不可用。');

    const sysCard = cardHtml(
      '运行时与系统信息',
      sysBody,
      `<span class="bdg ${healthOk ? 'bd-ok' : 'bd-er'}"><span class="dot"></span>${healthOk ? '健康' : '异常'}</span>`,
    );

    const dispOpts: Array<[string, string]> = [
      ['server', `跟随系统 (${sysInfo?.timezone || 'UTC'})`],
      ['browser', '浏览器本地'],
      ...TIMEZONE_PRESETS.map(([z, l]): [string, string] => [z, l]),
    ];
    if (
      state.timezonePref !== 'server' &&
      state.timezonePref !== 'browser' &&
      !dispOpts.some(([z]) => z === state.timezonePref)
    ) {
      dispOpts.push([state.timezonePref, state.timezonePref]);
    }

    const curSysTz = sysInfo?.timezone ?? '';
    const isPresetSysTz = Boolean(curSysTz && TIMEZONE_PRESETS.some(([z]) => z === curSysTz));
    const sysTzInit =
      sysInfo?.timezone_source === 'setting' ? (isPresetSysTz ? curSysTz : '__custom__') : '';
    const sysCustomInit = sysInfo?.timezone_source === 'setting' && !isPresetSysTz ? curSysTz : '';
    const sysTzOpts: Array<[string, string]> = [
      ['', sysInfo?.env_timezone ? `跟随环境变量 (${sysInfo.env_timezone})` : '系统默认 (UTC)'],
      ...TIMEZONE_PRESETS.map(([z, l]): [string, string] => [z, l]),
      ['__custom__', '自定义 IANA 时区…'],
    ];

    const RET_PRESETS = ['0', '7', '14', '30', '90', '180'];
    const envRet = sysInfo?.env_log_retention_days;
    const retOpts: Array<[string, string]> = [
      ['', envRet != null ? `跟随环境变量 (${envRet} 天)` : '系统默认 (30 天)'],
      ['0', '不自动清理'],
      ['7', '7 天'],
      ['14', '14 天'],
      ['30', '30 天'],
      ['90', '90 天'],
      ['180', '180 天'],
      ['__custom__', '自定义天数…'],
    ];
    const isSetRet = sysInfo?.log_retention_source === 'setting';
    const isPreRet = isSetRet && RET_PRESETS.includes(String(retDays));
    const retInit = isSetRet ? (isPreRet ? String(retDays) : '__custom__') : '';
    const retCustomInit = isSetRet && !isPreRet ? String(retDays) : '';

    const tzAdminHtml = isAdmin
      ? `<form id="tz-sys-form" class="ssm mt-2"><div class="grid-2">${fieldHtml(
          'tz-sys-sel',
          '系统调度与基准时区 (管理员)',
          selectHtml('tz-sys-sel', sysTzOpts, sysTzInit, 'input ism'),
        )}${fieldHtml(
          'tz-custom',
          '自定义 IANA 时区 (覆盖环境变量)',
          hInp('tz-custom', 'text', `placeholder="如 Asia/Seoul" value="${esc(sysCustomInit)}"`, 'input ism mono'),
        )}</div><div class="grid-2">${fieldHtml(
          'ret-sys-sel',
          '日志自动清理保留期',
          selectHtml('ret-sys-sel', retOpts, retInit, 'input ism'),
        )}${fieldHtml(
          'ret-custom',
          '自定义保留天数 (覆盖环境变量)',
          hInp('ret-custom', 'number', `min="0" max="3650" step="1" placeholder="如 15（0 为不清理）" value="${esc(retCustomInit)}"`, 'input ism mono num'),
        )}</div><div class="row gxs wrap">${[
          ['0', '不清理'],
          ['7', '7天'],
          ['14', '14天'],
          ['30', '30天'],
          ['90', '90天'],
        ].map(([v, l]) => `<button type="button" class="chip t2xs" data-ret-pre="${v}">${l}</button>`).join('')}</div><div class="rb gxs wrap"><span class="mut t2xs">生效优先级：页面自定义设置（覆盖环境变量） &gt; 环境变量 &gt; 系统默认</span><div class="row gxs wrap"><button type="submit" class="btn bsm bp">保存配置</button>${btn(`${icons.trash()} 立即清理过期日志`, 'id="btn-run-cleanup"', 'bsm bg')}</div></div><div id="cleanup-confirm-box" class="card-inset rb gxs wrap hidden"><span class="txs">确定清理超过保留期的历史执行日志、设备事件、审计记录与过期会话吗？（不可恢复）</span><div class="row gxs">${btn('取消', 'id="btn-cleanup-cancel"', 'bxs bg')}${btn('确认清理', 'id="btn-cleanup-confirm"', 'bxs be')}</div></div></form>`
      : '';

    const tzCard = cardHtml(
      '时区与日志保留策略',
      `<div class="ssm">${fieldHtml('tz-disp-sel', '本机显示时区 (仅当前浏览器)', selectHtml('tz-disp-sel', dispOpts, state.timezonePref, 'input ism'))}${tzAdminHtml}</div>`,
      hTag(esc(dispTz || '浏览器本地')),
      'mt-3" id="tz-sys-card',
    );

    const keysCard = cardHtml(
      '探针 API Keys',
      tableHtml(['名称', '作用域', '密钥前缀', '归属账号', '创建时间', '最近使用', hThTr()], keyRows, '暂无 API Key，可在右上角点击生成。', 'tbl-r'),
      `<form id="key-form" class="row gxs">${hInp('key-name', 'text', 'placeholder="密钥名称 (可选)"', 'input ism')}<button type="submit" class="btn bsm bp">${icons.plus()} 生成 API Key</button></form>`,
      'mt-3',
    );

    const usersCard = isAdmin
      ? cardHtml(
          '用户管理 (管理员)',
          tableHtml(['ID', '用户名', '邮箱', '角色', '创建时间', hThTr()], userRows, '暂无用户数据。', 'tbl-r'),
          btn(`${icons.plus()} 新增用户`, 'id="btn-new-user"', 'bsm bp'),
          'mt-3',
        )
      : '';

    ctx.root.innerHTML =
      pageHeadHtml('系统设置', '密码、API Keys、成员与系统状态') +
      `<div class="grid-2">${profileCard}${sysCard}</div>${tzCard}${keysCard}${usersCard}`;

    on(ctx.root, '#tz-disp-sel', (el) => {
      setTimezonePref((el as HTMLSelectElement).value);
      toast('显示时区已更新', 'ok');
      paint();
    }, 'change');

    if (isAdmin) {
      on(ctx.root, '#sys-go-ret', () => {
        ctx.root.querySelector('#tz-sys-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        ctx.root.querySelector<HTMLElement>('[data-csel-for="ret-sys-sel"]')?.focus();
      });
      const selEl = ctx.root.querySelector('#tz-sys-sel') as HTMLSelectElement | null;
      const custEl = ctx.root.querySelector('#tz-custom') as HTMLInputElement | null;
      selEl?.addEventListener('change', () => {
        if (selEl.value !== '__custom__' && custEl) custEl.value = '';
      });
      custEl?.addEventListener('input', () => {
        if (custEl.value.trim() && selEl) {
          selEl.value = '__custom__';
          syncSelectUi(selEl);
        }
      });
      const retSelEl = ctx.root.querySelector('#ret-sys-sel') as HTMLSelectElement | null;
      const retCustEl = ctx.root.querySelector('#ret-custom') as HTMLInputElement | null;
      retSelEl?.addEventListener('change', () => {
        if (retSelEl.value !== '__custom__' && retCustEl) retCustEl.value = '';
      });
      retCustEl?.addEventListener('input', () => {
        if (retCustEl.value.trim() !== '' && retSelEl) {
          retSelEl.value = '__custom__';
          syncSelectUi(retSelEl);
        }
      });
      onAll(ctx.root, '[data-ret-pre]', (b) => {
        if (retSelEl && b.dataset.retPre !== undefined) {
          retSelEl.value = b.dataset.retPre;
          syncSelectUi(retSelEl);
          if (retCustEl) retCustEl.value = '';
        }
      });

      on(ctx.root, '#tz-sys-form', async (_el, ev) => {
        ev.preventDefault();
        const selVal = val(ctx.root, '#tz-sys-sel');
        const customVal = val(ctx.root, '#tz-custom');
        let timezone: string | null;
        if (selVal === '__custom__' || customVal) {
          if (!customVal || !isValidTimeZone(customVal)) {
            toast('请输入有效的 IANA 时区名称 (如 Asia/Shanghai)', 'warn');
            return;
          }
          timezone = customVal;
        } else {
          timezone = selVal || null;
        }
        const retSelVal = val(ctx.root, '#ret-sys-sel');
        const retCustomRaw = val(ctx.root, '#ret-custom');
        let log_retention_days: number | null;
        if (retSelVal === '__custom__' || retCustomRaw !== '') {
          if (!/^\d+$/.test(retCustomRaw) || Number(retCustomRaw) > 3650) {
            toast('请输入 0–3650 之间的保留天数', 'warn');
            return;
          }
          log_retention_days = Number(retCustomRaw);
        } else {
          log_retention_days = retSelVal === '' ? null : Number(retSelVal);
        }
        try {
          const updated = await api.updateSystemSettings({ timezone, log_retention_days });
          state.systemInfo = updated;
          syncActiveTimeZone();
          toast('系统时区与清理配置已保存', 'ok');
          await load();
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '保存系统配置失败', 'err');
        }
      }, 'submit');

      const cBox = ctx.root.querySelector('#cleanup-confirm-box');
      on(ctx.root, '#btn-run-cleanup', () => cBox?.classList.toggle('hidden'));
      on(ctx.root, '#btn-cleanup-cancel', () => cBox?.classList.add('hidden'));
      on(ctx.root, '#btn-cleanup-confirm', async (el) => {
        const b = el as HTMLButtonElement;
        b.disabled = true;
        try {
          const res = await api.runSystemCleanup();
          const totalDel = Object.values(res.deleted ?? {}).reduce((a, n) => a + (Number(n) || 0), 0);
          toast(`日志清理完成，共移除 ${totalDel} 条记录`, 'ok');
          await load();
        } catch (err) {
          toast(err instanceof ApiError ? err.message : '日志清理失败', 'err');
          b.disabled = false;
        }
      });
    }

    on(ctx.root, '#pw-form', async (el, ev) => {
      ev.preventDefault();
      const old_password = (ctx.root.querySelector('#pw-old') as HTMLInputElement).value;
      const new_password = (ctx.root.querySelector('#pw-new') as HTMLInputElement).value;
      if (new_password !== (ctx.root.querySelector('#pw-confirm') as HTMLInputElement).value) {
        toast('两次输入的新密码不一致', 'warn');
        return;
      }
      try {
        await api.changePassword({ old_password, new_password });
        toast('密码已更新', 'ok');
        (el as HTMLFormElement).reset();
      } catch (err) {
        toast(err instanceof ApiError ? err.message : '修改密码失败', 'err');
      }
    }, 'submit');

    on(ctx.root, '#key-form', async (_el, ev) => {
      ev.preventDefault();
      const nameInput = ctx.root.querySelector('#key-name') as HTMLInputElement;
      try {
        const res = await api.createApiKey({ name: nameInput.value.trim() || undefined });
        state.mintedKeys[res.id] = res.api_key;
        saveCachedDeployKey(res.id, res.api_key, state.user?.id);
        nameInput.value = '';
        await load();
        openModal({
          title: 'API Key 已生成 — 请立即复制',
          bodyHtml: `<div class="ssm"><div class="alert alert-warn">此明文仅展示这一次，关闭后无法找回。</div>${codeBoxHtml(res.api_key, 'id="ak-copy"')}</div>`,
          footerHtml: btn('完成', 'data-done', 'bp'),
          onMount(panel, close) {
            on(panel, '[data-done]', close);
            on(panel, '#ak-copy', () => void copyText(res.api_key, '已复制 API Key'));
          },
        });
      } catch (err) {
        toast(err instanceof ApiError ? err.message : '生成 API Key 失败', 'err');
      }
    }, 'submit');

    onAll(ctx.root, '[data-del-key]', (b) => {
      const id = b.dataset.delKey;
      if (!id) return;
      const keyDevice = b.dataset.keyDevice;
      confirmModal({
        title: '吊销 API Key',
        bodyHtml: keyDevice
          ? `<p>吊销后仅绑定主机 "${esc(keyDevice)}" 失去认证权限，可在主机“安装命令”中重新签发。</p>`
          : '<p>吊销后使用该密钥的探针将立即失去认证权限，确定继续吗？</p>',
        confirmLabel: '确认吊销',
        danger: true,
        async onConfirm() {
          await api.deleteApiKey(id);
          delete state.mintedKeys[id];
          if (loadCachedDeployKey(state.user?.id)?.id === id) {
            clearCachedDeployKey();
          }
          toast('已吊销 API Key', 'ok');
          await load();
        },
      });
    });

    on(ctx.root, '#btn-new-user', () => {
      formModal({
        title: '新增用户账号',
        formId: 'nu-form',
        submitLabel: '创建用户',
        fieldsHtml:
          fieldHtml('nu-user', '用户名', hInp('nu-user', 'text', 'required minlength="3" maxlength="50"')) +
          fieldHtml('nu-email', '邮箱', hInp('nu-email', 'email', 'placeholder="operator@example.com"')) +
          fieldHtml('nu-pass', '密码', hInp('nu-pass', 'password', 'required minlength="6"')) +
          fieldHtml('nu-role', '角色', selectHtml('nu-role', [['0', '普通成员'], ['1', '管理员']], '0', 'input')),
        async onSubmit(panel, close) {
          const username = val(panel, '#nu-user');
          const email = val(panel, '#nu-email') || undefined;
          const password = (panel.querySelector('#nu-pass') as HTMLInputElement).value;
          const role = Number(val(panel, '#nu-role')) as UserRole;
          await api.createUser({ username, email, password, role });
          close();
          toast(`已创建用户 "${username}"`, 'ok');
          await load();
        },
      });
    });

    onAll(ctx.root, '[data-del-user]', (b) => {
      const uid = Number(b.dataset.delUser);
      const uname = b.dataset.uname ?? String(uid);
      const isAdminTarget = Number(b.dataset.urole) === UserRole.ADMIN;
      confirmModal({
        title: isAdminTarget ? '删除管理员' : '删除用户',
        bodyHtml: isAdminTarget
          ? `<p>确定删除管理员 <strong>${esc(uname)}</strong> 吗？</p><p class="mut txs mt-1">删除管理员后，其名下探针 API Keys、主机与分组将自动移交至当前管理员名下，已部署探针不会断联。</p>`
          : `<p>确定删除用户 <strong>${esc(uname)}</strong> 吗？</p><p class="mut txs mt-1">其名下主机与分组将移交至当前管理员，个人 API Keys 将被吊销。</p>`,
        confirmLabel: '确认删除',
        danger: true,
        async onConfirm() {
          await api.deleteUser(uid);
          toast(`已删除用户 "${uname}"`, 'ok');
          await load();
        },
      });
    });
  };

  await load();
}
