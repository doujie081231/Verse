/**
 * @file main/store.js
 * @description 持久化存储 + 激活验证 IPC
 *
 * 职责：
 * 1. 基于 JSON 文件的应用状态存储（loadStore / saveStore）
 * 2. 安全文件读写工具（safeWriteFileSync / safeReadJsonFile）
 * 3. 注册存储相关 IPC：store-get/set/delete、get-machine-id 等
 * 4. 注册激活验证 IPC：activate-verify/status、theme-activate-verify/status
 * 5. 注册辅助 IPC：clipboard-write/read-text、shell-open-external、
 *    preview:stop、read-file-buffer、get-aurora-video-path
 *
 * 依赖注入：registerStoreIPC({ app, isPathAllowed }) 接收主进程注入的依赖
 */

const { ipcMain, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 存储文件路径 - 跟随 DATA_DIR，避免修改数据目录后激活信息丢失
const { APP_STORE_FILE } = require('./paths');
const STORE_PATH = APP_STORE_FILE;

/**
 * 安全写入文件 - 先备份再原子写入，防止写入中断导致文件损坏
 * @param {string} filePath - 目标文件路径
 * @param {string} content - 文件内容
 */
function safeWriteFileSync(filePath, content) {
  const bakPath = filePath + '.bak';
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, bakPath);
    }
  } catch (e) {}
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.writeFileSync(filePath, content, 'utf8'); } catch (e2) {}
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e3) {}
  }
}

/**
 * 安全读取 JSON 文件 - 损坏时尝试从 .bak 恢复
 * @param {string} filePath - 文件路径
 * @param {*} defaults - 文件不存在或损坏且无备份时返回的默认值
 * @returns {*} 解析后的对象，或默认值
 */
function safeReadJsonFile(filePath, defaults) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error(`[Storage] File corrupted: ${filePath}`, e.message);
    const bakPath = filePath + '.bak';
    try {
      if (fs.existsSync(bakPath)) {
        const bakRaw = fs.readFileSync(bakPath, 'utf8');
        const restored = JSON.parse(bakRaw);
        console.log(`[Storage] Recovered from backup: ${bakPath}`);
        safeWriteFileSync(filePath, JSON.stringify(restored, null, 2));
        return restored;
      }
    } catch (e2) {}
    console.warn(`[Storage] No valid backup, using defaults for: ${filePath}`);
  }
  return defaults;
}

// 存储缓存（3秒 TTL，避免频繁读盘）
let _storeCache = null;
let _storeCacheTime = 0;
const STORE_CACHE_TTL = 3000;

/**
 * 加载存储数据
 * @returns {Object} 存储的键值对对象
 */
function loadStore() {
  const now = Date.now();
  if (_storeCache && (now - _storeCacheTime) < STORE_CACHE_TTL) {
    return _storeCache;
  }
  _storeCache = safeReadJsonFile(STORE_PATH, {});
  _storeCacheTime = now;
  return _storeCache;
}

/**
 * 保存存储数据
 * @param {Object} data - 待保存的键值对对象
 */
