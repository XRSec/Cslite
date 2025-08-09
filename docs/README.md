# Cslite 文档总览

- 文档目标：仅保留必要内容，便于快速理解与接入
- 本项目定位：轻量、HTTP-only、非长驻服务端。任务由前端写库，客户端轮询执行并上报。

## 文档结构

- `API 说明`：`docs/server/api/`
  - 认证 `/api/auth/*`
  - 设备 `/api/devices/*`
  - 命令 `/api/commands/*`
- `计划事项`：`docs/development/plans.md`（包含已完成与未完成）
- `注意事项`：`docs/注意事项.md`
- 根 README：项目介绍与快速开始（见仓库根 `README.md`）

## 快速入口

- API 起始：`docs/server/api/auth.md`
- 计划与路线：`docs/development/plans.md`
- 注意事项：`docs/注意事项.md`

## 设计摘要（便于 AI/新成员快速读懂）

- 服务端仅提供 HTTP API 与数据存储，不内置任务调度；默认 HTTP，不启用 HTTPS
- 前端提交任务入库；客户端通过轮询拉取任务并执行，上报结果入库（拉取与上报均可视为心跳）
- 会话使用 Cookie，长期使用 HTTP 目前暂不考虑 HTTPS, 可使用 NGINX 反代提供 HTTPS
