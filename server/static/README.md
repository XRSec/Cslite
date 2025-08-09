# Web UI（轻量 SPA）

- 技术：纯 HTML/CSS/JS，无构建依赖
- 路由：Hash 路由（`server/static/js/router.js`）
- 脚本：页面内联 `<script>` 会在页面加载后被执行（见 `router.js` 的脚本执行逻辑）

## 结构
```
static/
├── index.html
├── css/
├── js/
│   ├── config.js   # API 基础 URL 与本地存储键名
│   ├── api.js      # 与服务端通信的 API 封装
│   ├── router.js   # 路由与页面加载
│   └── app.js      # 顶部导航、提示、工具
└── pages/          # 页面片段（含 initXXXPage 函数）
```