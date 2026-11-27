# 环境配置

> **适用版本**: v4.0.0  
> **配置源码**: [`server/src/config.ts`](../../server/src/config.ts)、[`server/src/entry-node.ts`](../../server/src/entry-node.ts)、[`server/src/entry-worker.ts`](../../server/src/entry-worker.ts)、[`server/src/entry-scf.ts`](../../server/src/entry-scf.ts)、[`agent/internal/config/config.go`](../../agent/internal/config/config.go)

---

## 服务端环境变量

### 数据库配置

| 环境变量名               | 默认值               | 说明                                                                 |
| ------------------------ | -------------------- | -------------------------------------------------------------------- |
| `CSLITE_DB_DRIVER`       | `sqlite`             | 数据库驱动：`sqlite`、`mysql` 或 `turso`（Node / SCF 生效）          |
| `CSLITE_DB_PATH`         | `./data/cslite.db`   | SQLite 数据库文件路径（SCF 未配置外部库时回退为 `/tmp/cslite.db`）  |
| `CSLITE_DB_DSN`          | -                    | MySQL 连接 URI（如 `mysql://user:pass@127.0.0.1:3306/cslite`）       |
| `CSLITE_MYSQL_POOL_SIZE` | `3`                  | MySQL 连接池最大连接数                                               |
| `TURSO_DATABASE_URL`     | -                    | Turso / libSQL HTTP 地址（支持 `libsql://` 或 `https://`，全运行时通用） |
| `TURSO_AUTH_TOKEN`       | -                    | Turso 访问令牌（托管 Turso 必填）                                    |

> Cloudflare Workers 环境下可在 `server/wrangler.toml` 绑定 `DB`（D1 数据库），或通过 Wrangler Secret 配置 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`（优先使用 Turso）。

### 服务与运行时配置

| 环境变量名        | 默认值  | 说明                                                               |
| ----------------- | ------- | ------------------------------------------------------------------ |
| `SCF_SERVER_PORT` | -       | 腾讯云 SCF Web Function 注入端口（优先级最高）                     |
| `PORT`            | -       | 通用平台端口环境变量（次优先级）                                   |
| `CSLITE_PORT`     | `9000`  | Node / Docker HTTP 服务监听端口                                    |
| `CSLITE_VERSION`  | `4.0.0` | `/api/system/info` 返回的服务端版本号                              |

### 认证、会话与安全

| 环境变量名                  | 默认值   | 说明                                                                 |
| --------------------------- | -------- | -------------------------------------------------------------------- |
| `CSLITE_ADMIN_USERNAME`     | `admin`  | 首次迁移初始化的管理员用户名                                         |
| `CSLITE_ADMIN_PASSWORD`     | `admin`  | 首次迁移初始化的管理员密码（生产环境务必修改）                       |
| `CSLITE_SESSION_TTL`        | `604800` | 会话有效期（秒，默认 7 天）                                          |
| `CSLITE_COOKIE_SECURE`      | 自动检测 | `true` / `false`；未设置时依据 `X-Forwarded-Proto` 或 URL 协议自动判断 |
| `CSLITE_ALLOW_REGISTRATION` | `true`   | 是否允许 `/api/agent/register` 注册新设备（`true`/`1`/`yes` vs `false`/`0`/`no`） |

> 载荷与输出限制（内置安全上限）：单次请求体上限 `1 MiB`，单次命令回传输出上限 `256 KiB`。

### Agent 通信与任务默认参数

| 环境变量名                  | 默认值 | 说明                                                                 |
| --------------------------- | ------ | -------------------------------------------------------------------- |
| `CSLITE_HEARTBEAT_INTERVAL` | `60`   | 下发给 Agent 的默认心跳间隔（秒）；设备在线判定阈值为 `max(interval * 3, 90)` 秒 |
| `CSLITE_POLL_INTERVAL`      | `10`   | 下发给 Agent 的默认轮询间隔（秒）                                    |
| `CSLITE_DEFAULT_TIMEOUT`    | `1800` | 创建命令未指定 `timeout` 时的默认超时时间（秒）                      |

---

## Agent 配置与环境变量

Agent 配置解析优先级：**CLI 参数 > 环境变量 > 配置文件（`config.json` 或当前目录 `.env`）**。

### 核心连接与轮询参数

| 环境变量名                  | 兼容别名                    | 默认值 | 说明                                               |
| --------------------------- | --------------------------- | ------ | -------------------------------------------------- |
| `CSLITE_SERVER`             | `AGENT_SERVER`              | -      | 服务端 URL（如 `https://cslite.example.com`）      |
| `CSLITE_API_KEY`            | `AGENT_API_KEY`、`AGENT_KEY` | -      | API Key（`ak_live_...`，必填）                     |
| `CSLITE_NAME`               | `AGENT_NAME`                | 主机名 | 设备显示名称                                       |
| `CSLITE_DEVICE_ID`          | `AGENT_DEVICE_ID`           | -      | 预创建设备 ID（可选，用于绑定已有设备槽位）        |
| `CSLITE_POLL_INTERVAL`      | -                           | `5`    | 命令轮询间隔（秒）                                 |
| `CSLITE_HEARTBEAT_INTERVAL` | `AGENT_INTERVAL`            | `60`   | 心跳上报间隔（秒）                                 |
| `CSLITE_LOG_LEVEL`          | `AGENT_LOG_LEVEL`           | `info` | 日志等级：`debug` / `info` / `warn` / `error`      |

### 路径与 OpenWrt Lite 覆盖变量

| 环境变量名          | 默认值           | 说明                                                       |
| ------------------- | ---------------- | ---------------------------------------------------------- |
| `CSLITE_CONFIG_DIR` | 按系统默认路径   | 统一覆盖配置、状态与日志目录                               |
| `CSLITE_CONFIG`     | `<dir>/config.json` | 指定配置文件路径（支持 `.json` 或 `.env` 格式）         |
| `CSLITE_STATE_FILE` | `<dir>/state.json`  | 指定已注册状态文件 `state.json` 路径                    |
| `CSLITE_HTTP_CLIENT`| 自动探测         | 仅 `cslite-agent-lite` 生效：强制使用 `curl`/`wget`/`uclient-fetch` |

各操作系统默认持久化目录：
- **Linux（root / systemd）**：配置 `/etc/cslite-agent/config.json`，状态 `/var/lib/cslite-agent/state.json`，日志 `/var/log/cslite-agent.log`
- **Linux（非 root / `--user`）**：`~/.config/cslite-agent/`
- **OpenWrt（procd / Lite）**：配置 `/etc/cslite-agent/config.json`，状态 `/etc/cslite-agent/state.json`，日志 `/tmp/cslite-agent.log`
- **macOS（root / non-root）**：`/Library/Application Support/cslite-agent/` 或 `~/Library/Application Support/cslite-agent/`
- **Windows（管理员 SCM / 用户态）**：`C:\ProgramData\cslite-agent\` 或 `%APPDATA%\cslite-agent\`

---

## 相关文档

- [部署全指南](../deploy.md)
- [服务端概览](../server/overview.md)
- [错误码参考](./error-codes.md)
- [认证 API](../server/api/auth.md)
