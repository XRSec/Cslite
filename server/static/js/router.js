class Router {
    constructor() {
        this.routes = {};
        this.currentRoute = null;
        this.contentEl = document.getElementById('content');
        this.pageCache = new Map();
        this.initializeRoutes();
        this.bindEvents();
    }

    initializeRoutes() {
        this.routes = {
            '/': { page: 'dashboard', auth: true },
            '/login': { page: 'login', auth: false },
            '/devices': { page: 'devices', auth: true },
            '/devices/:id': { page: 'device-detail', auth: true },
            '/groups': { page: 'groups', auth: true },
            '/commands': { page: 'commands', auth: true },
            '/commands/:id': { page: 'command-detail', auth: true },
            '/logs': { page: 'logs', auth: true }
        };
    }

    bindEvents() {
        window.addEventListener('hashchange', () => this.handleRoute());
        document.addEventListener('click', (e) => {
            if (e.target.matches('a[href^="#"]')) {
                e.preventDefault();
                window.location.hash = e.target.getAttribute('href');
            }
        });
    }

    async handleRoute() {
        const hash = window.location.hash.slice(1) || '/';
        const route = this.matchRoute(hash);
        
        if (!route) {
            this.navigate('/');
            return;
        }

        if (route.auth && !this.isAuthenticated()) {
            this.navigate('/login');
            return;
        }

        if (!route.auth && this.isAuthenticated() && route.page === 'login') {
            this.navigate('/');
            return;
        }

        await this.loadPage(route.page, route.params);
        this.updateNavigation(hash);
    }

    matchRoute(path) {
        for (const [pattern, config] of Object.entries(this.routes)) {
            const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, '([^/]+)') + '$');
            const match = path.match(regex);
            
            if (match) {
                const params = {};
                const paramNames = pattern.match(/:[^/]+/g) || [];
                paramNames.forEach((name, index) => {
                    params[name.slice(1)] = match[index + 1];
                });
                return { ...config, params };
            }
        }
        return null;
    }

    async loadPage(pageName, params = {}) {
        const transitionEl = this.contentEl.querySelector('.page-transition');
        
        transitionEl.classList.add('fade-out');
        await this.sleep(300);

        try {
            let content;
            
            if (this.pageCache.has(pageName) && !this.shouldInvalidateCache(pageName)) {
                content = this.pageCache.get(pageName);
            } else {
                const response = await fetch(`/static/pages/${pageName}.html`);
                if (!response.ok) throw new Error('Page not found');
                content = await response.text();
                
                if (this.isCacheable(pageName)) {
                    this.pageCache.set(pageName, content);
                    setTimeout(() => this.pageCache.delete(pageName), window.CONFIG.CACHE_DURATION);
                }
            }

            transitionEl.innerHTML = content;
            
            // 执行插入页面中的脚本标签，确保 initXXXPage 可用
            const scripts = Array.from(transitionEl.querySelectorAll('script'));
            for (const oldScript of scripts) {
                const newScript = document.createElement('script');
                if (oldScript.src) {
                    newScript.src = oldScript.src;
                    newScript.async = false;
                } else {
                    newScript.textContent = oldScript.textContent;
                }
                document.body.appendChild(newScript);
                oldScript.remove();
            }

            transitionEl.classList.remove('fade-out');
            transitionEl.classList.add('fade-in');
            
            await this.sleep(50);
            transitionEl.classList.remove('fade-in');

            const initFunctionName = `init${this.toPascalCase(pageName)}Page`;
            if (window[`init${this.toPascalCase(pageName)}Page`]) {
                window[`init${this.toPascalCase(pageName)}Page`](params);
            } else {
                console.warn('Init function not found:', initFunctionName);
            }
        } catch (error) {
            console.error('Failed to load page:', error);
            transitionEl.innerHTML = '<div class="empty-state">页面加载失败</div>';
            transitionEl.classList.remove('fade-out');
        }
    }

    shouldInvalidateCache(pageName) {
        const dynamicPages = ['devices', 'groups', 'commands', 'logs'];
        return dynamicPages.includes(pageName);
    }

    isCacheable(pageName) {
        const staticPages = ['login', 'dashboard'];
        return staticPages.includes(pageName);
    }

    updateNavigation(currentPath) {
        document.querySelectorAll('.nav-link').forEach(link => {
            const href = link.getAttribute('href').slice(1);
            if (currentPath.startsWith(href) && href !== '/') {
                link.classList.add('active');
            } else if (href === '/' && currentPath === '/') {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });
    }

    navigate(path) {
        window.location.hash = path;
    }

    isAuthenticated() {
        // 基于 Cookie 的会话：以前端持有的用户信息作为是否已登录的判据
        return !!localStorage.getItem(window.CONFIG.USER_KEY);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    toPascalCase(str) {
        return str.split('-').map(word => 
            word.charAt(0).toUpperCase() + word.slice(1)
        ).join('');
    }
}

window.router = new Router();