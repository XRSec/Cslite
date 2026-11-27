# Cslite — 轻量级跨平台远程控制与批量执行平台

Cslite 是一个面向资源受限环境与无服务器（Serverless）场景的轻量级远程控制与命令编排平台：零 Redis、零消息队列，服务端采用纯 Web Standards 架构，可零改造部署至 **Node.js**、**Cloudflare Workers + D1** 与 **腾讯云 SCF**；客户端支持 **Linux**、**OpenWrt**（Go 全量版与 BusyBox Lite 脚本版）、**macOS** 与 **Windows**。

---

## 核心特性

- **多运行时服务端（TypeScript + Hono）**
  - **Node.js**（`>= 22.5`，内置 `node:sqlite`，开箱即用；亦支持 MySQL / Turso）
  - **Cloudflare Workers**（原生绑定 D1 数据库，或通过 HTTP 接入 Turso）
  - **腾讯云 SCF**（支持 Web Function `scf_bootstrap` 监听 `9000` 端口及 API 网关事件函数 `scf.main_handler`，支持 MySQL / Turso / `/tmp` SQLite）
- **单文件 Platypus 风格 Web UI（`web/`）**
  - 构建为单一无外部依赖 HTML（打包产物内嵌于 `server/src/ui-bundle.ts` 与 `web/dist/index.html`）
  - **Multi-Host Console**：多设备/多分组并发下发命令，支持实时轮询与逐行输出对比（Output Diff）
  - **设备与分组管理**：状态与平台筛选、系统遥测（CPU/内存/磁盘/负载/网络速率）、多平台一键安装弹窗（含现场生成 API Key）
  - **任务与 Cron 调度**：支持 `immediate`（立即）、`once`（一次性/定时）、`cron`（5 字段 UTC 表达式）及暂停/恢复/取消
  - **安全与审计**：PBKDF2-SHA256 密码哈希、`cslite_session` HttpOnly 会话 Cookie、`ak_live_*` API Key 认证、操作审计日志与深浅色主题切换
- **跨平台轻量 Agent（`agent/`）**
  - **全平台 Go 静态编译二进制**：无 CGO 依赖，内置服务生命周期 CLI（`install` / `uninstall` / `start` / `stop` / `restart` / `status` / `config` / `exec` / `run`）
    - Linux：`systemd`（系统级 `/etc/systemd/system` 与 `--user` 用户级）
    - OpenWrt：`procd` `/etc/init.d/cslite-agent`（`frpc` 风格）+ UCI `/etc/config/cslite-agent` + `/etc/cslite-agent` 持久化
    - macOS：`launchd`（`LaunchDaemons` / `--user` `LaunchAgents`）
    - Windows：Windows Service SCM（含自动恢复策略与 UTF-8 命令输出支持）
  - **OpenWrt 极简 Shell 版（`cslite-agent-lite`）**：纯 POSIX/BusyBox `ash` 实现，使用 `uclient-fetch`/`wget`/`curl` 与 `jsonfilter`/`awk`，适配 4MB/8MB Flash 路由器，提供 `.ipk` 打包脚本

---

## 快速开始

### 1. 环境准备

- **Node.js `>= 22.5`**（使用内置 `node:sqlite` 驱动）
- **Go `>= 1.24`**（编译或交叉编译 Agent 时需要）

### 2. 本地启动服务端

```bash
# 安装依赖（Node 与 Go 模块）
make install

# 构建单文件前端并以开发热重载模式启动 Node 服务（默认 SQLite: ./data/cslite.db）
make dev
```

服务默认监听 `http://0.0.0.0:9000`（可通过 `CSLITE_PORT` / `PORT` 调整）。

- 浏览器访问：`http://127.0.0.1:9000`
- 默认管理员账号：`admin` / `admin`（生产环境请设置 `CSLITE_ADMIN_PASSWORD` 或登录后在 **Settings & Access** 页面修改密码）

### 3. 常用命令

```bash
make build-web          # 编译打包单文件 Web UI -> web/dist/index.html & server/src/ui-bundle.ts
make typecheck          # 严格 TypeScript 类型检查（服务端与前端）
make dev                # 启动本地 Node 开发服务
make dev-worker         # 本地启动 Cloudflare Workers (wrangler dev)
make deploy-worker      # 构建前端并部署至 Cloudflare Workers
make build-scf          # 构建腾讯云 SCF 部署包 -> deploy/scf/dist/cslite-scf.zip
make build-agent        # 编译当前平台 cslite-agent 二进制
make build-agent-all    # 交叉编译 9 大平台/架构 Agent -> dist/agent/
make build-openwrt-ipk  # 构建 OpenWrt .ipk 安装包 -> dist/openwrt/
make test               # 全链路验证（build-web + typecheck + vitest + go vet + go test -race）
make clean              # 清理构建产物
```

