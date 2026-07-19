/**
 * main/redstone-online.js - 红石联机内网穿透 IPC 模块
 *
 * 实现：
 *   1. 拉取服务器节点列表（https://shithub.site/server.json）
 *   2. 生成本地 API Key，持久化到 DATA_DIR/redstone-online/apikey.txt
 *   3. 通过 HTTP API (端口 3000) 注册 API Key / 创建隧道 / 查询隧道 / 关闭隧道
 *   4. 通过 TCP (端口 7000) 建立到中转服务器的长连接
 *   5. 本地中继：TCP 隧道数据 ↔ 游戏 LAN 端口（如 25565）双向转发
 *
 * 所有网络操作都在主进程完成，绕过渲染进程的 CORS 限制。
 */

const { ipcMain } = require('electron');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./paths');

const REDSTONE_DIR = path.join(DATA_DIR, 'redstone-online');
const APIKEY_FILE = path.join(REDSTONE_DIR, 'apikey.txt');
const REGISTRY_URL = 'https://shithub.site/server.json';
const HTTP_PORT = 3000;
const TCP_PORT = 7000;
const APIKEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// 运行时状态（仅主进程内存中）
const state = {
  apikey: '',
  servers: [],            // [{name, address}]
  currentServerIdx: 0,
  tunnel: null,           // { listenPort, serverAddress, address }
  controlSocket: null,    // 到 7000 端口的 TCP 长连接
  localRelaySockets: [],  // 本地中转的 socket 列表
  running: false,
  stopping: false,
  _sender: null,          // 保存 IPC sender 用于通知前端
  _healthTimer: null,     // 健康检查定时器
};

// ===================================================================
// 工具函数
// ===================================================================

/** 生成 20 位随机 API Key */
function makeApikey() {
  const bytes = crypto.randomBytes(20);
  let key = '';
  for (let i = 0; i < 20; i++) {
    key += APIKEY_CHARS[bytes[i] % APIKEY_CHARS.length];
  }
  return key;
}

/** 加载本地 API Key，没有则生成并保存 */
function loadOrCreateApikey() {
  try {
    fs.mkdirSync(REDSTONE_DIR, { recursive: true });
    if (fs.existsSync(APIKEY_FILE)) {
      const key = fs.readFileSync(APIKEY_FILE, 'utf8').trim();
      if (key && key.length >= 16) return key;
    }
    const newKey = makeApikey();
    fs.writeFileSync(APIKEY_FILE, newKey, 'utf8');
    return newKey;
  } catch (e) {
    console.error('[RedstoneOnline] loadOrCreateApikey failed:', e.message);
    return makeApikey();
  }
}

