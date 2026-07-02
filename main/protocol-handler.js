/**
 * @file main/protocol-handler.js
 * @description versepc:// 协议处理器 - 协议路由 + API/SSE 分发 + 静态文件 + 路径白名单
 *
 * 职责：
 * 1. handleVersePCProtocol   主协议入口，路由 /api/* 与静态文件
 * 2. handleAPIRequest        API 请求分发，调用 server.js 的 handleNativeAPI
 * 3. handleSSERequest        SSE 流式请求（游戏日志流、安装进度流）
 * 4. handleStaticFile        静态文件服务（含 Range 请求支持）
 * 5. getAllowedPathRoots     路径白名单根目录列表（纯函数，带缓存）
 * 6. isPathAllowed           路径白名单校验（纯函数）
 *
 * 依赖注入：setupProtocolHandler({ appRoot, reloadServerModule, getServerCrashCount, SERVER_MAX_CRASHES })
 * - appRoot             项目根目录（main.js 所在目录），替代模块内的 __dirname
 * - reloadServerModule  server.js 崩溃重载函数（由 main.js 注入）
 * - getServerCrashCount 获取崩溃计数（由 main.js 注入）
 * - SERVER_MAX_CRASHES  最大崩溃次数（由 main.js 注入）
 * - apiHandler 通过 shared-state.getApiHandler() 读取
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const sharedState = require('./shared-state');

// 默认指向项目根（main.js 所在目录），避免 setup 调用前的时序问题
let _appRoot = path.resolve(__dirname, '..');
let _reloadServerModule = null;
let _getServerCrashCount = () => 0;
let _SERVER_MAX_CRASHES = 3;

// MIME 类型映射表 - 用于静态文件服务
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.jar': 'application/java-archive',
};

/**
 * 注入依赖
 * @param {Object} deps
 * @param {string} [deps.appRoot] - 项目根目录绝对路径
 * @param {() => boolean} [deps.reloadServerModule] - server.js 崩溃重载函数
 * @param {() => number} [deps.getServerCrashCount] - 获取当前崩溃计数
 * @param {number} [deps.SERVER_MAX_CRASHES] - 最大崩溃次数
 */
function setupProtocolHandler({ appRoot, reloadServerModule, getServerCrashCount, SERVER_MAX_CRASHES } = {}) {
  if (appRoot) _appRoot = appRoot;
  if (typeof reloadServerModule === 'function') _reloadServerModule = reloadServerModule;
  if (typeof getServerCrashCount === 'function') _getServerCrashCount = getServerCrashCount;
  if (typeof SERVER_MAX_CRASHES === 'number') _SERVER_MAX_CRASHES = SERVER_MAX_CRASHES;
}

/**
 * 主协议处理入口
 * 路由规则：
 * - /api/*  -> API 请求（包括 SSE 流式请求）
 * - 其他     -> 静态文件
 * @param {Request} request - Electron 协议请求对象
 * @returns {Promise<Response>}
 */
