// 崩溃日志模块 - 必须在所有其他代码之前 require，以捕获最早期的启动错误
const { _writeCrashLog, _crashLogPath } = require('./main/crash-log');

// 共享状态中介层 - 必须在所有其他 main/ 模块之前加载，提供跨模块共享状态
const sharedState = require('./main/shared-state');

/**
 * VersePC - Minecraft Launcher
 * Copyright (c) 2026 豆杰. All Rights Reserved.
 *
 * AI TRAINING PROHIBITED: This code is protected by copyright law.
 * Unauthorized use for AI model training, machine learning datasets,
 * or any form of artificial intelligence training is strictly prohibited.
 *
 * This software is proprietary and confidential.
 * Any unauthorized reproduction or distribution is prohibited.
 */

/**
 * VersePC - Minecraft 启动器 Electron 主进程入口
 * ============================================================================
 * 职责：
 * 1. 窗口管理 - 创建无边框窗口，全屏/最大化/窗口模式切换
 * 2. IPC 通信 - 渲染进程与主进程的通信桥梁（窗口控制、存储、剪贴板、文件对话框）
 * 3. 协议处理 - 注册 versepc:// 自定义协议，处理 API 请求和静态文件
 * 4. API 路由 - 将协议请求分发给 server.js 的业务逻辑处理
 * 5. 模组文件操作 - 提供文件浏览、读写、JAR 解析等 IPC 接口
 * 6. 自动更新 - 基于 electron-updater 的版本检查和更新下载
 * 7. JAR/ZIP 解析 - 纯原生 JS 实现的 ZIP 文件格式解析器
 * 8. 整合包导入 - 通过 IPC 调用 server.js 的整合包导入功能
 *
 * 架构说明：
 * - 使用自定义 versepc:// 协议替代传统 HTTP 服务器，消除端口冲突
 * - contextIsolation: true + preload.cjs 实现安全的进程隔离
 * - server.js 通过 require() 直接加载，使用 handleNativeAPI/handleNativeSSE 接口
 * - 无 Express/HTTP 层，协议请求直接调用业务函数，性能更高
 */

// ============================================================================
// 单实例锁 - 必须在所有初始化之前执行，防止重复启动导致闪窗口
// ============================================================================
const { app } = require('electron');
const { checkTampering: _chkTamper, autoRecover: _autoRecover } = require('./activation/activation-verify');

try {
    const { exec: _execAsync } = require('child_process');
    const _currentPid = process.pid;
    _execAsync('chcp 65001 >nul 2>nul && wmic process where "name=\'VersePC.exe\'" get ProcessId,ParentProcessId,CommandLine /format:csv 2>nul', { encoding: 'utf8', timeout: 5000, windowsHide: true }, (_err, _wmicOut) => {
        try {
            if (_wmicOut) {
                for (const _line of _wmicOut.split('\n')) {
                    const _trim = _line.trim();
                    if (!_trim || _trim.startsWith('Node')) continue;
                    const _parts = _trim.split(',');
                    if (_parts.length < 4) continue;
                    const _pid = parseInt(_parts[_parts.length - 2]);
                    const _ppid = parseInt(_parts[_parts.length - 1]);
                    if (!_pid || _pid === _currentPid) continue;
                    if (_ppid && _ppid !== 0) continue;
                    try { process.kill(_pid); } catch (e) {}
                }
            }
        } catch (e) {}
    });
    _execAsync('netstat -ano | findstr LISTENING', { encoding: 'utf8', timeout: 5000, windowsHide: true }, (_err, _netOut) => {
        try {
            if (_netOut) {
                for (let _port = 3001; _port <= 3010; _port++) {
                    const _regex = new RegExp(`:${_port}\\s.*LISTENING\\s+(\\d+)`, 'g');
                    let _match;
                    while ((_match = _regex.exec(_netOut)) !== null) {
                        const _pid = parseInt(_match[1]);
                        if (_pid && _pid !== _currentPid) {
                            try { process.kill(_pid); } catch (e) {}
                        }
                    }
                }
            }
        } catch (e) {}
    });
} catch (e) {}

const gotTheLockEarly = app.requestSingleInstanceLock();
if (!gotTheLockEarly) {
    process.exit(0);
}

// ============================================================================
// V8 Code Cache - 首次启动后缓存编译结果，后续启动提速 40-60%
// ============================================================================
try {
    const v8 = require('v8');
    const cacheDir = require('path').join(require('os').tmpdir(), 'versepc-v8-cache');
    try { require('fs').mkdirSync(cacheDir, { recursive: true }); } catch (e) {}
    v8.setFlagsFromString('--compile-cache-dir=' + cacheDir);
} catch (e) {}

