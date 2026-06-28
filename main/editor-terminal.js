// ============================================================================
// 编辑器窗口 + 终端会话模块
// ============================================================================
// 职责：
// 1. 编辑器窗口创建（createEditorWindow）
// 2. 编辑器文件操作 IPC：editor:open-file-dialog/read-file/write-file/open/scan-dir
// 3. 终端会话管理（terminalSessions Map + createTerminalSession）
// 4. 终端 IPC：terminal:create/write/resize/kill/list
//
// 本模块自包含，不依赖共享状态。appRoot（项目根目录）通过 setup 注入，
// 用于编辑器文件路径的白名单校验（模块内的 __dirname 指向 main/ 子目录，
// 不能直接用于校验应用根）。
//
// 依赖注入：
// - setupEditorTerminal({ appRoot }) 接收项目根目录
// - cleanupTermins() 在 app.before-quit 中调用，清理所有终端会话
// ============================================================================

const { ipcMain, BrowserWindow, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// 默认指向项目根（main.js 所在目录），实际由 setupEditorTerminal 注入
let _appRoot = path.resolve(__dirname, '..');
let editorWindow = null;
const terminalSessions = new Map();

/**
 * 注入应用根目录（项目根，即 main.js 所在目录）
 * @param {Object} deps
 * @param {string} deps.appRoot - 项目根目录绝对路径
 */
function setupEditorTerminal({ appRoot } = {}) {
    if (appRoot) _appRoot = appRoot;
}

function createEditorWindow(filePath) {
    if (editorWindow && !editorWindow.isDestroyed()) {
        editorWindow.focus();
        if (filePath) editorWindow.webContents.send('editor:open-file', filePath);
        return;
    }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    editorWindow = new BrowserWindow({
        width: Math.min(1200, width - 100),
        height: Math.min(800, height - 100),
        title: 'VersePC Editor',
        icon: path.join(_appRoot, 'img', 'logo.png'),
        backgroundColor: '#1e1e1e',
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: false,
            preload: path.join(_appRoot, 'editor-preload.cjs')
        }
    });
    editorWindow.loadFile(path.join(_appRoot, 'editor.html'));
    editorWindow.once('ready-to-show', () => {
        editorWindow.show();
        if (filePath) {
            editorWindow.webContents.once('did-finish-load', () => {
                editorWindow.webContents.send('editor:open-file', filePath);
            });
        }
    });
    editorWindow.on('closed', () => { editorWindow = null; });
}

