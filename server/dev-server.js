const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 9000;
const STATIC_DIR = __dirname; // 当前目录 (static)

// MIME类型映射
const mimeTypes = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);
    
    const parsedUrl = url.parse(req.url);
    let pathname = parsedUrl.pathname;

    // 静默处理浏览器自动请求的 /favicon.ico
    if (pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-cache' });
        return res.end();
    }
    
    // 处理SPA路由，根路径和无扩展名的路径返回index.html
    if (pathname === '/' || (!pathname.startsWith('/') && !path.extname(pathname))) {
        pathname = '/static/index.html';
    }
    
    // 移除开头的斜杠，因为我们直接在static目录下
    if (pathname.startsWith('/')) {
        pathname = pathname.substring(1);
    }
    
    // 如果路径为空，默认为index.html
    if (!pathname) {
        pathname = 'index.html';
    }
    
    const filePath = path.join(STATIC_DIR, pathname);
    
    // 安全检查：确保文件在STATIC_DIR内
    if (!filePath.startsWith(STATIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    
    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error('File not found:', filePath);
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        
        const ext = path.extname(filePath);
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        
        res.writeHead(200, { 
            'Content-Type': contentType,
            'Cache-Control': 'no-cache'
        });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Frontend dev server running at http://localhost:${PORT}`);
    console.log(`Static files served from: ${STATIC_DIR}`);
    console.log('Visit: http://localhost:3000#/login');
});