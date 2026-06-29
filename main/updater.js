/**
 * @file main/updater.js
 * @description 自动更新模块 - 多源 update.json 检测 + electron-updater 后备
 *
 * 职责：
 * 1. 多源 update.json 检测（jsdelivr / github / ghproxy 镜像）
 * 2. 版本比较、带 SHA256 校验的多镜像下载
 * 3. 启动时静默检查，发现新版本弹出通知
 * 4. 注册更新相关 IPC：updater:check-for-updates / download-update /
 *    install-update / get-version / skip-version / open-release-page
 *
 * 依赖注入：setup({ getMainWindow, setShuttingDown, isBeta }) 接收主进程注入的依赖
 * - getMainWindow: () => BrowserWindow | null  主窗口 getter（窗口可能被重建）
 * - setShuttingDown: (v: boolean) => void      设置关闭标志（runInstallerAndQuit 使用）
 * - isBeta: boolean                            是否测试版（决定更新源）
 */

const { app, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');

// electron-updater 懒加载（当前实现以多源 update.json 为主，保留 autoUpdater 备用）
let _autoUpdater;
function getAutoUpdater() {
  if (!_autoUpdater) _autoUpdater = require('electron-updater').autoUpdater;
  return _autoUpdater;
}

// 更新状态
let updateDownloaded = false;       // 更新是否已下载完成
let updateAvailableInfo = null;     // 可用的更新信息（用于弹窗通知）
let updateDownloadedPath = null;    // 已下载的安装包路径

// 更新配置文件路径
const UPDATE_CONFIG_PATH = path.join(require('os').homedir(), '.versepc', 'update-config.json');

// 依赖注入的句柄
let _getMainWindow = null;
let _setShuttingDown = null;
let _isBeta = false;

// 更新源（根据 isBeta 选择 beta 或正式版仓库）
let UPDATE_JSON_SOURCES = null;

// 私有函数：按 isBeta 初始化更新源列表
function _ensureSources() {
  if (UPDATE_JSON_SOURCES) return;
  if (_isBeta) {
    UPDATE_JSON_SOURCES = [
      'https://cdn.jsdelivr.net/gh/doujie081231/VersePC-beta@main/update.json',
      'https://raw.githubusercontent.com/doujie081231/VersePC-beta/main/update.json',
      'https://mirror.ghproxy.com/raw.githubusercontent.com/doujie081231/VersePC-beta/main/update.json',
    ];
  } else {
    UPDATE_JSON_SOURCES = [
      'https://cdn.jsdelivr.net/gh/doujie081231/versePc@main/update.json',
      'https://raw.githubusercontent.com/doujie081231/versePc/main/update.json',
      'https://mirror.ghproxy.com/raw.githubusercontent.com/doujie081231/versePc/main/update.json',
    ];
  }
}

// 下载镜像转换函数
const DOWNLOAD_MIRRORS = [
  (url) => url,
  (url) => url.replace('https://github.com/', 'https://mirror.ghproxy.com/https://github.com/'),
  (url) => {
    const match = url.match(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)/);
    if (match) {
      return `https://cdn.jsdelivr.net/gh/${match[1]}/${match[2]}@${match[3]}/${match[4]}`;
    }
    return url;
  },
];

/**
 * 从多个源获取 update.json
 * @returns {Promise<Object|null>} 更新信息对象，获取失败返回 null
 */
async function fetchUpdateJson() {
  _ensureSources();
  const bust = Date.now();
  for (const url of UPDATE_JSON_SOURCES) {
    try {
      const fetchUrl = url + '?t=' + bust;
      console.log('[Updater] Trying source:', fetchUrl.substring(0, 80));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await net.fetch(fetchUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        console.log('[Updater] Source returned', response.status);
        continue;
      }
      const data = await response.json();
      if (data && data.version && data.files) {
        console.log('[Updater] Got update info, version:', data.version);
        return data;
      }
    } catch (e) {
      console.log('[Updater] Source failed:', e.message);
    }
  }
  return null;
}

/**
 * 版本号比较
 * @param {string} a - 版本号 a
 * @param {string} b - 版本号 b
 * @returns {number} a>b 返回 1，a<b 返回 -1，相等返回 0
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * 多镜像下载文件，带 SHA256 校验
 * @param {Object} fileInfo - 文件信息（含 url、size、sha256）
 * @param {string} targetPath - 本地保存路径
 * @param {(progress: Object) => void} [onProgress] - 下载进度回调
 * @returns {Promise<boolean>} 下载成功返回 true，全部镜像失败返回 false
 */
