/**
 * @file server/http-client/download-chunked.js - HTTP/1.1 多线程分块下载
 * @description 支持续传、镜像回退、SHA1/JAR 校验、AbortSignal。
 *   通过 ctx (../context) 访问共享状态，通过 utils (../utils) 访问工具函数，
 *   依赖 ./settings（设置缓存）、./request（httpGet）、./mirror（getMirrorUrls）、
 *   ./file-ops（safeRename/_tryRemoveFile）、./download-single（_dlSingle）。
 */

const fs = require('fs');
const path = require('path');
const ctx = require('../context');
const utils = require('../utils');
const { loadSettingsCached } = require('./settings');
const { httpGet } = require('./request');
const { getMirrorUrls, probeMirrorsParallel } = require('./mirror');
const { safeRename, _tryRemoveFile } = require('./file-ops');
const { _dlSingle } = require('./download-single');

/**
 * HTTP/1.1 多线程分块下载：支持续传、镜像回退、SHA1/JAR 校验、AbortSignal
 * @param {string} url - 主下载 URL
 * @param {string} destPath - 目标文件路径
 * @param {object} [options={}] - retries/onProgress/sha1/timeout/mirrors/abortSignal/agent/maxChunks
 * @returns {Promise<{size: number, path: string, sha1Match?: boolean, chunks: number}>}
 */
