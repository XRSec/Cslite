import type { DeviceDTO, GroupDTO } from '../../../shared/types';
import { api, ApiError } from '../api';
import { platformBadge, statusBadge } from '../components/badges';
import { btn, confirmModal, fieldHtml, formModal, on, onAll, pageHeadHtml, targetItemHtml, val } from '../components/ui';
import { icons } from '../icons';
import type { RouteContext } from '../router';
import { openModal, state, toast } from '../state';
import { esc, formatDate } from '../utils';

export async function renderGroups(ctx: RouteContext): Promise<void> {
  let groups: GroupDTO[] = [];
  let devices: DeviceDTO[] = [];

  const load = async () => {
    try {
      const fleet = await api.fetchFleet();
      if (ctx.isStale()) return;
      groups = fleet.groups;
      devices = fleet.devices;
      state.groupsCache = groups;
      state.devicesCache = devices;
      paint();
    } catch (err) {
      if (!ctx.isStale()) toast(err instanceof ApiError ? err.message : '加载分组失败', 'err');
    }
  };

  const memberIdsOf = (g: GroupDTO): Set<string> => {
    const ids = new Set<string>(g.device_ids ?? []);
    for (const d of devices) if (d.group_id === g.id) ids.add(d.id);
    return ids;
  };

  const paint = () => {
    const cardsHtml = !groups.length
      ? '<div class="card emp-i mut">暂无主机分组，点击右上角“新建分组”开始整理设备。</div>'
      : `<div class="cards-grid">${groups
          .map((g) => {
            const members = devices.filter((d) => memberIdsOf(g).has(d.id));
            const onlineCount = members.filter((d) => d.status === 'online').length;
            const count = Math.max(g.device_count ?? 0, members.length);
            return `<div class="card ssm"><div class="rb"><div><h3 class="card-title">${esc(g.name)}</h3><div class="mut txs">${esc(g.description || '暂无描述')}</div></div><span class="grp-pill num">${esc(count)} 台</span></div><div class="mut txs num">${members.length ? `<span class="tok">${onlineCount} 在线</span> · ` : ''}创建于 ${esc(formatDate(g.created_at).slice(0, 10))}</div><div class="rb wrap gxs pt-1"><div class="row gxs">${btn(`${icons.devices()} 分配主机`, `data-members="${esc(g.id)}"`, 'bxs ba')}<a class="btn bxs bg" href="#/console?group=${encodeURIComponent(g.id)}">${icons.console()} 批量执行</a></div><div class="row gxs">${btn(icons.edit(), `data-edit-grp="${esc(g.id)}" title="编辑"`, 'bxs bg')}${btn(icons.trash(), `data-del-grp="${esc(g.id)}" title="删除"`, 'bxs bg ter')}</div></div></div>`;
          })
          .join('')}</div>`;

    ctx.root.innerHTML =
      pageHeadHtml(
        '主机分组',
        '分组管理与批量调度',
        btn(`${icons.refresh()} 刷新`, 'id="grp-refresh"') + btn(`${icons.plus()} 新建分组`, 'id="grp-create"', 'bsm bp'),
      ) + cardsHtml;

    on(ctx.root, '#grp-refresh', () => void load());
    on(ctx.root, '#grp-create', () => openGroupForm());
    onAll(ctx.root, '[data-edit-grp]', (b) => {
      const g = groups.find((x) => x.id === b.dataset.editGrp);
      if (g) openGroupForm(g);
    });
    onAll(ctx.root, '[data-del-grp]', (b) => {
      const g = groups.find((x) => x.id === b.dataset.delGrp);
      if (!g) return;
      confirmModal({
        title: '删除分组',
        bodyHtml: `<p>确定删除分组 <strong>${esc(g.name)}</strong> 吗？（主机不会被删除，仅解除分组关联）</p>`,
        confirmLabel: '确认删除',
        danger: true,
        async onConfirm() {
          await api.deleteGroup(g.id);
          toast(`已删除分组 "${g.name}"`, 'ok');
          await load();
        },
      });
    });
    onAll(ctx.root, '[data-members]', (b) => {
      const g = groups.find((x) => x.id === b.dataset.members);
      if (g) openMembersModal(g);
    });
  };

  const openGroupForm = (existing?: GroupDTO) => {
    formModal({
      title: existing ? `编辑分组 — ${existing.name}` : '新建主机分组',
      formId: 'grp-form',
      submitLabel: existing ? '保存修改' : '立即创建',
      fieldsHtml:
        fieldHtml('gf-name', '分组名称', `<input id="gf-name" class="input" type="text" required maxlength="80" value="${esc(existing?.name ?? '')}" placeholder="例如 edge-routers">`) +
        fieldHtml('gf-desc', '分组描述', `<textarea id="gf-desc" class="input" rows="3" placeholder="OpenWrt 边缘网关集群">${esc(existing?.description ?? '')}</textarea>`),
      async onSubmit(panel, close) {
        const name = val(panel, '#gf-name');
        const description = val(panel, '#gf-desc');
        if (!name) return;
        if (existing) await api.updateGroup(existing.id, { name, description });
        else await api.createGroup({ name, description });
        toast(existing ? '分组已更新' : '分组已创建', 'ok');
        close();
        await load();
      },
    });
  };

  const openMembersModal = (g: GroupDTO) => {
    const initial = memberIdsOf(g);
    const chosen = new Set<string>(initial);

    openModal({
      title: `分配成员主机 — ${g.name}`,
      wide: true,
      bodyHtml: '<div class="ssm"><input id="gm-search" class="input ism" type="search" placeholder="搜索主机名称 / IP…"><div id="gm-list" class="target-list max-h-340"></div></div>',
      footerHtml: `${btn('取消', 'data-cancel', 'bg')}${btn('保存成员', 'id="gm-save"', 'bp')}`,
      onMount(panel, close) {
        let q = '';
        const listEl = panel.querySelector('#gm-list') as HTMLElement;
        const paintList = () => {
          const filtered = devices.filter(
            (d) => !q || `${d.name} ${d.hostname ?? ''} ${d.ip_address ?? ''}`.toLowerCase().includes(q),
          );
          listEl.innerHTML = !filtered.length
            ? '<div class="mut txs p-2">无匹配主机</div>'
            : filtered
                .map((d) =>
                  targetItemHtml(
                    d.id,
                    'gm-chk',
                    chosen.has(d.id),
                    `<div class="rb flex-1 gsm wrap"><div><strong>${esc(d.name)}</strong> <span class="mut txs mono">${esc(d.ip_address || d.hostname || '')}</span></div><div class="row gxs">${platformBadge(d.platform)} ${statusBadge(d.status)}</div></div>`,
                  ),
                )
                .join('');

          onAll(listEl, '.gm-chk', (el) => {
            const c = el as HTMLInputElement;
            const id = c.dataset.id;
            if (!id) return;
            c.checked ? chosen.add(id) : chosen.delete(id);
            c.closest('.target-item')?.classList.toggle('selected', c.checked);
          }, 'change');
        };

        paintList();
        on(panel, '#gm-search', (el) => {
          q = (el as HTMLInputElement).value.trim().toLowerCase();
          paintList();
        }, 'input');
        on(panel, '[data-cancel]', close);
        on(panel, '#gm-save', async () => {
          const toAdd = Array.from(chosen).filter((id) => !initial.has(id));
          const toRemove = Array.from(initial).filter((id) => !chosen.has(id));
          try {
            if (toAdd.length) await api.assignGroupDevices(g.id, toAdd);
            if (toRemove.length) await api.removeGroupDevices(g.id, toRemove);
            close();
            toast(`已更新 "${g.name}" 分组成员`, 'ok');
            await load();
          } catch (err) {
            toast(err instanceof ApiError ? err.message : '更新成员失败', 'err');
          }
        });
      },
    });
  };

  await load();
}
