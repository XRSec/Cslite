# 权限与认证（简）

- 会话：Cookie（开发 HTTP 兼容；生产建议 HTTPS + Secure + HttpOnly）
- 认证中间件：`AuthRequired`、`AdminRequired`
- API Key：`X-API-Key` 请求头可用于 Agent 通信

详见代码：`server/middleware/auth.go`、`server/api/auth.go` 