// ============================================================================
// V8 内存上限 - 根据系统内存动态设置，防止渲染进程 OOM 崩溃
// ============================================================================
try {
    const osMod = require('os');
    const totalMemMB = Math.floor(osMod.totalmem() / 1024 / 1024);
    let rendererHeapMB;
    if (totalMemMB <= 4096) rendererHeapMB = 768;
    else if (totalMemMB <= 8192) rendererHeapMB = 1024;
    else if (totalMemMB <= 16384) rendererHeapMB = 1536;
    else rendererHeapMB = 2048;
    process.env.ELECTRON_RENDERER_V8_HEAP_SIZE = String(rendererHeapMB);
    try {
        const v8 = require('v8');
        v8.setFlagsFromString('--max-old-space-size=' + rendererHeapMB);
    } catch (e) {}
} catch (e) {}

// 运行时完整性自检模块 - 延迟到窗口显示后执行，避免阻塞启动
const { _runIntegrityCheckAsync } = require('./main/integrity');

// ============================================================================
// 模块导入
// ============================================================================
// 注意：app 在第 37 行单实例锁中已解构，这里只补齐其余模块
const { BrowserWindow, Menu, shell, ipcMain, dialog, screen, protocol, clipboard, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ============================================================================
// 全局状态变量
// ============================================================================
// mainWindow / serverModuleCache 仍保留为 main.js 局部变量（createWindow 与多处
// 初始化逻辑重度使用），在创建/加载时同步到 shared-state 供其他模块访问。
// apiHandler / sseExecuteTool / shuttingDown / ssePort 已迁移至 shared-state。
// isClosingAnimation / savedWindowBounds 已迁移至 window-manager 模块。
let mainWindow = null;            // 主窗口实例（同步到 sharedState）
let serverModuleCache = null;     // server.js 模块缓存（同步到 sharedState）

// ============================================================================
// Windows 任务栏图标关联（必须在 app.ready 之前设置）
// ============================================================================
if (process.platform === 'win32') {
    app.setAppUserModelId('com.versepc.launcher');
}

// JSON 自动修复模块 - 检测并修复损坏的配置/数据文件
const { autoRepairJsonFileAsync, repairVersePCDataAsync, _deferredRepairData } = require('./main/json-repair');

// 持久化存储 + 激活验证 IPC（从 main.js 抽离）
const { STORE_PATH, safeWriteFileSync, safeReadJsonFile, loadStore, registerStoreIPC } = require('./main/store');

// 自动更新模块（从 main.js 抽离）
const updaterModule = require('./main/updater');
const { initAutoUpdater, registerUpdaterIPC } = updaterModule;

// 窗口管理模块（从 main.js 抽离：窗口配置 + 窗口控制 IPC + 关闭动画）
const {
    loadWindowConfig, saveWindowConfig, animateCloseWindow,
    getSavedWindowBounds, setSavedWindowBounds,
    getIsClosingAnimation, setIsClosingAnimation,
    registerWindowManagerIPC
} = require('./main/window-manager');

// 编辑器窗口 + 终端会话模块（从 main.js 抽离）
const { setupEditorTerminal, registerEditorTerminalIPC, cleanupTerminals } = require('./main/editor-terminal');

// versepc:// 协议处理模块（从 main.js 抽离：协议路由 + API/SSE + 静态文件 + 路径白名单）
const {
    setupProtocolHandler, handleVersePCProtocol,
    isPathAllowed
} = require('./main/protocol-handler');

// ============================================================================
// 全局错误处理
// ============================================================================
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    _writeCrashLog('unhandledRejection (late): ' + (reason && reason.stack || reason));
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    _writeCrashLog('uncaughtException (late): ' + (err && err.stack || err));
    const msg = err && err.message || '';
    if (msg.includes('ReadableStream') || msg.includes('already closed') || msg.includes('ECONNRESET')) {
        return;
    }
    if (!sharedState.getShuttingDown() && mainWindow) {
        dialog.showErrorBox('发生错误', msg || '未知错误');
    }
});

// 注册 versepc:// 自定义协议为特权协议（支持 Fetch API、CORS、Stream 等）
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'versepc',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
            allowServiceWorkers: true,
        }
    },
    {
        scheme: 'wpfile',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
        }
    }
]);

// ============================================================================
// 窗口创建 - 创建无边框窗口并加载应用界面
// 注意：createWindow 涉及 GPU 看门狗、崩溃恢复、CSS 注入、菜单构建等大量初始化
// 逻辑，故保留在 main.js 中。窗口配置函数与窗口控制 IPC 已抽离至 window-manager。
// ============================================================================

