# Cslite 部署指南

本文档涵盖 Cslite 服务端（本地 Node.js、Docker、Cloudflare Workers + D1、腾讯云 SCF）与跨平台 Agent（Linux、OpenWrt、macOS、Windows）的完整部署步骤。

---

## 1. 本地 Node.js 与 Docker 部署

### 1.1 本地 Node.js（内置 `node:sqlite`）

**前置要求**：Node.js `>= 22.5`（项目直接调用标准内置模块 `node:sqlite`，无需编译 C++ 插件）。

```bash
# 1. 安装依赖
npm install

# 2. 构建单文件 Web UI（生成 web/dist/index.html 与 server/src/ui-bundle.ts）
node web/build.mjs

# 3. 启动开发/生产服务（默认数据库 ./data/cslite.db，默认端口 9000）
./node_modules/.bin/tsx server/src/entry-node.ts
```

如需热重载开发模式，直接运行：

```bash
make dev
```

使用 **MySQL** 或 **Turso** 替代本地 SQLite：

```bash
# MySQL 示例
export CSLITE_DB_DRIVER=mysql
export CSLITE_DB_DSN="mysql://user:pass@127.0.0.1:3306/cslite"
export CSLITE_ADMIN_PASSWORD="ChangeMeStrong!"
./node_modules/.bin/tsx server/src/entry-node.ts

# Turso / libSQL 示例
export CSLITE_DB_DRIVER=turso
export TURSO_DATABASE_URL="libsql://your-db-org.turso.io"
export TURSO_AUTH_TOKEN="your-turso-token"
./node_modules/.bin/tsx server/src/entry-node.ts
```

> 服务端首次访问 `/api/*` 时会自动执行建表 DDL 并初始化默认管理员（`admin / admin`，可通过 `CSLITE_ADMIN_USERNAME` 与 `CSLITE_ADMIN_PASSWORD` 覆盖）。健康检查端点 `GET /health` 不触碰数据库。

### 1.2 Docker 部署

Dockerfile 位于 [`deploy/docker/Dockerfile`](../deploy/docker/Dockerfile)，采用 `node:22-alpine` 多阶段构建并内置健康检查（端口 `9000`，持久化目录 `/app/data`）：

```bash
# 构建镜像
make docker-build
# 或: docker build -t cslite:latest -f deploy/docker/Dockerfile .

# 运行容器（本地 SQLite 持久化到卷 cslite_data）
docker run -d \
  --name cslite \
  -p 9000:9000 \
  -v cslite_data:/app/data \
  -e CSLITE_ADMIN_USERNAME=admin \
  -e CSLITE_ADMIN_PASSWORD='ChangeMeStrong!' \
  cslite:latest

# 验证健康状态
curl http://127.0.0.1:9000/health
```

若在容器中使用外部 MySQL 或 Turso，仅需追加 `-e CSLITE_DB_DRIVER=mysql -e CSLITE_DB_DSN=...` 或 `-e TURSO_DATABASE_URL=... -e TURSO_AUTH_TOKEN=...`。

---

## 2. Cloudflare Workers + D1 部署

Cloudflare Worker 入口 [`server/src/entry-worker.ts`](../server/src/entry-worker.ts) 使用零 Node 依赖的 Web Standards Hono 应用，支持 **D1 数据库**（默认）或 **Turso HTTP**。

### 步骤

1. **构建前端内嵌资源**：

```bash
make build-web
```

2. **创建 D1 数据库并更新配置**：

```bash
cd server
wrangler d1 create cslite-db
```

将输出的 `database_id` 填入 [`server/wrangler.toml`](../server/wrangler.toml)：

```toml
name = "cslite"
main = "src/entry-worker.ts"
compatibility_date = "2026-01-01"

[[d1_databases]]
binding = "DB"
database_name = "cslite-db"
database_id = "<替换为你的 database_id>"
migrations_dir = "migrations"
```

3. **执行 D1 数据库迁移**：

```bash
# 远端 D1
wrangler d1 migrations apply cslite-db --remote

# 若本地调试（wrangler dev）
wrangler d1 migrations apply cslite-db --local
```

4. **配置运行密钥（Secrets）**：

```bash
# 设置初始管理员密码（强烈建议修改默认值 admin）
wrangler secret put CSLITE_ADMIN_PASSWORD

# 可选：若改用 Turso 替代 D1，可额外配置以下两项
# wrangler secret put TURSO_DATABASE_URL
# wrangler secret put TURSO_AUTH_TOKEN
```

> 说明：新版会话认证采用加密随机 Token 并在数据库保存 SHA-256 摘要，密码使用 PBKDF2-SHA256（100,000 次迭代，符合 Worker CPU 限制），不再需要 legacy `CSLITE_SECRET_KEY` / `CSLITE_JWT_SECRET`。

5. **本地预览与部署上线**：

```bash
# 回到仓库根目录
cd ..

# 本地调试
make dev-worker

# 部署到 Cloudflare Workers
make deploy-worker
# 或: cd server && wrangler deploy
```