### 4. 快速接入 Agent

在 Web 控制台创建 API Key（或在 **Fleet -> Add Device** 弹窗中一键生成），然后在目标主机执行：

```bash
# Linux / OpenWrt / macOS（Go 全量版）
cslite-agent install --server "https://your-cslite-host" --key "ak_live_xxx" --name "edge-node-01"

# 或使用一键安装脚本
curl -fsSL https://raw.githubusercontent.com/XRSec/Cslite/main/agent/scripts/install.sh | \
  sh -s -- --server "https://your-cslite-host" --key "ak_live_xxx"

# OpenWrt 极简 BusyBox Shell 版
sh agent/scripts/install.sh --lite --server "https://your-cslite-host" --key "ak_live_xxx"
```

```powershell
# Windows（管理员 PowerShell）
.\agent\scripts\install.ps1 -Server "https://your-cslite-host" -Key "ak_live_xxx"
```

---

## 文档导航

- 部署全指南（Node / Docker / Cloudflare Workers + D1 / 腾讯云 SCF / 多平台 Agent）：[`docs/deploy.md`](docs/deploy.md)
- 文档总览与架构摘要：[`docs/README.md`](docs/README.md)
- 环境变量参考：[`docs/development/environment.md`](docs/development/environment.md)
- 错误码参考：[`docs/development/error-codes.md`](docs/development/error-codes.md)
- 服务端概览与数据模型：[`docs/server/overview.md`](docs/server/overview.md)、[`docs/server/data-models.md`](docs/server/data-models.md)
- API 参考：
  - 认证与用户：[`docs/server/api/auth.md`](docs/server/api/auth.md)
  - 设备与分组：[`docs/server/api/devices.md`](docs/server/api/devices.md)
  - 命令与执行：[`docs/server/api/commands.md`](docs/server/api/commands.md)
  - 权限模型：[`docs/server/api/permissions.md`](docs/server/api/permissions.md)
  - Agent 通信协议：[`docs/agent/api.md`](docs/agent/api.md)
- 注意事项：[`docs/注意事项.md`](docs/注意事项.md)

---

## 项目结构

```text
├── shared/                  # 前后端共享冻结契约 v1（DTO 与错误码）
│   └── types.ts
├── server/                  # Hono 多运行时服务端（TypeScript）
│   ├── migrations/          # Cloudflare D1 SQL 迁移脚本
│   ├── src/
│   │   ├── app.ts           # 可移植 Web-Standards Hono 应用核心
│   │   ├── config.ts        # 运行时无关配置解析
│   │   ├── entry-node.ts    # Node.js 入口（node:sqlite / MySQL / Turso）
│   │   ├── entry-worker.ts  # Cloudflare Workers 入口（D1 / Turso）
│   │   ├── entry-scf.ts     # 腾讯云 SCF API 网关事件入口
│   │   ├── db/              # 数据库驱动（d1 / node-sqlite / mysql / turso）与 Schema
│   │   ├── lib/             # 加密（PBKDF2/SHA256）、5 字段 UTC Cron 解析、状态收敛
│   │   ├── middleware/      # Cookie / Bearer / API Key 认证与 CSRF 中间件
│   │   └── routes/          # auth / devices / groups / commands / agent / logs / system
│   ├── test/                # Vitest 接口、适配器与并发测试
│   └── wrangler.toml        # Cloudflare Workers 与 D1 配置
├── web/                     # Platypus 风格单文件 SPA 前端（TypeScript + CSS）
│   ├── build.mjs            # esbuild 打包脚本（输出 web/dist/index.html 与 server/src/ui-bundle.ts）
│   └── src/                 # 路由、API 客户端、组件与视图（含 Multi-Host Console）
├── agent/                   # 跨平台 Go Agent 与 OpenWrt 适配
│   ├── main.go              # CLI 入口（run/install/uninstall/start/stop/restart/status/config/exec）
│   ├── internal/            # client / config / core / exec / metrics / protocol / service / state
│   ├── openwrt/             # procd init、UCI 配置、cslite-agent-lite.sh、build-ipk.sh
│   └── scripts/             # install.sh（Linux/OpenWrt/macOS）、install.ps1（Windows）
├── deploy/                  # 部署打包配置
│   ├── docker/Dockerfile    # Node 22 Alpine 多阶段镜像
│   └── scf/                 # 腾讯云 SCF Web Function 引导脚本与打包器
├── docs/                    # 项目文档
├── Makefile                 # 统一构建、交叉编译与测试入口
└── package.json
```
