/**
 * @file server/http-client/mirror.js - 镜像源管理
 * @description 镜像熔断（连续失败 3 次暂停 1 分钟）、镜像 URL 选择（BMCLAPI / MCIM / Forge maven）、镜像测速。
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
 * 获取原始 URL 对应的镜像 URL 列表（BMCLAPI / MCIM / Forge maven），原始 URL 始终在末尾
 * @param {string} originalUrl - 原始 URL
 * @returns {string[]} 镜像 URL 列表（含原始 URL）
 */
function getMirrorUrls(originalUrl) {
  if (!originalUrl) return [originalUrl];
  const urls = [];
  let hasBmclapi = false;
  // BMCLAPI 镜像映射
  for (const [original, mirror] of Object.entries(ctx.mirrors.BMCLAPI_MIRROR)) {
    if (originalUrl.startsWith(original)) {
      const mirrored = originalUrl.replace(original, mirror);
      if (mirrored !== originalUrl) {
        urls.push(mirrored);
        hasBmclapi = true;
      }
      break;
    }
  }
  // MCIM 镜像映射
  for (const [original, mirror] of Object.entries(ctx.mirrors.MCIM_MIRROR)) {
    if (originalUrl.startsWith(original)) {
      const mirrored = originalUrl.replace(original, mirror);
      if (mirrored !== originalUrl && !urls.includes(mirrored)) urls.push(mirrored);
      break;
    }
  }
  // libraries.minecraft.net 额外补 Forge maven 与 BMCLAPI maven 镜像
  if (originalUrl.startsWith('https://libraries.minecraft.net/')) {
    const forgeMirror = originalUrl.replace('https://libraries.minecraft.net/', 'https://maven.minecraftforge.net/');
    if (!urls.includes(forgeMirror)) urls.push(forgeMirror);
    const bmclapiMaven = originalUrl.replace('https://libraries.minecraft.net/', 'https://bmclapi2.bangbang93.com/maven/');
    if (!urls.includes(bmclapiMaven)) urls.push(bmclapiMaven);
  }
  urls.push(originalUrl);
  return urls;
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
  getMirrorUrl
};