> 提示：Worker 的 `fetch` 处理器在首次请求 `/api/*` 时会自动调用 `ensureMigrated` 初始化管理员；若在 `wrangler.toml` 中启用 `[triggers] crons`，`scheduled` 处理器也会自动触发检查。

---

## 3. 腾讯云 SCF 部署

Cslite 为腾讯云函数 SCF 提供专用打包脚本 [`deploy/scf/build-scf.sh`](../deploy/scf/build-scf.sh)，同时生成 **Web 函数** 与 **事件函数** 两种入口产物。

### 3.1 构建部署包

```bash
make build-scf
```

产物位于 `deploy/scf/dist/`：

- `index.mjs`：Web 函数 HTTP 服务器包（监听 `SCF_SERVER_PORT` / `PORT` / `CSLITE_PORT`，默认 `9000`）
- `scf.mjs`：API 网关事件函数包（导出 `main_handler` 与 `handler`）
- `scf_bootstrap`：Web 函数启动脚本（自动探测 `/var/lang/node22/bin/node`、`/var/lang/node20/bin/node` 等，绑定 `9000` 端口）
- `package.json`：`"type": "module"`，`"main": "scf.mjs"`
- `cslite-scf.zip`：可直接上传的代码压缩包

### 3.2 数据库选择（SCF 注意事项）

- **Turso（推荐轻量无服务器方案）**：原生 HTTP `fetch` 接入，零额外 npm 依赖。设置环境变量 `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN` 即可直接上传 `cslite-scf.zip`。
- **腾讯云 TencentDB MySQL**：`build-scf.sh` 为控制包体积将 `mysql2` 设为 external。如使用 MySQL，请在打包压缩前安装运行时依赖：

```bash
npm --prefix deploy/scf/dist install --omit=dev mysql2
(cd deploy/scf/dist && zip -qr cslite-scf.zip index.mjs scf.mjs scf_bootstrap package.json node_modules)
```

- **本地 `/tmp/cslite.db`**：仅在 Node.js `>= 22.5` 下且未配置 MySQL/Turso 时自动回退到 `/tmp/cslite.db`（实例销毁后数据不保留，仅作临时验证用途）。

### 3.3 部署模式

#### 方式 A：Web Function（Web 函数）

1. 在 SCF 控制台创建 **Web 函数**，运行环境选择 **Node.js 22**（或 Node.js 20 + MySQL/Turso）。
2. 上传 `deploy/scf/dist/cslite-scf.zip`（确保根目录包含可执行的 `scf_bootstrap` 与 `index.mjs`）。
3. 配置环境变量：`CSLITE_ADMIN_PASSWORD`、数据库环境变量（`CSLITE_DB_DRIVER` / `CSLITE_DB_DSN` 或 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`）。
4. 启用函数 URL 或关联 API 网关，访问 `/health` 验证返回 `{"code":20000,...}`。

#### 方式 B：Event Function（事件函数 + API 网关触发器）

1. 创建 **事件函数**，运行环境选择 **Node.js 22**（或 Node.js 20 + MySQL/Turso）。
2. 上传 `deploy/scf/dist/cslite-scf.zip`，将执行入口设为 `scf.main_handler`（对应 `package.json` 中 `"main": "scf.mjs"`）。
3. 添加 **API 网关触发器**（集成响应模式），`entry-scf.ts` 会自动还原多值 `Set-Cookie`（`multiValueHeaders`）、Query 参数与 Base64 请求体。

---

## 4. 跨平台 Agent 部署

### 4.1 构建或交叉编译 Agent

```bash
# 编译当前平台二进制 -> agent/cslite-agent
make build-agent

# 交叉编译全部 9 个平台/架构目标 -> dist/agent/
make build-agent-all
```

输出矩阵：
- Linux：`amd64`、`arm64`、`armv7`（`GOARM=7`）、`mips`（`GOMIPS=softfloat`）、`mipsle`（`GOMIPS=softfloat`）
- macOS：`amd64`、`arm64`
- Windows：`amd64`、`arm64`

---

### 4.2 Linux（`systemd`）

**方式一：直接使用二进制安装服务**

```bash
# 系统级安装（需 root / sudo）
sudo ./cslite-agent install \
  --server "https://your-cslite-host" \
  --key "ak_live_xxx" \
  --name "linux-node-01"

# 用户级安装（无需 root）
./cslite-agent install --user \
  --server "https://your-cslite-host" \
  --key "ak_live_xxx"
```

**方式二：一键脚本**

```bash
sh agent/scripts/install.sh \
  --server "https://your-cslite-host" \
  --key "ak_live_xxx" \
  --bin-url "/path/to/cslite-agent-linux-amd64"
```

默认路径：
- 系统级：unit `/etc/systemd/system/cslite-agent.service`，配置 `/etc/cslite-agent/config.json`，状态 `/var/lib/cslite-agent/state.json`，日志 `/var/log/cslite-agent.log`
- 用户级：unit `~/.config/systemd/user/cslite-agent.service`，配置与状态 `~/.config/cslite-agent/`

---

### 4.3 OpenWrt（Go 全量版 / BusyBox Lite 版 / `.ipk`）

OpenWrt `/var` 属于内存 tmpfs，Agent 会自动将配置与设备状态持久化到 `/etc/cslite-agent/` 下，重启不丢失。

#### 方案 A：Go 全量静态二进制（`procd` 服务）

```bash
# 上传对应架构二进制到 /usr/bin/cslite-agent 并赋予执行权限
chmod +x /usr/bin/cslite-agent

