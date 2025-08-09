# Cslite - 轻量级远程控制平台

Cslite 面向资源受限环境：不依赖 Redis/消息队列等中间件，仅需 MySQL。服务端默认 HTTP，仅提供 API 与数据存储，客户端轮询拉取任务与上报结果。

## 功能特性

- 用户认证（Cookie 会话）、API Key
- 设备与分组管理
- 命令创建、执行、结果上报（客户端执行，服务端入库）
- Agent 注册、心跳（轮询）
- 简洁 Web 界面（`server/static`）

## 技术栈

- 后端: Go + Gin + GORM + MySQL
- 前端: 纯 HTML/CSS/JS（内嵌于 `server/static`）
- Agent: Go（跨平台）

## 快速开始

1) 配置环境变量（创建 `.env` 或导出环境变量）

```
CSLITE_PORT=8080
CSLITE_MODE=development
CSLITE_LOG_LEVEL=info
CSLITE_DB_DSN=user:pass@tcp(127.0.0.1:3306)/cslite?charset=utf8mb4&parseTime=True&loc=Local
CSLITE_SECRET_KEY=change-me
CSLITE_JWT_SECRET=change-me
```

2) 启动服务端

```
make install-deps
make run-server
```

浏览器访问 `http://127.0.0.1:8080`，默认管理员：`admin / admin`

## 文档

- API 文档：`docs/server/api/`
- 计划事项：`docs/development/plans.md`
- 注意事项：`docs/注意事项.md`

## 项目结构

```
├── server/          # 服务端（HTTP API + 静态页面）
│   ├── api/         # 路由与处理器
│   ├── config/      # 配置与数据库
│   ├── internal/    # 业务逻辑
│   ├── middleware/  # 中间件
│   ├── models/      # 数据模型
│   ├── static/      # 轻量 Web UI
│   └── utils/       # 工具
├── agent/           # 客户端 Agent
└── docs/            # 精简文档（API/计划/注意）
```

欢迎提交 Issue 与 PR。