async function handleVersePCProtocol(request) {
  try {
    const reqUrl = new URL(request.url);
    let pathname = reqUrl.pathname;

    if (pathname.startsWith('/api/')) {
      return await handleAPIRequest(request, reqUrl);
    }

    return await handleStaticFile(pathname, request);
  } catch (e) {
    console.error('Protocol handler error:', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * 处理 API 请求
 * 解析请求方法和参数后，直接调用 server.js 的 handleNativeAPI
 * 不做 HTTP 模拟，直接函数调用
 * @param {Request} request - 请求对象
 * @param {URL} reqUrl - 已解析的 URL 对象
 * @returns {Promise<Response>}
 */
async function handleAPIRequest(request, reqUrl) {
  const method = request.method;
  let body = null;
  let contentType = request.headers.get('content-type') || 'application/json';
  if (method === 'POST' || method === 'PUT') {
    try {
      const arrBuf = await request.arrayBuffer();
      body = Buffer.from(arrBuf);
    } catch (e) { body = null; }
  }

  const query = {};
  reqUrl.searchParams.forEach((value, key) => { query[key] = value; });

  const pathname = reqUrl.pathname;
  // 判断是否为 SSE（Server-Sent Events）流式请求
  const isSSE = pathname === '/api/game/log/stream' ||
                (pathname === '/api/install-progress' && query.sse === 'true');

  if (isSSE) {
    return handleSSERequest(pathname, method, body, query);
  }

  try {
    let apiHandler = sharedState.getApiHandler();
    // server.js 模块不可用时尝试重载，重载仍失败则返回 503
    if (!apiHandler || !apiHandler.handleNativeAPI) {
      const reloaded = _reloadServerModule ? _reloadServerModule() : false;
      if (!reloaded) {
        return new Response(JSON.stringify({ error: 'Server module unavailable' }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        });
      }
      apiHandler = sharedState.getApiHandler();
    }
    const result = await apiHandler.handleNativeAPI(pathname, method, body, query, contentType);
    const responseHeaders = new Headers();
    Object.entries(result.headers || {}).forEach(([key, value]) => {
      try { responseHeaders.set(key, value); } catch (e) {}
    });

    const responseBody = result.body instanceof Buffer
      ? new Uint8Array(result.body.buffer, result.body.byteOffset, result.body.byteLength)
      : result.body;
    return new Response(responseBody, {
      status: result.status,
      headers: responseHeaders
    });
  } catch (e) {
    console.error('API handler error:', pathname, e.message);
    // 致命错误（类型错误或函数缺失）时尝试重载 server.js 模块
    const isFatal = e instanceof TypeError || e.message.includes('is not a function') || e.message.includes('Cannot read prop');
    if (isFatal && _getServerCrashCount() < _SERVER_MAX_CRASHES) {
      console.warn(`[Server] Fatal error detected, attempting reload... (${_getServerCrashCount() + 1}/${_SERVER_MAX_CRASHES})`);
      if (_reloadServerModule) _reloadServerModule();
    }
    return new Response(JSON.stringify({ error: '内部服务错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * 处理 SSE（Server-Sent Events）流式请求
 * 通过 Readable Stream 将 server.js 的异步数据推送到渲染进程
 * 用于游戏日志流和安装进度流
 * @param {string} pathname - 请求路径
 * @param {string} method - HTTP 方法
 * @param {Buffer|null} body - 请求体
 * @param {Object} query - 查询参数
 * @returns {Response}
 */
function handleSSERequest(pathname, method, body, query) {
  const { Readable } = require('stream');
  const readable = new Readable({ read() {} });

  try {
    let apiHandler = sharedState.getApiHandler();
    // server.js 模块不可用时尝试重载，重载失败则推送错误事件并关闭流
    if (!apiHandler || !apiHandler.handleNativeSSE) {
      const reloaded = _reloadServerModule ? _reloadServerModule() : false;
      if (!reloaded) {
        readable.push('data: {"error":"Server module unavailable"}\n\n');
        readable.push(null);
        return new Response(readable, {
          status: 503,
          headers: new Headers({ 'Content-Type': 'text/event-stream' })
        });
      }
      apiHandler = sharedState.getApiHandler();
    }

    const { status, headers } = apiHandler.handleNativeSSE(pathname, method, body, query, (chunk) => {
      if (chunk === null) {
        readable.push(null);
      } else {
        readable.push(chunk);
      }
    });

    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', 'text/event-stream');
    responseHeaders.set('Cache-Control', 'no-cache');
    responseHeaders.set('Connection', 'keep-alive');
    Object.entries(headers || {}).forEach(([key, value]) => {
      try { responseHeaders.set(key, value); } catch (e) {}
    });

    return new Response(readable, {
      status: status,
      headers: responseHeaders
    });
  } catch (e) {
    console.error('SSE handler error:', pathname, e.message);
    // 致命错误时尝试重载 server.js 模块
    const isFatal = e instanceof TypeError || e.message.includes('is not a function') || e.message.includes('Cannot read prop');
    if (isFatal && _getServerCrashCount() < _SERVER_MAX_CRASHES) {
      console.warn(`[Server] SSE fatal error, attempting reload... (${_getServerCrashCount() + 1}/${_SERVER_MAX_CRASHES})`);
      if (_reloadServerModule) _reloadServerModule();
    }
    readable.push('data: {"error":"内部服务错误"}\n\n');
    readable.push(null);
    return new Response(readable, {
      status: 500,
      headers: new Headers({ 'Content-Type': 'text/event-stream' })
    });
  }
}

/**
 * 处理静态文件请求
 * 安全检查：只允许访问应用目录内的文件，防止路径遍历攻击
 * @param {string} pathname - 请求路径
 * @param {Request} request - 请求对象（用于读取 Range 头）
 * @returns {Promise<Response>}
 */
async function handleStaticFile(pathname, request) {
  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(_appRoot, 'index.html');
  } else {
    filePath = path.join(_appRoot, pathname.replace(/^\//, ''));
  }

  filePath = path.resolve(filePath);
  const appDir = path.resolve(_appRoot);
  // 路径白名单校验：只允许访问应用目录内的文件
  if (!filePath.toLowerCase().startsWith(appDir.toLowerCase())) {
    return new Response('Forbidden', { status: 403 });
  }

  // asar 解包文件位于 app.asar 旁的 app.asar.unpacked 目录
  if (!fs.existsSync(filePath)) {
    const unpackedPath = path.join(path.dirname(_appRoot), 'app.asar.unpacked', pathname.replace(/^\//, ''));
    if (fs.existsSync(unpackedPath)) {
      filePath = path.resolve(unpackedPath);
    }
  }

  try {
    const stats = await fs.promises.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const rangeHeader = request?.headers?.get?.('range');

    // Range 请求：返回部分内容（206）
    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      if (isNaN(start) || isNaN(end) || start >= stats.size || end >= stats.size || start > end) {
        return new Response('Range Not Satisfiable', { status: 416 });
      }
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(chunkSize),
          'Content-Range': `bytes ${start}-${end}/${stats.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache'
        }
      });
    }

    const stream = fs.createReadStream(filePath);
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(stats.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (e) {
    return new Response('Not Found', { status: 404 });
  }
}

let _allowedPathRoots = null;

/**
 * 获取路径白名单根目录列表（带缓存）
 * @returns {string[]} 根目录绝对路径列表（已转为小写）
 */
function getAllowedPathRoots() {
  if (_allowedPathRoots) return _allowedPathRoots;
  const os = require('os');
  const homeDir = os.homedir();
  const roots = [
    homeDir,
    path.join(homeDir, '.minecraft'),
    path.join(homeDir, 'AppData', 'Local', 'VersePC'),
  ];
  try { roots.push(path.resolve(_appRoot)); } catch (e) {}
  try { roots.push(app.getPath('userData')); } catch (e) {}
  try { roots.push(app.getPath('temp')); } catch (e) {}
  try { roots.push(app.getPath('downloads')); } catch (e) {}
  try { roots.push(app.getPath('desktop')); } catch (e) {}
  try { roots.push(app.getPath('documents')); } catch (e) {}
  try { if (process.resourcesPath) roots.push(process.resourcesPath); } catch (e) {}
  try { if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'app.asar.unpacked')); } catch (e) {}
  _allowedPathRoots = roots.map((r) => path.resolve(r).toLowerCase());
  return _allowedPathRoots;
}

/**
 * 路径白名单校验（纯函数）
 * @param {string} filePath - 待校验文件路径
 * @returns {boolean} 在白名单内返回 true，否则 false
 */
function isPathAllowed(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const resolved = path.resolve(filePath).toLowerCase();
  const originalSegments = filePath.replace(/\\/g, '/').split('/');
  if (originalSegments.includes('..')) return false;
  const roots = getAllowedPathRoots();
  return roots.some((root) => resolved.startsWith(root));
}

module.exports = {
  setupProtocolHandler,
  handleVersePCProtocol,
  handleAPIRequest,
  handleSSERequest,
  handleStaticFile,
  getAllowedPathRoots,
  isPathAllowed,
  MIME_TYPES,
};