# 自动生成 /etc/init.d/cslite-agent (procd) 并启用自启
cslite-agent install \
  --server "https://your-cslite-host" \
  --key "ak_live_xxx" \
  --name "openwrt-gw"
```

#### 方案 B：极简 BusyBox Shell 版（`cslite-agent-lite`，适配 4MB/8MB Flash）

零 Go 二进制依赖，纯 POSIX `/bin/sh` + `uclient-fetch`/`wget`/`curl` + `jsonfilter`/`awk`：

```bash
# 使用安装脚本（--lite 模式）
sh agent/scripts/install.sh --lite \
  --server "https://your-cslite-host" \
  --key "ak_live_xxx" \
  --name "openwrt-lite"
```

也支持 `frpc` 风格的 **UCI 配置管理**（[`agent/openwrt/cslite-agent.uci`](../agent/openwrt/cslite-agent.uci) + [`agent/openwrt/cslite-agent.init`](../agent/openwrt/cslite-agent.init)）：

```sh
uci set cslite-agent.main.enabled='1'
uci set cslite-agent.main.server='https://your-cslite-host'
uci set cslite-agent.main.api_key='ak_live_xxx'
uci set cslite-agent.main.name='openwrt-gw'
uci set cslite-agent.main.poll_interval='5'
uci set cslite-agent.main.heartbeat_interval='60'
uci commit cslite-agent

/etc/init.d/cslite-agent enable
/etc/init.d/cslite-agent restart
```

#### 方案 C：构建与安装 `.ipk` 软件包

```bash
# 仅构建架构无关的 Lite .ipk -> dist/openwrt/cslite-agent-lite_<ver>_all.ipk
make build-openwrt-ipk

# 同时构建指定架构的 Go 全量 .ipk（示例：mipsel_24kc）
make build-agent-all
make build-openwrt-ipk \
  AGENT_BIN=dist/agent/cslite-agent-linux-mipsle \
  OPENWRT_ARCH=mipsel_24kc
```

在路由器上安装：

```sh
opkg install /tmp/cslite-agent-lite_1.0.0_all.ipk
cslite-agent-lite install --server "https://your-cslite-host" --key "ak_live_xxx"
```

---

### 4.4 macOS（`launchd`）

```bash
# 系统级 LaunchDaemon（/Library/LaunchDaemons/com.cslite.agent.plist，需 sudo）
sudo ./cslite-agent install \
  --server "https://your-cslite-host" \
  --key "ak_live_xxx"

# 当前用户 LaunchAgent（~/Library/LaunchAgents/com.cslite.agent.plist）
./cslite-agent install --user \
  --server "https://your-cslite-host" \
  --key "ak_live_xxx"
```

默认路径：
- 系统级：`/Library/Application Support/cslite-agent/{config,state}.json`、`/Library/Logs/cslite-agent.log`
- 用户级：`~/Library/Application Support/cslite-agent/{config,state}.json`、`~/Library/Logs/cslite-agent.log`

---

### 4.5 Windows（Windows Service SCM）

请使用 **管理员权限 PowerShell** 执行：

```powershell
# 方式一：一键脚本（支持 -BinUrl 指定本地或自定义下载路径）
.\agent\scripts\install.ps1 -Server "https://your-cslite-host" -Key "ak_live_xxx" -Name "win-node-01"

# 方式二：直接使用二进制安装 Windows SCM 服务
.\cslite-agent.exe install --server "https://your-cslite-host" --key "ak_live_xxx" --name "win-node-01"
```

- 服务名称：`cslite-agent`（自动启动 + 失败自动重启恢复策略）
- 配置与状态：`C:\ProgramData\cslite-agent\{config.json,state.json,cslite-agent.log}`
- 若以 `-User` 或非管理员前台运行 `cslite-agent.exe run`，配置位于 `%APPDATA%\cslite-agent\`（`install.ps1 -User` 将可执行文件置于 `%LOCALAPPDATA%\cslite-agent\`；Windows SCM 系统服务需管理员权限安装且不支持 `--user`）。

---

### 4.6 Agent 日常运维 CLI 速查

```bash
cslite-agent status                        # 查看服务状态、Init 系统、平台架构与配置路径
cslite-agent start | stop | restart        # 控制后台服务启停
cslite-agent config show                   # 查看当前生效配置（API Key 默认脱敏，加 --reveal 显示明文）
cslite-agent config set poll_interval 5    # 修改配置项（支持 server/api_key/name/device_id/poll_interval/heartbeat_interval/log_level）
cslite-agent run --once                    # 执行单次心跳 + 拉取 + 执行后退出（便于调试）
cslite-agent exec "uname -a" --timeout 30  # 本地诊断命令执行
cslite-agent uninstall --purge             # 卸载服务并清理配置、状态与日志文件
```