async function downloadFileChunked(url, destPath, options = {}) {
  const { retries = 3, onProgress = null, sha1 = null, timeout = 120000, mirrors = null, abortSignal = null, agent: customAgent = null, maxChunks: optMaxChunks = null } = options;
  const minChunkSize = 512 * 1024;
  const CHUNK_THRESHOLD = 1 * 1024 * 1024;
  // [CRITICAL] 分块下载前清理路径中与目录同名的文件。
  // 此函数不调用 ensureDir，需要自行处理 ENOTDIR 问题（同 ensureDir 的原理）。
  // [AI 自动生成警告] 请勿删除此处的文件清理块。
  {
    const d = path.dirname(destPath);
    try {
      for (const p of d.split(path.sep).map((_, i, a) => a.slice(0, i + 1).join(path.sep))) {
        if (p) { try { const s = await fs.promises.stat(p); if (!s.isDirectory()) await fs.promises.unlink(p); } catch (_) {} }
      }
    } catch (_) {}
    await fs.promises.mkdir(d, { recursive: true });
  }

  // [P0 FIX - 2026-07-21] 清理目标路径的旧分块残留文件 (.cN)
  // 上次下载若因进程中断或文件锁定导致分块未清理，残留的 xxx.jar.cN 文件
  // 会被 Forge 的 ModDirTransformerDiscoverer 当作 jar 扫描（因文件名含 .jar），
  // 触发 "zip END header not found" 崩溃。每次下载前先清理，避免积累。
  {
    const dir = path.dirname(destPath);
    const base = path.basename(destPath);
    try {
      const entries = await fs.promises.readdir(dir);
      for (const f of entries) {
        // 匹配 destPath.cN 格式的残留分块
        if (f.startsWith(base + '.c') && /^\.c\d+$/.test(f.slice(base.length))) {
          try { await fs.promises.unlink(path.join(dir, f)); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // 优先使用传入的 mirrors（已排序），否则内部生成
  const rawUrls = (mirrors && mirrors.length > 0) ? mirrors : getMirrorUrls(url);
  const _agent = customAgent || undefined;

  // 并行测速所有镜像，选最快的源
  // allUrls 存储排序后的 URL 列表，allProbeResults 存储每个 URL 的元信息。
  let allUrls = rawUrls;
  let allProbeResults = null;
  if (rawUrls.length > 1) {
    try {
      allProbeResults = await probeMirrorsParallel(rawUrls, 1500);
      // 只保留能拿到 fileSize 的 URL（探测成功的）
      const valid = allProbeResults.filter(r => r.fileSize > 0);
      if (valid.length > 0) {
        allUrls = valid.map(r => r.url);
      }
    } catch (e) { /* 测速失败，回退原始 URL 列表 */ }
  }

  // 缓存首次成功的探针结果，重试时复用，避免 CDN 限速时探针返回 200 导致回退单流下载
  let cachedProbe = null;

  for (let ra = 0; ra <= retries; ra++) {
    if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
    for (let urlIdx = 0; urlIdx < allUrls.length; urlIdx++) {
      if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
      const currentUrl = allUrls[urlIdx];
      try {
        let fileSize = 0, supportsRange = false, workingUrl = currentUrl;
        if (cachedProbe && cachedProbe.supportsRange) {
          // 重试时复用首次探针结果：CDN 限速时探针可能返回 200 误判为不支持 Range
          fileSize = cachedProbe.fileSize;
          supportsRange = cachedProbe.supportsRange;
          workingUrl = cachedProbe.workingUrl;
        } else {
          // 首次探针：探测当前 URL 的 Range 支持与文件大小，使用 finalUrl 缓存避免每块重定向
          const probeR = await httpGet(currentUrl, { start: 0, end: 0, timeout: 2000, agent: _agent });
          probeR.stream.destroy();
          if (probeR.statusCode === 206) {
            supportsRange = true;
            workingUrl = probeR.finalUrl || currentUrl;
            const crMatch = (probeR.headers['content-range'] || '').match(/\/(\d+)/);
            fileSize = crMatch ? parseInt(crMatch[1], 10) : probeR.contentLength;
          } else if (probeR.statusCode === 200) {
            supportsRange = false;
            fileSize = probeR.contentLength;
            workingUrl = probeR.finalUrl || currentUrl;
          }
          // 当前 URL 拿不到大小时，依次探测后续镜像
          if (fileSize <= 0) {
            for (let probeIdx = urlIdx + 1; probeIdx < allUrls.length; probeIdx++) {
              try {
                const r2 = await httpGet(allUrls[probeIdx], { start: 0, end: 0, timeout: 2000, agent: _agent });
                r2.stream.destroy();
                if (r2.statusCode === 206) {
                  supportsRange = true;
                  workingUrl = r2.finalUrl || allUrls[probeIdx];
                  const crMatch = (r2.headers['content-range'] || '').match(/\/(\d+)/);
                  fileSize = crMatch ? parseInt(crMatch[1], 10) : r2.contentLength;
                } else if (r2.statusCode === 200) {
                  supportsRange = false;
                  fileSize = r2.contentLength;
                  workingUrl = r2.finalUrl || allUrls[probeIdx];
                }
                if (fileSize > 0) break;
              } catch (e) { continue; }
            }
          }
          // 仅在确认支持 Range 且拿到大小时缓存，避免缓存错误的 200 探针
          if (supportsRange && fileSize > 0) {
            cachedProbe = { fileSize, supportsRange, workingUrl };
          }
        }

        const settings = loadSettingsCached();
        const useChunk = settings.enableChunkDownload && supportsRange && fileSize > CHUNK_THRESHOLD;
        // 不启用分块或文件过小：回退单流下载
        if (!useChunk || fileSize <= 0) {
          return await _dlSingle(workingUrl, destPath, { onProgress, sha1, timeout, abortSignal, agent: customAgent });
        }
        // 下载前检查文件是否已存在（大小匹配则跳过，复用文件）
        if (fs.existsSync(destPath)) {
          try {
            const existStat = fs.statSync(destPath);
            if (existStat.size === fileSize) {
              if (sha1) {
                const actualSha1 = await utils.calculateSHA1(destPath);
                if (actualSha1 === sha1) {
                  console.log(`[Download] 文件已存在且 SHA1 匹配，跳过下载: ${path.basename(destPath)}`);
                  if (onProgress) onProgress({ bytesDownloaded: existStat.size, totalBytes: fileSize, speed: 0, progress: 100, chunks: 1, activeChunks: 0 });
                  return { size: existStat.size, path: destPath, sha1Match: true, chunks: 1 };
                }
                console.warn(`[Download] 文件已存在但 SHA1 不匹配，重新下载: ${path.basename(destPath)}`);
                try { fs.unlinkSync(destPath); } catch (_) {}
              } else {
                console.log(`[Download] 文件已存在且大小匹配，跳过下载: ${path.basename(destPath)}`);
                if (onProgress) onProgress({ bytesDownloaded: existStat.size, totalBytes: fileSize, speed: 0, progress: 100, chunks: 1, activeChunks: 0 });
                return { size: existStat.size, path: destPath, chunks: 1 };
              }
            }
          } catch (_) {}
        }
        // 分块计算：根据文件大小与最大分块数均匀切分
        const maxC = optMaxChunks !== null ? optMaxChunks : Math.min(parseInt(settings.maxChunksPerFile, 10) || 16, 32);
        const cCount = Math.min(maxC, Math.ceil(fileSize / minChunkSize));
        const cSize = Math.ceil(fileSize / cCount);
        const chunks = [];
        for (let i = 0; i < cCount; i++) {
          chunks.push({ i, s: i * cSize, e: Math.min((i + 1) * cSize - 1, fileSize - 1), tmp: `${destPath}.c${i}` });
        }
        const cProg = new Array(cCount).fill(0);
        // 检测已下载的分块，支持续传
        const _getChunkResumeOffset = (c) => {
          try {
            if (!fs.existsSync(c.tmp)) return 0;
            const stat = fs.statSync(c.tmp);
            const expected = c.e - c.s + 1;
            if (stat.size > expected) return 0;   // 文件过大，重新下载
            if (stat.size === expected) return -1; // 已完成，跳过
            return stat.size;                      // 返回续传偏移
          } catch (_) { return 0; }
        };
        // 初始化进度（累加已完成分块的字节）
        for (const c of chunks) {
          const off = _getChunkResumeOffset(c);
          if (off === -1) cProg[c.i] = c.e - c.s + 1;
          else if (off > 0) cProg[c.i] = off;
        }
        let lastProgUpdate = Date.now();

        // 60 秒 stall 超时：检测 CDN 节点卡死，足够避开短暂网络抖动
        const CHUNK_STALL_TIMEOUT = 60000;

        const dlChunk = async (c) => {
          if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
          let resumeOffset = _getChunkResumeOffset(c);
          if (resumeOffset === -1) {
            console.log(`[MultiThread] Chunk ${c.i} 已完成，跳过`);
            return;
          }
          // 等待连接数配额
          while (!ctx.DownloadManager.acquireConnection()) {
            if (abortSignal && abortSignal.aborted) throw new Error('下载已中止');
            await new Promise((r) => setTimeout(r, 50));
          }
          try {
            const startByte = c.s + resumeOffset;
            const cr = await httpGet(workingUrl, { start: startByte, end: c.e, timeout, agent: _agent });
            if (abortSignal && abortSignal.aborted) {
              cr.stream.destroy();
              throw new Error('下载已中止');
            }
            if (cr.statusCode !== 206) {
              cr.stream.destroy();
              throw new Error(`Chunk ${c.i}: HTTP ${cr.statusCode} (expected 206)`);
            }
            // 非续传时先清空旧分块文件，appendFileSync 从 0 开始追加
            const isChunkResume = (resumeOffset > 0);
            if (!isChunkResume) { try { fs.unlinkSync(c.tmp); } catch (_) {} }
            let dl = resumeOffset;
            let aborted = false;
            let stalled = false;
            let stallTimer = null;
            // 60s 内无数据流入则视为卡死，销毁流并 reject，由外层重试或回退处理
            const resetStall = () => {
              if (stallTimer) clearTimeout(stallTimer);
              stallTimer = setTimeout(() => {
                if (!aborted) {
                  stalled = true;
                  console.warn(`[MultiThread] Chunk ${c.i} stall timeout (60s), aborting...`);
                  try { cr.stream.destroy(); } catch (_) {}
                  if (_chunkReject) { try { _chunkReject(new Error(`Chunk ${c.i} stall timeout`)); } catch (_) {} _chunkReject = null; }
                }
              }, CHUNK_STALL_TIMEOUT);
            };
            resetStall();
            let _chunkReject = null;
            const onAbort = () => {
              aborted = true;
              stalled = true;
              if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
              if (cr.stream) try { cr.stream.destroy(); } catch (_) {}
              if (_chunkReject) { try { _chunkReject(new Error('下载已中止')); } catch (_) {} _chunkReject = null; }
            };
            if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
            // 同步写盘：appendFileSync 简单稳定，避免 createWriteStream 异步事件竞态
            await new Promise((resolve, reject) => {
              _chunkReject = reject;
              cr.stream.on('data', (d) => {
                if (stalled || aborted) return;
                dl += d.length;
                ctx.DownloadManager.recordProgress(d.length);
                cProg[c.i] = dl;
                resetStall();
                try { fs.appendFileSync(c.tmp, d); } catch (_) {}
                if (onProgress && Date.now() - lastProgUpdate > 50) {
                  lastProgUpdate = Date.now();
                  const t = cProg.reduce((a, b) => a + b, 0);
                  onProgress({
                    bytesDownloaded: t,
                    totalBytes: fileSize,
                    speed: ctx.DownloadManager.getSpeed(),
                    progress: Math.min(99.9, (t / fileSize) * 100),
                    chunks: cCount,
                    activeChunks: ctx.DownloadManager.activeConnections
                  });
                }
              });
              cr.stream.on('end', () => {
                _chunkReject = null;
                if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                if (aborted) return;
                resolve();
              });
              cr.stream.on('error', (err) => {
                _chunkReject = null;
                if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
                reject(err);
              });
            });
            // 分块完成时再触发一次进度更新
            if (onProgress) {
              const t = cProg.reduce((a, b) => a + b, 0);
              onProgress({
                bytesDownloaded: t,
                totalBytes: fileSize,
                speed: ctx.DownloadManager.getSpeed(),
                progress: Math.min(99.9, (t / fileSize) * 100),
                chunks: cCount,
                activeChunks: ctx.DownloadManager.activeConnections
              });
            }
          } finally {
            ctx.DownloadManager.releaseConnection();
          }
        };
        // 所有分块并发执行，无 worker 调度、无分块 split、无单 chunk 重试换 URL
        await Promise.all(chunks.map((c) => dlChunk(c)));

        try {
          // 合并到临时文件，避免 AV 锁定 0 字节的 destPath
          const mergeTmp = destPath + '.merging';
          await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(mergeTmp);
            let idx = 0;
            let mergedBytes = 0;
            let lastMergeProg = Date.now();
            const writeNext = () => {
              if (idx >= chunks.length) { ws.end(); return; }
              const rs = fs.createReadStream(chunks[idx].tmp);
              rs.on('data', (d) => {
                mergedBytes += d.length;
                // 合并阶段也上报进度（merging 标记）
                if (onProgress && Date.now() - lastMergeProg > 100) {
                  lastMergeProg = Date.now();
                  onProgress({
                    bytesDownloaded: mergedBytes,
                    totalBytes: fileSize,
                    speed: 0,
                    progress: Math.min(99.9, (mergedBytes / fileSize) * 100),
                    chunks: cCount,
                    activeChunks: 0,
                    merging: true
                  });
                }
              });
              rs.on('end', () => { idx++; writeNext(); });
              rs.on('error', reject);
              rs.pipe(ws, { end: false });
            };
            ws.on('finish', () => {
              // 等待文件描述符完全关闭后再 resolve (Windows: 否则 EPERM 锁定源文件)
              const onClose = () => resolve();
              ws.on('close', onClose);
              try { ws.close(); } catch (_) { onClose(); }
              setTimeout(onClose, 2000);
            });
            ws.on('error', reject);
            writeNext();
          });
          // 合并成功后清理临时分块（带重试，防止 AV 锁定导致残留）
          for (const c of chunks) {
            for (let _retry = 0; _retry < 3; _retry++) {
              try { await fs.promises.unlink(c.tmp); break; }
              catch (e) {
                if (_retry < 2) await new Promise(r => setTimeout(r, 300));
                else console.warn(`[MultiThread] 清理分块失败: ${path.basename(c.tmp)} - ${e.message}`);
              }
            }
          }
        } catch (e) {
          // 保留临时分块文件，支持下次重试续传
          try { await fs.promises.unlink(destPath + '.merging'); } catch (_) {}
          throw e;
        }
        // 合并后校验（在 mergeTmp 上进行，不触碰 destPath）
        const mergeTmp = destPath + '.merging';
        const actualSize = fs.existsSync(mergeTmp) ? fs.statSync(mergeTmp).size : 0;
        const _mergeCleanup = async () => {
          await fs.promises.unlink(mergeTmp).catch(() => {});
          for (const c of chunks) { try { await fs.promises.unlink(c.tmp); } catch (_) {} }
        };
        // 大小不匹配：清理后切下一个镜像或重试
        if (fileSize > 0 && actualSize !== fileSize) {
          console.warn(`[MultiThread] Size mismatch after merge: ${path.basename(destPath)} expected=${fileSize} got=${actualSize}`);
          await _mergeCleanup();
          if (urlIdx < allUrls.length - 1) {
            continue;
          }
          if (ra < retries) continue;
          throw new Error(`Size mismatch after merge: ${path.basename(destPath)} expected=${fileSize} got=${actualSize}`);
        }
        // 0 字节文件：同样清理后切换
        if (actualSize === 0) {
          console.warn(`[MultiThread] Empty file after merge: ${path.basename(destPath)}`);
          await _mergeCleanup();
          if (urlIdx < allUrls.length - 1) { continue; }
          if (ra < retries) continue;
          throw new Error(`Empty file after merge: ${path.basename(destPath)}`);
        }
        // JAR 完整性校验（即使无 SHA1 也要检查 ZIP 结构）
        if (destPath.toLowerCase().endsWith('.jar') && !utils.isJarIntact(mergeTmp)) {
          console.warn(`[MultiThread] JAR not intact after merge: ${path.basename(destPath)} (${actualSize} bytes)`);
          await _mergeCleanup();
          if (urlIdx < allUrls.length - 1) { continue; }
          if (ra < retries) continue;
          throw new Error(`JAR not intact: ${path.basename(destPath)}`);
        }
        // SHA1 校验：不匹配视为下载损坏
        if (sha1) {
          const actual = await utils.calculateSHA1(mergeTmp);
          if (actual !== sha1) {
            console.warn(`[MultiThread] SHA1 mismatch on ${allUrls[urlIdx]}: ${path.basename(destPath)}`);
            await _mergeCleanup();
            if (urlIdx < allUrls.length - 1) {
              continue;
            }
            if (ra < retries) continue;
            // SHA1 不匹配但不重试时返回 sha1Match: false 让上层决定
            return { size: fileSize, path: destPath, sha1Match: false, chunks: cCount };
          }
        }
        // 校验通过，用带重试的 safeRename 写入最终路径
        const _renameOK = await safeRename(mergeTmp, destPath);
        if (!_renameOK) {
          if (urlIdx < allUrls.length - 1) {
            continue;
          }
          if (ra < retries) continue;
          throw new Error(`无法写入文件 ${path.basename(destPath)}: 文件可能被占用`);
        }
        if (onProgress) onProgress({ bytesDownloaded: fileSize, totalBytes: fileSize, speed: 0, progress: 100, chunks: cCount, activeChunks: 0 });
        return { size: fileSize, path: destPath, sha1Match: sha1 ? true : undefined, chunks: cCount };
      } catch (err) {
        console.warn(`[MultiThread] URL ${currentUrl} failed: ${err.message}`);
        // 当前镜像失败：切下一个镜像
        if (urlIdx < allUrls.length - 1) {
          continue;
        }
        // 所有镜像都失败：重试或抛错
        if (ra < retries) {
          console.warn(`[MultiThread] Retry ${ra + 1}/${retries}`);
          // 保留临时分块文件用于续传，仅清理目标文件（处理锁定/只读）
          _tryRemoveFile(destPath);
          await new Promise((r) => setTimeout(r, Math.min(1000 * (ra + 1), 5000) + Math.floor(Math.random() * 500)));
        } else {
          // 所有重试耗尽：清理分块临时文件后回退单流下载
          // 触发条件：服务器不支持 Range (expected 206)、分块大小不匹配 (size mismatch)、
          // 分块卡死超时 (stall timeout)。这些场景下分块下载不可靠，单流更稳定。
          for (let i = 0; i < 64; i++) { _tryRemoveFile(`${destPath}.c${i}`); }
          _tryRemoveFile(destPath);
          const _errMsg = err.message || '';
          // [P0 FIX - 2026-07-21] 加入 'Request timeout'：httpGet 的 socket 无活动超时会抛此错误，
          // 单流下载有低速检测，能更好地应对 CDN 滴漏/节点卡死。
          const _shouldFallback = _errMsg.includes('expected 206')
            || _errMsg.includes('size mismatch')
            || _errMsg.includes('stall timeout')
            || _errMsg.includes('Request timeout')
            || _errMsg.includes('low speed')
            || _errMsg.includes('ECONNRESET')
            || _errMsg.includes('ECONNREFUSED')
            || _errMsg.includes('ETIMEDOUT');
          if (_shouldFallback) {
            console.warn(`[MultiThread] 分块下载失败(${_errMsg})，回退单流下载: ${path.basename(destPath)}`);
            for (const fallbackUrl of allUrls) {
              try {
                // 单流也用 60秒 socket 无活动超时，避免无响应节点等 10 分钟
                return await _dlSingle(fallbackUrl, destPath, { onProgress, sha1, timeout: Math.min(timeout, 60000), abortSignal, agent: customAgent });
              } catch (singleErr) {
                console.warn(`[MultiThread] 单流回退失败 (${fallbackUrl}): ${singleErr.message}`);
              }
            }
          }
          throw err;
        }
      }
    }
  }
}

module.exports = { downloadFileChunked };