async function createWindow() {
    const [configResult, storeResult] = await Promise.allSettled([
        Promise.resolve().then(() => loadWindowConfig()),
        fs.promises.readFile(STORE_PATH, 'utf-8').then(raw => JSON.parse(raw)).catch(() => null)
    ]);
    const config = configResult.status === 'fulfilled' ? configResult.value : { fullscreen: false, windowMode: true, windowWidth: 1200, windowHeight: 800 };
    const storeData = storeResult.status === 'fulfilled' ? storeResult.value : null;
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

    let bgColor = '#ffffff';
    try {
        if (storeData && storeData.versepc_theme === 'dark') bgColor = '#0a0a0a';
    } catch (e) {}
    console.log('[Window] Final bgColor:', bgColor);

    const windowWidth = config.windowWidth || 1200;
    const windowHeight = config.windowHeight || 800;
    
    let windowX = config.windowX !== undefined ? config.windowX : Math.floor((screenWidth - windowWidth) / 2);
    let windowY = config.windowY !== undefined ? config.windowY : Math.floor((screenHeight - windowHeight) / 2);

    const workArea = primaryDisplay.workArea;
    if (windowX < workArea.x || windowX + windowWidth > workArea.x + workArea.width ||
        windowY < workArea.y || windowY + windowHeight > workArea.y + workArea.height) {
        windowX = Math.floor((screenWidth - windowWidth) / 2);
        windowY = Math.floor((screenHeight - windowHeight) / 2);
    }

    const isMac = process.platform === 'darwin';

    mainWindow = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        x: windowX,
        y: windowY,
        minWidth: 800,
        minHeight: 450,
        frame: false,
        ...(isMac ? { titleBarStyle: 'hiddenInset' } : {}),
        show: false,
        backgroundColor: bgColor,
        title: 'VersePC - Minecraft Launcher',
        icon: path.join(__dirname, 'img', 'icon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            webviewTag: true,
            preload: path.join(__dirname, 'preload.cjs'),
        },
    });
    // 同步主窗口实例到共享状态，供 window-manager 等抽离模块访问
    sharedState.setMainWindow(mainWindow);
    mainWindow.show();

    // 根据保存的配置恢复窗口状态
    if (config.fullscreen && !config.windowMode) {
        setSavedWindowBounds({ x: windowX, y: windowY, width: windowWidth, height: windowHeight });
        mainWindow.setFullScreen(true);
    } else if (config.maximized) {
        mainWindow.maximize();
    }

    // 使用 versepc:// 协议加载首页
    mainWindow.loadURL('versepc://app/index.html');

    // GPU 黑屏检测：8秒内页面未渲染则标记下次禁用GPU
    const _gpuWatchdog = setTimeout(() => {
        try {
            mainWindow.webContents.executeJavaScript('document.body.children.length').then(len => {
                if (len === 0) {
                    console.log('[GPU] Page not rendered in 8s, flagging GPU disable for next launch');
                    require('fs').writeFileSync(disableGpuFile, '1');
                    const _gpuFg = bgColor === '#ffffff' ? '#1a1a1a' : '#e5e5e5';
                    const _gpuSub = bgColor === '#ffffff' ? '#666' : '#888';
                    const _gpuBtn = bgColor === '#ffffff' ? '#ccc' : '#555';
                    mainWindow.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="background:${bgColor};color:${_gpuFg};font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>VersePC 启动异常</h2><p>页面加载失败，可能是显卡驱动问题</p><p style="color:${_gpuSub};font-size:13px">已自动标记禁用GPU加速，请重启应用</p><p style="margin-top:20px"><button onclick="location.href='https://github.com/doujie081231/versePc/issues'" style="padding:8px 16px;border:1px solid ${_gpuBtn};border-radius:6px;background:transparent;color:${_gpuFg};cursor:pointer">报告问题</button></div></div></body></html>`));
                }
            }).catch(() => {});
        } catch (e) {}
    }, 8000);
    mainWindow.webContents.once('did-finish-load', () => clearTimeout(_gpuWatchdog));

    // 渲染进程崩溃检测
    let rendererCrashRetries = 0;
    const MAX_RENDERER_RETRIES = 2;
    mainWindow.webContents.on('render-process-gone', (event, details) => {
        const reason = details.reason || 'unknown';
        const exitCode = details.exitCode || -1;
        console.error(`[Renderer] Process gone: reason=${reason}, exitCode=${exitCode}`);

        const osMod = require('os');
        const freeMB = Math.floor(osMod.freemem() / 1024 / 1024);
        const totalMB = Math.floor(osMod.totalmem() / 1024 / 1024);
        const usedPct = Math.round(((totalMB - freeMB) / totalMB) * 100);

        if (reason === 'oom' && rendererCrashRetries < MAX_RENDERER_RETRIES) {
            rendererCrashRetries++;
            console.log(`[Renderer] OOM 崩溃, 尝试自动恢复 (${rendererCrashRetries}/${MAX_RENDERER_RETRIES})`);
            try {
                if (process.platform === 'win32') {
                    const { execSync } = require('child_process');
                    execSync('powershell -NoProfile -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"', { timeout: 3000, windowsHide: true });
                }
            } catch (e) {}
            setTimeout(() => {
                try { mainWindow.webContents.reload(); } catch (e) {}
            }, 1500);
            return;
        }

        rendererCrashRetries = 0;
        const reasonText = reason === 'oom'
            ? `内存不足 (系统内存使用 ${usedPct}%，剩余 ${freeMB}MB/${totalMB}MB)`
            : `渲染进程异常退出: ${reason} (code: ${exitCode})`;
        const suggestion = reason === 'oom'
            ? '建议关闭其他程序释放内存，或在设置中减少分配给游戏的内存'
            : '请尝试重启启动器';

        mainWindow.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>VersePC 崩溃</title></head><body style="background:#0a0a0a;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center;max-width:500px;padding:20px"><h2 style="margin-bottom:16px">VersePC 崩溃</h2><p style="color:#ccc;margin-bottom:8px">' + reasonText + '</p><p style="color:#888;font-size:13px;margin-bottom:24px">' + suggestion + '</p><div style="display:flex;gap:12px;justify-content:center"><button onclick="location.reload()" style="padding:10px 24px;border:1px solid #555;border-radius:8px;background:transparent;color:#e5e5e5;cursor:pointer;font-size:14px">重新加载</button><button onclick="require(\'electron\').ipcRenderer.send(\'relaunch-app\')" style="padding:10px 24px;border:1px solid #0066cc;border-radius:8px;background:#0066cc;color:white;cursor:pointer;font-size:14px">重启启动器</button></div></div></body></html>'
        ));
    });

    mainWindow.webContents.on('unresponsive', () => {
        console.warn('[Renderer] Window became unresponsive');
    });

    // 窗口关闭时清理引用
    mainWindow.on('closed', () => {
        setIsClosingAnimation(false);
        if (serverModuleCache && serverModuleCache.setMainWindow) {
            serverModuleCache.setMainWindow(null);
        }
        mainWindow = null;
        sharedState.setMainWindow(null);
    });

    // 拦截关闭事件，播放关闭动画（Alt+F4 等系统级关闭触发）
    mainWindow.on('close', (e) => {
        if (!getIsClosingAnimation() && !sharedState.getShuttingDown() && mainWindow && !mainWindow.isDestroyed()) {
            e.preventDefault();
            animateCloseWindow();
        }
    });

    // 窗口大小改变时保存配置（非全屏、非最大化状态才保存）
    mainWindow.on('resize', () => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFullScreen() && !mainWindow.isMaximized()) {
            const bounds = mainWindow.getBounds();
            setSavedWindowBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
            const cfg = loadWindowConfig();
            cfg.windowWidth = bounds.width;
            cfg.windowHeight = bounds.height;
            cfg.windowX = bounds.x;
            cfg.windowY = bounds.y;
            saveWindowConfig(cfg);
        }
    });

    // 窗口移动时保存位置配置
    mainWindow.on('move', () => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFullScreen() && !mainWindow.isMaximized()) {
            const bounds = mainWindow.getBounds();
            setSavedWindowBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
            const cfg = loadWindowConfig();
            cfg.windowX = bounds.x;
            cfg.windowY = bounds.y;
            saveWindowConfig(cfg);
        }
    });

    // 最大化/还原时通知渲染进程
    mainWindow.on('maximize', () => {
        mainWindow.webContents.send('window-state-changed', { maximized: true, fullscreen: mainWindow.isFullScreen() });
    });

    mainWindow.on('unmaximize', () => {
        mainWindow.webContents.send('window-state-changed', { maximized: false, fullscreen: mainWindow.isFullScreen() });
    });

    mainWindow.on('enter-full-screen', () => {
        mainWindow.webContents.send('window-state-changed', { maximized: mainWindow.isMaximized(), fullscreen: true });
    });

    mainWindow.on('leave-full-screen', () => {
        const _savedBounds = getSavedWindowBounds();
        if (_savedBounds) {
            mainWindow.setBounds(_savedBounds);
        }
        mainWindow.webContents.send('window-state-changed', { maximized: mainWindow.isMaximized(), fullscreen: false });
    });

    // 页面加载完成后注入标题栏拖拽样式和窗口模式通知
    mainWindow.webContents.on('did-finish-load', () => {
        const isFullscreen = mainWindow.isFullScreen();
        const isWindowMode = config.windowMode;

        // 注入 CSS：设置标题栏区域可拖拽（-webkit-app-region: drag）
        // 排除右侧按钮区域、侧边栏、启动栏等不可拖拽区域
        mainWindow.webContents.insertCSS(`
            .title-bar {
                -webkit-app-region: drag;
            }
            .title-bar-right, .title-bar-right * {
                -webkit-app-region: no-drag;
            }
            .sidebar {
                -webkit-app-region: no-drag;
            }
            .launch-bar {
                -webkit-app-region: no-drag;
            }
            .window-controls, .window-controls * {
                -webkit-app-region: no-drag;
            }
        `);

        // 通知渲染进程当前窗口模式
        mainWindow.webContents.send('window-mode-changed', {
            fullscreen: isFullscreen,
            windowMode: isWindowMode,
            maximized: mainWindow.isMaximized()
        });

        // 开发环境才打开 DevTools
        if (process.env.NODE_ENV == 'dev') {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
    });

    // 外部链接在系统浏览器中打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // 构建应用菜单栏（中文）
    const menuTemplate = [
        {
            label: '文件',
            submenu: [
                { role: 'quit', label: '退出' }
            ]
        },
        {
            label: '编辑',
            submenu: [
                { role: 'undo', label: '撤销' },
                { role: 'redo', label: '重做' },
                { type: 'separator' },
                { role: 'cut', label: '剪切' },
                { role: 'copy', label: '复制' },
                { role: 'paste', label: '粘贴' },
                { role: 'selectAll', label: '全选' }
            ]
        },
        {
            label: '视图',
            submenu: [
                { role: 'reload', label: '刷新' },
                { role: 'forceReload', label: '强制刷新' },
                { type: 'separator' },
                { role: 'resetZoom', label: '重置缩放' },
                { role: 'zoomIn', label: '放大' },
                { role: 'zoomOut', label: '缩小' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: '全屏' },
                { type: 'separator' },
                {
                    label: '开发者工具',
                    accelerator: 'CmdOrCtrl+Shift+I',
                    click: () => {
                        mainWindow?.webContents.toggleDevTools();
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
}

// ============================================================================
// 窗口控制 IPC（window-minimize/maximize/close/is-maximized/is-fullscreen/
// set-fullscreen/set-window-mode、app-quit、relaunch-app）+ 关闭动画
// 已抽离至 main/window-manager.js，通过 registerWindowManagerIPC(app) 注册
// ============================================================================

// 文件打开对话框（通用对话框，保留在 main.js）
ipcMain.handle('dialog-open', async (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return dialog.showOpenDialog(win, options);
});

// ============================================================================
// 编辑器窗口 + 编辑器文件操作 IPC + 终端会话 + 终端 IPC
// 已抽离至 main/editor-terminal.js，通过 registerEditorTerminalIPC() 注册
// ============================================================================

ipcMain.handle('get-memory-info', async () => {
    try {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        return {
            total: totalMem,
            free: freeMem,
            used: usedMem,
            loadPercent: Math.round((usedMem / totalMem) * 100)
        };
    } catch (e) {
        return { total: 0, free: 0, used: 0, loadPercent: 0, error: e.message };
    }
});

ipcMain.handle('memory-optimize', async () => {
    if (process.platform !== 'win32') {
        return { success: false, error: '内存优化功能仅支持 Windows 系统' };
    }
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const psScript = `$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -MemberDefinition '[DllImport("psapi.dll")] public static extern int EmptyWorkingSet(IntPtr hwProc);' -Name "W32PSAPI" -Namespace "VP" -WarningAction SilentlyContinue -PassThru | Out-Null
Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] private static extern int SetSystemInformation(uint infoClass, IntPtr info, uint length);' -Name "W32SysInfo" -Namespace "VP" -WarningAction SilentlyContinue -PassThru | Out-Null
Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);' -Name "W32File" -Namespace "VP" -WarningAction SilentlyContinue -PassThru | Out-Null
Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FlushFileBuffers(IntPtr hFile);' -Name "W32Flush" -Namespace "VP" -WarningAction SilentlyContinue -PassThru | Out-Null
Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr hObject);' -Name "W32Close" -Namespace "VP" -WarningAction SilentlyContinue -PassThru | Out-Null
$before = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
function DoRound {
    try {
        $h = [VP.W32File]::CreateFile("\\\\.\\C:", 0x40000000, 0x00000003, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
        if ($h -ne [IntPtr]::Zero -and [long]$h -ne -1) {
            [void][VP.W32Flush]::FlushFileBuffers($h)
            [void][VP.W32Close]::CloseHandle($h)
        }
    } catch {}
    Start-Sleep -Milliseconds 1000
    Get-Process | ForEach-Object {
        try { [void][VP.W32PSAPI]::EmptyWorkingSet($_.Handle) } catch {}
    }
    try { [VP.W32SysInfo]::SetSystemInformation(80, [IntPtr]::Zero, 0) } catch {}
    try { [VP.W32SysInfo]::SetSystemInformation(81, [IntPtr]::Zero, 0) } catch {}
    try { [VP.W32SysInfo]::SetSystemInformation(82, [IntPtr]::Zero, 0) } catch {}
    try { [VP.W32SysInfo]::SetSystemInformation(39, [IntPtr]::Zero, 0) } catch {}
}
DoRound
Start-Sleep -Seconds 3
[GC]::Collect()
[GC]::WaitForPendingFinalizers()
DoRound
Start-Sleep -Seconds 3
[GC]::Collect()
[GC]::WaitForPendingFinalizers()
DoRound
Start-Sleep -Seconds 2
$after = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
$diff = $after - $before
@{ Before=$before; After=$after; Diff=$diff } | ConvertTo-Json -Compress`;
    const tmpScript = path.join(os.tmpdir(), 'versepc_memopt.ps1');
    return new Promise((resolve) => {
        try {
            fs.writeFileSync(tmpScript, psScript, 'utf8');
        } catch (e) {
            resolve({ success: false, error: 'write script failed: ' + e.message });
            return;
        }
        const { execFile } = require('child_process');
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpScript], { timeout: 90000 }, (err, stdout, stderr) => {
            try { fs.unlinkSync(tmpScript); } catch (_) {}
            if (err) {
                resolve({ success: false, error: err.message });
                return;
            }
            try {
                const result = JSON.parse(stdout.trim());
                resolve({
                    success: true,
                    freedMB: Math.round(result.Diff),
                    beforeMB: Math.round(result.Before),
                    afterMB: Math.round(result.After)
                });
            } catch (e) {
                resolve({ success: false, error: 'parse failed: ' + e.message });
            }
        });
    });
});

ipcMain.handle('jvm-preheat', async (event, javaPath, maxMemMB) => {
    return { success: true };
});

// ============================================================================
// 整合包导入 IPC Handler - 主进程通过 IPC 调用 server.js 的整合包导入功能
// ============================================================================
ipcMain.handle('import-modpack', async (event, filePath, targetVersion = '') => {
    console.log(`[IPC] import-modpack 收到请求: ${filePath}, 目标版本: ${targetVersion || '(自动)'}`);
    try {
        if (!serverModuleCache || !serverModuleCache.importModpackFromPath) {
            console.error(`[IPC] import-modpack 服务器模块未就绪`);
            return { success: false, error: '服务器模块尚未准备好，请稍后重试' };
        }
        const sender = event.sender;
        const result = await serverModuleCache.importModpackFromPath(filePath, (progress) => {
            if (!sender.isDestroyed()) {
                sender.send('import-progress', progress);
            }
        }, targetVersion);
        console.log(`[IPC] import-modpack 完成: ${result?.success ? '成功' : '失败'} ${result?.error || ''}`);
        return result;
    } catch (e) {
        console.error('[IPC] import-modpack 异常:', e);
        return { success: false, error: e.message };
    }
});

// ============================================================================
// Server 模块加载 - 崩溃隔离 + 自动重载
// ============================================================================
let _serverLoadTime = 0;
let _serverCrashCount = 0;
const SERVER_MAX_CRASHES = 3;

function loadServerModule() {
    const serverPath = path.join(__dirname, 'server.js');
    _writeCrashLog('[Server] Loading module from: ' + serverPath);
    try {
        delete require.cache[require.resolve(serverPath)];
        const serverModule = require(serverPath);
        serverModuleCache = serverModule;
        sharedState.setServerModuleCache(serverModule);
        sharedState.setApiHandler({
            handleNativeAPI: serverModule.handleNativeAPI,
            handleNativeSSE: serverModule.handleNativeSSE,
        });
        _serverLoadTime = Date.now();
        console.log('[Server] Module loaded/reloaded successfully');
        _writeCrashLog('[Server] Module loaded successfully');
        return serverModule;
    } catch (e) {
        _writeCrashLog('[Server] Module load FAILED: ' + (e && e.stack || e));
        throw e;
    }
}

function reloadServerModule() {
    _serverCrashCount++;
    if (_serverCrashCount > SERVER_MAX_CRASHES) {
        console.error(`[Server] 崩溃次数超过 ${SERVER_MAX_CRASHES} 次，不再自动重载`);
        return false;
    }
    console.warn(`[Server] 正在重载模块 (第 ${_serverCrashCount} 次)...`);
    try {
        if (serverModuleCache && serverModuleCache.cleanupOnShutdown) {
            try { serverModuleCache.cleanupOnShutdown(); } catch (e) {}
        }
        loadServerModule();
        return true;
    } catch (e) {
        console.error('[Server] 重载失败:', e.message);
        return false;
    }
}

// ============================================================================
// 抽离模块的 IPC 注册与依赖注入（顶层执行，在 app.whenReady 之前完成）
// ============================================================================
// 窗口控制 IPC（window-minimize/maximize/close/...、app-quit、relaunch-app）
registerWindowManagerIPC(app);
// 编辑器窗口 + 终端 IPC，注入项目根目录用于路径白名单校验
setupEditorTerminal({ appRoot: __dirname });
registerEditorTerminalIPC();
// 协议处理器依赖注入：appRoot 替代 __dirname，reloadServerModule/崩溃计数由 main.js 提供
setupProtocolHandler({
    appRoot: __dirname,
    reloadServerModule,
    getServerCrashCount: () => _serverCrashCount,
    SERVER_MAX_CRASHES
});

// ============================================================================
// GPU 硬件加速 + 高帧率支持 - 默认启用以获得流畅界面
// ============================================================================
const disableGpuFile = path.join(app.getPath('userData'), '.disable-gpu');
const safeMode = process.argv.includes('--safe-mode') || process.argv.includes('--disable-gpu');
const forceDisableGpu = process.argv.includes('--disable-gpu');

app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('enable-use-zoom-for-dsf', 'true');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-frame-rate-limit');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

const shouldDisableGpu = forceDisableGpu || safeMode || require('fs').existsSync(disableGpuFile);

if (shouldDisableGpu) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('use-gl', 'swiftshader');
    if (safeMode) console.log('[GPU] Hardware acceleration disabled (safe mode)');
    else if (require('fs').existsSync(disableGpuFile)) console.log('[GPU] Hardware acceleration disabled (previous GPU failure)');
} else {
    console.log('[GPU] Hardware acceleration enabled (high frame rate mode)');
}

app.on('gpu-info-update', () => {
    try {
        const info = app.getGPUFeatureInfo();
        if (info && info.status === 3) {
            console.log('[GPU] GPU fallen back to software rendering, disabling for next launch');
            require('fs').writeFileSync(disableGpuFile, '1');
        }
    } catch (e) {}
});

// ============================================================================
// 单实例锁的第二阶段：second-instance 事件处理（仅在拿到锁的实例中注册）
// 单实例锁检查已上移到文件最早期（line 33-41），此处只注册事件处理器
// ============================================================================
app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        if (mainWindow.isFullScreen()) {
        } else {
            mainWindow.focus();
        }
        if (process.platform === 'win32') {
            try { mainWindow.flashFrame(true); setTimeout(() => { try { mainWindow.flashFrame(false); } catch (e) {} }, 800); } catch (e) {}
        }
        mainWindow.moveTop();
    } else {
        if (typeof createWindow === 'function') createWindow().catch(() => {});
    }
});

