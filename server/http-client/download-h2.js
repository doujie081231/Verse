/**
 * @file server/http-client/download-h2.js - 真实 HTTP/2 多路复用分块下载
 * @description 使用 node:http2 在单一 TCP 连接上并发多条 Range 流，
 *   减少建连开销。仅适用于 https:// 且源站支持 H2 + Range 的场景。
 *   失败时由调用方回退到 downloadFileChunked（HTTP/1.1）。
 */

const http2 = require('http2');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const ctx = require('../context');

/**
 * 判断 URL 是否适合尝试 HTTP/2
 * @param {string} urlStr
 * @returns {boolean}
 */
function shouldTryH2(urlStr) {
  if (!urlStr || !urlStr.startsWith('https://')) return false;
  if (ctx.constants.NO_CHUNK_HOSTS.some((d) => urlStr.includes(d))) return false;
  return true;
}

/**
 * H2 单流下载
 * @param {import('http2').ClientHttp2Session} client
 * @param {URL} parsed
 * @param {string} destPath
 * @param {number} fileSize
 * @param {Function|null} onProgress
 * @param {AbortSignal|null} abortSignal
 * @returns {Promise<number>} 下载字节数
 */
function downloadSingleH2(client, parsed, destPath, fileSize, onProgress, abortSignal) {
  return new Promise((resolve, reject) => {
    const stream = client.request({
      ':method': 'GET',
      ':path': parsed.pathname + parsed.search,
      ':scheme': 'https',
      ':authority': parsed.host,
      'user-agent': 'VersePC/2.0'
    });
    const ws = fs.createWriteStream(destPath);
    let dl = 0;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { stream.close(); } catch (_) {}
      try { ws.destroy(); } catch (_) {}
      reject(new Error('下载已取消'));
    };
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

    stream.on('response', (headers) => {
      const st = headers[':status'] || 0;
      if (st >= 400) {
        stream.close();
        reject(new Error(`H2 HTTP ${st}`));
      }
    });
    stream.on('data', (chunk) => {
      if (aborted) return;
      dl += chunk.length;
      try { ws.write(chunk); } catch (_) {}
      ctx.DownloadManager.recordProgress(chunk.length);
      if (onProgress && fileSize > 0) {
        onProgress({
          progress: Math.min(99.9, (dl / fileSize) * 100),
          bytesDownloaded: dl,
          totalBytes: fileSize,
          speed: ctx.DownloadManager.getSpeed(),
          chunks: 1,
          activeChunks: 1
        });
      }
    });
    stream.on('end', () => {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      ws.end(() => resolve(dl));
    });
    stream.on('error', (e) => {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      try { ws.destroy(); } catch (_) {}
      reject(e);
    });
    stream.end();
  });
}

function drainStream(stream) {
  return new Promise((resolve) => {
    stream.on('data', () => {});
    stream.on('end', resolve);
    stream.on('error', resolve);
  });
}

/**
 * 真实 HTTP/2 Range 多路复用下载
 * @param {string} url
 * @param {string} destPath
 * @param {object} [options]
 * @returns {Promise<{size: number, path: string, chunks: number, h2: true}>}
 */
