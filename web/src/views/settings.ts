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
  infoGridHtml,
  on,
  onAll,
  pageHeadHtml,
  tableHtml,
  val,
} from '../components/ui';
import { icons } from '../icons';
import type { RouteContext } from '../router';
import { copyText, openModal, state, toast } from '../state';
import { esc, formatDate, formatRelativeZh } from '../utils';

export async function renderSettings(ctx: RouteContext): Promise<void> {
  const isAdmin = state.user?.role === UserRole.ADMIN;
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
      healthOk = hRes;
      users = uRes?.users ?? [];
      paint();
    } catch (err) {
      if (!ctx.isStale()) toast(err instanceof ApiError ? err.message : '加载设置失败', 'err');
    }
  };

  const paint = () => {
    const keyRows = keys
      .map(
        (k) =>
          `<tr><td><strong>${esc(k.name)}</strong></td><td class="mono txs">${esc(k.key_prefix || k.id.slice(0, 12))}…</td><td class="txs mut num">${esc(formatDate(k.created_at))}</td><td class="txs mut">${k.last_used ? esc(formatRelativeZh(k.last_used)) : '从未使用'}</td><td class="tr">${btn(`${icons.trash()} 吊销`, `data-del-key="${esc(k.id)}"`, 'bxs bg ter')}</td></tr>`,
      )
      .join('');

    const userRows = users
      .map(
        (u) =>
          `<tr><td class="mono txs num">${esc(u.id)}</td><td><strong>${esc(u.username)}</strong></td><td class="txs mut">${esc(u.email || '—')}</td><td><span class="tag">${u.role === UserRole.ADMIN ? '管理员' : '普通成员'}</span></td><td class="txs mut num">${esc(formatDate(u.created_at))}</td><td class="tr">${
            u.id === state.user?.id
              ? '<span class="mut txs">(当前账号)</span>'
              : btn(icons.trash(), `data-del-user="${esc(u.id)}" data-uname="${esc(u.username)}"`, 'bxs bg ter')
          }</td></tr>`,
      )
      .join('');

    const profileCard = cardHtml(
      '个人资料与密码安全',
      `${infoGridHtml([
        ['用户名', `<strong>${esc(state.user?.username ?? '—')}</strong>`],
        ['邮箱', esc(state.user?.email || '—')],
      ])}<form id="pw-form" class="ssm mt-2">${fieldHtml('pw-old', '当前密码', '<input id="pw-old" class="input ism" type="password" autocomplete="current-password" required>')}${fieldHtml('pw-new', '新密码', '<input id="pw-new" class="input ism" type="password" autocomplete="new-password" required minlength="6">')}${fieldHtml('pw-confirm', '确认新密码', '<input id="pw-confirm" class="input ism" type="password" autocomplete="new-password" required minlength="6">')}<button type="submit" class="btn bsm bp">更新密码</button></form>`,
      `<span class="tag">${isAdmin ? '管理员' : '成员'}</span>`,
    );

    const sysBody = sysInfo
      ? infoGridHtml([
          ['系统版本', `<span class="mono">${esc(sysInfo.version)}</span>`],
          ['运行环境', `<span class="tag">${esc(sysInfo.runtime)}</span>`],
          ['数据库方言', `<span class="tag">${esc(sysInfo.db_dialect)}</span>`],
          ['探针自动注册', sysInfo.allow_registration ? '已开启' : '已关闭'],
          ['心跳间隔', `<span class="mono num">${esc(sysInfo.heartbeat_interval)}s</span>`],
          ['轮询间隔', `<span class="mono num">${esc(sysInfo.poll_interval)}s</span>`],
          ['服务端 UTC', `<span class="mono txs num">${esc(formatDate(sysInfo.server_time))}</span>`],
        ])
      : '<div class="mut txs">系统运行信息暂不可用。</div>';

    const sysCard = cardHtml(
      '运行时与系统信息',
      sysBody,
      `<span class="bdg ${healthOk ? 'bd-ok' : 'bd-er'}"><span class="dot"></span>${healthOk ? '健康' : '异常'}</span>`,
    );

    const keysCard = cardHtml(
      '探针 API Keys',
      tableHtml(['名称', '密钥前缀', '创建时间', '最近使用', '<span class="tr" style="display:block">操作</span>'], keyRows, '暂无 API Key，可在右上角点击生成。'),
      `<form id="key-form" class="row gxs"><input id="key-name" class="input ism" type="text" placeholder="密钥名称 (可选)"><button type="submit" class="btn bsm bp">${icons.plus()} 生成 API Key</button></form>`,
      'mt-3',
    );

    const usersCard = isAdmin
      ? cardHtml(
          '用户管理 (管理员)',
          tableHtml(['ID', '用户名', '邮箱', '角色', '创建时间', '<span class="tr" style="display:block">操作</span>'], userRows, '暂无用户数据。'),
          btn(`${icons.plus()} 新增用户`, 'id="btn-new-user"', 'bsm bp'),
          'mt-3',
        )
      : '';

    ctx.root.innerHTML =
      pageHeadHtml('系统设置', '密码、API Keys、成员与系统状态') +
      `<div class="grid-2">${profileCard}${sysCard}</div>${keysCard}${usersCard}`;

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
      confirmModal({
        title: '吊销 API Key',
        bodyHtml: '<p>吊销后使用该密钥的探针将立即失去认证权限，确定继续吗？</p>',
        confirmLabel: '确认吊销',
        danger: true,
        async onConfirm() {
          await api.deleteApiKey(id);
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
          fieldHtml('nu-user', '用户名', '<input id="nu-user" class="input" type="text" required minlength="3" maxlength="50">') +
          fieldHtml('nu-email', '邮箱', '<input id="nu-email" class="input" type="email" placeholder="operator@example.com">') +
          fieldHtml('nu-pass', '密码', '<input id="nu-pass" class="input" type="password" required minlength="6">') +
          fieldHtml('nu-role', '角色', '<select id="nu-role" class="input"><option value="0">普通成员</option><option value="1">管理员</option></select>'),
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
      confirmModal({
        title: '删除用户',
        bodyHtml: `<p>确定删除用户 <strong>${esc(uname)}</strong> 吗？</p>`,
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
