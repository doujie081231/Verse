/**
 * @file server/http-client/download-single.js - 单流下载
 * @description 支持续传、SHA1 校验、JAR 完整性校验、stall 超时检测。
 *   通过 ctx (../context) 访问共享状态，通过 utils (../utils) 访问工具函数，依赖 ./file-ops 的安全重命名/删除。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const ctx = require('../context');
const utils = require('../utils');
const { safeRename, _tryRemoveFile } = require('./file-ops');

/**
 * 单流下载：支持续传、SHA1 校验、JAR 完整性校验、stall 超时检测
 * @param {string} urlStr - 下载 URL
 * @param {string} destPath - 目标文件路径
 * @param {object} [options={}] - onProgress / sha1 / timeout / retries / abortSignal / stallTimeout / agent
 * @returns {Promise<{size: number, path: string}>}
 */
async function _dlSingle(urlStr, destPath, options = {}) {
  const { onProgress = null, sha1 = null, timeout = 60000, retries = 3, abortSignal = null, stallTimeout = 60000, agent: customAgent = null } = options;
  const isHttps = urlStr.startsWith('https');
  const agent = customAgent || (isHttps ? ctx.httpAgents.SHARED_HTTPS_AGENT : ctx.httpAgents.SHARED_HTTP_AGENT);
  // 等待连接数配额
  while (!ctx.DownloadManager.acquireConnection()) {
    if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
    await new Promise((r) => setTimeout(r, 50));
  }
  const tmpPath = destPath + '.downloading';
  let settled = false;
  try {
    if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
    return await new Promise((resolve, reject) => {
      const doReject = (e) => { if (!settled) { settled = true; reject(e); } };
      const doResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
      let currentAbortHandler = null;
      const removeAbortListener = () => {
        if (currentAbortHandler && abortSignal) {
          try { abortSignal.removeEventListener('abort', currentAbortHandler); } catch (_) {}
          currentAbortHandler = null;
        }
      };
      // 单次尝试：rc 为剩余重试次数
      const attempt = (rc) => {
        if (settled) return;
        if (abortSignal && abortSignal.aborted) { doReject(new Error('下载已中止')); return; }
        removeAbortListener();
        const mod = urlStr.startsWith('https') ? https : http;
        utils.ensureDir(destPath);
        const reqHeaders = { 'User-Agent': 'VersePC/2.0', 'Connection': 'keep-alive' };
        // 检测续传偏移：临时文件已存在且非空时从其大小续传
        let resumeOffset = 0;
        try {
          if (fs.existsSync(tmpPath)) {
            const stat = fs.statSync(tmpPath);
            if (stat.size > 0) resumeOffset = stat.size;
          }
        } catch (_) {}
        if (resumeOffset > 0) {
          reqHeaders['Range'] = `bytes=${resumeOffset}-`;
        }
        let ws = null;
        let cleaned = false;
        let stallTimer = null;
        // keepTmp=true 时保留临时文件供续传，keepTmp=false 时删除
        const clean = (keepTmp = false) => {
          if (cleaned) return;
          cleaned = true;
          try { if (ws) ws.destroy(); } catch (_) {}
          if (!keepTmp) _tryRemoveFile(tmpPath);
          _tryRemoveFile(destPath);
          if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
        };
        // stall 检测：stallTimeout 内无数据视为卡死
        const resetStall = () => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            if (!settled && !cleaned) {
              try { if (onProgress) onProgress({ bytesDownloaded: resumeOffset, totalBytes: 0, speed: 0, progress: 0, chunks: 1, activeChunks: 1, stall: true }); } catch (_) {}
              try { req.destroy(); } catch (_) {}
              clean(true); // 保留临时文件供续传
              if (rc > 0) {
                setTimeout(() => attempt(rc - 1), 1000);
              } else {
                doReject(new Error(`Stall timeout: ${urlStr}`));
              }
            }
          }, stallTimeout);
        };
        currentAbortHandler = () => {
          try { req.destroy(); } catch (_) {}
          clean(false); // 用户取消，删除临时文件
          doReject(new Error('下载已中止'));
        };
        if (abortSignal) {
          if (abortSignal.aborted) { currentAbortHandler(); return; }
          abortSignal.addEventListener('abort', currentAbortHandler, { once: true });
        }
        resetStall();
        const req = mod.get(urlStr, { headers: reqHeaders, agent }, (res) => {
          if (settled) { res.destroy(); return; }
          if (abortSignal && abortSignal.aborted) { res.destroy(); clean(false); doReject(new Error('下载已中止')); return; }
          // 3xx 重定向：递归请求新 URL
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            clean(false); // 重定向到新 URL，删除临时文件
            const nu = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, urlStr).toString();
            return _dlSingle(nu, destPath, { onProgress, sha1, timeout, retries: rc, abortSignal, stallTimeout }).then(doResolve).catch(doReject);
          }
          // 206 = 续传成功，追加写入；200 = 服务器不支持续传，覆盖写入
          const isResume = (res.statusCode === 206 && resumeOffset > 0);
          if (res.statusCode !== 200 && res.statusCode !== 206) { clean(false); doReject(new Error(`HTTP ${res.statusCode} for ${urlStr}`)); return; }
          // 服务器返回 200 而非 206 时，忽略续传偏移，从头下载
          if (resumeOffset > 0 && !isResume) {
            resumeOffset = 0;
          }
          // 206 响应的 content-length 是剩余字节数，总大小需加上 resumeOffset
          const contentLen = parseInt(res.headers['content-length'] || '0', 10);
          const tSz = isResume ? (resumeOffset + contentLen) : contentLen;
          let dl = resumeOffset;
          ws = fs.createWriteStream(tmpPath, isResume ? { flags: 'a' } : {});
          res.on('data', (ch) => {
            if (settled) { res.destroy(); return; }
            dl += ch.length;
            ctx.DownloadManager.recordProgress(ch.length);
            resetStall();
            try { if (onProgress) onProgress({ bytesDownloaded: dl, totalBytes: tSz, speed: ctx.DownloadManager.getSpeed(), progress: tSz > 0 ? (dl / tSz * 100) : 0, chunks: 1, activeChunks: 1 }); } catch (_) {}
          });
          res.pipe(ws);
          res.on('error', (e) => {
            try { ws.destroy(); } catch (_) {}
            clean(true); // 保留临时文件供续传
            if (settled) return;
            if (rc > 0) { setTimeout(() => attempt(rc - 1), 1000 + Math.random() * 500); }
            else { doReject(e); }
          });
          ws.on('finish', async () => {
            try {
              if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
              // 等待文件描述符完全关闭后再 rename（Windows: 否则 EPERM 锁定源文件）
              await new Promise((resolve) => {
                if (ws.destroyed) return resolve();
                const done = () => { ws.removeListener('close', done); resolve(); };
                ws.on('close', done);
                try { ws.close(); } catch (_) { done(); }
                setTimeout(done, 2000); // 超时回退
              });
              if (settled || cleaned) return;
              // SHA1 校验：不匹配视为下载损坏
              if (sha1) {
                const a = await utils.calculateSHA1(tmpPath);
                if (settled || cleaned) return;
                if (a !== sha1) {
                  clean(false);
                  if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); }
                  else { doReject(new Error(`SHA1 mismatch: ${path.basename(destPath)}`)); }
                  return;
                }
              }
              // 大小不匹配：保留临时文件供续传
              if (tSz > 0 && dl !== tSz) {
                clean(true);
                if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); }
                else { doReject(new Error(`Size mismatch: ${path.basename(destPath)} expected=${tSz} got=${dl}`)); }
                return;
              }
              // 0 字节文件：清理后重试
              if (dl === 0) {
                clean(false);
                if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); }
                else { doReject(new Error(`Empty file: ${path.basename(destPath)}`)); }
                return;
              }
              // JAR 完整性校验：ZIP 结构检查
              if (destPath.toLowerCase().endsWith('.jar') && !utils.isJarIntact(tmpPath)) {
                const fileSize = dl || (fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0);
                console.warn(`[Download] JAR文件ZIP结构不完整: ${path.basename(destPath)} (${fileSize} bytes)，尝试重新下载`);
                clean(false); // JAR 损坏，删除重下
                if (rc > 0 && !settled) { setTimeout(() => attempt(rc - 1), 1000); }
                else { doReject(new Error(`JAR not intact: ${path.basename(destPath)} (${fileSize} bytes)`)); }
                return;
              }
              if (settled || cleaned) return;
              // 带重试的 rename：Windows 上杀毒软件可能短暂锁定目标文件
              const _renameOK = await safeRename(tmpPath, destPath);
              if (!_renameOK) {
                // 保留 tmpPath 供下次续传，不删除已下载的数据
                clean(true);
                if (!settled) doReject(new Error(`无法写入文件 ${path.basename(destPath)}: 文件可能被占用`));
                return;
              }
              doResolve({ size: dl, path: destPath });
            } catch (e) {
              console.error(`[Download] finish处理异常: ${e.message}`);
              clean(true); // 保留 tmpPath，避免丢失已下载数据
              if (!settled) doReject(e);
            }
          });
          ws.on('error', (e) => {
            clean(true); // 保留临时文件供续传
            if (settled) return;
            if (rc > 0) { setTimeout(() => attempt(rc - 1), 1000 + Math.random() * 500); }
            else { doReject(e); }
          });
        });
        req.on('error', (e) => {
          clean(true); // 保留临时文件供续传
          if (settled) return;
          if (rc > 0) { setTimeout(() => attempt(rc - 1), Math.min(2000 + (retries - rc) * 1000, 8000)); }
          else { doReject(e); }
        });
        req.setTimeout(timeout, () => {
          req.destroy();
          clean(true); // 保留临时文件供续传
          if (settled) return;
          if (rc > 0) { setTimeout(() => attempt(rc - 1), 2000); }
          else { doReject(new Error(`Timeout: ${urlStr}`)); }
        });
      };
      attempt(retries);
    });
  } finally {
    ctx.DownloadManager.releaseConnection();
  }
}

module.exports = { _dlSingle };