function createTerminalSession(id, cols, rows) {
    const isWin = process.platform === 'win32';
    const shell = isWin ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/bash');
    const homeDir = process.env[isWin ? 'USERPROFILE' : 'HOME'] || (isWin ? 'C:\\' : '/');
    let child;
    if (isWin) {
        try {
            child = require('child_process').spawn('powershell.exe', ['-NoLogo', '-NoExit'], {
                cwd: homeDir,
                env: { ...process.env, TERM: 'xterm-256color' },
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (e) {
            child = require('child_process').spawn(shell, [], {
                cwd: homeDir,
                env: { ...process.env, TERM: 'xterm-256color' },
                stdio: ['pipe', 'pipe', 'pipe']
            });
        }
    } else {
        child = require('child_process').spawn(shell, ['--login'], {
            cwd: homeDir,
            env: { ...process.env, TERM: 'xterm-256color' },
            stdio: ['pipe', 'pipe', 'pipe']
        });
    }
    const session = { id, process: child, cols: cols || 80, rows: rows || 24 };
    terminalSessions.set(id, session);
    return session;
}

/**
 * 注册编辑器 + 终端 IPC 处理器
 */
function registerEditorTerminalIPC() {
    ipcMain.handle('editor:open-file-dialog', async (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showOpenDialog(win, {
            title: '打开文件',
            properties: ['openFile'],
            filters: [
                { name: '所有文件', extensions: ['*'] },
                { name: 'JSON', extensions: ['json', 'jsonc'] },
                { name: 'JavaScript', extensions: ['js', 'jsx', 'ts', 'tsx'] },
                { name: '配置文件', extensions: ['toml', 'ini', 'cfg', 'properties', 'yml', 'yaml'] },
                { name: '文本文件', extensions: ['txt', 'md', 'log'] }
            ]
        });
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
    });

    ipcMain.handle('editor:read-file', async (event, filePath) => {
        try {
            const resolved = path.resolve(filePath);
            const allowedBase = path.resolve(_appRoot);
            if (!resolved.toLowerCase().startsWith(allowedBase.toLowerCase()) || !fs.existsSync(resolved)) {
                return { error: '无效的文件路径' };
            }
            const content = fs.readFileSync(resolved, 'utf-8');
            return { content };
        } catch (e) {
            return { error: e.message };
        }
    });

    ipcMain.handle('editor:write-file', async (event, filePath, content) => {
        try {
            const resolved = path.resolve(filePath);
            const allowedBase = path.resolve(_appRoot);
            if (!resolved.toLowerCase().startsWith(allowedBase.toLowerCase())) {
                return { error: '无效的文件路径' };
            }
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(resolved, content, 'utf-8');
            return { success: true };
        } catch (e) {
            return { error: e.message };
        }
    });

    ipcMain.handle('editor:open', async (event, filePath) => {
        createEditorWindow(filePath);
        return true;
    });

    ipcMain.handle('editor:scan-dir', async (event, dirPath) => {
        try {
            const allowedBase = path.resolve(_appRoot);
            const resolved = path.resolve(dirPath);
            if (!resolved.toLowerCase().startsWith(allowedBase.toLowerCase())) {
                return [];
            }
            const entries = fs.readdirSync(resolved, { withFileTypes: true });
            const IGNORE = ['node_modules', '.git', '.svn', '__pycache__', '.DS_Store', 'Thumbs.db', 'dist', '.next', '.cache'];
            return entries
                .filter(e => !IGNORE.includes(e.name) && !e.name.startsWith('.'))
                .sort((a, b) => {
                    if (a.isDirectory() && !b.isDirectory()) return -1;
                    if (!a.isDirectory() && b.isDirectory()) return 1;
                    return a.name.localeCompare(b.name);
                })
                .slice(0, 200)
                .map(e => ({
                    name: e.name,
                    path: path.join(resolved, e.name),
                    isDir: e.isDirectory(),
                    rel: path.relative(resolved, path.join(resolved, e.name))
                }));
        } catch (e) { return []; }
    });

    ipcMain.handle('terminal:create', async (event, id, cols, rows) => {
        const session = createTerminalSession(id, cols, rows);
        const win = BrowserWindow.fromWebContents(event.sender);
        session.process.stdout.on('data', (data) => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('terminal:data', id, data.toString('utf-8'));
            }
        });
        session.process.stderr.on('data', (data) => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('terminal:data', id, data.toString('utf-8'));
            }
        });
        session.process.on('exit', (code) => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('terminal:exit', id, code);
            }
            terminalSessions.delete(id);
        });
        session.process.on('error', (err) => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('terminal:data', id, `\r\n\x1b[31mError: ${err.message}\x1b[0m\r\n`);
            }
        });
        return { success: true };
    });

    ipcMain.handle('terminal:write', async (event, id, data) => {
        const session = terminalSessions.get(id);
        if (session && session.process && !session.process.killed) {
            session.process.stdin.write(data);
        }
    });

    ipcMain.handle('terminal:resize', async (event, id, cols, rows) => {
        const session = terminalSessions.get(id);
        if (session) {
            session.cols = cols;
            session.rows = rows;
        }
    });

    ipcMain.handle('terminal:kill', async (event, id) => {
        const session = terminalSessions.get(id);
        if (session) {
            if (session.process && !session.process.killed) {
                session.process.kill();
            }
            terminalSessions.delete(id);
        }
    });

    ipcMain.handle('terminal:list', async () => {
        return Array.from(terminalSessions.keys());
    });
}

/**
 * 清理所有终端会话（app.before-quit 时调用）
 */
function cleanupTerminals() {
    if (terminalSessions && terminalSessions.size > 0) {
        for (const [id, session] of terminalSessions) {
            try {
                if (session.process && !session.process.killed) {
                    session.process.kill('SIGTERM');
                }
            } catch (e) {}
        }
        terminalSessions.clear();
    }
}

module.exports = {
    setupEditorTerminal,
    registerEditorTerminalIPC,
    cleanupTerminals,
};
