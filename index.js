const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ================= 1. 核心配置 =================
const UUID = process.env.UUID || '0dff8b4c-f778-4648-8817-3a434f7fa443';
const ARGO_AUTH = process.env.ARGO_AUTH || 'eyJhIjoiMDU5NDkzODljMmM3YTZkNGJiNjU5OTU2MThhN2FiYzAiLCJ0IjoiYjAyNmM2ZTctODRiZi00YjRlLTkwZmMtNDRjMGFmYzBlMGQ1IiwicyI6Ik0yTXlZMkk0TkdVdE5tTTJZUzAwWkdOaExUZzFZV1l0WldVME5qSmlaR0V6WkdVNCJ9';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || 'sap.wow83168.de5.net';

// SAP 分配的端口 (必须监听这个端口，否则容器会被杀)
const PORT = process.env.PORT || 8080;

// 定义内部端口 (Xray 躲在这里)
const INTERNAL_PORT = 5555;
const APP_DIR = path.join(__dirname, 'sap_app');

// ================= 2. 初始化环境 =================
if (!fs.existsSync(APP_DIR)) fs.mkdirSync(APP_DIR);

// ================= 3. 启动保活 Web 服务 =================
// 这一步是为了通过 SAP 的 Health Check
const server = http.createServer((req, res) => {
    // 伪装成一个正常的应用
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: "UP",
        msg: "SAP BTP Container is Healthy",
        timestamp: new Date().toISOString()
    }));
});

server.listen(PORT, () => {
    console.log(`[SAP] Health Check Server listening on port ${PORT}`);
    // Web 服务启动成功后，开始后台任务
    startBackend();
});

// ================= 4. 后台核心逻辑 =================
async function startBackend() {
    const coreBin = path.join(APP_DIR, 'web');     // Xray/Singbox
    const tunnelBin = path.join(APP_DIR, 'bot');   // Cloudflared
    const configFile = path.join(APP_DIR, 'config.json');

    // A. 下载依赖
    // 检测架构: SAP BTP 通常是 amd64 (x86_64)
    const arch = ['arm', 'arm64', 'aarch64'].includes(process.arch) ? 'arm64' : 'amd64';
    
    await download(`https://${arch}.ssss.nyc.mn/web`, coreBin);
    await download(`https://${arch}.ssss.nyc.mn/bot`, tunnelBin);

    // B. 赋予执行权限 (关键修复)
    try {
        fs.chmodSync(coreBin, 0o755);
        fs.chmodSync(tunnelBin, 0o755);
    } catch (e) {
        // 如果 chmod 失败，尝试 shell 命令
        try { execSync(`chmod +x ${coreBin} ${tunnelBin}`); } catch (e) {}
    }

    // C. 生成配置 (监听内部 5555)
    const config = {
        log: { loglevel: "none" },
        inbounds: [{
            port: INTERNAL_PORT,
            listen: "127.0.0.1", // 只允许本地访问，安全
            protocol: "vless",
            settings: { clients: [{ id: UUID }], decryption: "none" },
            streamSettings: { network: "ws", wsSettings: { path: "/vless" } }
        }],
        outbounds: [{ protocol: "freedom" }]
    };
    fs.writeFileSync(configFile, JSON.stringify(config));

    // D. 启动 Tunnel (地道模式)
    // 关键：Tunnel 直接把流量转发给 localhost:5555，绕过 SAP 的 PORT 限制
    if (ARGO_AUTH) {
        spawn(tunnelBin, ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', ARGO_AUTH, '--url', `http://localhost:${INTERNAL_PORT}`], {
            stdio: 'inherit',
            env: { ...process.env, GOMEMLIMIT: '100MiB' }
        });
        console.log('[SAP] Tunnel started.');
    } else {
        console.log('[Error] ARGO_AUTH is missing!');
    }

    // E. 启动 Xray (核心)
    spawn(coreBin, ['-c', configFile], {
        stdio: 'inherit',
        env: { 
            ...process.env, 
            GOMAXPROCS: '1',     // 单核模式
            GOGC: '50',          // 适中回收：既不浪费内存，也不狂吃 CPU
            GOMEMLIMIT: '256MiB' // 内存限制
        }
    });
    console.log(`[SAP] Core running on internal port ${INTERNAL_PORT}`);

    // 打印链接
    setTimeout(() => {
        console.log(`\n🔗 Link: vless://${UUID}@www.visa.com.sg:443?encryption=none&security=tls&sni=${ARGO_DOMAIN}&type=ws&host=${ARGO_DOMAIN}&path=%2Fvless#SAP-BTP`);
    }, 3000);
}

// ================= 5. 工具函数 =================
function download(url, dest) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(dest)) return resolve(); // 存在则跳过
        console.log(`[Down] Downloading to ${dest}...`);
        const file = fs.createWriteStream(dest);
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                fs.unlink(dest, () => {});
                return reject(`Download failed: ${res.statusCode}`);
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err.message);
        });
    });
}
