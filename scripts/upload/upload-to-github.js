const fs = require('fs');
const path = require('path');

const SOURCE_DIR = __dirname;
const TARGET_REPO = 'doujie081231/versePc';

const INCLUDE_DIRS = [
    'css', 'js', 'plugins', 'assets', 'scripts'
];

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

function shouldInclude(filePath) {
    const relativePath = path.relative(SOURCE_DIR, filePath).replace(/\\/g, '/');
    
    if (EXCLUDE_FILES.includes(relativePath)) {
        return false;
    }
    
    for (const includeDir of INCLUDE_DIRS) {
        if (relativePath === includeDir || relativePath.startsWith(includeDir + '/')) {
            return true;
        }
    }
    
    for (const includeFile of INCLUDE_FILES) {
        if (relativePath === includeFile) {
            return true;
        }
    }
    
    return false;
}

function getFileContent(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return Buffer.from(content).toString('base64');
    } catch (e) {
        return null;
    }
}

function scanDirectory(dir, results = []) {
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
        if (item.startsWith('.') || item === 'node_modules' || item === 'dist' || item === 'output' || item === 'logs') {
            continue;
        }
        
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            if (shouldInclude(fullPath)) {
                scanDirectory(fullPath, results);
            }
        } else {
            if (shouldInclude(fullPath)) {
                const relativePath = path.relative(SOURCE_DIR, fullPath).replace(/\\/g, '/');
                const content = getFileContent(fullPath);
                if (content) {
                    results.push({
                        path: relativePath,
                        content: content
                    });
                }
            }
        }
    }
    
    return results;
}

const files = scanDirectory(SOURCE_DIR);
console.log(`Found ${files.length} files to upload`);

const output = {
    repo: TARGET_REPO,
    files: files.map(f => f.path)
};

fs.writeFileSync(path.join(SOURCE_DIR, 'files-to-upload.json'), JSON.stringify(output, null, 2));
console.log('File list saved to files-to-upload.json');
