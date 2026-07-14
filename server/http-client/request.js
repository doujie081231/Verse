/**
 * @file server/http-client/request.js - 基础 HTTP 请求
 * @description GET/POST/PUT 请求、重定向、429 限流、gzip/br/deflate 解压、镜像回退、TTL 缓存、竞速请求。
 *   通过 ctx (../context) 访问共享状态，依赖 ./mirror 的镜像熔断逻辑。
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const ctx = require('../context');
const { _isMirrorAvailable, _mirrorFailed, _mirrorSuccess } = require('./mirror');

/**
 * 用指定协议（http/https）发起 GET 请求，返回响应流
 * @param {string} targetUrl - 目标 URL
 * @param {object} [options={}] - 原生 http.get 选项
 * @returns {Promise<import('http').IncomingMessage>}
 */
function fetchWithProtocol(targetUrl, options = {}) {
  const mod = targetUrl.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(targetUrl, options, resolve);
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * 单次请求：处理重定向、429 限流、gzip/br/deflate 解压
 * @param {string} url - 请求 URL
 * @param {object} headers - 请求头
 * @param {number} timeout - 超时毫秒
 * @param {number} [retries=0] - 当前重试层级（用于 429）
 * @returns {Promise<object>} 解析后的 JSON
 */
function _fetchOnce(url, headers, timeout, retries = 0) {
  const mod = url.startsWith('https') ? https : http;
  const agent = url.startsWith('https') ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT;
  const reqHeaders = { ...headers, 'Accept-Encoding': 'gzip, deflate, br' };
  return new Promise((resolve, reject) => {
    const req = mod.get(url, { headers: reqHeaders, agent, timeout }, (res) => {
      // 3xx 重定向：销毁当前流，递归请求 location
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        return _fetchOnce(res.headers.location, headers, timeout, retries).then(resolve).catch(reject);
      }
      // 429 限流：按 Retry-After 头等待后重试，最多 2 次
      if (res.statusCode === 429) {
        res.destroy();
        const retryAfter = parseInt(res.headers['retry-after'] || '0', 10) || 3;
        const waitMs = Math.min(retryAfter * 1000, 15000);
        if (retries < 2) {
          console.warn(`[fetchOnce] 429 限流，等待 ${waitMs}ms 后重试 (${url.substring(0, 60)}...)`);
          setTimeout(() => _fetchOnce(url, headers, timeout, retries + 1).then(resolve).catch(reject), waitMs);
        } else {
          reject(new Error(`HTTP 429 限流，已重试 ${retries} 次`));
        }
        return;
      }
      if (res.statusCode !== 200) { res.destroy(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      // 按 content-encoding 自动解压
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      let data = '';
      stream.on('data', (chunk) => { data += chunk; });
      stream.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON解析失败: ${e.message}`)); }
      });
      stream.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时 (${timeout}ms)`)); });
    req.on('error', reject);
  });
}

/**
 * 带镜像回退的 JSON 请求：Modrinth / CurseForge 自动走镜像，超时梯度升级
 * @param {string} urlStr - 请求 URL
 * @param {object|number} [retriesOrHeaders=3] - 自定义 headers 或重试次数
 * @param {number} timeoutMs - 总超时
 * @returns {Promise<object>} 解析后的 JSON
 */
async function fetchJSON(urlStr, retriesOrHeaders = 3, timeoutMs) {
  let extraHeaders = {};
  if (typeof retriesOrHeaders === 'object' && retriesOrHeaders !== null) {
    extraHeaders = retriesOrHeaders;
  }
  const reqTimeout = typeof timeoutMs === 'number' ? timeoutMs : 20000;

  // 命中 Modrinth / CurseForge 前缀时构造镜像 URL
  let mirrorUrl = null;
  if (urlStr.startsWith(ctx.urls.MODRINTH_API)) {
    mirrorUrl = urlStr.replace(ctx.urls.MODRINTH_API, ctx.urls.MODRINTH_API_MIRROR);
  } else if (urlStr.startsWith(ctx.urls.CURSEFORGE_API)) {
    mirrorUrl = urlStr.replace(ctx.urls.CURSEFORGE_API, ctx.urls.CURSEFORGE_API_MIRROR);
  }

  const headers = { 'User-Agent': 'VersePC/2.0', 'Connection': 'keep-alive', ...extraHeaders };
  const useMirror = mirrorUrl && _isMirrorAvailable();
  // 多步策略：镜像 4s → 官方 10s → 官方完整超时；不走镜像时官方 10s → 官方完整超时
  const steps = useMirror
    ? [{ url: mirrorUrl, t: 4000, isMirror: true }, { url: urlStr, t: Math.min(reqTimeout, 10000) }, { url: urlStr, t: reqTimeout }]
    : [{ url: urlStr, t: Math.min(reqTimeout, 10000) }, { url: urlStr, t: reqTimeout }];

  let lastErr = null;
  for (const step of steps) {
    try {
      const result = await _fetchOnce(step.url, headers, step.t);
      if (step.isMirror) _mirrorSuccess();
      return result;
    } catch (e) {
      lastErr = e;
      if (step.isMirror) _mirrorFailed();
      console.warn(`[fetchJSON] ${step.url.substring(0, 80)}... 失败: ${e.message} (超时${step.t}ms)`);
    }
  }
  throw lastErr || new Error('fetchJSON failed: ' + urlStr.substring(0, 80));
}

