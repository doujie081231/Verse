/**
 * @file server/api/routes/mods/shared.js
 * @description 模组路由共享依赖与常量提取
 */

/**
 * 从 deps 中提取模组路由共用的依赖与常量
 * @param {Object} deps - 依赖对象（ctx/sendJSON/sendError/readBody/mods/modpack/accounts/utils/http/versions）
 * @returns {Object} 包含解构后的依赖与派生常量的对象
 */
function extractDeps(deps) {
  const { ctx, sendJSON, sendError, readBody } = deps;
  const { mods, modpack, accounts, utils, http, versions } = deps;

  const MODRINTH_API = ctx.urls.MODRINTH_API;
  const CURSEFORGE_API = ctx.urls.CURSEFORGE_API;
  const ICON_CACHE_DIR = ctx.dirs.ICON_CACHE_DIR;
  const DATA_DIR = ctx.dirs.DATA_DIR;
  const modDownloadSessions = ctx.sessions.modDownloadSessions;

  return {
    ctx, sendJSON, sendError, readBody,
    mods, modpack, accounts, utils, http, versions,
    MODRINTH_API, CURSEFORGE_API, ICON_CACHE_DIR, DATA_DIR,
    modDownloadSessions
  };
}

module.exports = { extractDeps };
