# Cslite 部署指南

本文档涵盖 Cslite 服务端（本地 Node.js、Docker、Cloudflare Workers + D1、腾讯云 SCF + 腾讯云 CDN）与跨平台 Agent（Linux、OpenWrt、macOS、Windows）的完整部署步骤。

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

## 3. 腾讯云 SCF + 腾讯云 CDN 部署

生产环境推荐采用 **腾讯云 CDN（自定义域名 + HTTPS） + 腾讯云 SCF Web 函数 + 外部 MySQL / Turso** 的组合：CDN 负责对外暴露统一域名、终止 HTTPS、缓存单文件前端 `/` 并在回源请求中注入保护密钥；SCF Web 函数负责运行控制面逻辑且不直接暴露给未授权请求。

### 3.1 架构与数据流

```text
浏览器 / Agent
  │  HTTPS（https://cslite.example.com）
  ▼
腾讯云 CDN
  ├─ 命中缓存（/、/index.html，遵循源站 Cache-Control: public, max-age=300）
  └─ 动态回源（/api/*、/i、/u、/agent-lite* 等，缓存 0 秒）
       │  HTTPS 回源 + 回源 HOST=SCF 函数域名 + X-CSLite-Origin-Secret
       ▼
腾讯云 SCF Web 函数（scf_bootstrap 监听 9000 -> index.mjs）
  ├─ 校验 X-CSLite-Origin-Secret（未匹配直接返回 403 空响应，不触碰数据库）
  └─ 连接数据库（TencentDB MySQL / 外部 MySQL / Turso HTTP）
```

> 打包脚本 [`deploy/scf/build-scf.sh`](../deploy/scf/build-scf.sh) 会同时生成 **Web 函数**（`index.mjs` + `scf_bootstrap`）与 **事件函数**（`scf.mjs`）两种入口。

### 3.2 构建部署包

在仓库根目录执行（会先运行 `make build-web` 编译前端单文件并内嵌脚本，再打包 SCF 产物）：

```bash
make build-scf
```

构建产物位于 `deploy/scf/dist/`：

- `index.mjs`：Web 函数 HTTP 服务主包（按 `SCF_SERVER_PORT` -> `PORT` -> `CSLITE_PORT` 默认 `9000` 监听）
- `scf.mjs`：API 网关事件函数入口（导出 `main_handler` 与 `handler`）
- `scf_bootstrap`：Web 函数引导脚本（自动探测 `/var/lang/node22/bin/node`、`/var/lang/node20/bin/node`、`/var/lang/node18/bin/node` 或系统 `node`）
- `package.json` & `node_modules/`：`build-scf.sh` 已自动执行 `npm --prefix deploy/scf/dist install --omit=dev` 安装运行时依赖 `mysql2`（如无需自行二次安装）
- `cslite-scf.zip`：包含 `index.mjs`、`scf.mjs`、`scf_bootstrap`、`package.json` 与 `node_modules/` 的完整上传包

### 3.3 数据库选择

- **MySQL 8.x（TencentDB MySQL / 外部 MySQL，推荐长期生产使用）**：支持通过 `CSLITE_DB_DSN`（如 `mysql://user:pass@host:3306/cslite`）或分项环境变量 `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` / `MYSQL_SSL` 连接；默认连接池上限 `CSLITE_MYSQL_POOL_SIZE=3`，适合 Serverless 并发控制。
- **Turso / libSQL**：基于标准 HTTP `fetch` 通信，配置 `CSLITE_DB_DRIVER=turso`、`TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN` 即可使用。
- **本地 `/tmp/cslite.db`**：仅在 Node.js `>= 22.5` 且未配置 MySQL/Turso 时自动回退（SCF 实例销毁即丢失，只适合临时联调）。

### 3.4 创建与配置 SCF 函数

#### 方式 A：Web 函数 + 函数 URL（配合 CDN，推荐）

1. 在 SCF 控制台（如 `ap-nanjing` 地域）新建 **Web 函数**，运行环境选择 **Nodejs 18.15**（或 **Nodejs 20** / **Nodejs 22**），建议内存 `256 MB`、执行超时 `30s`、初始化超时 `120s`。
2. 上传构建好的 [`deploy/scf/dist/cslite-scf.zip`](../deploy/scf/dist/cslite-scf.zip)（保证解压根目录即包含可执行的 `scf_bootstrap`、`index.mjs` 与 `node_modules`）。
3. **开启公网访问与函数 URL**：鉴权类型选择 **免鉴权（NONE）**，由应用层的 `CSLITE_ORIGIN_SECRET` 对接 CDN 回源鉴权头，防止绕过 CDN 直接刷源站。
4. 参考 [`deploy/scf/serverless.yml`](../deploy/scf/serverless.yml) 配置完整环境变量：

