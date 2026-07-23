/**
 * server/modpack/dep-completion.js - 整合包依赖 mod 自动补全
 * ============================================================================
 * 整合包导入后扫描所有已安装 mod 的 fabric.mod.json / mods.toml 中的 depends 字段，
 * 对比已安装 mod 列表，发现缺失的前置依赖时自动从 Modrinth 下载。
 * 解决整合包作者漏写依赖 mod 导致游戏启动崩溃的问题。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ctx = require('../context');
const utils = require('../utils');
const http = require('../http-client');
const logger = require('../logger').createLogger('DepCompletion');

let AdmZip;
try { AdmZip = require('adm-zip'); } catch (_) {}

// 这些是加载器/平台自身的依赖声明，不需要补全
const SKIP_DEP_IDS = new Set([
  'fabricloader', 'fabric-loader', 'minecraft', 'forge', 'neoforge',
  'java', 'fabric-language-kotlin', 'fabric_api', 'fabric-api',
  'quilt_loader', 'quiltloader'
]);

/**
 * 从 JAR 文件中解析 mod 元数据和依赖声明
 * @param {string} jarPath - JAR 文件路径
 * @returns {{id:string, depends:string[]}|null}
 */
function parseModDependencies(jarPath) {
  if (!AdmZip) return null;
  try {
    const zip = new AdmZip(jarPath);
    // 优先读 fabric.mod.json
    const fabricEntry = zip.getEntry('fabric.mod.json');
    if (fabricEntry) {
      const meta = JSON.parse(fabricEntry.getData().toString('utf8'));
      const id = (meta.id || '').toLowerCase();
      const depends = meta.depends || {};
      const depIds = Object.keys(depends).map(k => k.toLowerCase());
      return { id, depends: depIds };
    }
    // quilt.mod.json
    const quiltEntry = zip.getEntry('quilt.mod.json');
    if (quiltEntry) {
      const meta = JSON.parse(quiltEntry.getData().toString('utf8'));
      const id = (meta.quilt_loader?.id || '').toLowerCase();
      const depends = meta.quilt_loader?.depends || {};
      const depIds = Object.keys(depends).map(k => k.toLowerCase());
      return { id, depends: depIds };
    }
    // mods.toml (Forge)
    const modsTomlEntry = zip.getEntry('META-INF/mods.toml');
    if (modsTomlEntry) {
      const tomlText = modsTomlEntry.getData().toString('utf8');
      // 提取 modId
      const modIdMatch = tomlText.match(/modId\s*=\s*"([^"]+)"/);
      const id = modIdMatch ? modIdMatch[1].toLowerCase() : '';
      // 提取 [[dependencies.xxx]] 段中的 modId
      const depIds = [];
      const depBlocks = tomlText.split(/\[\[dependencies\.[^\]]+\]\]/);
      for (let i = 1; i < depBlocks.length; i++) {
        const block = depBlocks[i];
        // 只处理必选依赖
        if (/mandatory\s*=\s*true/i.test(block)) {
          const depModIdMatch = block.match(/modId\s*=\s*"([^"]+)"/);
          if (depModIdMatch) {
            depIds.push(depModIdMatch[1].toLowerCase());
          }
        }
      }
      return { id, depends: depIds };
    }
    // neoforge.mods.toml
    const neoTomlEntry = zip.getEntry('META-INF/neoforge.mods.toml');
    if (neoTomlEntry) {
      const tomlText = neoTomlEntry.getData().toString('utf8');
      const modIdMatch = tomlText.match(/modId\s*=\s*"([^"]+)"/);
      const id = modIdMatch ? modIdMatch[1].toLowerCase() : '';
      const depIds = [];
      const depBlocks = tomlText.split(/\[\[dependencies\.[^\]]+\]\]/);
      for (let i = 1; i < depBlocks.length; i++) {
        const block = depBlocks[i];
        if (/mandatory\s*=\s*true/i.test(block)) {
          const depModIdMatch = block.match(/modId\s*=\s*"([^"]+)"/);
          if (depModIdMatch) {
            depIds.push(depModIdMatch[1].toLowerCase());
          }
        }
      }
      return { id, depends: depIds };
    }
  } catch (e) {
    // 解析失败静默跳过
  }
  return null;
}

