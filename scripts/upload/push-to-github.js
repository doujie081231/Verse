const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEMP_DIR = path.join(process.env.TEMP || process.env.TMP, 'versepc-github-push');

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

try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch(e) {}

fs.mkdirSync(TEMP_DIR, { recursive: true });

const SOURCE_DIR = __dirname;
let fileCount = 0;

function copyDir(src, dest) {
    const items = fs.readdirSync(src);
    for (const item of items) {
        if (item.startsWith('.') || item === 'node_modules' || item === 'dist' || item === 'output' || item === 'logs') continue;
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        const stat = fs.statSync(srcPath);
        if (stat.isDirectory()) {
            const rel = path.relative(SOURCE_DIR, srcPath).replace(/\\/g, '/');
            if (shouldInclude(rel)) {
                fs.mkdirSync(destPath, { recursive: true });
                copyDir(srcPath, destPath);
            }
        } else {
            const rel = path.relative(SOURCE_DIR, srcPath).replace(/\\/g, '/');
            if (shouldInclude(rel)) {
                fs.copyFileSync(srcPath, destPath);
                fileCount++;
            }
        }
    }
}

copyDir(SOURCE_DIR, TEMP_DIR);
console.log(`Copied ${fileCount} files to ${TEMP_DIR}`);

process.chdir(TEMP_DIR);

const cmds = [
    'git init',
    'git checkout -b main',
    'git add -A',
    'git commit -m "VersePC 正式版源代码"',
    'git remote add origin https://github.com/doujie081231/versePc.git',
    'git push -u origin main --force'
];

for (const cmd of cmds) {
    console.log(`\n>>> ${cmd}`);
    try {
        const output = execSync(cmd, { encoding: 'utf-8', timeout: 120000 });
        console.log(output);
    } catch (e) {
        console.log(e.stdout || '');
        console.error(e.stderr || e.message);
    }
}

console.log('\nDone!');
