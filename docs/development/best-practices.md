# 最佳实践

> **适用版本**: v4.0.0

---

## 运行时与部署建议

- **个人/内网轻量场景**：使用 Node.js `>= 22.5` + 内置 `node:sqlite` 或 Docker 挂载 `/app/data` 卷即可运行，详见[部署指南](../deploy.md)。
- **边缘无服务器场景**：优先使用 **Cloudflare Workers + D1**；若需多区域共用或接入腾讯云 SCF，使用 **Turso**（零额外驱动包）或 **TencentDB MySQL**。
- **HTTPS 与 Cookie**：生产环境务必启用 HTTPS（Cloudflare Workers / API 网关自带 TLS，Node 部署可前置 Nginx / Caddy 反代），确保 `cslite_session` 自动携带 `Secure` 标识。

## 安全与运维建议

- **首次上线即改密**：通过 `CSLITE_ADMIN_PASSWORD` 指定强密码，或在登录后前往 Web UI **Settings & Access** 修改默认 `admin` 密码。
- **按设备/用途拆分 API Key**：利用 **Keys & Users** 或设备创建弹窗签发独立命名的 `ak_live_*` 密钥，发生泄漏时可随时吊销单个 Key 而不影响其他节点。
- **OpenWrt 资源保护**：4MB/8MB Flash 路由器推荐使用 `cslite-agent-lite`（BusyBox `/bin/sh`）与 `.ipk` 精简包；命令输出在 Lite 端会安全截断至 64 KiB（Go Agent 端截断至 200 KiB，服务端上限 256 KiB），避免耗尽路由器 RAM/Flash。

---

## 相关文档

- [部署全指南](../deploy.md)
- [服务端概览](../server/overview.md)
- [环境配置](./environment.md)
- [错误码参考](./error-codes.md)
- [认证 API](../server/api/auth.md)
