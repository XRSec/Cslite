# 环境配置

> **最后更新**: 2025-06-20  
> **文档状态**: 正式发布

---

## 服务端环境变量

### 数据库配置

| 环境变量名      | 默认值               | 说明                                 |
| --------------- | -------------------- | ------------------------------------ |
| `CSLITE_DB_DSN` | `user:pass@tcp(...)` | MySQL / PostgreSQL DSN 地址          |
| `CSLITE_DB_HOST`| `localhost`          | 数据库主机地址                       |
| `CSLITE_DB_PORT`| `3306`               | 数据库端口                           |
| `CSLITE_DB_USER`| `cslite`             | 数据库用户名                         |
| `CSLITE_DB_PASS`| -                    | 数据库密码                           |
| `CSLITE_DB_NAME`| `cslite`             | 数据库名称                           |

### 服务配置

| 环境变量名              | 默认值               | 说明                                 |
| ----------------------- | -------------------- | ------------------------------------ |
| `CSLITE_PORT`           | `8080`               | HTTP 服务监听端口                    |
| `CSLITE_HOST`           | `0.0.0.0`            | HTTP 服务监听地址                    |
| `CSLITE_SECRET_KEY`     | -                    | 签名和加密使用的全局密钥（计划项，详见计划任务文档） |
| `CSLITE_LOG_LEVEL`      | `info`               | 日志等级：debug/info/warn/error      |
| `CSLITE_API_RATE_LIMIT` | `60`                 | 每分钟最大 API 请求数（限流）        |

### 文件存储配置

| 环境变量名        | 默认值                    | 说明                           |
| ----------------- | ------------------------- | ------------------------------ |
| `CSLITE_FILE_DIR` | `/var/cslite/files`       | 日志文件等静态内容存放目录     |
| `CSLITE_LOG_DIR`  | `/var/cslite/logs`        | 应用日志存放目录               |
| `CSLITE_TEMP_DIR` | `/tmp/cslite`             | 临时文件目录                   |

### 功能开关

| 环境变量名            | 默认值 | 说明                           |
| --------------------- | ------ | ------------------------------ |
| `CSLITE_ALLOW_REGISTER` | `true` | 是否允许 Agent 注册            |
| `CSLITE_DEBUG_MODE`  | `false`| 是否启用调试模式               |

---

## Agent 环境变量

### 基础配置

| 环境变量名        | 默认值               | 说明                                      |
| ----------------- | -------------------- | ----------------------------------------- |
| `AGENT_KEY`       | -                    | 分配的 API Key（必填）                    |
| `AGENT_SERVER`    | -                    | 服务端地址，例如 `http://api.cslite.com`  |
| `AGENT_DEVICE_ID` | -                    | 初始化后绑定的设备 ID                     |
| `AGENT_NAME`      | -                    | 设备名称（可选，自动生成）                |

### 通信配置

| 环境变量名        | 默认值 | 说明                           |
| ----------------- | ------ | ------------------------------ |
| `AGENT_INTERVAL`  | `60`   | 心跳间隔，单位：秒              |
| `AGENT_TIMEOUT`   | `30`   | 请求超时时间，单位：秒          |
| `AGENT_RETRY`     | `3`    | 请求重试次数                   |

### 日志配置

| 环境变量名        | 默认值               | 说明                           |
| ----------------- | -------------------- | ------------------------------ |
| `AGENT_LOG_PATH`  | `/var/log/agent.log` | 本地日志输出文件路径           |
| `AGENT_LOG_LEVEL` | `info`               | 日志等级                       |
| `AGENT_ENV_FILE`  | `.env`               | 本地环境变量定义文件路径       |

---

## 计划项说明

- systemd、Nginx、Docker、集群、加密等内容详见[计划任务文档](./plans.md)

---

## 相关文档

- [项目概览](../architecture/overview.md) - 系统架构和核心概念
- [最佳实践](./best-practices.md) - 部署和运维建议
- [错误码参考](./error-codes.md) - 配置错误处理
- [API 文档](../api/auth.md) - 服务端接口文档 