/**
 * 带 TTL 缓存的 fetchJSON，相同 URL 在 TTL 内返回缓存结果
 * @param {string} urlStr - 请求 URL
 * @param {number} cacheTTL - 缓存有效期（毫秒）
 * @param {object|number} retriesOrHeaders - 重试次数或自定义 headers
 * @param {number} timeoutMs - 请求超时
 * @returns {Promise<object>} 解析后的 JSON
 */
function cachedFetchJSON(urlStr, cacheTTL, retriesOrHeaders, timeoutMs) {
  const cached = ctx.caches._apiCache.get(urlStr);
  if (cached && Date.now() - cached.ts < cacheTTL) return Promise.resolve(cached.data);
  return fetchJSON(urlStr, retriesOrHeaders, timeoutMs).then((data) => {
    ctx.caches._apiCache.set(urlStr, { data, ts: Date.now() });
    // 缓存项超过 2000 时清理过期项（TTL × 2 视为过期）
    if (ctx.caches._apiCache.size > 2000) {
      const now = Date.now();
      for (const [k, v] of ctx.caches._apiCache) {
        if (now - v.ts > cacheTTL * 2) ctx.caches._apiCache.delete(k);
      }
    }
    return data;
  });
}

/**
 * 拉取纯文本响应（不解析 JSON）
 * @param {string} urlStr - 请求 URL
 * @returns {Promise<string>} 文本内容
 */
