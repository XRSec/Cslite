const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const STATIC_DIR = path.join(__dirname, 'server/static');

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
    
    // 处理SPA路由，所有非静态资源请求都返回index.html
    if (pathname === '/' || (!pathname.startsWith('/static') && !path.extname(pathname))) {
        pathname = '/index.html';
    }
    
    // 处理/static路径
    if (pathname.startsWith('/static/')) {
        pathname = pathname.substring('/static'.length);
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
    console.log(`Frontend server running at http://localhost:${PORT}`);
    console.log(`Static files served from: ${STATIC_DIR}`);
    console.log('Visit: http://localhost:3000#/login');
});