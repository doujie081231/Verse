/**
 * main/private-server.js - 私人服务器管理 IPC 模块
 *
 * 功能：
 *   1. 持久化存储用户添加的私人服务器列表
 *   2. 提供 CRUD IPC 接口供渲染进程调用
 *   3. 在线状态检测（TCP 连接测试 + 简单 MC 协议握手）
 *   4. 复制地址到剪贴板
 */

const { ipcMain, clipboard } = require('electron');
const net = require('net');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { DATA_DIR } = require('./paths');

const PRIVATE_SERVER_DIR = path.join(DATA_DIR, 'private-server');
const PRIVATE_SERVER_FILE = path.join(PRIVATE_SERVER_DIR, 'servers.json');

// 远程服务器列表 API 地址
const REMOTE_API_URL = 'https://www.verselauncher.cn/api/servers.json';

// 本地 fallback 数据（远程接口不可用时使用）
const FALLBACK_SERVERS = [];

function ensureDataFile() {
  try {
    fs.mkdirSync(PRIVATE_SERVER_DIR, { recursive: true });
    if (!fs.existsSync(PRIVATE_SERVER_FILE)) {
      fs.writeFileSync(PRIVATE_SERVER_FILE, JSON.stringify([], null, 2), 'utf8');
    }
  } catch (e) {
    console.error('[PrivateServer] ensureDataFile failed:', e.message);
  }
}

function fetchRemoteServers() {
  return new Promise((resolve) => {
    const url = new URL(REMOTE_API_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      timeout: 8000,
      headers: { 'Accept': 'application/json' },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && parsed.length > 0) {
            // 给每条数据补充默认字段
            const servers = parsed.map((s, i) => ({
              id: s.id || `srv_remote_${i}`,
              name: s.name || '未知服务器',
              address: s.address || '',
              description: s.description || '',
              icon: s.icon || '',
              modpackUrl: s.modpackUrl || '',
              maxPlayers: s.maxPlayers == null ? null : Number(s.maxPlayers),
              createdAt: s.createdAt || Date.now(),
            }));
            resolve({ ok: true, servers });
          } else {
            resolve({ ok: false, error: '数据格式错误' });
          }
        } catch (e) {
          resolve({ ok: false, error: `JSON 解析失败: ${e.message}` });
        }
      });
    });

    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '请求超时' }); });

    req.end();
  });
}

function loadServers() {
  return FALLBACK_SERVERS;
}