// ============================================================================
// 应用就绪 - Electron 启动完成后的初始化流程
// ============================================================================
app.whenReady().then(async () => {
    try {
        console.log('VersePC starting...');

        _autoRecover();

        let _serverReady = false;
        protocol.handle('versepc', async (request) => {
            if (!_serverReady) {
                const reqUrl = new URL(request.url);
                if (reqUrl.pathname.startsWith('/api/')) {
                    return new Response(JSON.stringify({ error: 'Server loading...' }), {
                        status: 503, headers: { 'Content-Type': 'application/json' }
                    });
                }
            }
            return handleVersePCProtocol(request);
        });

        // 创建窗口（最优先）
        await createWindow();

        // 启动成功，清除崩溃日志
        try { require('fs').writeFileSync(_crashLogPath, '', 'utf8'); } catch (e) {}

        // 窗口显示后再做一切非关键初始化
        setImmediate(() => {
            // CSP 安全头
            session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
                const responseHeaders = { ...details.responseHeaders };
                if (details.url.startsWith('versepc://') || details.url.startsWith('devtools://')) {
                    responseHeaders['Content-Security-Policy'] = [
                        "default-src 'self' versepc:; " +
                        "script-src 'self' versepc: 'unsafe-inline' 'unsafe-eval'; " +
                        "style-src 'self' versepc: 'unsafe-inline' https://fonts.googleapis.com; " +
                        "img-src 'self' versepc: wpfile: data: blob: https:; " +
                        "font-src 'self' versepc: data: https://fonts.gstatic.com; " +
                        "connect-src 'self' versepc: ws: wss: http://localhost:* https:; " +
                        "media-src 'self' versepc: wpfile: blob:; " +
                        "child-src 'self' blob:; " +
                        "worker-src 'self' blob:; " +
                        "object-src 'none'; " +
                        "base-uri 'self';"
                    ];
                }
                callback({ responseHeaders });
            });

            // wpfile 协议
            protocol.handle('wpfile', (request) => {
                try {
                    const url = new URL(request.url);
                    let filePath = decodeURIComponent(url.pathname);
                    if (filePath.startsWith('/')) filePath = filePath.substring(1);
                    const resolved = path.resolve(filePath);
                    if (!isPathAllowed(resolved)) return new Response('Forbidden', { status: 403 });
                    if (!fs.existsSync(resolved)) return new Response('Not Found', { status: 404 });
                    const ext = path.extname(resolved).toLowerCase();
                    const allowedExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.mp4', '.webm', '.mkv', '.avi', '.cur', '.ani', '.ico'];
                    if (!allowedExts.includes(ext)) return new Response('Forbidden', { status: 403 });
                    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.cur': 'image/x-icon', '.ani': 'image/x-icon', '.ico': 'image/x-icon' };
                    const mime = mimeMap[ext] || 'application/octet-stream';
                    const stat = fs.statSync(resolved);
                    const fileSize = stat.size;
                    const rangeHeader = request.headers.get('range');
                    if (rangeHeader) {
                        const parts = rangeHeader.replace(/bytes=/, '').split('-');
                        const start = parseInt(parts[0], 10);
                        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                        const chunkSize = end - start + 1;
                        const stream = fs.createReadStream(resolved, { start, end });
                        return new Response(stream, { status: 206, headers: { 'Content-Type': mime, 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(chunkSize) } });
                    }
                    const stream = fs.createReadStream(resolved);
                    return new Response(stream, { status: 200, headers: { 'Content-Type': mime, 'Content-Length': String(fileSize), 'Accept-Ranges': 'bytes' } });
                } catch (e) {
                    return new Response('Error: ' + e.message, { status: 500 });
                }
            });

            // IPC 和其他初始化
            registerModsIPC({ isPathAllowed, loadStore });
            registerStoreIPC({ app, isPathAllowed });
            updaterModule.setup({
                getMainWindow: () => mainWindow,
                setShuttingDown: (v) => sharedState.setShuttingDown(v),
                isBeta: IS_BETA
            });
            registerUpdaterIPC();
            initAutoUpdater();

            // 加载 server.js、启动 SSE、完整性检查等（延迟执行，不阻塞启动）
            setImmediate(() => {
                try { loadServerModule(); } catch (e) { console.error('[Server] Load failed:', e.message); }
                _serverReady = true;
                if (serverModuleCache && serverModuleCache.setMainWindow) {
                    try { serverModuleCache.setMainWindow(mainWindow); } catch (e) {}
                }
                try { _runIntegrityCheckAsync().catch(() => {}); } catch (e) {}
                try { _deferredRepairData(); } catch (e) {}
                if (serverModuleCache) {
                    try { serverModuleCache.logStartupInfo(); } catch (e) {}
                }
            });
        });

    } catch (e) {
        console.error('Failed to start:', e);
        _writeCrashLog('app.whenReady failed: ' + (e && e.stack || e));
        const _errMsg = String(e && e.message || e || '未知错误');
        const _isModuleError = _errMsg.includes('Cannot find module') || _errMsg.includes('MODULE_NOT_FOUND');
        const _isVCRuntime = _errMsg.includes('.dll') || _errMsg.includes('vcruntime') || _errMsg.includes('msvcp');
        let _detail = _errMsg;
        if (_isModuleError) {
            _detail = '缺少必要文件：' + _errMsg + '\n\n请尝试重新安装 VersePC。';
        } else if (_isVCRuntime) {
            _detail = '缺少系统运行库（VC++ Redistributable）：' + _errMsg + '\n\n请安装 Visual C++ 运行库后重试。\n下载地址：https://aka.ms/vs/17/release/vc_redist.x64.exe';
        }
        dialog.showErrorBox('VersePC 启动失败', _detail + '\n\n崩溃日志已保存到：\n' + _crashLogPath);
        app.quit();
    }

    // macOS: 点击 Dock 图标时重新创建窗口
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(() => {});
    });
});