async function downloadWithFallback(fileInfo, targetPath, onProgress) {
  const crypto = require('crypto');

  for (const getMirrorUrl of DOWNLOAD_MIRRORS) {
    const downloadUrl = getMirrorUrl(fileInfo.url);
    try {
      console.log('[Updater] Downloading from:', downloadUrl);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await net.fetch(downloadUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        console.log('[Updater] Download failed, status:', response.status);
        continue;
      }

      const totalSize = parseInt(response.headers.get('content-length') || fileInfo.size || '0');
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress && totalSize > 0) {
          onProgress({ percent: (received / totalSize) * 100, transferred: received, total: totalSize });
        }
      }

      const buffer = Buffer.concat(chunks);

      // SHA256 校验，不匹配则抛错切换下一镜像
      if (fileInfo.sha256) {
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        if (hash !== fileInfo.sha256) {
          console.error('[Updater] SHA256 mismatch:', hash, 'expected:', fileInfo.sha256);
          throw new Error('SHA256 校验失败');
        }
      }

      fs.writeFileSync(targetPath, buffer);
      console.log('[Updater] Download complete:', targetPath);
      return true;
    } catch (e) {
      console.log('[Updater] Download source failed:', downloadUrl, e.message);
    }
  }
  return false;
}

/**
 * 读取更新配置（记录用户跳过的版本）
 * @returns {{skippedVersion: string|null}} 更新配置对象
 */
function loadUpdateConfig() {
  try {
    if (fs.existsSync(UPDATE_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(UPDATE_CONFIG_PATH, 'utf8'));
    }
  } catch (e) {}
  return { skippedVersion: null };
}

/**
 * 保存更新配置
 * @param {Object} config - 更新配置对象
 */
