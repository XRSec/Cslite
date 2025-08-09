# Cslite - 轻量级远程控制平台

Cslite 是一个为资源受限环境设计的轻量级远程控制平台，不依赖 Redis、Elasticsearch 等中间件，仅需 MySQL 支持。

## 功能特性

- 🔐 **用户认证系统** - 支持登录/注销、API Key 生成、权限管理
- 🖥️ **设备管理** - 设备注册、状态监控、批量操作
- 🤖 **Agent 系统** - 自动注册、心跳上报、命令执行
- 📋 **命令调度** - 支持一次性、定时（客户端执行）、立即执行三种模式
- 👥 **群组管理** - 设备分组、批量操作、权限控制
- 📊 **日志系统** - 命令执行日志、设备操作日志、用户行为日志

## 技术栈

- **后端**: Go + Gin + GORM
- **数据库**: MySQL
- **前端**: (待开发)
- **Agent**: Go

## 快速开始

### 环境要求

- Go 1.21+
- MySQL 5.7+

### 安装步骤

1. 克隆项目
```bash
git clone https://github.com/XRSec/Cslite.git
cd cslite
```

2. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env 文件，配置数据库连接等信息
```

3. 安装依赖
```bash
go mod download
```

4. 运行服务端
```bash
cd server
go run main.go
```

服务将在 http://localhost:8080 启动

## API 文档

详细的 API 文档请参考 [docs/](./docs/) 目录：

- [用户认证 API](./docs/server/api/auth.md)
- [设备管理 API](./docs/server/api/devices.md)
- [命令管理 API](./docs/server/api/commands.md)
- [Agent API](./docs/agent/api.md)

## 项目结构

```
cslite/
├── server/          # 服务端代码
│   ├── api/         # API 处理器
│   ├── config/      # 配置管理
│   ├── internal/    # 内部业务逻辑
│   ├── middleware/  # 中间件
│   ├── models/      # 数据模型
│   └── utils/       # 工具函数
├── agent/           # Agent 客户端代码
├── web/             # Web UI (待开发)
└── docs/            # 项目文档
```

## 开发进度

| 功能模块 | 状态 | 完成度 |
|---------|------|--------|
| 用户认证模块 | ✅ 已完成 | 100% |
| Agent 注册与上报 | ✅ 已完成 | 100% |
| 命令调度中心 | ✅ 已完成 | 100% |
| 日志系统 | ✅ 已完成 | 100% |
| 群组管理 | ✅ 已完成 | 100% |
| Web UI | ❌ 待开始 | 0% |

## 贡献指南

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License