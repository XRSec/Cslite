# Cslite Server

- 运行模型：HTTP-only（默认），无常驻调度器；无状态，轻量运行
- 工作流：前端创建任务→写入数据库；客户端定时轮询拉取任务（充当心跳）→执行→上报结果（亦为心跳）→服务端校验入库

## 快速启动

1) 准备环境变量（推荐复制根目录 `.env.example` 并按需修改）

```
CSLITE_PORT=8080
CSLITE_MODE=development
CSLITE_LOG_LEVEL=info
CSLITE_DB_DSN=user:pass@tcp(127.0.0.1:3306)/cslite?charset=utf8mb4&parseTime=True&loc=Local
CSLITE_SECRET_KEY=change-me
CSLITE_JWT_SECRET=change-me
```

2) 安装依赖并启动

```
make install-deps
make run-server
```

访问 `http://127.0.0.1:8080`

- 首次启动会自动创建默认管理员：`admin / admin`
- 登录状态通过 Cookie 会话维持（开发模式下允许 HTTP Cookie）

## 目录结构（精简）

```
server/
├── api/          # HTTP 处理器（路由、认证、设备、命令、日志等）
├── config/       # 配置与数据库初始化（仅 MySQL）
├── internal/     # 业务服务（auth、agent、command、group、log、device）
├── middleware/   # 认证鉴权中间件
├── models/       # GORM 模型
├── static/       # 轻量 Web UI（纯 HTML/CSS/JS）
├── utils/        # 通用工具（令牌、密码、JWT 等）
└── main.go       # 启动入口（HTTP 服务器）
```

## 设计要点

- 不内置任务调度器，服务端仅提供 API 与数据存储
- 客户端采用轮询（拉模式），心跳与任务拉取合并
- 会话首选 Cookie（开发 HTTP，生产建议 HTTPS）；无需 Redis 等中间件
- API 前缀统一为 `/api`，静态资源位于 `/static`

## 注意

- 生产环境若仍为 HTTP，请确保 `auth` 设置 Cookie 的 `Secure` 不强制开启（当前按 `CSLITE_MODE` 自动判定）
- 数据库仅支持 MySQL，首次运行会自动迁移并创建默认管理员