/** 通用 HTTP 请求封装 */
function httpRequest(method, urlStr, { headers = {}, body = null, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const opts = {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { ...headers },
        timeout,
      };
      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      });
      req.on('timeout', () => { req.destroy(new Error('http timeout')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

/** 拉取服务器节点列表 */
async function fetchServerList() {
  try {
    const resp = await httpRequest('GET', REGISTRY_URL, { timeout: 6000 });
    if (resp.statusCode !== 200) throw new Error('registry returned ' + resp.statusCode);
    const obj = JSON.parse(resp.body);
    const list = [];
    for (const name of Object.keys(obj)) {
      const address = String(obj[name]).trim();
      if (address) list.push({ name, address });
    }
    if (list.length === 0) throw new Error('registry is empty');
    return list;
  } catch (e) {
    // 兜底：用内置默认节点
    console.warn('[RedstoneOnline] fetchServerList fallback:', e.message);
    return [{ name: '上海', address: '122.51.108.96' }];
  }
}

/** 向中转服务器注册 API Key（幂等，已存在视为成功） */
async function registerApikey(serverAddress, apikey) {
  const url = `http://${serverAddress}:${HTTP_PORT}/apikey`;
  const body = JSON.stringify({ apikey });
  const resp = await httpRequest('POST', url, { body, timeout: 6000 });
  if (resp.statusCode === 200 || resp.statusCode === 409) {
    return { ok: true, alreadyExists: resp.statusCode === 409 };
  }
  throw new Error(`register apikey failed: ${resp.statusCode} ${resp.body}`);
}

/** 创建隧道 */
async function createTunnel(serverAddress, apikey, maxPlayers) {
  const url = `http://${serverAddress}:${HTTP_PORT}/tunnels?maxPlayers=${maxPlayers}`;
  const resp = await httpRequest('POST', url, {
    headers: { Authorization: apikey },
    timeout: 10000,
  });
  if (resp.statusCode >= 200 && resp.statusCode < 300) {
    const obj = JSON.parse(resp.body);
    return { ok: true, listenPort: obj.listenPort, tunnelId: obj.tunnelId };
  }
  // 429：已有隧道 → 先 DELETE 再重试一次
  if (resp.statusCode === 429) {
    await closeTunnel(serverAddress, apikey).catch(() => {});
    const resp2 = await httpRequest('POST', url, {
      headers: { Authorization: apikey },
      timeout: 10000,
    });
    if (resp2.statusCode >= 200 && resp2.statusCode < 300) {
      const obj = JSON.parse(resp2.body);
      return { ok: true, listenPort: obj.listenPort, tunnelId: obj.tunnelId };
    }
    throw new Error(`create tunnel retry failed: ${resp2.statusCode} ${resp2.body}`);
  }
  throw new Error(`create tunnel failed: ${resp.statusCode} ${resp.body}`);
}

/** 关闭隧道 */
async function closeTunnel(serverAddress, apikey) {
  const url = `http://${serverAddress}:${HTTP_PORT}/tunnels`;
  const resp = await httpRequest('DELETE', url, {
    headers: { Authorization: apikey },
    timeout: 8000,
  });
  return { ok: resp.statusCode === 200, statusCode: resp.statusCode, body: resp.body };
}

// ===================================================================
// TCP 控制连接 + 本地中继
// ===================================================================

/** 读取一行（以 \n 结尾） */
function readLineFromStream(stream, callback) {
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      callback(line);
    }
  };
  stream.on('data', onData);
  return () => stream.removeListener('data', onData);
}

/**
 * 启动红石联机隧道
 * @param {Object} params - { serverAddress, maxPlayers, gamePort }
 * @param {(msg:string)=>void} onLog - 日志回调
 * @returns {Promise<{ok:boolean, address?:string, listenPort?:number, error?:string}>}
 */
async function startTunnel(params, onLog) {
  const log = (msg) => { try { onLog(msg); } catch (_) {} };
  if (state.running) {
    return { ok: false, error: '隧道已在运行中，请先关闭' };
  }
  const serverAddress = params.serverAddress;
  const maxPlayers = Math.max(1, parseInt(params.maxPlayers) || 1);
  const gamePort = Math.max(1, parseInt(params.gamePort) || 25565);

  state.stopping = false;
  state.running = true;
  state.localRelaySockets = [];

  try {
    // 1. 确保有 API Key
    if (!state.apikey) state.apikey = loadOrCreateApikey();
    log('API Key: ' + state.apikey);

    // 2. 注册 API Key
    log('正在注册 API Key 到 ' + serverAddress + ' ...');
    await registerApikey(serverAddress, state.apikey);
    log('API Key 已注册');

    // 3. 建立 TCP 控制连接到 7000 端口
    log('正在连接控制服务器 ' + serverAddress + ':7000 ...');
    const controlSocket = await new Promise((resolve, reject) => {
      const s = net.connect(TCP_PORT, serverAddress, () => resolve(s));
      s.setTimeout(8000);
      s.once('error', reject);
      s.once('timeout', () => reject(new Error('tcp connect timeout')));
    });
    controlSocket.setTimeout(0);
    controlSocket.setNoDelay(true);
    controlSocket.setKeepAlive(true, 10000);
    state.controlSocket = controlSocket;
    log('已建立 TCP 控制连接');

    // 4. 发送 apikey 进入连接池
    controlSocket.write(state.apikey + '\n', 'utf8');

    // 5. 等待首行响应
    const firstLine = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('等待服务器响应超时'));
      }, 12000);
      const cleanup = () => {
        clearTimeout(timer);
        controlSocket.removeListener('data', onData);
      };
      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        const idx = buf.indexOf('\n');
        if (idx !== -1) {
          const line = buf.slice(0, idx).trim();
          const rest = Buffer.from(buf.slice(idx + 1), 'utf8');
          cleanup();
          // 把剩余数据放回 stream（重要：可能是隧道首批数据）
          if (rest.length > 0) controlSocket.unshift(rest);
          resolve(line);
        }
      };
      controlSocket.on('data', onData);
      controlSocket.once('error', (e) => { cleanup(); reject(e); });
    });
    log('服务器响应: ' + firstLine);

    let listenPort = null;
    if (firstLine.startsWith('OK TUNNEL ')) {
      // 已有隧道，从首行无法拿到端口，调 API 查询
      try {
        const qurl = `http://${serverAddress}:${HTTP_PORT}/tunnels`;
        const qresp = await httpRequest('GET', qurl, {
          headers: { Authorization: state.apikey },
          timeout: 6000,
        });
        if (qresp.statusCode === 200) {
          const obj = JSON.parse(qresp.body);
          if (obj.tunnels && obj.tunnels.length > 0) {
            listenPort = obj.tunnels[0].listenPort;
          }
        }
      } catch (_) {}
      if (!listenPort) {
        throw new Error('已有隧道但无法获取 listenPort');
      }
    } else if (firstLine === 'OK WAITING' || firstLine.startsWith('OK WAITING')) {
      // 6. 需要创建隧道
      log('正在创建隧道（最大人数: ' + maxPlayers + '）...');
      const result = await createTunnel(serverAddress, state.apikey, maxPlayers);
      listenPort = result.listenPort;
      log('隧道已创建，端口: ' + listenPort);

      // 等待 OK TUNNEL 通知
      await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => { cleanup(); resolve(); }, 8000);
        const cleanup = () => {
          clearTimeout(timer);
          controlSocket.removeListener('data', onData);
        };
        const onData = (chunk) => {
          buf += chunk.toString('utf8');
          const idx = buf.indexOf('\n');
          if (idx !== -1) {
            const line = buf.slice(0, idx).trim();
            const rest = Buffer.from(buf.slice(idx + 1), 'utf8');
            cleanup();
            if (rest.length > 0) controlSocket.unshift(Buffer.from(rest));
            resolve(line);
          }
        };
        controlSocket.on('data', onData);
        controlSocket.once('error', () => { cleanup(); resolve(); });
      });
    } else if (firstLine.startsWith('ERR')) {
      throw new Error('服务器拒绝: ' + firstLine);
    } else {
      throw new Error('未知响应: ' + firstLine);
    }

    state.tunnel = {
      listenPort,
      serverAddress,
      address: serverAddress + ':' + listenPort,
    };

    // 7. 启动本地中继：游戏端口 ↔ 控制连接
    //    控制连接在 OK TUNNEL 后变成数据通道，双向转发到本地 gamePort
    log('正在启动本地中转 (游戏端口 ' + gamePort + ')...');
    startLocalRelay(controlSocket, gamePort, log);

    log('隧道已就绪，地址: ' + state.tunnel.address);

    // 启动保活健康检查：每 30 秒检测控制 socket 是否还活着
    state._healthTimer = setInterval(() => {
      if (!state.controlSocket || state.controlSocket.destroyed) {
        if (state.running && !state.stopping) {
          log('检测到连接已断开，正在自动清理...');
          stopTunnel((m) => {}).catch(() => {});
          // 通知前端
          if (state._sender) {
            try { state._sender.send('redstone:disconnected', {}); } catch (_) {}
          }
        }
        clearInterval(state._healthTimer);
        state._healthTimer = null;
      }
    }, 30000);

    return { ok: true, address: state.tunnel.address, listenPort };
  } catch (e) {
    state.running = false;
    // 出错时清理半成品
    await stopTunnel((m) => {}).catch(() => {});
    log('启动失败: ' + e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 启动本地中继：把控制 socket 的数据双向转发到本地 gamePort
 * 控制连接的 socket 在 OK TUNNEL 后变成数据通道
 */
function startLocalRelay(controlSocket, gamePort, log) {
  // 一个本地游戏连接（可能因为断开重建多个）
  let gameSocket = null;
  let stopped = false;
  let _lastGameActivity = Date.now();   // 上次 gameSocket 收到数据的时间
  let _l2rTimer = null;                 // L2R 保活定时器

  const connectGame = () => {
    if (stopped) return;
    const s = net.connect(gamePort, '127.0.0.1', () => {
      log('已连接本地游戏端口 ' + gamePort);
    });
    s.setNoDelay(true);
    s.setKeepAlive(true, 10000);
    s.on('error', (e) => {
      log('本地游戏连接错误: ' + e.message);
    });
    s.on('close', () => {
      log('本地游戏连接关闭');
      gameSocket = null;
    });
    s.on('data', (data) => {
      _lastGameActivity = Date.now();
      // 游戏数据 → 控制 socket（隧道）
      try { controlSocket.write(data); } catch (_) {}
    });
    gameSocket = s;
    state.localRelaySockets.push(s);
    return s;
  };

  // 控制连接 → 游戏
  controlSocket.removeAllListeners('data');
  controlSocket.on('data', (data) => {
    if (!gameSocket) {
      const s = connectGame();
      if (!s) return;
      try { s.write(data); } catch (_) {}
    } else {
      try { gameSocket.write(data); } catch (_) {}
    }
  });

  controlSocket.on('error', (e) => {
    log('控制连接错误: ' + e.message);
  });
  controlSocket.on('close', () => {
    log('控制连接已关闭');
    stopped = true;
    clearL2RTimer();
    if (gameSocket) { try { gameSocket.end(); } catch (_) {} }
    state.running = false;
    // 如果不是用户主动关闭，通知前端
    if (!state.stopping) {
      // 先调 API 清理服务端隧道
      if (state.tunnel && state.apikey) {
        closeTunnel(state.tunnel.serverAddress, state.apikey).catch(() => {});
      }
      // 通知前端
      if (state._sender) {
        try { state._sender.send('redstone:disconnected', {}); } catch (_) {}
      }
    }
  });

  /** 清理 L2R 保活定时器 */
  const clearL2RTimer = () => {
    if (_l2rTimer) {
      clearInterval(_l2rTimer);
      _l2rTimer = null;
    }
  };

  // L2R 保活：gameSocket 空闲超过 25 秒则重建连接
  // 防止 Minecraft 局域网服务器因连接空闲而断开
  _l2rTimer = setInterval(() => {
    if (stopped || !gameSocket || gameSocket.destroyed) return;
    const idle = Date.now() - _lastGameActivity;
    if (idle > 25000) {
      log('L2R 保活：gameSocket 已空闲 ' + Math.round(idle / 1000) + ' 秒，重建连接');
      const oldSocket = gameSocket;
      gameSocket = null;
      try { oldSocket.end(); } catch (_) {}
      // 重建连接
      connectGame();
    }
  }, 30000);
}

/**
 * 关闭隧道
 * @param {(msg:string)=>void} onLog
 */
async function stopTunnel(onLog) {
  const log = (msg) => { try { onLog(msg); } catch (_) {} };
  if (state.stopping) return { ok: true };
  state.stopping = true;

  log('正在关闭隧道...');

  // 关闭本地中转 socket
  for (const s of state.localRelaySockets) {
    try { s.end(); s.destroy(); } catch (_) {}
  }
  state.localRelaySockets = [];

  // 关闭控制连接
  if (state.controlSocket) {
    try { state.controlSocket.end(); state.controlSocket.destroy(); } catch (_) {}
    state.controlSocket = null;
  }

  // 调用 HTTP API 删除隧道
  if (state.tunnel && state.apikey) {
    try {
      const r = await closeTunnel(state.tunnel.serverAddress, state.apikey);
      log('DELETE /tunnels -> ' + r.statusCode + ' ' + r.body);
    } catch (e) {
      log('关闭隧道 API 失败: ' + e.message);
    }
  }

  state.tunnel = null;
  state.running = false;
  state.stopping = false;

  // 清除保活定时器
  if (state._healthTimer) {
    clearInterval(state._healthTimer);
    state._healthTimer = null;
  }

  log('隧道已关闭');
  return { ok: true };
}

// ===================================================================
// IPC 通道
// ===================================================================

function registerRedstoneOnlineIPC() {
  // 拉取服务器列表
  ipcMain.handle('redstone:servers', async () => {
    try {
      const list = await fetchServerList();
      state.servers = list;
      return { ok: true, servers: list };
    } catch (e) {
      return { ok: false, error: e.message, servers: state.servers };
    }
  });

  // 获取当前 API Key（不存在则生成）
  ipcMain.handle('redstone:apikey', async () => {
    try {
      if (!state.apikey) state.apikey = loadOrCreateApikey();
      return { ok: true, apikey: state.apikey };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 重置 API Key（生成新的并保存）
  ipcMain.handle('redstone:apikey-reset', async () => {
    try {
      const newKey = makeApikey();
      fs.mkdirSync(REDSTONE_DIR, { recursive: true });
      fs.writeFileSync(APIKEY_FILE, newKey, 'utf8');
      state.apikey = newKey;
      return { ok: true, apikey: newKey };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 启动隧道
  // 渲染进程通过 redstone:log 事件接收日志
  ipcMain.handle('redstone:start', async (event, params) => {
    const sender = event.sender;
    state._sender = sender; // 保存 sender 供断连通知使用
    const onLog = (msg) => {
      try { sender.send('redstone:log', msg); } catch (_) {}
    };
    return await startTunnel(params || {}, onLog);
  });

  // 关闭隧道
  ipcMain.handle('redstone:stop', async (event) => {
    const sender = event.sender;
    const onLog = (msg) => {
      try { sender.send('redstone:log', msg); } catch (_) {}
    };
    return await stopTunnel(onLog);
  });

  // 查询当前状态
  ipcMain.handle('redstone:status', async () => {
    return {
      ok: true,
      running: state.running,
      address: state.tunnel ? state.tunnel.address : null,
      listenPort: state.tunnel ? state.tunnel.listenPort : null,
      apikey: state.apikey,
      servers: state.servers,
    };
  });
}

module.exports = { registerRedstoneOnlineIPC };
