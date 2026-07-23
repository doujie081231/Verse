/**
 * @file server/http-client/mirror.js - 镜像源管理
 * @description 镜像熔断（连续失败 3 次暂停 1 分钟）、镜像 URL 选择（根据下载源设置动态调整顺序）、镜像测速。
 *   通过 ctx (../context) 访问共享状态。
 */

const ctx = require('../context');

// 镜像是否可用：连续失败 3 次后熔断 1 分钟
function _isMirrorAvailable() {
  if (ctx.caches._mirrorHealth.down && Date.now() < ctx.caches._mirrorHealth.until) return false;
  if (ctx.caches._mirrorHealth.down && Date.now() >= ctx.caches._mirrorHealth.until) {
    ctx.caches._mirrorHealth.down = false;
    ctx.caches._mirrorHealth.fails = 0;
  }
  return true;
}
function _mirrorFailed() {
  ctx.caches._mirrorHealth.fails++;
  if (ctx.caches._mirrorHealth.fails >= 3) {
    ctx.caches._mirrorHealth.down = true;
    ctx.caches._mirrorHealth.until = Date.now() + 60 * 1000;
    console.warn(`[Mirror] 镜像连续失败${ctx.caches._mirrorHealth.fails}次，暂停使用1分钟`);
  }
}
function _mirrorSuccess() {
  ctx.caches._mirrorHealth.fails = 0;
  ctx.caches._mirrorHealth.down = false;
}

/**
 * 读取当前下载源设置
 * @returns {string} downloadSource: china-first | auto | official-first | mojang
 */
function _getDownloadSource() {
  try {
    const { loadSettingsCached } = require('./settings');
    const settings = loadSettingsCached();
    return settings.downloadSource || 'china-first';
  } catch (e) {
    return 'china-first';
  }
}

/**
 * 获取原始 URL 对应的镜像 URL 列表，根据下载源设置动态调整顺序
 * @param {string} originalUrl - 原始 URL
 * @returns {string[]} URL 列表（含原始 URL），顺序由下载源设置决定
 */
function getMirrorUrls(originalUrl) {
  if (!originalUrl) return [originalUrl];

  const downloadSource = _getDownloadSource();

  // mojang 模式：只使用官方源，不使用任何镜像
  if (downloadSource === 'mojang') {
    return [originalUrl];
  }

  const mirrorUrls = [];
  const officialUrl = originalUrl;

  // 收集 BMCLAPI/MCIM 镜像（cdn.modrinth.com → mod.mcimirror.top 等）
  for (const [original, mirror] of Object.entries(ctx.mirrors.BMCLAPI_MIRROR)) {
    if (originalUrl.startsWith(original)) {
      const mirrored = originalUrl.replace(original, mirror);
      if (mirrored !== originalUrl && !mirrorUrls.includes(mirrored)) {
        mirrorUrls.push(mirrored);
      }
      break;
    }
  }

  // libraries.minecraft.net 额外补 Forge maven 镜像
  if (originalUrl.startsWith('https://libraries.minecraft.net/')) {
    const forgeMirror = originalUrl.replace('https://libraries.minecraft.net/', 'https://maven.minecraftforge.net/');
    if (!mirrorUrls.includes(forgeMirror)) mirrorUrls.push(forgeMirror);
  }

  // 熔断时跳过镜像
  const mirrorAvailable = _isMirrorAvailable();

  let urls;
  if (downloadSource === 'china-first') {
    // 国内优先：镜像在前，官方在后（熔断时跳过镜像）
    urls = mirrorAvailable ? [...mirrorUrls, officialUrl] : [officialUrl];
  } else {
    // auto / official-first：官方在前，镜像在后（熔断时跳过镜像）
    urls = mirrorAvailable ? [officialUrl, ...mirrorUrls] : [officialUrl];
  }

  return urls;
}

