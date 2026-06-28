// ============================================================================
// 窗口管理模块 - 窗口配置持久化 + 窗口控制 IPC + 关闭动画
// ============================================================================
// 职责：
// 1. 窗口配置的加载/保存（loadWindowConfig / saveWindowConfig）
// 2. 关闭动画（animateCloseWindow）
// 3. 窗口控制 IPC：window-minimize/maximize/close/is-maximized/is-fullscreen/
//    set-fullscreen/set-window-mode、app-quit、relaunch-app
//
// 注意：createWindow 函数因涉及大量初始化逻辑（GPU 看门狗、崩溃恢复、CSS 注入、
// 菜单构建等）仍保留在 main.js 中。本模块通过导出 savedWindowBounds 与
// isClosingAnimation 的 getter/setter 供 createWindow 使用，并通过 shared-state
// 读写 mainWindow / shuttingDown。
//
// 依赖注入：
// - registerWindowManagerIPC(app) 接收 electron app 实例
// ============================================================================

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { safeReadJsonFile, safeWriteFileSync } = require('./store');
const sharedState = require('./shared-state');

// 窗口配置文件路径和缓存
const CONFIG_PATH = path.join(os.homedir(), '.versepc', 'window-config.json');
let windowConfigCache = null;     // 配置缓存对象
let windowConfigCacheTime = 0;    // 缓存时间戳
const CONFIG_CACHE_DURATION = 1000; // 缓存有效期（1秒）

// 保存的窗口边界（用于全屏恢复）—— 与 main.js 的 createWindow 共享
let savedWindowBounds = null;
// 是否正在播放关闭动画 —— 与 main.js 的 createWindow 共享
let isClosingAnimation = false;

/**
 * 加载窗口配置
 * @returns {Object} 配置对象 { fullscreen, windowMode, windowWidth, windowHeight, windowX, windowY }
 */
function loadWindowConfig() {
    const defaults = { fullscreen: false, windowMode: true, windowWidth: 1200, windowHeight: 800 };
    const now = Date.now();
    if (windowConfigCache && (now - windowConfigCacheTime) < CONFIG_CACHE_DURATION) {
        return { ...windowConfigCache };
    }
    const config = safeReadJsonFile(CONFIG_PATH, defaults);
    windowConfigCache = { ...config };
    windowConfigCacheTime = now;
    return config;
}

/**
 * 保存窗口配置到磁盘
 * @param {Object} config - 配置对象
 */
function saveWindowConfig(config) {
    try {
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        safeWriteFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        windowConfigCache = { ...config };
        windowConfigCacheTime = Date.now();
    } catch (e) { console.error('Failed to save window config:', e); }
}

function getSavedWindowBounds() { return savedWindowBounds; }
function setSavedWindowBounds(b) { savedWindowBounds = b; }
function getIsClosingAnimation() { return isClosingAnimation; }
function setIsClosingAnimation(v) { isClosingAnimation = v; }

/**
 * 播放窗口关闭动画后销毁窗口
 */
function animateCloseWindow() {
    const mainWindow = sharedState.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || isClosingAnimation) return;
    isClosingAnimation = true;

    try { mainWindow.webContents.send('request-close-animate'); } catch (e) {}

    const doAnimate = () => {
        const win = sharedState.getMainWindow();
        if (!win || win.isDestroyed()) { isClosingAnimation = false; return; }

        const bounds = win.getBounds();
        const startY = bounds.y;
        const targetY = startY - bounds.height - 60;
        const duration = 400;
        const startTime = Date.now();

        const timer = setInterval(() => {
            const w = sharedState.getMainWindow();
            if (!w || w.isDestroyed()) { clearInterval(timer); return; }
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = progress < 0.5
                ? 4 * progress * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 3) / 2;

            try {
                w.setBounds({
                    x: bounds.x,
                    y: Math.round(startY + (targetY - startY) * eased),
                    width: bounds.width,
                    height: bounds.height,
                }, false);
                w.setOpacity(1 - progress);
            } catch (e) {}

            if (progress >= 1) {
                clearInterval(timer);
                try { w.destroy(); } catch (e) {}
            }
        }, 20);
    };

    const wasMaximized = mainWindow.isMaximized();
    const wasFullScreen = mainWindow.isFullScreen();

    if (wasFullScreen) {
        mainWindow.setFullScreen(false);
    }
    if (wasMaximized || wasFullScreen) {
        mainWindow.unmaximize();
        setTimeout(doAnimate, 200);
    } else {
        doAnimate();
    }
}

