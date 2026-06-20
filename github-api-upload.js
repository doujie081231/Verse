const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'doujie081231';
const REPO = 'versePc';
const BRANCH = 'main';

const INCLUDE_DIRS = ['css', 'js', 'plugins', 'assets', 'scripts'];
const INCLUDE_FILES = [
    'main.js', 'server.js', 'index.html', 'package.json',
    'preload.cjs', 'crashAnalyzer.js', 'forge-installer.js',
    'forge-processor.js', 'neoforge-processor.js', 'hooks-manager.js',
    'generate-integrity.js', 'sse-server.js', 'update.json',
    '.gitignore', 'LICENSE', 'README.md'
];
const EXCLUDE_FILES = [
    'js/ai-chat.js',
    'agent-engine.js', 'agent-worker.js', 'ai-config.js', 'ai-enabled.json',
    'knowledge-graph.js', 'mcp-client.js', 'memory-manager.js',
    'parallel-agent.js', 'plugin-manager.js', 'sandbox.js',
    'self-evolution.js', 'session-manager.js', 'skill-manager.js',
    'snapshot-manager.js', 'workflow-engine.js'
];

function shouldInclude(relativePath) {
    if (EXCLUDE_FILES.includes(relativePath)) return false;
    for (const d of INCLUDE_DIRS) {
        if (relativePath === d || relativePath.startsWith(d + '/')) return true;
    }
    return INCLUDE_FILES.includes(relativePath);
}

function githubApi(method, urlPath, data) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: urlPath,
            method: method,
            headers: {
                'User-Agent': 'VersePC-Upload',
                'Authorization': `token ${TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        };
        if (data) {
            const body = JSON.stringify(data);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(body);
        }
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
        if (data) req.write(JSON.stringify(data));
        req.end();
    });
}

async function getFileSha(filePath) {
    try {
        const res = await githubApi('GET', `/repos/${OWNER}/${REPO}/contents/${filePath}?ref=${BRANCH}`);
        if (res.status === 200 && res.data.sha) return res.data.sha;
    } catch (e) {}
    return null;
}

async function uploadFile(filePath, content) {
    const sha = await getFileSha(filePath);
    const data = {
        message: `更新 ${filePath}`,
        content: Buffer.from(content).toString('base64'),
        branch: BRANCH
    };
    if (sha) data.sha = sha;
    const res = await githubApi('PUT', `/repos/${OWNER}/${REPO}/contents/${filePath}`, data);
    return res;
}

async function main() {
    const SOURCE_DIR = __dirname;
    const files = [];

    function scanDir(dir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            if (item.startsWith('.') || item === 'node_modules' || item === 'dist' || item === 'output' || item === 'logs') continue;
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                if (shouldInclude(path.relative(SOURCE_DIR, fullPath).replace(/\\/g, '/'))) {
                    scanDir(fullPath);
                }
            } else {
                const rel = path.relative(SOURCE_DIR, fullPath).replace(/\\/g, '/');
                if (shouldInclude(rel)) files.push(rel);
            }
        }
    }

    scanDir(SOURCE_DIR);
    console.log(`Found ${files.length} files`);

    let success = 0, failed = 0;
    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf-8');
            const res = await uploadFile(file, content);
            if (res.status === 200 || res.status === 201) {
                console.log(`✓ ${file}`);
                success++;
            } else {
                console.log(`✗ ${file}: ${res.status} - ${JSON.stringify(res.data).substring(0, 100)}`);
                failed++;
            }
        } catch (e) {
            console.log(`✗ ${file}: ${e.message}`);
            failed++;
        }
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\nDone! Success: ${success}, Failed: ${failed}`);
}

main().catch(console.error);