function fetchText(urlStr) {
  return new Promise((resolve, reject) => {
    const mod = urlStr.startsWith('https') ? https : http;
    const req = mod.get(urlStr, { headers: { 'User-Agent': 'VersePC/1.0' }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
  });
}

/**
 * 多任务竞速：任一任务成功即返回，全部失败时抛 AggregateError
 * @param {Array<{fetchFn: () => Promise, label: string}>} tasks - 任务数组
 * @param {number} [timeout=15000] - 单任务超时
 * @returns {Promise<any>} 第一个成功的结果
 */
async function fetchWithRacing(tasks, timeout = 15000) {
  return Promise.any(tasks.map(async ({ fetchFn, label }) => {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout`)), timeout)
    );
    const result = await Promise.race([fetchFn(), timeoutPromise]);
    // 空结果视为失败，让 Promise.any 继续等其他任务
    if (!result || (Array.isArray(result) && result.length === 0)) {
      throw new Error(`${label} returned empty`);
    }
    return result;
  }));
}

/* HTTP GET (支持 Range / 重定向) */

/**
 * HTTP GET 请求，支持 Range、最多 5 次重定向
 * @param {string} urlStr - 请求 URL
 * @param {object} [opts={}] - 选项：start/end/timeout/headers/agent
 * @param {number} [_redirectCount=0] - 当前重定向次数（内部递归用）
 * @returns {Promise<{stream: import('http').IncomingMessage, statusCode: number, headers: object, contentLength: number, request: object}>}
 */
function httpGet(urlStr, opts = {}, _redirectCount = 0) {
  if (_redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const isHttps = urlStr.startsWith('https');
    const mod = isHttps ? https : http;
    const agent = opts.agent || (isHttps ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT);
    const headers = { 'User-Agent': 'VersePC/2.0', 'Connection': 'keep-alive', ...opts.headers };
    // 设置 Range 头用于分块下载
    if (opts.start !== undefined) {
      headers['Range'] = opts.end !== undefined ? `bytes=${opts.start}-${opts.end}` : `bytes=${opts.start}-`;
    }
    const req = mod.get(urlStr, { headers, agent }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy();
        // 相对路径补全为绝对 URL
        const nu = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, urlStr).toString();
        return httpGet(nu, opts, _redirectCount + 1).then(resolve).catch(reject);
      }
      resolve({
        stream: res,
        statusCode: res.statusCode,
        headers: res.headers,
        contentLength: parseInt(res.headers['content-length'] || '0', 10),
        request: req
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeout || 30000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

/* 带方法的 JSON 请求（POST/PUT 等） */

/**
 * 带自定义方法的 JSON 请求：支持重定向、429 限流错误、4xx/5xx 错误
 * @param {string} urlStr - 请求 URL
 * @param {string} method - HTTP 方法（GET/POST/PUT/DELETE 等）
 * @param {string|Buffer} [body] - 请求体
 * @param {object} [headers] - 自定义请求头
 * @param {number} [_redirectCount=0] - 当前重定向次数（内部递归用）
 * @returns {Promise<object>} 解析后的 JSON
 */
function fetchJSONWithMethod(urlStr, method, body, headers, _redirectCount) {
  if (!_redirectCount) _redirectCount = 0;
  return new Promise((resolve, reject) => {
    if (_redirectCount > 5) { reject(new Error('Too many redirects')); return; }
    const urlObj = new URL(urlStr);
    const isHttps = urlObj.protocol === 'https:';
    const mod = isHttps ? https : http;
    const agent = isHttps ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: method,
      agent: agent,
      headers: {
        'User-Agent': 'VersePC/1.0 (Minecraft Launcher)',
        'Accept': 'application/json',
        ...(headers || {})
      }
    };
    const req = mod.request(options, (res) => {
      // 3xx 重定向：相对路径补全后递归请求
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
        res.resume();
        fetchJSONWithMethod(redirectUrl, method, body, headers, _redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      // 429 限流：返回带 retryAfter 的错误
      if (res.statusCode === 429) {
        let errData = '';
        res.on('data', (chunk) => (errData += chunk));
        res.on('end', () => {
          const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
          const err = new Error(`HTTP 429: 请求过于频繁，请等待 ${retryAfter} 秒后重试`);
          err.isRateLimit = true;
          err.retryAfter = retryAfter;
          reject(err);
        });
        return;
      }
      // 4xx/5xx：返回带 httpStatus 的错误
      if (res.statusCode >= 400) {
        let errData = '';
        res.on('data', (chunk) => (errData += chunk));
        res.on('end', () => {
          const err = new Error(`HTTP ${res.statusCode}: ${errData.substring(0, 200)}`);
          err.httpStatus = res.statusCode;
          reject(err);
        });
        return;
      }
      // 2xx：解析 JSON
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}, data: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout: ' + urlStr)); });
    if (body) req.write(body);
    req.end();
  });
}

/* 带 Bearer Token 的 JSON 请求 */

/**
 * 带 Bearer Token 的 HTTPS JSON 请求（用于微软账号等鉴权接口）
 * @param {string} urlStr - 请求 URL
 * @param {string} token - Bearer Token
 * @returns {Promise<object>} 解析后的 JSON
 */
function fetchJSONWithAuth(urlStr, token) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'VersePC/1.0' }
    }, (res) => {
      // 429 限流：返回带 retryAfter 的错误
      if (res.statusCode === 429) {
        let errData = '';
        res.on('data', (chunk) => (errData += chunk));
        res.on('end', () => {
          const retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
          const err = new Error(`HTTP 429: 请求过于频繁，请等待 ${retryAfter} 秒后重试`);
          err.isRateLimit = true;
          err.retryAfter = retryAfter;
          reject(err);
        });
        return;
      }
      // 4xx/5xx：返回带 httpStatus 的错误
      if (res.statusCode >= 400) {
        let errData = '';
        res.on('data', (chunk) => (errData += chunk));
        res.on('end', () => {
          const err = new Error(`HTTP ${res.statusCode}: ${errData.substring(0, 200)}`);
          err.httpStatus = res.statusCode;
          reject(err);
        });
        return;
      }
      // 2xx：解析 JSON
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

module.exports = {
  fetchWithProtocol,
  _fetchOnce,
  cachedFetchJSON,
  fetchJSON,
  fetchText,
  fetchWithRacing,
  httpGet,
  fetchJSONWithMethod,
  fetchJSONWithAuth
};