/**
 * 通过 Modrinth search API 查找 mod 项目 ID
 * @param {string} modId - mod 的 ID（fabric.mod.json 中的 id）
 * @returns {Promise<string|null>} Modrinth project ID
 */
async function searchModrinthProject(modId) {
  try {
    const searchUrl = `${ctx.urls.MODRINTH_API}/search?query=${encodeURIComponent(modId)}&facets=%5B%5B%22project_type:mod%22%5D%5D`;
    const result = await http.cachedFetchJSON(searchUrl);
    if (result && result.hits && result.hits.length > 0) {
      // 优先精确匹配 slug
      const exact = result.hits.find(h => h.slug && h.slug.toLowerCase() === modId);
      if (exact) return exact.project_id;
      // 其次匹配 project_id
      const idMatch = result.hits.find(h => h.project_id && h.project_id.toLowerCase() === modId);
      if (idMatch) return idMatch.project_id;
      // 取第一个结果
      return result.hits[0].project_id;
    }
  } catch (e) {
    logger.warn(`Modrinth 搜索失败: ${modId} - ${e.message}`);
  }
  return null;
}

/**
 * 查询 mod 的兼容版本并下载
 * @param {string} projectId - Modrinth project ID
 * @param {string} mcVersion - Minecraft 版本
 * @param {string} loader - 加载器 (forge/fabric/neoforge)
 * @param {string} modsDir - mods 目录
 * @returns {Promise<boolean>} 是否下载成功
 */
async function downloadMissingDep(projectId, mcVersion, loader, modsDir) {
  try {
    // 三策略查询版本
    const queries = [
      `game_versions=%5B%22${mcVersion}%22%5D&loaders=%5B%22${loader}%22%5D`,
      `game_versions=%5B%22${mcVersion}%22%5D`,
      ''
    ];

    let versionData = null;
    for (const q of queries) {
      try {
        const url = `${ctx.urls.MODRINTH_API}/project/${projectId}/version${q ? '?' + q : ''}`;
        const versions = await http.cachedFetchJSON(url);
        if (versions && versions.length > 0) {
          // 优先找匹配 loader 的版本
          if (loader) {
            const loaderMatch = versions.find(v => (v.loaders || []).includes(loader));
            versionData = loaderMatch || versions[0];
          } else {
            versionData = versions[0];
          }
          if (versionData) break;
        }
      } catch (_) {}
    }

    if (!versionData || !versionData.files || versionData.files.length === 0) {
      return false;
    }

    const file = versionData.files.find(f => f.primary) || versionData.files[0];
    const destPath = path.join(modsDir, file.filename);

    // 检查是否已存在
    if (fs.existsSync(destPath)) {
      return true;
    }

    logger.info(`下载缺失依赖: ${file.filename} (${Math.round((file.size || 0) / 1024)}KB)`);

    // 下载：走镜像（MCIM 镜像会自动替换 cdn.modrinth.com），与资源页面下载一致
    await http.downloadFileWithMirror(file.url, destPath, null, 2, null, 120000);

    // 校验
    if (utils.isJarIntact(destPath)) {
      return true;
    }
    try { fs.unlinkSync(destPath); } catch (_) {}
    return false;
  } catch (e) {
    logger.warn(`下载缺失依赖失败 ${projectId}: ${e.message}`);
    return false;
  }
}

/**
 * 整合包依赖 mod 自动补全
 * 扫描所有已安装 mod 的依赖声明，发现缺失的前置依赖时自动从 Modrinth 下载
 * @param {string} versionDir - 版本目录
 * @param {string} mcVersion - Minecraft 版本
 * @param {string} loader - 加载器类型 (forge/fabric/neoforge)
 * @param {object} settings - 设置
 * @param {function} [progress] - 进度回调
 * @returns {Promise<{scanned:number, downloaded:number, skipped:number, failed:number, failedDeps:string[]}>}
 */
