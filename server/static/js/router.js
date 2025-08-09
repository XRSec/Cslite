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
        console.log('=== handleRoute called ===');
        const hash = window.location.hash.slice(1) || '/';
        console.log('Current hash:', hash);
        const route = this.matchRoute(hash);
        console.log('Matched route:', route);
        
        if (!route) {
            console.log('No route matched, navigating to /');
            this.navigate('/');
            return;
        }

        if (route.auth && !this.isAuthenticated()) {
            console.log('Auth required but not authenticated, navigating to login');
            this.navigate('/login');
            return;
        }

        if (!route.auth && this.isAuthenticated() && route.page === 'login') {
            console.log('Already authenticated, navigating to /');
            this.navigate('/');
            return;
        }

        console.log('Loading page:', route.page);
        await this.loadPage(route.page, route.params);
        this.updateNavigation(hash);
        console.log('Route handling complete');
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
        console.log('=== loadPage called ===', pageName, params);
        const transitionEl = this.contentEl.querySelector('.page-transition');
        
        transitionEl.classList.add('fade-out');
        await this.sleep(300);

        try {
            let content;
            
            console.log('Checking cache for', pageName);
            if (this.pageCache.has(pageName) && !this.shouldInvalidateCache(pageName)) {
                content = this.pageCache.get(pageName);
                console.log('Using cached content for', pageName);
            } else {
                console.log('Fetching content for', pageName);
                const response = await fetch(`/static/pages/${pageName}.html`);
                if (!response.ok) throw new Error('Page not found');
                content = await response.text();
                console.log('Fetched content length:', content.length);
                
                if (this.isCacheable(pageName)) {
                    this.pageCache.set(pageName, content);
                    setTimeout(() => this.pageCache.delete(pageName), window.CONFIG.CACHE_DURATION);
                }
            }

            console.log('Setting innerHTML for', pageName);
            transitionEl.innerHTML = content;
            
            // 执行插入页面中的脚本标签，确保 initXXXPage 可用
            console.log('Looking for scripts in page');
            const scripts = Array.from(transitionEl.querySelectorAll('script'));
            console.log('Found', scripts.length, 'scripts');
            for (const oldScript of scripts) {
                console.log('Processing script:', oldScript.textContent.substring(0, 100) + '...');
                const newScript = document.createElement('script');
                if (oldScript.src) {
                    newScript.src = oldScript.src;
                    newScript.async = false;
                } else {
                    newScript.textContent = oldScript.textContent;
                }
                document.body.appendChild(newScript);
                oldScript.remove();
                console.log('Script processed and executed');
            }

            transitionEl.classList.remove('fade-out');
            transitionEl.classList.add('fade-in');
            
            await this.sleep(50);
            transitionEl.classList.remove('fade-in');

            const initFunctionName = `init${this.toPascalCase(pageName)}Page`;


            console.log('Looking for init function:', initFunctionName);
            console.log('Function exists?', typeof window[initFunctionName]);

            if (window[`init${this.toPascalCase(pageName)}Page`]) {
                console.log('Calling init function:', initFunctionName);
                window[`init${this.toPascalCase(pageName)}Page`](params);
                console.log('Init function called successfully');
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