/**
 * 注册窗口控制 IPC 处理器
 * @param {import('electron').App} app
 */
function registerWindowManagerIPC(app) {
    ipcMain.on('window-minimize', () => {
        const win = sharedState.getMainWindow();
        if (win) win.minimize();
    });

    ipcMain.on('window-maximize', () => {
        const win = sharedState.getMainWindow();
        if (win) {
            if (win.isFullScreen()) {
                win.setFullScreen(false);
                if (savedWindowBounds) {
                    win.setBounds(savedWindowBounds);
                }
            } else if (win.isMaximized()) {
                win.unmaximize();
            } else {
                win.maximize();
            }
        }
    });

    ipcMain.on('window-close', () => {
        animateCloseWindow();
    });

    ipcMain.on('relaunch-app', () => {
        app.relaunch();
        app.exit(0);
    });

    ipcMain.handle('window-is-maximized', async () => {
        const win = sharedState.getMainWindow();
        return win ? win.isMaximized() : false;
    });

    ipcMain.handle('window-is-fullscreen', async () => {
        const win = sharedState.getMainWindow();
        return win ? win.isFullScreen() : false;
    });

    // 全屏模式切换
    ipcMain.on('window-set-fullscreen', (event, fullscreen) => {
        const win = sharedState.getMainWindow();
        if (win) {
            if (fullscreen) {
                if (!win.isFullScreen()) {
                    const bounds = win.getBounds();
                    savedWindowBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
                }
                win.setFullScreen(true);
            } else {
                win.setFullScreen(false);
                if (savedWindowBounds) {
                    win.setBounds(savedWindowBounds);
                }
            }
            const config = loadWindowConfig();
            config.fullscreen = fullscreen;
            config.windowMode = !fullscreen;
            if (!fullscreen && savedWindowBounds) {
                config.windowWidth = savedWindowBounds.width;
                config.windowHeight = savedWindowBounds.height;
                config.windowX = savedWindowBounds.x;
                config.windowY = savedWindowBounds.y;
            }
            saveWindowConfig(config);
        }
    });

    // 窗口模式切换（全屏 和 窗口 之间切换）
    ipcMain.on('window-set-window-mode', (event, windowMode) => {
        const win = sharedState.getMainWindow();
        if (win) {
            const config = loadWindowConfig();
            config.windowMode = windowMode;
            if (windowMode) {
                if (win.isFullScreen()) {
                    win.setFullScreen(false);
                    if (savedWindowBounds) {
                        win.setBounds(savedWindowBounds);
                    }
                }
                config.fullscreen = false;
            } else {
                if (!win.isFullScreen()) {
                    const bounds = win.getBounds();
                    savedWindowBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
                }
                win.setFullScreen(true);
                config.fullscreen = true;
            }
            if (windowMode && savedWindowBounds) {
                config.windowWidth = savedWindowBounds.width;
                config.windowHeight = savedWindowBounds.height;
                config.windowX = savedWindowBounds.x;
                config.windowY = savedWindowBounds.y;
            }
            saveWindowConfig(config);
        }
    });

    // 退出应用
    ipcMain.on('app-quit', () => {
        sharedState.setShuttingDown(true);
        app.quit();
    });
}

module.exports = {
    loadWindowConfig,
    saveWindowConfig,
    animateCloseWindow,
    getSavedWindowBounds,
    setSavedWindowBounds,
    getIsClosingAnimation,
    setIsClosingAnimation,
    registerWindowManagerIPC,
};
