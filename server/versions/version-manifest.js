/**
 * @file server/versions/version-manifest.js - 版本清单与详情获取
 * @description 从多个源获取版本清单，顺序由下载源设置决定；回退磁盘缓存。
 */

const { fs, ctx, http } = require('./shared');
const { saveDiskCache } = require('./version-settings');

/**
 * 读取当前下载源设置
 * @returns {string} downloadSource: china-first | auto | official-first | mojang
 */
function _getDownloadSource() {
  try {
    const { loadSettingsCached } = require('../http-client/settings');
    const settings = loadSettingsCached();
    return settings.downloadSource || 'china-first';
  } catch (e) {
    return 'china-first';
  }
}

/**
 * 获取版本清单：根据下载源设置决定请求顺序，并发请求，任一成功即用；全部失败时回退磁盘缓存
 * @param {boolean} forceRefresh - 是否强制刷新缓存
 * @returns {Promise<Object>} 版本清单对象
 * @throws {Error} 所有源失败且无缓存时抛出
 */
async function getVersionManifest(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && ctx.caches.versionCache && (now - ctx.caches.versionCacheTime) < ctx.caches.CACHE_DURATION) {
    return ctx.caches.versionCache;
  }

  const downloadSource = _getDownloadSource();

  const bmclapiUrls = [
    ctx.urls.VERSION_MANIFEST_MIRROR,
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest.json'
  ];
  const officialUrls = [
    ctx.urls.VERSION_MANIFEST_URL
  ];

  let urls;
  if (downloadSource === 'mojang') {
    urls = officialUrls;
  } else if (downloadSource === 'china-first') {
    urls = [...bmclapiUrls, ...officialUrls];
  } else {
    urls = [...officialUrls, ...bmclapiUrls];
  }

  const fetchWithValidation = async (url) => {
    const manifest = await http.fetchJSON(url);
    if (manifest && manifest.versions && manifest.versions.length > 0) {
      return manifest;
    }
    throw new Error('Invalid manifest from ' + url);
  };

  try {
    const manifest = await Promise.any(urls.map((url) =>
      fetchWithValidation(url).catch(() => { throw new Error(url + ' failed'); })
    ));
    ctx.caches.versionCache = manifest;
    ctx.caches.versionCacheTime = now;
    saveDiskCache();
    return manifest;
  } catch (e) {
    console.error('All version manifest sources failed');
  }

  if (!forceRefresh && ctx.caches.versionCache) return ctx.caches.versionCache;

  // 全部源失败时回退磁盘缓存
  try {
    if (fs.existsSync(ctx.dirs.DISK_CACHE_PATH)) {
      const cached = JSON.parse(fs.readFileSync(ctx.dirs.DISK_CACHE_PATH, 'utf8'));
      if (cached && cached.data && cached.data.versions && cached.data.versions.length > 0) {
        ctx.caches.versionCache = cached.data;
        ctx.caches.versionCacheTime = cached.timestamp || 0;
        return ctx.caches.versionCache;
      }
    }
  } catch (e) {}

  throw new Error('无法获取版本列表，请检查网络连接');
}

/**
 * 获取指定版本的详细信息（带 TTL 缓存）
 * @param {string} versionUrl - 版本 JSON 的 URL
 * @returns {Promise<Object>} 版本详情
 * @throws {Error} 请求失败时抛出
 */
async function getVersionDetails(versionUrl) {
  const cachedTime = ctx.caches.versionDetailsCacheTime[versionUrl];
  if (ctx.caches.versionDetailsCache[versionUrl] && cachedTime && (Date.now() - cachedTime < ctx.caches.VERSION_DETAILS_CACHE_TTL)) {
    return ctx.caches.versionDetailsCache[versionUrl];
  }
  try {
    const details = await http.fetchJSON(versionUrl);
    ctx.caches.versionDetailsCache[versionUrl] = details;
    ctx.caches.versionDetailsCacheTime[versionUrl] = Date.now();
    return details;
  } catch (e) {
    console.error('Failed to fetch version details:', e.message);
    throw e;
  }
}

module.exports = {
  getVersionManifest,
  getVersionDetails
};