function saveServers(list) {
  ensureDataFile();
  try {
    fs.writeFileSync(PRIVATE_SERVER_FILE, JSON.stringify(list, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    console.error('[PrivateServer] saveServers failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function parseAddress(address) {
  const trimmed = String(address || '').trim();
  if (!trimmed) return null;
  // 支持 IPv6 [addr]:port 和普通 host:port / host
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return null;
    const host = trimmed.slice(1, end);
    const portPart = trimmed.slice(end + 1);
    const port = portPart.startsWith(':') ? parseInt(portPart.slice(1), 10) : 25565;
    return { host, port: isNaN(port) ? 25565 : port, raw: trimmed };
  }
  const lastColon = trimmed.lastIndexOf(':');
  const firstColon = trimmed.indexOf(':');
  if (lastColon > firstColon) {
    // 可能是 IPv6 无括号，暂不处理
    return null;
  }
  if (lastColon !== -1) {
    const host = trimmed.slice(0, lastColon);
    const port = parseInt(trimmed.slice(lastColon + 1), 10);
    return { host, port: isNaN(port) ? 25565 : port, raw: trimmed };
  }
  return { host: trimmed, port: 25565, raw: trimmed };
}

// ──────────────────────────────────────────────
// Minecraft 协议工具（VarInt / 封包读写）
// ──────────────────────────────────────────────

function writeVarInt(value) {
  const buf = [];
  do {
    let temp = value & 0x7F;
    value >>>= 7;
    if (value !== 0) temp |= 0x80;
    buf.push(temp);
  } while (value !== 0);
  return Buffer.from(buf);
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    if (pos >= buffer.length) throw new Error('VarInt 读取越界');
    const byte = buffer[pos++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value: result, bytes: pos - offset };
}

function writeString(str) {
  const encoded = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(encoded.length), encoded]);
}

/**
 * Minecraft 服务器状态查询（Server List Ping）
 * 通过 MC 协议握手获取在现人数、最大人数、版本、MOTD
 */
async function checkServerStatus(address) {
  const parsed = parseAddress(address);
  if (!parsed) return { online: false, error: '地址格式错误' };

  return new Promise((resolve) => {
    const startTime = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(8000);
    let step = 'connect';
    let chunks = [];
    let expectedLen = -1;

    const finish = (result) => {
      try { socket.destroy(); } catch (_) {}
      resolve(result);
    };

    const onError = (err) => {
      if (step === 'connect') {
        finish({ online: false, error: `连接失败: ${err.message}`, host: parsed.host, port: parsed.port });
      } else {
        finish({ online: false, error: `协议错误: ${err.message}`, host: parsed.host, port: parsed.port });
      }
    };

    socket.once('error', onError);
    socket.once('timeout', () => {
      finish({ online: false, error: '连接超时', host: parsed.host, port: parsed.port });
    });

    socket.connect(parsed.port, parsed.host, () => {
      step = 'handshake';
      const latency = Date.now() - startTime;

      // ① Handshake（packet ID 0x00, next state = 1 状态查询）
      const handshakeBuf = Buffer.concat([
        writeVarInt(-1),           // 协议版本 -1（自动匹配）
        writeString(parsed.host),  // 服务器地址
        Buffer.from([(parsed.port >> 8) & 0xFF, parsed.port & 0xFF]), // 端口
        writeVarInt(1),            // next state: 1 = status
      ]);
      const handshakePacket = Buffer.concat([
        writeVarInt(handshakeBuf.length + 1), // 包长度（ID + payload）
        writeVarInt(0x00),                     // packet ID
        handshakeBuf,
      ]);
      socket.write(handshakePacket);

      // ② Request（packet ID 0x00, 空 payload）
      const requestPacket = Buffer.concat([
        writeVarInt(1),   // 包长度
        writeVarInt(0x00), // packet ID
      ]);
      socket.write(requestPacket);
      step = 'response';
    });

    // ③ 读取 Response
    socket.on('data', (data) => {
      if (step !== 'response') return;
      chunks.push(data);

      try {
        const full = Buffer.concat(chunks);
        if (full.length < 1) return;

        // 解析：VarInt 包长度 → packet ID → JSON 字符串
        let offset = 0;
        const lenResult = readVarInt(full, offset);
        offset += lenResult.bytes;
        if (full.length < offset) return;

        const idResult = readVarInt(full, offset);
        offset += idResult.bytes;
        if (full.length < offset) return;

        // JSON 字符串长度 + 内容
        const strLenResult = readVarInt(full, offset);
        offset += strLenResult.bytes;
        if (full.length < offset + strLenResult.value) return;

        const jsonStr = full.slice(offset, offset + strLenResult.value).toString('utf8');
        const info = JSON.parse(jsonStr);
        const latency = Date.now() - startTime;

        // 解析 MOTD（可能是对象或字符串）
        let motd = '';
        if (typeof info.description === 'string') {
          motd = info.description;
        } else if (info.description) {
          motd = info.description.text || JSON.stringify(info.description);
          // 兼容 extra 数组
          if (info.description.extra && Array.isArray(info.description.extra)) {
            motd = info.description.extra.map(e => e.text || '').join('');
          }
        }

        // 解析版本
        const version = info.version ? info.version.name : '';

        finish({
          online: true,
          latency,
          host: parsed.host,
          port: parsed.port,
          motd: motd,
          version: version,
          playersOnline: info.players ? info.players.online : 0,
          playersMax: info.players ? info.players.max : 0,
          protocol: info.version ? info.version.protocol : 0,
        });
      } catch (e) {
        // 数据还不够，继续等
        if (e.message === 'VarInt 读取越界') return;
        finish({ online: false, error: `数据解析失败: ${e.message}`, host: parsed.host, port: parsed.port });
      }
    });
  });
}

function initPrivateServerIPC() {
  ipcMain.handle('private-server:list', async () => {
    // 优先从远程 API 获取，失败则回退到本地数据
    const remote = await fetchRemoteServers();
    if (remote.ok) {
      return { ok: true, servers: remote.servers, source: 'remote' };
    }
    console.warn('[PrivateServer] 远程 API 请求失败，使用本地数据:', remote.error);
    return { ok: true, servers: loadServers(), source: 'local' };
  });

  ipcMain.handle('private-server:save', async (event, servers) => {
    if (!Array.isArray(servers)) return { ok: false, error: 'servers must be array' };
    return saveServers(servers);
  });

  ipcMain.handle('private-server:add', async (event, server) => {
    if (!server || !server.name || !server.address) {
      return { ok: false, error: '名称和地址不能为空' };
    }
    const list = loadServers();
    const newServer = {
      id: server.id || `srv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: server.name.trim(),
      address: server.address.trim(),
      description: (server.description || '').trim(),
      icon: (server.icon || '').trim(),
      modpackUrl: (server.modpackUrl || '').trim(),
      maxPlayers: server.maxPlayers == null ? null : Number(server.maxPlayers),
      createdAt: server.createdAt || Date.now(),
    };
    list.push(newServer);
    const saveResult = saveServers(list);
    if (!saveResult.ok) return saveResult;
    return { ok: true, server: newServer };
  });

  ipcMain.handle('private-server:update', async (event, server) => {
    if (!server || !server.id) return { ok: false, error: '缺少服务器 id' };
    const list = loadServers();
    const idx = list.findIndex(s => s.id === server.id);
    if (idx === -1) return { ok: false, error: '服务器不存在' };
    list[idx] = {
      ...list[idx],
      name: (server.name || '').trim(),
      address: (server.address || '').trim(),
      description: (server.description || '').trim(),
      icon: (server.icon || '').trim(),
      modpackUrl: (server.modpackUrl || '').trim(),
      maxPlayers: server.maxPlayers == null ? null : Number(server.maxPlayers),
    };
    const saveResult = saveServers(list);
    if (!saveResult.ok) return saveResult;
    return { ok: true, server: list[idx] };
  });

  ipcMain.handle('private-server:delete', async (event, id) => {
    const list = loadServers();
    const idx = list.findIndex(s => s.id === id);
    if (idx === -1) return { ok: false, error: '服务器不存在' };
    list.splice(idx, 1);
    const saveResult = saveServers(list);
    if (!saveResult.ok) return saveResult;
    return { ok: true };
  });

  ipcMain.handle('private-server:check', async (event, address) => {
    return checkServerStatus(address);
  });

  ipcMain.handle('private-server:copy-address', async (event, address) => {
    try {
      clipboard.writeText(String(address || ''));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { initPrivateServerIPC };
