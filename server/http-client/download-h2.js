/**
 * @file server/http-client/download-h2.js - HTTP/2 多线程分块下载
 * @description 小文件回退单流，大文件按 512KB 分块。
 *   通过 ctx (../context) 访问共享状态。
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const ctx = require('../context');

/**
 * HTTP/2 多线程分块下载（小文件回退单流，大文件按 512KB 分块）
 * @param {string} url - 下载 URL
 * @param {string} destPath - 目标文件路径
 * @param {object} [options={}] - onProgress / timeout / abortSignal
 * @returns {Promise<void>}
 */
async function downloadFileH2(url, destPath, options = {}) {
  const { onProgress = null, timeout = 600000, abortSignal = null } = options;
  // [CRITICAL] H2 下载前清理路径中与目录同名的文件。
  // 此函数不调用 ensureDir，需要自行处理 ENOTDIR 问题（同 ensureDir 的原理）。
  // [AI 自动生成警告] 请勿删除此处的文件清理块。
  const dir = path.dirname(destPath);
  try {
    const parts = dir.split(path.sep);
    for (let i = 1; i <= parts.length; i++) {
      const partial = parts.slice(0, i).join(path.sep);
      if (partial) {
        try {
          const st = await fs.promises.stat(partial);
          if (!st.isDirectory()) await fs.promises.unlink(partial);
        } catch (_) {}
      }
    }
  } catch (_) {}
  await fs.promises.mkdir(dir, { recursive: true });

  // H2 用独立的 Agent，避免与共享 Agent 竞争 socket
  const _h2Agent = new https.Agent({
    keepAlive: true,
    maxSockets: 200,
    maxFreeSockets: 128,
    timeout: timeout || 120000,
    keepAliveMsecs: 300000,
    scheduling: 'fifo'
  });

  try {
    // HEAD 探测：判断是否支持 Range、获取文件大小
    const probeRes = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        method: 'HEAD',
        agent: _h2Agent,
        headers: { 'User-Agent': 'VersePC/2.0' }
      }, (res) => { resolve({ statusCode: res.statusCode, headers: res.headers }); res.destroy(); });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('probe timeout')); });
    });

    let fileSize = 0, supportsRange = false;
    if (probeRes.statusCode === 206) {
      // 206 直接说明支持 Range，从 content-range 取总大小
      supportsRange = true;
      const cr = probeRes.headers['content-range'] || '';
      const m = cr.match(/\/(\d+)/);
      fileSize = m ? parseInt(m[1], 10) : parseInt(probeRes.headers['content-length'] || '0', 10);
    } else if (probeRes.statusCode === 200) {
      supportsRange = (probeRes.headers['accept-ranges'] === 'bytes');
      fileSize = parseInt(probeRes.headers['content-length'] || '0', 10);
    }
    if (fileSize <= 0) throw new Error('H2: 无法获取文件大小');

    // 不支持 Range 或文件过小（<1MB）时走单流
    if (!supportsRange || fileSize <= 1 * 1024 * 1024) {
      await new Promise((resolve, reject) => {
        if (abortSignal && abortSignal.aborted) { reject(new Error('已取消')); return; }
        const req = https.get(url, {
          agent: _h2Agent,
          headers: { 'User-Agent': 'VersePC/2.0' }
        }, (res) => {
          if (res.statusCode >= 400) { res.destroy(); reject(new Error(`H2 HTTP ${res.statusCode}`)); return; }
          let dl = 0;
          const ws = fs.createWriteStream(destPath);
          res.on('data', (chunk) => {
            dl += chunk.length;
            ws.write(chunk);
            ctx.DownloadManager.recordProgress(chunk.length);
            if (onProgress && fileSize > 0) onProgress({ progress: Math.round((dl / fileSize) * 100), downloaded: dl, total: fileSize, speed: ctx.DownloadManager.getSpeed() });
          });
          res.on('end', () => { ws.end(); ws.on('finish', resolve); });
          res.on('error', reject);
        });
        req.on('error', reject);
        if (abortSignal) abortSignal.addEventListener('abort', () => { req.destroy(); reject(new Error('已取消')); }, { once: true });
      });
      return;
    }

    // 分块策略：最多 16 路，每块至少 512KB
    const cCount = Math.min(16, Math.ceil(fileSize / (512 * 1024)));
    const cSize = Math.ceil(fileSize / cCount);
    const chunks = [];
    for (let i = 0; i < cCount; i++) {
      chunks.push({ i, s: i * cSize, e: Math.min((i + 1) * cSize - 1, fileSize - 1), tmp: `${destPath}.c${i}` });
    }
    const cProg = new Array(cCount).fill(0);
    let lastProgUpdate = Date.now();

    const dlChunk = (c) => new Promise((resolve, reject) => {
      if (abortSignal && abortSignal.aborted) { reject(new Error('已取消')); return; }
      const req = https.get(url, {
        agent: _h2Agent,
        headers: { 'Range': `bytes=${c.s}-${c.e}`, 'User-Agent': 'VersePC/2.0' }
      }, (res) => {
        if (res.statusCode !== 206 && res.statusCode !== 200) { res.destroy(); reject(new Error(`H2 chunk ${c.i}: HTTP ${res.statusCode}`)); return; }
        let dl = 0;
        const ws = fs.createWriteStream(c.tmp);
        // 60s 无数据视为卡死，销毁流并报错
        let stalled = setTimeout(() => { res.destroy(); reject(new Error(`chunk ${c.i} stall`)); }, 60000);
        res.on('data', (chunk) => {
          clearTimeout(stalled);
          stalled = setTimeout(() => { res.destroy(); reject(new Error(`chunk ${c.i} stall`)); }, 60000);
          dl += chunk.length;
          ws.write(chunk);
          cProg[c.i] = dl;
          const now = Date.now();
          // 节流：每 200ms 最多触发一次进度回调
          if (now - lastProgUpdate >= 200) {
            lastProgUpdate = now;
            const total = cProg.reduce((a, b) => a + b, 0);
            // 增量上报：用本次 total 减去上次记录值
            ctx.DownloadManager.recordProgress(total - (downloadFileH2._lastTotal || 0));
            downloadFileH2._lastTotal = total;
            if (onProgress) onProgress({ progress: Math.round((total / fileSize) * 100), downloaded: total, total: fileSize, speed: ctx.DownloadManager.getSpeed() });
          }
        });
        res.on('end', () => { clearTimeout(stalled); ws.end(); ws.on('finish', resolve); });
        res.on('error', (e) => { clearTimeout(stalled); reject(e); });
      });
      req.on('error', reject);
      if (abortSignal) abortSignal.addEventListener('abort', () => { req.destroy(); reject(new Error('已取消')); }, { once: true });
    });

    downloadFileH2._lastTotal = 0;
    await Promise.all(chunks.map((c) => dlChunk(c)));
    // 合并所有分块到目标文件
    const buffers = [];
    for (const c of chunks) {
      buffers.push(await fs.promises.readFile(c.tmp));
      try { fs.unlinkSync(c.tmp); } catch (_) {}
    }
    await fs.promises.writeFile(destPath, Buffer.concat(buffers));
  } finally {
    try { _h2Agent.destroy(); } catch (_) {}
  }
}

module.exports = { downloadFileH2 };