/**
 * 并行探测所有 URL 的速度，返回按速度降序排列的 URL 列表 + 每个 URL 的文件大小/Range 支持情况。
 * 下载前并行测速所有镜像，选最快的源，而非串行探测或只用第一个。
 *
 * @param {string[]} urls - 待探测的 URL 列表
 * @param {number} [timeoutMs=1500] - 单 URL 探测超时
 * @returns {Promise<{url: string, speed: number, fileSize: number, supportsRange: boolean}[]>}
 *   按速度降序排列，失败的 URL speed=0 会被排到最后
 */
async function probeMirrorsParallel(urls, timeoutMs = 1500) {
  if (!urls || urls.length <= 1) {
    return urls.map(url => ({ url, speed: Infinity, fileSize: 0, supportsRange: false }));
  }
  const { httpGet } = require('./request');
  const probes = urls.map(async (url) => {
    const start = Date.now();
    try {
      const r = await httpGet(url, { start: 0, end: 0, timeout: timeoutMs });
      r.stream.destroy();
      const elapsed = Date.now() - start;
      // 探针只下载 1 字节（Range:0-0），速度用响应延迟倒数近似
      // 延迟越低 = 速度越快（排序用）
      const speed = elapsed > 0 ? 1000 / elapsed : 0;
      let fileSize = 0, supportsRange = false;
      if (r.statusCode === 206) {
        supportsRange = true;
        const crMatch = (r.headers['content-range'] || '').match(/\/(\d+)/);
        fileSize = crMatch ? parseInt(crMatch[1], 10) : r.contentLength;
      } else if (r.statusCode === 200) {
        supportsRange = false;
        fileSize = r.contentLength;
      }
      return { url, finalUrl: r.finalUrl || url, speed, fileSize, supportsRange, ok: true };
    } catch (e) {
      return { url, speed: 0, fileSize: 0, supportsRange: false, ok: false };
    }
  });
  const results = await Promise.all(probes);
  // 按速度降序（speed 越高越快），失败的排最后
  results.sort((a, b) => b.speed - a.speed);
  return results;
}

/**
 * 对多个镜像并发测速，按速度降序返回 URL 列表
 * @param {string[]} urls - 待测速的 URL 列表
 * @param {number} [probeSize=65536] - 探测下载字节数
 * @param {number} [timeoutMs=5000] - 单镜像超时
 * @returns {Promise<string[]>} 按速度降序排列的 URL 列表
 */
async function probeMirrorSpeed(urls, probeSize = 65536, timeoutMs = 5000) {
  if (!urls || urls.length <= 1) return urls;
  // lazy require 以避免与 request.js 的循环依赖
  const { httpGet } = require('./request');
  const probes = urls.map(async (url) => {
    const start = Date.now();
    try {
      const r = await httpGet(url, { start: 0, end: probeSize - 1, timeout: timeoutMs });
      const chunks = [];
      for await (const c of r.stream) chunks.push(c);
      const elapsed = Date.now() - start;
      const bytes = Buffer.concat(chunks).length;
      const speed = elapsed > 0 ? bytes / (elapsed / 1000) : 0;
      return { url, speed, elapsed, ok: true };
    } catch (e) {
      return { url, speed: 0, elapsed: 99999, ok: false };
    }
  });
  const results = await Promise.all(probes);
  results.sort((a, b) => b.speed - a.speed);
  const sorted = results.map((r) => r.url);
  return sorted;
}

/**
 * 获取原始 URL 的第一个镜像（无镜像时返回原始 URL）
 * @param {string} originalUrl - 原始 URL
 * @returns {string} 镜像 URL 或原始 URL
 */
function getMirrorUrl(originalUrl) {
  if (!originalUrl) return originalUrl;
  const urls = getMirrorUrls(originalUrl);
  return urls.length > 1 ? urls[1] : originalUrl;
}

module.exports = {
  _isMirrorAvailable,
  _mirrorFailed,
  _mirrorSuccess,
  getMirrorUrls,
  probeMirrorSpeed,
  probeMirrorsParallel,
  getMirrorUrl
};