function saveUpdateConfig(config) {
  try {
    const dir = path.dirname(UPDATE_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(UPDATE_CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {}
}

/**
 * 向渲染进程发送更新状态事件
 * @param {string} channel - 事件频道
 * @param {*} data - 事件数据
 */
function sendToUpdateUI(channel, data) {
  const mw = _getMainWindow && _getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('updater-status', { channel, data });
  }
}

/**
 * 初始化自动更新器 - 启动后静默检查，发现新版本弹出通知
 */
function initAutoUpdater() {
  const config = loadUpdateConfig();

  setTimeout(async () => {
    try {
      sendToUpdateUI('checking-for-update');
      const updateInfo = await fetchUpdateJson();
      if (!updateInfo) {
        console.log('[Updater] No update info available');
        sendToUpdateUI('update-error', {
          message: '无法获取更新信息，请检查网络连接后重试',
          hint: '可尝试使用 VPN 或稍后再试'
        });
        return;
      }

      const currentVersion = app.getVersion();
      if (compareVersions(updateInfo.version, currentVersion) <= 0) {
        sendToUpdateUI('update-not-available', { version: currentVersion });
        return;
      }

      const cfg = loadUpdateConfig();
      if (cfg.skippedVersion === updateInfo.version) {
        sendToUpdateUI('update-skipped', { version: updateInfo.version });
        return;
      }

      updateAvailableInfo = updateInfo;
      sendToUpdateUI('update-available', {
        version: updateInfo.version,
        releaseDate: updateInfo.releaseDate,
        releaseName: updateInfo.releaseName,
        releaseNotes: updateInfo.releaseNotes,
      });
      showUpdateNotification(updateInfo);
    } catch (e) {
      console.error('[Updater] Check failed:', e.message);
      sendToUpdateUI('update-error', {
        message: e.message || '检查更新失败',
        hint: '可尝试使用 VPN 或稍后再试'
      });
    }
  }, 3000);
}

/**
 * 显示更新可用通知（向主窗口发送事件）
 * @param {Object} info - 更新信息
 */
function showUpdateNotification(info) {
  const mw = _getMainWindow && _getMainWindow();
  if (!mw || mw.isDestroyed()) return;
  const notes = typeof info.releaseNotes === 'string'
    ? info.releaseNotes
    : Array.isArray(info.releaseNotes)
      ? info.releaseNotes.map((n) => n.note || '').filter(Boolean).join('\n')
      : '';
  sendToUpdateUI('update-available', {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseName: info.releaseName,
    releaseNotes: notes,
    currentVersion: app.getVersion(),
  });
}

/**
 * 下载更新包
 * @param {Object} updateInfo - 更新信息
 * @returns {Promise<void>}
 */
async function doDownloadUpdate(updateInfo) {
  const fileInfo = updateInfo.files?.['win-x64'];
  if (!fileInfo) {
    sendToUpdateUI('update-error', { message: '未找到适用于当前平台的安装包' });
    return;
  }

  sendToUpdateUI('start-download', {});

  const targetPath = path.join(app.getPath('temp'), `VersePC-Setup-${updateInfo.version}.exe`);

  try {
    const success = await downloadWithFallback(fileInfo, targetPath, (progress) => {
      sendToUpdateUI('download-progress', {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
      });
    });

    if (success) {
      updateDownloadedPath = targetPath;
      updateDownloaded = true;
      sendToUpdateUI('update-downloaded', {
        version: updateInfo.version,
        releaseName: updateInfo.releaseName,
      });
      showUpdateReadyDialog(updateInfo);
    } else {
      sendToUpdateUI('update-error', { message: '所有下载源均失败，请稍后重试或手动下载' });
    }
  } catch (e) {
    sendToUpdateUI('update-error', { message: e.message || '下载失败' });
  }
}

/**
 * 更新下载完成后弹窗询问是否立即安装
 * @param {Object} info - 更新信息
 */
function showUpdateReadyDialog(info) {
  const mw = _getMainWindow && _getMainWindow();
  if (!mw || mw.isDestroyed()) return;
  dialog.showMessageBox(mw, {
    type: 'info',
    title: '更新已就绪',
    message: 'VersePC v' + info.version + ' 已下载完成',
    detail: '点击"立即安装"将关闭应用并启动安装程序。',
    buttons: ['下次再说', '立即安装'],
    defaultId: 1,
    cancelId: 0,
  }).then(({ response }) => {
    if (response === 1) {
      runInstallerAndQuit();
    }
  }).catch(() => {});
}

/**
 * 启动安装程序并退出应用
 */
function runInstallerAndQuit() {
  if (!updateDownloadedPath || !fs.existsSync(updateDownloadedPath)) return;
  if (_setShuttingDown) _setShuttingDown(true);
  const { spawn } = require('child_process');
  spawn(updateDownloadedPath, ['/SILENT'], {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  }).unref();
  app.quit();
}

/**
 * 注册更新相关 IPC 处理器
 */
function registerUpdaterIPC() {
  ipcMain.handle('updater:check-for-updates', async () => {
    try {
      updateAvailableInfo = null;
      sendToUpdateUI('checking-for-update');
      const updateInfo = await fetchUpdateJson();
      if (!updateInfo) {
        sendToUpdateUI('update-error', {
          message: '无法获取更新信息，请检查网络连接后重试',
          hint: '可尝试使用 VPN 或稍后再试'
        });
        return { available: false, error: '无法获取更新信息' };
      }
      const currentVersion = app.getVersion();
      if (compareVersions(updateInfo.version, currentVersion) > 0) {
        updateAvailableInfo = updateInfo;
        sendToUpdateUI('update-available', {
          version: updateInfo.version,
          releaseDate: updateInfo.releaseDate,
          releaseName: updateInfo.releaseName,
          releaseNotes: updateInfo.releaseNotes,
        });
        return { available: true, version: updateInfo.version };
      }
      sendToUpdateUI('update-not-available', { version: currentVersion });
      return { available: false, version: currentVersion };
    } catch (e) {
      sendToUpdateUI('update-error', { message: e.message || '检查更新失败' });
      return { available: false, error: e.message };
    }
  });

  ipcMain.handle('updater:download-update', async () => {
    try {
      if (!updateAvailableInfo) return { success: false, error: '没有可用的更新信息' };
      await doDownloadUpdate(updateAvailableInfo);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('updater:install-update', async () => {
    if (updateDownloaded) {
      runInstallerAndQuit();
      return { success: true };
    }
    return { success: false, error: '更新尚未下载完成' };
  });

  ipcMain.handle('updater:get-version', async () => {
    return { version: app.getVersion() };
  });

  ipcMain.handle('updater:skip-version', async (event, version) => {
    const config = loadUpdateConfig();
    config.skippedVersion = version;
    saveUpdateConfig(config);
    updateAvailableInfo = null;
    return { success: true };
  });

  ipcMain.handle('updater:open-release-page', async () => {
    shell.openExternal('https://github.com/doujie081231/versePc/releases/latest');
    return { success: true };
  });
}

/**
 * 注入主进程依赖
 * @param {Object} deps
 * @param {() => Electron.BrowserWindow | null} deps.getMainWindow - 主窗口 getter
 * @param {(v: boolean) => void} deps.setShuttingDown - 设置关闭标志
 * @param {boolean} deps.isBeta - 是否测试版
 */
function setup({ getMainWindow, setShuttingDown, isBeta }) {
  _getMainWindow = getMainWindow;
  _setShuttingDown = setShuttingDown;
  _isBeta = !!isBeta;
}

module.exports = {
  setup,
  initAutoUpdater,
  registerUpdaterIPC,
  getAutoUpdater,
  getUpdateDownloaded: () => updateDownloaded,
  getUpdateAvailableInfo: () => updateAvailableInfo,
  getUpdateDownloadedPath: () => updateDownloadedPath,
};