async function downloadFileH2(url, destPath, options = {}) {
  const {
    onProgress = null,
    timeout = 120000,
    abortSignal = null,
    maxChunks = 8
  } = options;

  if (!shouldTryH2(url)) throw new Error('H2: host not eligible');
  if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');

  const dir = path.dirname(destPath);
  await fs.promises.mkdir(dir, { recursive: true });

  const parsed = new URL(url);
  const client = http2.connect(parsed.origin, { rejectUnauthorized: false });
  client.setTimeout(timeout);

  const closeClient = () => { try { client.close(); } catch (_) {} };
  const abortHandler = () => { closeClient(); };
  if (abortSignal) abortSignal.addEventListener('abort', abortHandler, { once: true });

  try {
    // 探测：Range 0-0
    const probe = await new Promise((resolve, reject) => {
      const stream = client.request({
        ':method': 'GET',
        ':path': parsed.pathname + parsed.search,
        ':scheme': 'https',
        ':authority': parsed.host,
        'user-agent': 'VersePC/2.0',
        range: 'bytes=0-0'
      });
      stream.on('response', (headers) => {
        resolve({ status: headers[':status'] || 0, headers, stream });
      });
      stream.on('error', reject);
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          try { stream.close(); } catch (_) {}
          reject(new Error('下载已取消'));
        }, { once: true });
      }
      stream.end();
    });

    let fileSize = 0;
    let supportsRange = false;
    if (probe.status === 206) {
      supportsRange = true;
      const m = (probe.headers['content-range'] || '').match(/\/(\d+)/);
      fileSize = m ? parseInt(m[1], 10) : 0;
    } else if (probe.status === 200) {
      fileSize = parseInt(probe.headers['content-length'] || '0', 10) || 0;
      supportsRange = false;
    } else {
      throw new Error(`H2 probe HTTP ${probe.status}`);
    }
    await drainStream(probe.stream);

    if (fileSize <= 0) throw new Error('H2: cannot get file size');

    // 小文件/无 Range → 单流
    if (!supportsRange || fileSize <= 1 * 1024 * 1024) {
      const size = await downloadSingleH2(client, parsed, destPath, fileSize, onProgress, abortSignal);
      return { size, path: destPath, chunks: 1, h2: true };
    }

    // 已存在且大小匹配 → 跳过
    if (fs.existsSync(destPath)) {
      try {
        if (fs.statSync(destPath).size === fileSize) {
          if (onProgress) {
            onProgress({
              progress: 100,
              bytesDownloaded: fileSize,
              totalBytes: fileSize,
              speed: 0,
              chunks: 1,
              activeChunks: 0
            });
          }
          return { size: fileSize, path: destPath, chunks: 1, h2: true };
        }
      } catch (_) {}
    }

    const minChunk = 512 * 1024;
    const cCount = Math.min(maxChunks, Math.ceil(fileSize / minChunk));
    const cSize = Math.ceil(fileSize / cCount);
    const chunks = [];
    for (let i = 0; i < cCount; i++) {
      chunks.push({
        i,
        s: i * cSize,
        e: Math.min((i + 1) * cSize - 1, fileSize - 1),
        tmp: `${destPath}.h2.c${i}`
      });
    }
    for (const c of chunks) {
      try { if (fs.existsSync(c.tmp)) fs.unlinkSync(c.tmp); } catch (_) {}
    }

    const cProg = new Array(cCount).fill(0);
    let lastProg = Date.now();

    // 同一 session 上并发多路 Range 流
    await Promise.all(chunks.map(async (c) => {
      while (!ctx.DownloadManager.acquireConnection()) {
        if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
        await new Promise((r) => setTimeout(r, 10));
      }
      try {
        await new Promise((resolve, reject) => {
          if (abortSignal && abortSignal.aborted) return reject(new Error('下载已取消'));
          const stream = client.request({
            ':method': 'GET',
            ':path': parsed.pathname + parsed.search,
            ':scheme': 'https',
            ':authority': parsed.host,
            'user-agent': 'VersePC/2.0',
            range: `bytes=${c.s}-${c.e}`
          });
          const ws = fs.createWriteStream(c.tmp);
          let dl = 0;
          let stallTimer = setTimeout(() => {
            try { stream.close(); } catch (_) {}
            try { ws.destroy(); } catch (_) {}
            reject(new Error(`H2 chunk ${c.i} stall`));
          }, 15000);

          stream.on('response', (headers) => {
            const st = headers[':status'] || 0;
            if (st !== 206 && st !== 200) {
              clearTimeout(stallTimer);
              stream.close();
              reject(new Error(`H2 chunk ${c.i}: HTTP ${st}`));
            }
          });
          stream.on('data', (chunk) => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
              try { stream.close(); } catch (_) {}
              try { ws.destroy(); } catch (_) {}
              reject(new Error(`H2 chunk ${c.i} stall`));
            }, 15000);
            dl += chunk.length;
            try { ws.write(chunk); } catch (_) {}
            cProg[c.i] = dl;
            ctx.DownloadManager.recordProgress(chunk.length);
            const now = Date.now();
            if (onProgress && now - lastProg >= 100) {
              lastProg = now;
              const total = cProg.reduce((a, b) => a + b, 0);
              onProgress({
                progress: Math.min(99.9, (total / fileSize) * 100),
                bytesDownloaded: total,
                totalBytes: fileSize,
                speed: ctx.DownloadManager.getSpeed(),
                chunks: cCount,
                activeChunks: ctx.DownloadManager.activeConnections
              });
            }
          });
          stream.on('end', () => {
            clearTimeout(stallTimer);
            ws.end(() => {
              const expected = c.e - c.s + 1;
              try {
                const actual = fs.existsSync(c.tmp) ? fs.statSync(c.tmp).size : 0;
                if (actual !== expected) {
                  try { fs.unlinkSync(c.tmp); } catch (_) {}
                  return reject(new Error(`H2 chunk ${c.i} size mismatch: ${actual}/${expected}`));
                }
              } catch (e) { return reject(e); }
              resolve();
            });
          });
          stream.on('error', (e) => {
            clearTimeout(stallTimer);
            try { ws.destroy(); } catch (_) {}
            reject(e);
          });
          stream.end();
        });
      } finally {
        ctx.DownloadManager.releaseConnection();
      }
    }));

    // 顺序合并分块
    const fd = await fs.promises.open(destPath, 'w');
    try {
      for (const c of chunks) {
        const buf = await fs.promises.readFile(c.tmp);
        await fd.write(buf);
        try { fs.unlinkSync(c.tmp); } catch (_) {}
      }
    } finally {
      await fd.close();
    }

    if (onProgress) {
      onProgress({
        progress: 100,
        bytesDownloaded: fileSize,
        totalBytes: fileSize,
        speed: ctx.DownloadManager.getSpeed(),
        chunks: cCount,
        activeChunks: 0
      });
    }
    return { size: fileSize, path: destPath, chunks: cCount, h2: true };
  } finally {
    if (abortSignal) abortSignal.removeEventListener('abort', abortHandler);
    closeClient();
  }
}

module.exports = { downloadFileH2, shouldTryH2 };