function saveStore(data) {
  _storeCache = data;
  _storeCacheTime = Date.now();
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    safeWriteFileSync(STORE_PATH, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Failed to save store:', e); }
}

/**
 * 注册存储 + 激活验证 + 辅助 IPC 处理器
 * @param {Object} deps
 * @param {Electron.App} deps.app - Electron app 实例
 * @param {(filePath: string) => boolean} deps.isPathAllowed - 路径白名单校验函数
 */
function registerStoreIPC({ app, isPathAllowed }) {
  /* 剪贴板 */
  ipcMain.handle('clipboard-write-text', async (event, text) => {
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle('clipboard-read-text', async () => {
    return clipboard.readText();
  });

  /* Key-Value 存储 */
  ipcMain.handle('store-get', async (event, key) => {
    const store = loadStore();
    return store[key] !== undefined ? store[key] : null;
  });

  ipcMain.handle('store-get-multiple', async (event, keys) => {
    const store = loadStore();
    const result = {};
    for (const key of keys) {
      result[key] = store[key] !== undefined ? store[key] : null;
    }
    return result;
  });

  ipcMain.handle('store-set', async (event, key, value) => {
    if (!global._storeWriteQueue) global._storeWriteQueue = Promise.resolve();
    if (!global._storeQueueLen) global._storeQueueLen = 0;

    // 队列长度上限 100，超限丢弃当前写入避免堆积
    if (global._storeQueueLen >= 100) {
      console.warn('[Store] 写入队列超限（100），丢弃当前写入:', key);
      return false;
    }

    global._storeQueueLen++;
    global._storeWriteQueue = global._storeWriteQueue
      .then(() => {
        const store = loadStore();
        store[key] = value;
        saveStore(store);
      })
      .catch((err) => {
        // 单次写入失败不阻塞后续写入
        console.error('[Store] 写入失败:', err && err.message);
      })
      .then(() => {
        global._storeQueueLen = Math.max(0, global._storeQueueLen - 1);
      });
    return true;
  });

  ipcMain.handle('store-delete', async (event, key) => {
    const store = loadStore();
    delete store[key];
    saveStore(store);
    return true;
  });

  /* 机器码 */
  ipcMain.handle('get-machine-id', async () => {
    try {
      const crypto = require('crypto');
      const parts = [];
      try { parts.push(os.hostname()); } catch (e) {}
      try { parts.push(os.arch()); } catch (e) {}
      try { parts.push(os.platform()); } catch (e) {}
      try {
        const cpus = os.cpus();
        if (cpus.length > 0) parts.push(cpus[0].model);
      } catch (e) {}
      try {
        const totalMem = os.totalmem();
        parts.push(String(totalMem));
      } catch (e) {}
      try {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
          for (const iface of nets[name]) {
            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
              parts.push(iface.mac);
              break;
            }
          }
        }
      } catch (e) {}
      const raw = parts.join('|');
      const hash = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
      return hash.substring(0, 16);
    } catch (e) {
      return null;
    }
  });

  /* 极光视频路径 */
  ipcMain.handle('get-aurora-video-path', async () => {
    try {
      const candidates = [];
      // 打包环境：app.asar.unpacked/resources/wallpapers/aurora.mp4
      if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'wallpapers', 'aurora.mp4'));
        candidates.push(path.join(process.resourcesPath, 'resources', 'wallpapers', 'aurora.mp4'));
      }
      // 开发环境
      candidates.push(path.join(__dirname, '..', 'resources', 'wallpapers', 'aurora.mp4'));
      for (const p of candidates) {
        try {
          if (fs.existsSync(p)) return p;
        } catch (e) {}
      }
      return candidates[0];
    } catch (e) {
      return null;
    }
  });

  /* 读取文件为 buffer（用于壁纸视频加载） */
  ipcMain.handle('read-file-buffer', async (event, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') return null;
      if (!isPathAllowed(filePath)) return null;
      if (!fs.existsSync(filePath)) return null;
      const buffer = fs.readFileSync(filePath);
      return buffer;
    } catch (e) {
      console.error('[read-file-buffer] Error:', e.message);
      return null;
    }
  });

  /* 预览服务器停止 */
  ipcMain.handle('preview:stop', async () => {
    if (global._previewServer) {
      global._previewServer.close();
      const oldPort = global._previewPort;
      global._previewServer = null;
      global._previewPort = null;
      return { success: true, port: oldPort };
    }
    return { success: false, message: '没有运行中的预览服务器' };
  });

  /* 在系统默认浏览器中打开外部链接 */
  ipcMain.handle('shell-open-external', async (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: '仅允许打开 http/https 链接' };
      }
    } catch (e) {
      return { success: false, error: '无效的URL' };
    }
    await shell.openExternal(url);
    return true;
  });
}

module.exports = {
  STORE_PATH,
  safeWriteFileSync,
  safeReadJsonFile,
  loadStore,
  saveStore,
  registerStoreIPC
};
