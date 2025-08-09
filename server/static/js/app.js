document.addEventListener('DOMContentLoaded', () => {
    console.log('=== DOM Content Loaded ===');
    console.log('Router available:', !!window.router);
    console.log('API available:', !!window.api);
    updateAuthUI();
    console.log('Auth UI updated');
    console.log('Calling router.handleRoute()');
    window.router.handleRoute();
    console.log('Initial route handling initiated');
});

function updateAuthUI() {
    const authLink = document.getElementById('auth-link');
    const user = JSON.parse(localStorage.getItem(window.CONFIG.USER_KEY) || 'null');
    
    if (user) {
        authLink.textContent = `${user.username} (退出)`;
        authLink.href = '#/logout';
        authLink.onclick = async (e) => {
            e.preventDefault();
            if (confirm('确定要退出登录吗？')) {
                await window.api.logout();
            }
        };
    } else {
        authLink.textContent = '登录';
        authLink.href = '#/login';
        authLink.onclick = null;
    }
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `alert alert-${type}`;
    toast.style.cssText = 'position: fixed; top: 20px; right: 20px; z-index: 9999; min-width: 250px;';
    toast.textContent = typeof message === 'string' ? message : (message && message.message) || String(message);
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('zh-CN');
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Noise filtering for browser extensions/userscripts errors
(function setupGlobalErrorFilters() {
    const noisePatterns = [
        'back/forward cache',
        'bootstrap-autofill-overlay.js',
        'AutofillInlineMenuContentService',
        'chrome-extension://',
        'moz-extension://',
        'userscript.html?name='
    ];

    function isIgnorable(message, filename, stack) {
        const text = [message || '', filename || '', stack || ''].join(' \n ');
        return noisePatterns.some((p) => text.includes(p));
    }

    window.addEventListener('error', (event) => {
        try {
            if (isIgnorable(event.message, event.filename, event.error && event.error.stack)) {
                event.preventDefault();
            }
        } catch (_) {}
    });

    window.addEventListener('unhandledrejection', (event) => {
        try {
            const reason = event.reason || {};
            const message = typeof reason === 'string' ? reason : reason.message;
            const stack = reason && reason.stack;
            if (isIgnorable(message, '', stack)) {
                event.preventDefault();
            }
        } catch (_) {}
    });
})();

window.showToast = showToast;
window.formatDate = formatDate;
window.debounce = debounce;
window.updateAuthUI = updateAuthUI;