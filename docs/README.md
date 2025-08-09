# Cslite 开发文档

> **最后更新**: 2025-06-20  
> **文档状态**: 正式发布  
> **开发语言**: Go + NodeJS

---

## 📖 文档导航

### ��️ 架构与设计
- [项目概览](./server/overview.md) - 系统架构图和核心概念
- [权限控制](./server/api/permissions.md) - 用户角色和权限说明
- [数据模型](./server/data-models.md) - GORM 模型和 ER 图

### 🔧 开发指南
- [环境配置](./development/environment.md) - 环境变量和配置说明
- [错误码参考](./development/error-codes.md) - 统一错误码和处理方式
- [最佳实践](./development/best-practices.md) - 部署建议（详细优化见计划任务文档）
- [计划任务](./development/plans.md) - 未来可选功能与优化

### 📡 API 文档
- [用户认证](./server/api/auth.md) - 登录、注销、用户管理
- [设备管理](./server/api/devices.md) - 设备注册、状态查询、分组
- [命令管理](./server/api/commands.md) - 命令创建、调度、结果查询
- [群组管理](./server/api/groups.md) - 群组创建、设备分配
- [日志系统](./server/api/logs.md) - 操作日志、执行日志查询

### 🤖 Agent 开发
- [Agent 接口](./agent/api.md) - 注册、心跳、命令拉取
- [Agent 部署](./agent/deployment.md) - 安装、配置、运维（详见计划任务文档）

### 🌐 Web 界面
- [Web UI 指南](./web/guide.md) - 界面使用说明

---

## 🚧 功能开发计划

详见[计划任务文档](./development/plans.md)

---

## 💡 项目简介

Cslite 是为资源受限环境设计的轻量级远程控制平台，**不依赖 Redis、Elasticsearch 等中间件**，仅需 MySQL 支持。

### 核心特性
- 🚀 轻量级架构，最小化资源占用
- 🔐 完善的权限控制和用户管理
- 📱 支持设备分组和批量操作
- ⏰ 灵活的命令执行调度
- 📊 实时状态监控和日志记录
- 🌐 现代化的 Web 管理界面

### 技术栈
- **后端**: Go + GORM + MySQL
- **前端**: Vue3 + Vite + Naive UI + TypeScript
- **Agent**: Go (跨平台)

---

## 📞 快速开始

1. [环境配置](./development/environment.md) - 配置开发环境
2. [项目概览](./server/overview.md) - 了解系统架构
3. [API 文档](./server/api/auth.md) - 查看接口文档
4. [最佳实践](./development/best-practices.md) - 部署建议

---

## 🔗 相关链接

- [GitHub 仓库](https://github.com/your-org/cslite)
- [在线演示](https://demo.cslite.com)
- [问题反馈](https://github.com/your-org/cslite/issues)
