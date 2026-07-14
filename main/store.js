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

const { ipcMain, shell, clipboard, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 存储文件路径
const STORE_PATH = path.join(os.homedir(), '.versepc', 'app-store.json');

// 激活 schema 版本 - 升级此版本会使旧 schema 的激活记录失效，强制重新激活
const ACTIVATION_SCHEMA_VERSION = 3;

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

  /* 激活验证 */
  ipcMain.handle('activate-verify', async (event, code) => {
    try {
      const crypto = require('crypto');
      const requestJson = (url, body) => new Promise((resolve, reject) => {
        try {
          const req = net.request({ url, method: 'POST' });
          const payload = JSON.stringify(body);
          req.setHeader('Content-Type', 'application/json');
          req.setHeader('User-Agent', 'VersePC/' + app.getVersion());
          req.on('response', (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk.toString(); });
            res.on('end', () => {
              try {
                if ((res.headers?.['content-type'] || '').indexOf('application/json') === -1) {
                  return reject(new Error('服务端返回非JSON(' + res.statusCode + ')'));
                }
                resolve(JSON.parse(text || '{}'));
              } catch (e) {
                reject(new Error('解析服务端响应失败'));
              }
            });
          });
          req.on('error', (err) => reject(err));
          req.write(payload);
          req.end();
        } catch (err) {
          reject(err);
        }
      });

      const parts = [];
      try { parts.push(os.hostname()); } catch (e) {}
      try { parts.push(os.arch()); } catch (e) {}
      try { parts.push(os.platform()); } catch (e) {}
      try { const cpus = os.cpus(); if (cpus.length > 0) parts.push(cpus[0].model); } catch (e) {}
      try { parts.push(String(os.totalmem())); } catch (e) {}
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
      const machineId = crypto.createHash('sha256').update(parts.join('|')).digest('hex').toUpperCase().substring(0, 16);

      let c = (code || '').trim().toUpperCase();
      if (!c) return { success: false, message: '请输入激活码' };
      const codeMatch = c.match(/(VU-[A-F0-9]{6,12})/i);
      if (codeMatch) c = codeMatch[1].toUpperCase();
      if (!c.startsWith('VU-')) return { success: false, message: '旧版激活码已失效，请前往官网申请新密钥\nhttps://verselauncher.cn/community' };

      const baseUrl = 'https://www.verselauncher.cn';
      const endpoints = [baseUrl + '/api/activate/verify', baseUrl + '/.netlify/functions/activate/verify', baseUrl + '/functions/api/activate/verify'];

      let data = null;
      let lastErr = null;
      const body = { activation_code: c, machine_id: machineId, app_version: app.getVersion() };
      // 依次尝试多个激活接口，任一成功即返回
      for (const url of endpoints) {
        try {
          const json = await requestJson(url, body);
          data = json?.data || json;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err.message || '网络异常';
        }
      }

      if (!data || !data.activated) {
        return { success: false, message: lastErr ? ('激活验证失败: ' + lastErr) : '激活码无效或与本机不匹配' };
      }

      const activationType = data.type || 'single';
      const store = loadStore();
      store['activation_type'] = activationType;
      store['activation_code'] = c;
      store['activation_time'] = new Date().toISOString();
      store['activation_schema_ver'] = ACTIVATION_SCHEMA_VERSION;
      fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), () => {});

      return { success: true, type: activationType, message: activationType === 'permanent' ? '永久激活成功！' : '单次激活成功！' };
    } catch (e) {
      return { success: false, message: '验证过程出错: ' + e.message };
    }
  });

  ipcMain.handle('activate-status', async () => {
    const store = loadStore();
    // 旧 schema 的激活记录失效，强制重新激活
    if (store['activation_type'] && store['activation_schema_ver'] !== ACTIVATION_SCHEMA_VERSION) {
      delete store['activation_type'];
      delete store['activation_code'];
      delete store['activation_time'];
      delete store['activation_version'];
      delete store['activation_schema_ver'];
      fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), () => {});
      return { activated: false, type: null, time: null };
    }
    return {
      activated: !!store['activation_type'],
      type: store['activation_type'] || null,
      time: store['activation_time'] || null
    };
  });

  /* 主题激活验证 */
  ipcMain.handle('theme-activate-verify', async (event, code) => {
    try {
      const crypto = require('crypto');
      const requestJson = (url, body) => new Promise((resolve, reject) => {
        try {
          const payload = JSON.stringify(body);
          const req = net.request({ url, method: 'POST', headers: { 'Content-Type': 'application/json' } });
          req.on('response', (res) => {
            let text = '';
            res.on('data', (chunk) => text += chunk.toString());
            res.on('end', () => {
              try {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                  return reject(new Error('服务端错误: ' + res.statusCode));
                }
                resolve(JSON.parse(text || '{}'));
              } catch (e) {
                reject(new Error('解析服务端响应失败'));
              }
            });
          });
          req.on('error', (err) => reject(err));
          req.write(payload);
          req.end();
        } catch (err) { reject(err); }
      });

      const parts = [];
      try { parts.push(os.hostname()); } catch (e) {}
      try { parts.push(os.arch()); } catch (e) {}
      try { parts.push(os.platform()); } catch (e) {}
      try { const cpus = os.cpus(); if (cpus.length > 0) parts.push(cpus[0].model); } catch (e) {}
      try { parts.push(String(os.totalmem())); } catch (e) {}
      try {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
          for (const iface of nets[name]) {
            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') { parts.push(iface.mac); break; }
          }
        }
      } catch (e) {}
      const machineId = crypto.createHash('sha256').update(parts.join('|')).digest('hex').toUpperCase().substring(0, 16);

      let c = (code || '').trim().toUpperCase();
      if (!c) return { success: false, message: '请输入激活码' };
      const codeMatch = c.match(/(VT-[A-F0-9]{6,12})/i);
      if (codeMatch) c = codeMatch[1].toUpperCase();
      if (!c.startsWith('VT-')) return { success: false, message: '请输入麦香主题激活码（VT-开头）' };

      const baseUrl = 'https://www.verselauncher.cn';
      const endpoints = [baseUrl + '/api/activate/verify', baseUrl + '/.netlify/functions/activate/verify', baseUrl + '/functions/api/activate/verify'];

      let data = null;
      let lastErr = null;
      const body = { activation_code: c, machine_id: machineId, app_version: app.getVersion() };
      for (const url of endpoints) {
        try {
          const json = await requestJson(url, body);
          data = json?.data || json;
          lastErr = null;
          break;
        } catch (err) { lastErr = err.message || '网络异常'; }
      }

      if (!data || !data.activated) {
        return { success: false, message: lastErr ? ('激活验证失败: ' + lastErr) : '激活码无效或与本机不匹配' };
      }

      const store = loadStore();
      store['theme_activation_code'] = c;
      store['theme_activation_time'] = new Date().toISOString();
      fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), () => {});

      return { success: true, message: '麦香主题已解锁' };
    } catch (e) {
      return { success: false, message: '验证过程出错: ' + e.message };
    }
  });

  ipcMain.handle('theme-activate-status', async () => {
    const store = loadStore();
    return {
      activated: !!store['theme_activation_code'],
      code: store['theme_activation_code'] || null,
      time: store['theme_activation_time'] || null
    };
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
  ACTIVATION_SCHEMA_VERSION,
  safeWriteFileSync,
  safeReadJsonFile,
  loadStore,
  saveStore,
  registerStoreIPC
};
