/**
 * @file server/api/routes/mods/mod-manage.js
 * @description 模组启用/禁用、删除、更新检查、安装、移除相关路由
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractDeps } = require('./shared');

module.exports = {
  /**
   * 注册模组管理相关路由
   * @param {Function} registerRoute - 路由注册函数
   * @param {Object} deps - 依赖对象
   * @returns {void}
   */
  register(registerRoute, deps) {
    const {
      sendJSON, sendError, readBody, mods, versions,
      DATA_DIR
    } = extractDeps(deps);

    /* /api/mods/toggle - 启用/禁用模组（重命名 .disabled 后缀） */
    registerRoute('POST', '/api/mods/toggle', async (req, res, parsedUrl) => {
      const data = await readBody(req);
      const modId = data.modId;
      const enabled = data.enabled;
      const verId = data.versionId;
      if (!modId) { sendError(res, 'Missing modId', 400); return; }
      let modsPath = verId ? versions.getVersionModsDir(verId) : null;
      if (!modsPath) {
        const settings = versions.loadSettingsCached();
        modsPath = versions.getVersionModsDir(settings.selectedVersion);
      }
      if (!modsPath) {
        const installedVersions = versions.getInstalledVersions();
        if (installedVersions.length > 0) modsPath = versions.getVersionModsDir(installedVersions[0].id);
        if (!modsPath) { sendError(res, '请先安装一个游戏版本'); return; }
      }
      if (!fs.existsSync(modsPath)) { sendError(res, 'mods文件夹不存在'); return; }

      const baseName = modId.endsWith('.disabled') ? modId.replace(/\.disabled$/, '') : modId;
      const cleanPath = path.join(modsPath, baseName);
      const disabledPath = path.join(modsPath, baseName + '.disabled');

      try {
        if (enabled) {
          if (fs.existsSync(disabledPath)) {
            fs.renameSync(disabledPath, cleanPath);
          } else if (fs.existsSync(cleanPath)) {
            // 已启用，无需操作
          }
        } else {
          if (fs.existsSync(cleanPath)) {
            fs.renameSync(cleanPath, disabledPath);
          }
        }
      } catch (e) {
        sendError(res, `文件操作失败: ${e.message}`);
        return;
      }
      sendJSON(res, { success: true, enabled });
    });

    /* /api/mods/delete - 删除模组（在多个可能目录中搜索匹配文件） */
    registerRoute('POST', '/api/mods/delete', async (req, res, parsedUrl) => {
      const data = await readBody(req);
      const modId = data.modId;
      if (!modId) { sendError(res, 'Missing modId', 400); return; }
      const settings = versions.loadSettingsCached();
      let modsPath = versions.getVersionModsDir(settings.selectedVersion);
      if (!modsPath) {
        const installedVersions = versions.getInstalledVersions();
        if (installedVersions.length > 0) modsPath = versions.getVersionModsDir(installedVersions[0].id);
      }
      // 非隔离版本需搜索共享目录与 .minecraft/mods
      const searchDirs = [modsPath];
      if (modsPath && !versions.resolveVersionIsolation(settings.selectedVersion)) {
        const sharedGameDir = settings.gameDir || DATA_DIR;
        const sharedModsDir = path.join(sharedGameDir, 'mods');
        if (sharedModsDir !== modsPath) searchDirs.push(sharedModsDir);
        const homeMinecraftMods = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', 'mods');
        if (homeMinecraftMods !== modsPath && homeMinecraftMods !== sharedModsDir) searchDirs.push(homeMinecraftMods);
      }
      let deletedCount = 0;
      for (const dir of searchDirs) {
        if (!dir || !fs.existsSync(dir)) continue;
        const modFiles = fs.readdirSync(dir).filter((f) => {
          const base = f.toLowerCase().replace('.disabled', '');
          return base.includes(modId.toLowerCase());
        });
        modFiles.forEach((f) => { try { fs.unlinkSync(path.join(dir, f)); deletedCount++; } catch (_) {} });
      }
      sendJSON(res, { success: true, message: `已删除 ${deletedCount} 个文件`, deleted: deletedCount });
    });

    /* /api/mods/check-updates - 检查模组更新 */
    registerRoute('POST', '/api/mods/check-updates', async (req, res, parsedUrl) => {
      const cuData = await readBody(req);
      const cuVersionId = cuData.versionId;
      if (!cuVersionId) { sendError(res, 'Missing versionId', 400); return; }
      try {
        const result = await mods.checkModUpdates(cuVersionId);
        sendJSON(res, result);
      } catch (e) { sendJSON(res, { updates: [], error: e.message }); }
    });

    /* /api/mods/install-from-file - 从本地文件安装模组到指定版本 */
    registerRoute('POST', '/api/mods/install-from-file', async (req, res, parsedUrl) => {
      const mifData = await readBody(req);
      const { versionId, filePath: mifFilePath } = mifData;
      if (!versionId || !mifFilePath) { sendError(res, 'Missing params', 400); return; }
      try {
        const modsDir = versions.getVersionSubDir(versionId, 'mods');
        if (!modsDir) { sendError(res, '无法确定模组目录'); return; }
        if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
        const destPath = path.join(modsDir, path.basename(mifFilePath));
        fs.copyFileSync(mifFilePath, destPath);
        sendJSON(res, { success: true });
      } catch (e) { sendJSON(res, { success: false, error: e.message }); }
    });

    /* /api/mods/remove - 删除指定版本的指定模组文件 */
    registerRoute('POST', '/api/mods/remove', async (req, res, parsedUrl) => {
      const body7 = await readBody(req);
      const { versionId: rmVerId, fileName: rmFile } = body7;
      if (!rmVerId || !rmFile) { sendError(res, 'Missing params', 400); return; }
      // 路径安全校验：禁止目录穿越
      if (rmFile.includes('..') || rmFile.includes('/') || rmFile.includes('\\')) { sendError(res, 'Invalid fileName', 400); return; }
      try {
        const modsDir = versions.getVersionModsDir(rmVerId);
        if (!modsDir) { sendError(res, '无法确定模组目录', 400); return; }
        const rmFilePath = path.resolve(path.join(modsDir, rmFile));
        if (!rmFilePath.startsWith(path.resolve(modsDir))) { sendError(res, 'Invalid path', 400); return; }
        if (fs.existsSync(rmFilePath)) { fs.unlinkSync(rmFilePath); }
        sendJSON(res, { success: true });
      } catch (e) { sendJSON(res, { success: false, error: e.message }); }
    });
  }
};