// 所有窗口关闭时退出应用（macOS 除外，macOS 下应用通常保持运行）
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async (event) => {
    if (sharedState.getShuttingDown()) return;
    sharedState.setShuttingDown(true);

    if (global._previewServer) {
        try { global._previewServer.close(); } catch (e) {}
        global._previewServer = null;
    }
    if (global._bgProcesses) {
        for (const [pid, proc] of Object.entries(global._bgProcesses)) {
            try { process.kill(Number(pid)); } catch (e) {}
        }
        global._bgProcesses = {};
    }
    // 终端会话清理已抽离至 editor-terminal.js
    cleanupTerminals();

    if (serverModuleCache && serverModuleCache.cleanupOnShutdown) {
        try {
            console.log('[App] 正在清理下载任务...');
            const cleanupTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('清理超时')), 5000));
            await Promise.race([serverModuleCache.cleanupOnShutdown(), cleanupTimeout]);
            console.log('[App] 下载任务清理完成');
        } catch (e) {
            console.error('[App] 关闭清理失败:', e.message);
        }
    }

    try {
        const { exec } = require('child_process');
        exec('taskkill /F /IM VersePC.exe /T', { windowsHide: true }, () => {});
    } catch (e) {}
});

app.on('web-contents-created', (event, contents) => {
    contents.on('new-window', (event, navigationUrl) => {
        event.preventDefault();
        shell.openExternal(navigationUrl);
    });

    contents.on('will-navigate', (event, navigationUrl) => {
        const parsed = new URL(navigationUrl);
        if (parsed.protocol !== 'versepc:' && parsed.protocol !== 'devtools:') {
            event.preventDefault();
        }
    });

    contents.on('will-attach-webview', (event, webPreferences, params) => {
        const src = new URL(params.src);
        if (src.protocol !== 'versepc:' && src.protocol !== 'https:') {
            event.preventDefault();
        }
        delete webPreferences.nodeIntegration;
        delete webPreferences.nodeIntegrationInWorker;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
    });

    if (app.isPackaged) {
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
});

// ============================================================================
// versepc:// 协议处理（handleVersePCProtocol/handleAPIRequest/handleSSERequest/
// handleStaticFile）+ 路径白名单（getAllowedPathRoots/isPathAllowed）+ MIME_TYPES
// 已抽离至 main/protocol-handler.js，通过 setupProtocolHandler(...) 注入依赖
// ============================================================================

const { registerModsIPC } = require('./main/mods-ipc');

// IS_BETA 占位符 - 在构建时由 generate-integrity.js 替换为 true/false。
// 保留在 main.js 中（构建脚本只处理 main.js），通过 updaterModule.setup 注入到 updater.js。
// IS_BETA is injected at build time via generate-integrity.js placeholder replacement.
// This avoids relying on runtime env detection (which caused false positives when
// beta.flag was packaged into release builds).
let IS_BETA = (() => { try { return __IS_BETA__; } catch (_) { return false; } })();

/* @versepc-protected: anti-ai-plagiarism-v1.0 */
