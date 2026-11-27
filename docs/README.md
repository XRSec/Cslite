# Cslite 文档总览

- **项目定位**：轻量、多运行时、无外部中间件依赖的远程控制与批量执行平台。服务端基于 **TypeScript + Hono**（可部署于 Node.js、Cloudflare Workers + D1、腾讯云 SCF），任务在数据库中持久化与原子抢占，客户端 Agent 通过 `/api/agent/*` 主动轮询拉取与上报结果。

## 文档结构

- **部署指南**：[`docs/deploy.md`](./deploy.md)（Node / Docker / Cloudflare Workers + D1 / 腾讯云 SCF / 多平台 Agent）
- **服务端概览与数据模型**：
  - [`docs/server/overview.md`](./server/overview.md)
  - [`docs/server/data-models.md`](./server/data-models.md)
- **服务端 API 说明**：`docs/server/api/`
  - 认证与用户 `/api/auth/*`：[`docs/server/api/auth.md`](./server/api/auth.md)
  - 设备与分组 `/api/devices/*`、`/api/groups/*`：[`docs/server/api/devices.md`](./server/api/devices.md)
  - 命令与执行 `/api/commands/*`：[`docs/server/api/commands.md`](./server/api/commands.md)
  - 权限与认证机制：[`docs/server/api/permissions.md`](./server/api/permissions.md)
- **Agent 通信协议**：[`docs/agent/api.md`](./agent/api.md)（`/api/agent/*`）
- **开发与配置参考**：
  - 环境变量配置：[`docs/development/environment.md`](./development/environment.md)
  - 错误码参考：[`docs/development/error-codes.md`](./development/error-codes.md)
  - 最佳实践：[`docs/development/best-practices.md`](./development/best-practices.md)
  - 计划事项：[`docs/development/plans.md`](./development/plans.md)
- **注意事项**：[`docs/注意事项.md`](./注意事项.md)
- **根 README**：[`README.md`](../README.md)

## 设计摘要

- **无长驻调度器，支持 Serverless**：不依赖 Redis 或后台常驻 cron 守护进程；`once`（定时）与 5 字段 UTC `cron` 命令由服务端存储 `next_run_at`，并在 Agent 轮询 `/api/agent/commands` 时通过数据库唯一索引与原子 `UPDATE ... WHERE status = 'queued'` 惰性实例化与并发防重。
- **惰性超时回收**：查询命令详情或 Agent 轮询时自动回收已超时的 `running` 任务并收敛父执行状态（`reapTimedOutExecutions`）。
- **单文件内嵌前端**：`web/` 构建产物内嵌于 `server/src/ui-bundle.ts`，支持 Cloudflare Workers 与 SCF 单包运行。
- **认证与安全**：Web 会话使用 `cslite_session` HttpOnly Cookie（写请求校验 CSRF 同源或 JSON 头）与 Bearer 会话令牌；程序与 Agent 支持 `X-API-Key: ak_live_...`。