| 变量名 | 示例 / 推荐值 | 说明 |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://cslite.example.com` | **CDN 外部自定义域名**（勿带末尾 `/`）；让 `/i`、`/u`、安装命令及 Cookie CSRF 校验统一使用你的 CDN 域名而非 SCF 默认域名 |
| `CSLITE_COOKIE_SECURE` | `true` | 在 CDN HTTPS 终端回源场景下强制 `cslite_session` 携带 `Secure` |
| `CSLITE_ORIGIN_SECRET` | `openssl rand -hex 32` | 回源保护密钥；启用后所有未携带匹配请求头的直连请求在入口即返回 `403`（零数据库开销） |
| `CSLITE_ORIGIN_SECRET_HEADER` | `x-cslite-origin-secret` | 回源校验请求头名称（可选，默认 `x-cslite-origin-secret`） |
| `CSLITE_ENCRYPTION_KEY` | 高熵随机字符串 | 用于 AES-GCM 加密存储设备绑定密钥 `api_keys.key_secret`（生产必配） |
| `CSLITE_ADMIN_USERNAME` | `admin` | 首次建表初始化管理员账号 |
| `CSLITE_ADMIN_PASSWORD` | 强密码 | 首次建表初始化管理员密码（勿留默认 `admin`） |
| `CSLITE_ALLOW_REGISTRATION` | `false` | 推荐设为 `false`，仅通过控制台预生成设备专属 `ak_dev_*` Key 接入 Agent |
| `CSLITE_POLL_INTERVAL` | `60` | 下发默认轮询周期（秒）；Serverless 按请求计费场景建议 `60` 秒（`1m`）以显著减少空轮询调用次数 |
| `CSLITE_HEARTBEAT_INTERVAL` | `300` | 下发默认心跳周期（秒）；Serverless 场景建议 `300` 秒（`5m`），与 `1m` 轮询配合更省成本 |
| `TZ` / `CSLITE_TIMEZONE` | `Asia/Shanghai` | 运行时及面板统计默认时区（也可在 Web **设置** 中在线调整） |
| `CSLITE_LOG_RETENTION_DAYS` | `30` | 默认日志保留天数 |
| `CSLITE_DB_DRIVER` / `MYSQL_*` | `mysql` | 或配置 `CSLITE_DB_DSN` / `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` |

#### 方式 B：事件函数 + API 网关触发器（兼容方案）

1. 创建 **事件函数**，上传同一份 `cslite-scf.zip`，将执行入口设为 `scf.main_handler`（对应 `package.json` 中 `"main": "scf.mjs"`）。
2. 添加 **API 网关触发器** 并开启 **集成响应模式**，[`server/src/entry-scf.ts`](../server/src/entry-scf.ts) 会自动处理 `multiValueHeaders`（多条 `Set-Cookie`）、Query 参数与 Base64 请求体。

### 3.5 腾讯云 CDN 配置

在腾讯云 CDN 控制台接入你的自定义域名（如 `cslite.example.com`）并完成 DNS CNAME 解析后，按以下顺序配置：

1. **源站与回源 HOST（关键）**：
   - **源站类型**：自有源（填 SCF 函数 URL 分配的域名，去掉 `https://`，如 `xxxx-xxxx.ap-nanjing.tencentscf.com`）。
   - **回源协议**：**HTTPS**（端口 `443`）。
   - **回源 HOST**：必须填写 **SCF 函数 URL 域名**（不要保留用户的 CDN 自定义域名，否则 SCF 网关会因 Host 不匹配拒收或 404）。
2. **回源 HTTP 请求头（源站保护）**：
   - 在 **回源配置 -> 回源 HTTP 请求头** 新增一条请求头：
     - Header 名称：`X-CSLite-Origin-Secret`（与 SCF 的 `CSLITE_ORIGIN_SECRET_HEADER` 对应，大小写不敏感）
     - Header 值：填入与 SCF `CSLITE_ORIGIN_SECRET` 完全一致的密钥。
   - 若服务端需记录真实客户端 IP，可保留默认的 `X-Forwarded-For` 透传（[`server/src/lib/response.ts`](../server/src/lib/response.ts) 按 `cf-connecting-ip -> x-forwarded-for -> x-real-ip` 读取）。
