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
    toast.textContent = message;
    
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

window.showToast = showToast;
window.formatDate = formatDate;
window.debounce = debounce;
window.updateAuthUI = updateAuthUI;