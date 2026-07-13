/**
 * @file server/versions/version-dir.js - 版本运行目录、隔离设置解析
 * @description 含版本游戏目录、mods/子目录解析、版本隔离判定、外部版本目录解析。
 */

const { fs, path, ctx } = require('./shared');
const { getInstalledVersions } = require('./version-list');
const { loadSettingsCached, loadVersionSettings } = require('./version-settings');

/**
 * 解析外部版本的实际版本目录路径
 * @param {string} versionId - 版本 ID（可能带 " [外部N]" 后缀）
 * @returns {string|null} 外部版本目录绝对路径，非外部版本返回 null
 */
function resolveExternalVersionDir(versionId) {
  if (!versionId) return null;
  const installed = getInstalledVersions();
  if (versionId.includes('[外部')) {
    const ext = installed.find((v) => v.id === versionId && v.isExternal);
    if (ext && ext.externalVersionDir) return ext.externalVersionDir;
    const cleanId = versionId.replace(/\s*\[外部\d*\]/, '');
    const ext2 = installed.find((v) => v.id === cleanId && v.isExternal);
    if (ext2 && ext2.externalVersionDir) return ext2.externalVersionDir;
  }
  const ext3 = installed.find((v) => v.id === versionId && v.isExternal && v.externalVersionDir);
  if (ext3) return ext3.externalVersionDir;
  return null;
}

/**
 * 解析版本的隔离设置：版本级 > 全局；关闭时若版本目录已有 mods/saves，则自动开启隔离
 * @param {string} versionId - 版本 ID
 * @returns {boolean} 是否启用版本隔离
 */
function resolveVersionIsolation(versionId) {
  if (!versionId || versionId.includes(' [外部')) return !!versionId;

  const settings = loadSettingsCached();
  const verSettings = loadVersionSettings(versionId);

  let effectiveIsolation;
  if (verSettings.isolation === 'on') {
    effectiveIsolation = true;
  } else if (verSettings.isolation === 'off') {
    effectiveIsolation = false;
  } else {
    effectiveIsolation = settings.versionIsolation !== false;
  }

  // 关闭隔离时，若版本目录里已有 mods 文件或 saves 子目录，则保留隔离避免数据混淆
  if (!effectiveIsolation) {
    const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    const modsDir = path.join(versionDir, 'mods');
    const savesDir = path.join(versionDir, 'saves');
    const modsHasFiles = fs.existsSync(modsDir) && fs.readdirSync(modsDir).some((f) => !f.startsWith('.'));
    const savesHasDirs = fs.existsSync(savesDir) && fs.readdirSync(savesDir).some((f) => {
      try { return fs.statSync(path.join(savesDir, f)).isDirectory(); } catch { return false; }
    });
    if (modsHasFiles || savesHasDirs) {
      effectiveIsolation = true;
    }
  }

  return effectiveIsolation;
}

/**
 * 获取版本运行时的游戏目录：外部版本 > 隔离目录 > 全局 gameDir
 * @param {string} [versionId] - 版本 ID，未传则使用全局选中版本
 * @returns {string|null} 游戏目录绝对路径
 */
function getVersionGameDir(versionId) {
  if (!versionId) {
    const settings = loadSettingsCached();
    versionId = settings.selectedVersion || '';
  }
  if (!versionId) return null;

  const extDir = resolveExternalVersionDir(versionId);
  if (extDir) return extDir;

  if (resolveVersionIsolation(versionId)) {
    return path.join(ctx.dirs.VERSIONS_DIR, versionId);
  }

  const settings = loadSettingsCached();
  return settings.gameDir || ctx.dirs.DATA_DIR;
}

/**
 * 获取版本 mods 目录
 * @param {string} versionId - 版本 ID
 * @returns {string|null} mods 目录绝对路径
 */
function getVersionModsDir(versionId) {
  const baseDir = getVersionGameDir(versionId);
  if (!baseDir) return null;
  return path.join(baseDir, 'mods');
}

/**
 * 获取版本指定子目录（如 saves、resourcepacks）
 * @param {string} versionId - 版本 ID
 * @param {string} subfolder - 子目录名
 * @returns {string|null} 子目录绝对路径
 */
function getVersionSubDir(versionId, subfolder) {
  const baseDir = getVersionGameDir(versionId);
  if (!baseDir) return null;
  return path.join(baseDir, subfolder);
}

module.exports = {
  resolveExternalVersionDir,
  resolveVersionIsolation,
  getVersionGameDir,
  getVersionModsDir,
  getVersionSubDir
};
