# 计划事项（Done / TODO）

## Done（已完成）

- **多运行时 TypeScript + Hono 服务端**：
  - 统一 Web Standards 核心（[`server/src/app.ts`](../../server/src/app.ts)），支持 **Node.js**（`node:sqlite` / MySQL / Turso）、**Cloudflare Workers + D1** 与 **腾讯云 SCF**（Web Function 与 APIGW Event Handler）
  - 共享冻结契约 [`shared/types.ts`](../../shared/types.ts) 与自动建表/种子管理员迁移
- **认证、API Key 与权限控制**：
  - PBKDF2-SHA256（100,000 次迭代）密码哈希与 SHA-256 摘要会话表
  - 支持 `cslite_session` HttpOnly Cookie（含写操作 CSRF 校验）、Bearer Session Token 与 `X-API-Key`（`ak_live_*`）
  - 完整的 API Key 列表/生成/删除与管理员用户管理（创建/列表/删除）
- **设备、分组与调度引擎**：
  - 设备 CRUD、多条件过滤、在线状态基于 `max(heartbeat_interval * 3, 90)` 秒自动计算、批量删除与多平台安装命令生成
  - 分组管理（创建/编辑/删组/批量移入移除设备）
  - 5 字段 UTC Cron 解析器、惰性定时/Cron 触发（`UNIQUE (command_id, scheduled_for)` 并发防重）、原子任务抢占与惰性超时回收
- **Platypus 风格单文件 Web UI**：
  - `web/build.mjs` 通过 `esbuild` 打包为单一内嵌 HTML（`web/dist/index.html` 与 `server/src/ui-bundle.ts`）
  - Overview 仪表盘、Fleet 设备池、Multi-Host Console（多机并行执行 + 逐行 Output Diff 对比）、Groups、Tasks & Cron、Logs & Audit（含日志下载）、Settings & Access（API Key 与用户管理）、多平台安装弹窗与深浅色主题切换
- **跨平台 Agent 与 OpenWrt 生态**：
  - Go 静态编译单二进制，支持 Linux `systemd`、OpenWrt `procd`、macOS `launchd` 与 Windows Service SCM
  - 完整 CLI（`run` / `install` / `uninstall` / `start` / `stop` / `restart` / `status` / `config` / `exec` / `version`）
  - OpenWrt 极简 BusyBox Shell 版（`cslite-agent-lite.sh`）、`frpc` 风格 `init.d` + UCI 配置、`.ipk` 打包脚本与 `install.sh` / `install.ps1`
- **自动化测试覆盖**：
  - Vitest 覆盖前端构建/逻辑、SQLite/Turso/SCF 适配器、API 全流程与并发防重（25 个测试用例）
  - `go vet` 与 `go test -race` 覆盖 Agent 核心、配置、指标、执行器、状态与服务渲染

## TODO（后续增强）

- 细粒度 RBAC 权限与只读审计员角色
- Agent 自动在线升级与版本灰度分发
- Webhook / 告警通知集成（设备离线或任务失败触发）
- API 速率限制与防爆破策略（如基于 Cloudflare Rate Limiting 或中间件增强）
- 日志归档与自动清理保留策略（Retention Policy）