3. **节点缓存规则（务必区分静态入口与动态路由）**：

   | 匹配路径 | CDN 缓存配置 | 服务端响应行为 |
   | --- | --- | --- |
   | `/api/*` | **不缓存（0 秒）** | 服务端返回 `Cache-Control: no-store`，禁止缓存登录态与轮询响应 |
   | `/health` | **不缓存（0 秒）** | 实时健康探针 |
   | `/i`、`/i.ps1`、`/ia`、`/u`、`/u.ps1`、`/install*`、`/upgrade*`、`/agent-lite*`、`/openwrt/*` | **不缓存（0 秒）** | 返回 `Cache-Control: no-store`，确保脚本热更新及动态域名注入即时生效 |
   | `/`、`/index.html` | **遵循源站** | 服务端返回 `Cache-Control: public, max-age=300`（单文件前端由浏览器/边缘短期缓存） |

   - 同时在 **缓存键 / 参数过滤** 中开启 **保留全部 Query String**（确保分页、搜索、日志筛选与历史时间窗参数透传至源站），并确保不剥离请求头中的 `Cookie`、`Authorization` 与 `X-API-Key`。
4. **HTTPS 与安全策略**：
   - 绑定 SSL 证书并开启 **HTTPS 强制跳转（HTTP -> HTTPS 301/302）**。
   - 若开启 CDN 防盗链或 WAF/UA 策略，请放行 **空 Referer** 与包含 `CSLite-Agent/*`、`CSLite-Installer/*` 的请求访问 `/api/agent/*`、`/i`、`/u`、`/agent-lite*`，避免 OpenWrt、PowerShell 或 Linux 探针被拦截。

### 3.6 代码更新、缓存刷新与零 CLS 计费避坑

- **关闭 CLS 日志投递（避免额外账单）**：在 SCF 控制台创建或配置函数时关闭 CLS 日志投递；若未关闭，CLS 索引和长期存储会按量计费。
- **推荐更新方式（谨慎直接使用 `scf deploy`）**：Serverless Framework / `scf deploy` 在部分版本中可能默认重建 CLS 日志集/日志主题或覆盖控制台中的函数 URL 与运行环境变量。首次上线完成后，日常更新代码推荐：
  1. 重新打包：`make build-scf`
  2. 通过 **SCF 控制台上传 `deploy/scf/dist/cslite-scf.zip`**，或使用腾讯云 CLI 仅更新函数代码（不影响已有环境变量与 CLS 开关）：
     ```bash
     tccli scf UpdateFunctionCode \
       --FunctionName cslite \
       --Namespace default \
       --Region ap-nanjing \
       --ZipFile "$(base64 < deploy/scf/dist/cslite-scf.zip | tr -d '\n')"
     ```
     （Web 函数通过根目录 `scf_bootstrap` 启动；仅在首次创建或切换为事件函数模式时设置入口 `scf.main_handler`。）
  3. **刷新 CDN 缓存**：若本次更新修改了前端 UI，上线后务必在 CDN 控制台提交目录刷新，或调用 CLI 立即失效首页缓存：
     ```bash
     tccli cdn PurgePathCache --Paths '["https://cslite.example.com/"]' --FlushType flush
     ```

### 3.7 上线验收清单

1. **验证源站防直连**：直接请求 SCF 函数 URL 的 `/health` 且不带密钥头，应返回 HTTP `403`（空响应体）。
2. **验证 CDN 回源正常**：请求 `https://cslite.example.com/health`，应返回 `200` 且响应 JSON 中 `"runtime":"scf"`。
3. **验证动态域名与不缓存策略**：检查 `curl -I https://cslite.example.com/i` 响应头包含 `Cache-Control: no-store`，且脚本文本中已替换为你配置的 `https://cslite.example.com`（不含 `tencentscf.com` 或 `__CSLITE_DEFAULT_SERVER__`）。
4. **验证登录态与 CSRF**：浏览器访问 `https://cslite.example.com/` 登录后，检查 `Set-Cookie` 包含 `cslite_session=...; Path=/; HttpOnly; SameSite=Lax; ...; Secure`，且新增主机、修改系统设置等写操作返回正常。

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
opkg install /tmp/cslite-agent-lite_1.2.1_all.ipk
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