async function completeModpackDependencies(versionDir, mcVersion, loader, settings, progress) {
  const modsDir = path.join(versionDir, 'mods');
  if (!fs.existsSync(modsDir)) {
    return { scanned: 0, downloaded: 0, skipped: 0, failed: 0, failedDeps: [] };
  }

  const jarFiles = fs.readdirSync(modsDir).filter(f =>
    f.toLowerCase().endsWith('.jar') && !f.endsWith('.disabled')
  );

  if (jarFiles.length === 0) {
    return { scanned: 0, downloaded: 0, skipped: 0, failed: 0, failedDeps: [] };
  }

  logger.info(`扫描 ${jarFiles.length} 个 mod 的依赖声明...`);
  if (progress) progress('deps', `扫描 mod 依赖关系 (0/${jarFiles.length})`, 95, [], '');

  // 第一步：解析所有 JAR 的 mod ID 和依赖声明
  const installedModIds = new Set();
  const requiredDeps = new Map(); // depId -> Set<来源 mod 名>

  for (let i = 0; i < jarFiles.length; i++) {
    const jarPath = path.join(modsDir, jarFiles[i]);
    const meta = parseModDependencies(jarPath);
    if (meta) {
      if (meta.id) {
        installedModIds.add(meta.id);
      }
      for (const depId of meta.depends) {
        if (SKIP_DEP_IDS.has(depId)) continue;
        if (!requiredDeps.has(depId)) {
          requiredDeps.set(depId, new Set());
        }
        requiredDeps.get(depId).add(meta.id || jarFiles[i]);
      }
    }
    if (progress && (i + 1) % 20 === 0) {
      progress('deps', `扫描 mod 依赖关系 (${i + 1}/${jarFiles.length})`, 95, [], '');
    }
  }

  logger.info(`已安装 mod: ${installedModIds.size} 个，声明的依赖: ${requiredDeps.size} 个`);

  // 第二步：找出缺失的依赖
  const missingDeps = [];
  for (const [depId, sources] of requiredDeps) {
    if (!installedModIds.has(depId)) {
      missingDeps.push({ id: depId, sources: [...sources] });
    }
  }

  if (missingDeps.length === 0) {
    logger.info('所有依赖均已安装，无需补全');
    return { scanned: jarFiles.length, downloaded: 0, skipped: 0, failed: 0, failedDeps: [] };
  }

  logger.info(`发现 ${missingDeps.length} 个缺失依赖，尝试自动补全...`);
  if (progress) progress('deps', `发现 ${missingDeps.length} 个缺失依赖，正在补全...`, 96, [], '');

  // 第三步：通过 Modrinth 搜索并下载缺失依赖
  let downloaded = 0;
  let failed = 0;
  const failedDeps = [];

  for (let i = 0; i < missingDeps.length; i++) {
    const dep = missingDeps[i];
    logger.info(`[${i + 1}/${missingDeps.length}] 查找缺失依赖: ${dep.id} (被 ${dep.sources.join(', ')} 依赖)`);

    const projectId = await searchModrinthProject(dep.id);
    if (!projectId) {
      logger.warn(`Modrinth 未找到 mod: ${dep.id}`);
      failedDeps.push(dep.id);
      failed++;
      continue;
    }

    const success = await downloadMissingDep(projectId, mcVersion, loader, modsDir);
    if (success) {
      downloaded++;
      logger.info(`成功补全依赖: ${dep.id}`);
    } else {
      failed++;
      failedDeps.push(dep.id);
      logger.warn(`补全依赖失败: ${dep.id}`);
    }

    if (progress) {
      progress('deps', `补全缺失依赖 (${i + 1}/${missingDeps.length})`, 96, [], '');
    }
  }

  logger.info(`依赖补全完成: ${downloaded} 下载成功, ${failed} 失败`);
  return {
    scanned: jarFiles.length,
    downloaded,
    skipped: 0,
    failed,
    failedDeps
  };
}

module.exports = {
  completeModpackDependencies,
  parseModDependencies
};
