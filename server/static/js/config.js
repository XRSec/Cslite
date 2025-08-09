// 全局配置对象
window.CONFIG = {
    API_BASE_URL: '/api',                    // API基础URL
    TOKEN_KEY: 'cslite_token',               // 令牌存储键名
    USER_KEY: 'cslite_user',                 // 用户信息存储键名
    PAGE_SIZE: 20,                           // 分页大小
    REQUEST_TIMEOUT: 30000,                  // 请求超时时间（毫秒）
    HEARTBEAT_INTERVAL: 30000,               // 心跳间隔（毫秒）
    CACHE_DURATION: 5 * 60 * 1000           // 缓存持续时间（5分钟）
};