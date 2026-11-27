# 服务端架构概览

Cslite 服务端基于 **TypeScript + Hono** 构建，采用完全无状态的 Web Standards `fetch` 核心，可在以下三种运行时无缝运行，无需引入 Redis 或独立消息队列：

| 运行时             | 入口文件                         | 支持数据库                              | 说明                                                    |
| ------------------ | -------------------------------- | --------------------------------------- | ------------------------------------------------------- |
| Node.js / Docker   | `server/src/entry-node.ts`       | `node:sqlite`（默认）、MySQL、Turso     | 要求 Node `>= 22.5`（内置 `node:sqlite`），默认端口 `9000` |
| Cloudflare Workers | `server/src/entry-worker.ts`     | Cloudflare D1（默认）、Turso            | 零 Node 依赖 Bundle，支持 `fetch` 与 `scheduled` 触发器 |
| 腾讯云 SCF         | `server/src/entry-scf.ts` / `entry-node.ts` | MySQL、Turso、`/tmp/cslite.db` | 同时支持 Web Function（`scf_bootstrap`）与 APIGW Event (`scf.main_handler`) |

---

## 核心模块与路由

- **应用装配（[`server/src/app.ts`](../../server/src/app.ts)）**：
  - `GET /health`：零 CPU、零数据库健康检查
  - `/api/*` 中间件：首次请求按驱动实例执行一次幂等建表与管理员初始化（`ensureMigrated`）
  - 路由挂载：
    - `/api/auth/*`：登录、注销、当前用户、改密、API Key 管理、用户管理
    - `/api/devices/*`：设备注册槽位、列表过滤、详情、状态探测、更新、单个与批量删除
    - `/api/groups/*`：设备分组 CRUD 与成员批量绑定/解绑
    - `/api/commands/*`：命令下发（`immediate` / `once` / `cron`）、列表、详情、暂停/恢复/取消、结果明细
    - `/api/agent/*`：Agent 注册、心跳、任务拉取（`GET` 与 `POST`）、结果上报
    - `/api/logs/*`：命令执行日志、设备事件日志、用户审计日志与日志纯文本下载
    - `/api/system/info`：运行环境、方言与轮询配置信息
  - 非 `/api/*` 路径统一返回单文件 SPA 页面 `UI_HTML`（[`server/src/ui-bundle.ts`](../../server/src/ui-bundle.ts)）。

## 调度与状态收敛机制

1. **立即任务（`immediate`）与即时 `once`**：创建命令时直接在同一数据库事务/批次中生成 `executions` 与各设备的 `execution_results`（`status = 'queued'`）。
2. **定时任务（future `once` 与 5 字段 UTC `cron`）**：创建时计算 `next_run_at`。当目标 Agent 轮询 `/api/agent/commands` 时，服务端惰性触发到期任务，并借助 `executions(command_id, scheduled_for)` 唯一约束防止并发重复实例化。
3. **原子抢占与超时回收**：Agent 拉取命令时通过 `UPDATE execution_results SET status = 'running' ... WHERE id = ? AND status = 'queued'` 原子认领任务；超时任务在查询详情或下次轮询时惰性标记为 `timeout`，并实时收敛父 `executions` 与非周期 `commands` 状态（`cron` 命令永不置为 `completed`）。

详细架构约束与阅读入口请参见：[`docs/README.md`](../README.md)（[中文版](../README.zh-CN.md)）与 [`docs/deploy.md`](../deploy.md)。
