// API类，处理与后端服务器的通信
class API {
    constructor() {
        this.baseURL = window.CONFIG.API_BASE_URL; // API基础URL
        this.token = localStorage.getItem(window.CONFIG.TOKEN_KEY); // 从本地存储获取令牌
    }

    // 通用请求方法
    async request(method, endpoint, data = null, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const config = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                ...options.headers
            }
        };

        // 如果有令牌且不需要跳过认证，则添加认证头
        if (this.token && !options.noAuth) {
            config.headers['Authorization'] = `Bearer ${this.token}`;
        }

        // 如果是POST、PUT或PATCH请求且有数据，则添加请求体
        if (data && ['POST', 'PUT', 'PATCH'].includes(method)) {
            config.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, config);
            const responseData = await response.json();

            if (!response.ok) {
                throw new Error(responseData.error || `HTTP error! status: ${response.status}`);
            }

            return responseData;
        } catch (error) {
            console.error('API request failed:', error);
            throw error;
        }
    }

    // 设置令牌
    setToken(token) {
        this.token = token;
        if (token) {
            localStorage.setItem(window.CONFIG.TOKEN_KEY, token);
        } else {
            localStorage.removeItem(window.CONFIG.TOKEN_KEY);
        }
    }

    // 用户登录
    async login(username, password) {
        const response = await this.request('POST', '/auth/login', { username, password }, { noAuth: true });
        if (response.token) {
            this.setToken(response.token);
            localStorage.setItem(window.CONFIG.USER_KEY, JSON.stringify(response.user));
        }
        return response;
    }

    // 用户登出
    async logout() {
        try {
            await this.request('POST', '/auth/logout');
        } finally {
            this.setToken(null);
            localStorage.removeItem(window.CONFIG.USER_KEY);
            window.location.hash = '#/login';
        }
    }

    // 获取设备列表
    async getDevices(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request('GET', `/devices${query ? '?' + query : ''}`);
    }

    // 获取单个设备详情
    async getDevice(id) {
        return this.request('GET', `/devices/${id}`);
    }

    // 创建设备
    async createDevice(data) {
        return this.request('POST', '/devices', data);
    }

    // 删除设备
    async deleteDevices(ids) {
        return this.request('DELETE', '/devices', { ids });
    }

    // 获取分组列表
    async getGroups(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request('GET', `/groups${query ? '?' + query : ''}`);
    }

    // 创建分组
    async createGroup(data) {
        return this.request('POST', '/groups', data);
    }

    // 删除分组
    async deleteGroup(id) {
        return this.request('DELETE', `/groups/${id}`);
    }

    // 添加设备到分组
    async addDevicesToGroup(groupId, deviceIds) {
        return this.request('PUT', `/groups/${groupId}/devices`, { device_ids: deviceIds });
    }

    // 获取命令列表
    async getCommands(params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request('GET', `/commands${query ? '?' + query : ''}`);
    }

    // 获取单个命令详情
    async getCommand(id) {
        return this.request('GET', `/commands/${id}`);
    }

    // 创建命令
    async createCommand(data) {
        return this.request('POST', '/commands', data);
    }

    // 获取命令结果
    async getCommandResults(id) {
        return this.request('GET', `/commands/${id}/results`);
    }

    // 获取日志
    async getLogs(type, params = {}) {
        const query = new URLSearchParams(params).toString();
        return this.request('GET', `/logs/${type}${query ? '?' + query : ''}`);
    }
}

window.api = new API();