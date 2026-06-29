/**
 * @file server/modloaders/fabric.js - Fabric 加载器安装
 * @description 从 server/modloaders.js 拆分而来。包含 Fabric 安装、合并到版本 JSON、
 *   Fabric 版本列表获取、指定 MC 版本的 Fabric 版本列表获取、Fabric API 自动下载等功能。
 */
const fs = require('fs');
const path = require('path');

const ctx = require('../context');
const utils = require('../utils');
const http = require('../http-client');
const versions = require('../versions');

const { ensureBaseVersionInstalled } = require('./shared');

/* Fabric 安装 */

/**
 * 安装 Fabric 模组加载器
 * @param {string} gameVersion - Minecraft 版本号
 * @param {string} loaderVersion - Fabric Loader 版本号
 * @param {Function|null} onProgress - 进度回调 (percent, message)
 * @returns {Promise<{success: boolean, versionId?: string, error?: string, libsMissing?: number}>}
 */
async function installFabric(gameVersion, loaderVersion, onProgress = null) {
  const versionId = `fabric-loader-${loaderVersion}-${gameVersion}`;

  try {
    const baseResult = await ensureBaseVersionInstalled(gameVersion);
    if (baseResult.error) {
      return { success: false, error: baseResult.error };
    }

    // 优先尝试 profile/json 端点（包含完整版本配置）
    const profileJsonUrl = `${ctx.urls.FABRIC_META_URL}/versions/loader/${gameVersion}/${loaderVersion}/profile/json`;
    const baseMetaUrl = `${ctx.urls.FABRIC_META_URL}/versions/loader/${gameVersion}/${loaderVersion}`;
    console.log(`[Fabric] Fetching profile/json from: ${profileJsonUrl}`);

    let fullProfile = null;
    try {
      fullProfile = await http.fetchJSON(profileJsonUrl);
      fullProfile.id = versionId;
      fullProfile.inheritsFrom = gameVersion;
      if (!fullProfile.time) fullProfile.time = fullProfile.releaseTime || new Date().toISOString();
      console.log(`[Fabric] profile/json returned ${fullProfile.libraries?.length || 0} libraries`);
    } catch (profileErr) {
      console.warn(`[Fabric] profile/json failed (${profileErr.message}), falling back to base endpoint`);
    }

    // profile/json 失败时回退到基础端点，手动构造版本配置
    if (!fullProfile || !fullProfile.libraries || fullProfile.libraries.length === 0) {
      console.log(`[Fabric] Falling back to base endpoint: ${baseMetaUrl}`);
      const profileData = await http.fetchJSON(baseMetaUrl);
      console.log(`[Fabric] Profile data keys: ${Object.keys(profileData).join(', ')}`);

      fullProfile = {
        id: versionId,
        inheritsFrom: gameVersion,
        mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
        type: 'release',
        time: new Date().toISOString(),
        libraries: [],
        arguments: { game: [], jvm: [] }
      };

      // 从 launcherMeta 提取库列表（common + client）
      if (profileData.launcherMeta) {
        const launcherMeta = profileData.launcherMeta;
        if (launcherMeta.libraries) {
          const common = launcherMeta.libraries.common || [];
          const client = launcherMeta.libraries.client || [];
          fullProfile.libraries = [...common, ...client];
          console.log(`[Fabric] Libraries from launcherMeta: ${fullProfile.libraries.length}`);
        }
        if (launcherMeta.mainClass) {
          const metaMainClass = typeof launcherMeta.mainClass === 'string'
            ? launcherMeta.mainClass
            : launcherMeta.mainClass?.client;
          if (metaMainClass && metaMainClass.includes('fabricmc')) {
            fullProfile.mainClass = metaMainClass;
          }
        }
      }

      if (profileData.loader?.mainClass) {
        fullProfile.mainClass = profileData.loader.mainClass;
      }
      if (profileData.mainClass) {
        if (typeof profileData.mainClass === 'string') {
          fullProfile.mainClass = profileData.mainClass;
        } else if (profileData.mainClass.client) {
          fullProfile.mainClass = profileData.mainClass.client;
        }
      }

      // 添加 fabric-loader 主库
      if (profileData.loader?.maven) {
        const loaderParts = profileData.loader.maven.split(':');
        if (loaderParts.length >= 3) {
          fullProfile.libraries.push({
            name: profileData.loader.maven,
            url: 'https://maven.fabricmc.net/'
          });
          console.log(`[Fabric] Added fabric-loader library: ${profileData.loader.maven}`);
        }
      }
      // 添加 intermediary 中间映射库
      if (profileData.intermediary?.maven) {
        const interParts = profileData.intermediary.maven.split(':');
        if (interParts.length >= 3) {
          fullProfile.libraries.push({
            name: profileData.intermediary.maven,
            url: 'https://maven.fabricmc.net/'
          });
          console.log(`[Fabric] Added intermediary library: ${profileData.intermediary.maven}`);
        }
      }

      // 合并启动参数
      if (profileData.arguments) {
        for (const key of Object.keys(profileData.arguments)) {
          if (Array.isArray(profileData.arguments[key])) {
            fullProfile.arguments[key] = profileData.arguments[key];
          }
        }
      }
      if (profileData.launcherMeta?.arguments) {
        for (const key of Object.keys(profileData.launcherMeta.arguments)) {
          if (Array.isArray(profileData.launcherMeta.arguments[key])) {
            fullProfile.arguments[key] = profileData.launcherMeta.arguments[key];
          }
        }
      }
    }

    const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

    console.log(`[Fabric] Final mainClass: ${fullProfile.mainClass}`);
    console.log(`[Fabric] Final libraries count: ${fullProfile.libraries.length}`);

    // 收集需要下载的 Fabric 库文件
    const fabLibsToDownload = [];
    for (const lib of fullProfile.libraries) {
      if (lib.downloads?.artifact?.url) {
        const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
        if (!utils.isJarIntact(libPath)) {
          fabLibsToDownload.push({ lib, url: lib.downloads.artifact.url, libPath });
        }
      } else if (lib.name) {
        // 处理仅有 maven 坐标的库：构造下载 URL 与备用源
        const parts = lib.name.split(':');
        if (parts.length >= 3) {
          const mavenGroupPath = parts[0].replace(/\./g, '/');
          const name = parts[1];
          const ver = parts[2];
          const classifier = parts.length >= 4 ? parts[3] : '';
          const jarName = classifier ? `${name}-${ver}-${classifier}.jar` : `${name}-${ver}.jar`;
          const localGroupPath = parts[0].replace(/\./g, path.sep);
          const libPath = path.join(ctx.dirs.LIBRARIES_DIR, localGroupPath, name, ver, jarName);

          if (!lib.downloads) lib.downloads = {};
          if (!lib.downloads.artifact) {
            lib.downloads.artifact = {
              path: `${mavenGroupPath}/${name}/${ver}/${jarName}`,
              sha1: '', size: 0, url: ''
            };
          }

          if (!utils.isJarIntact(libPath)) {
            const mavenBaseUrl = lib.url || 'https://maven.fabricmc.net/';
            const downloadUrl = `${mavenBaseUrl}${mavenGroupPath}/${name}/${ver}/${jarName}`;
            // 构造备用下载源（Maven Central 与 Fabric Maven）
            const altUrls = [];
            if (mavenBaseUrl !== 'https://repo1.maven.org/maven2/') {
              altUrls.push(`https://repo1.maven.org/maven2/${mavenGroupPath}/${name}/${ver}/${jarName}`);
            }
            if (mavenBaseUrl !== 'https://maven.fabricmc.net/') {
              altUrls.push(`https://maven.fabricmc.net/${mavenGroupPath}/${name}/${ver}/${jarName}`);
            }
            fabLibsToDownload.push({ lib, url: downloadUrl, libPath, altUrls });
          }
        }
      }
    }

    // 并发下载 Fabric 库文件，支持 SHA1 校验与多源重试
    let fabLibFailures = 0;
    if (fabLibsToDownload.length > 0) {
      const settings = versions.loadSettingsCached();
      const FAB_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, fabLibsToDownload.length);
      let completed = 0;
      let failed = 0;
      let active = 0;
      let done = null;

      const scheduleNext = () => {
        while (active < FAB_PARALLEL && completed + failed + active < fabLibsToDownload.length) {
          const item = fabLibsToDownload[completed + failed + active];
          active++;
          (async () => {
            const expectedSha1 = item.lib.downloads?.artifact?.sha1 || '';
            const expectedSize = item.lib.downloads?.artifact?.size || 0;
            // 已存在文件先校验，避免重复下载
            if (fs.existsSync(item.libPath)) {
              const stat = fs.statSync(item.libPath);
              if (stat.size > 0 && (!expectedSize || stat.size === expectedSize)) {
                if (!expectedSha1) {
                  completed++;
                  return;
                }
                try {
                  const actual = await utils.calculateSHA1(item.libPath);
                  if (actual === expectedSha1) { completed++; return; }
                } catch (_) {}
              }
              try { fs.unlinkSync(item.libPath); } catch (_) {}
            }
            // 依次尝试主 URL 与备用 URL
            const urlsToTry = [item.url, ...(item.altUrls || [])];
            let downloaded = false;
            for (const tryUrl of urlsToTry) {
              try {
                await http.downloadFileWithMirror(tryUrl, item.libPath);
                if (expectedSha1) {
                  const actual = await utils.calculateSHA1(item.libPath);
                  if (actual !== expectedSha1) {
                    try { fs.unlinkSync(item.libPath); } catch (_) {}
                    continue;
                  }
                }
                downloaded = true;
                break;
              } catch (e) {
                console.warn(`[Fabric] 下载失败 ${tryUrl}: ${e.message}`);
                try { if (fs.existsSync(item.libPath)) fs.unlinkSync(item.libPath); } catch (_) {}
              }
            }
            if (!downloaded) {
              throw new Error(`所有下载源失败: ${path.basename(item.libPath)}`);
            }
          })().then(() => {
            completed++;
          }).catch((e) => {
            fabLibFailures++;
            console.log(`[Fabric] Failed to download ${item.lib.name}: ${e.message}`);
            failed++;
          }).finally(() => {
            active--;
            if (onProgress) {
              onProgress((completed + failed) / fabLibsToDownload.length, `下载Fabric库 (${completed + failed}/${fabLibsToDownload.length})...`);
            }
            if (active === 0 && completed + failed >= fabLibsToDownload.length && done) done();
            else if (active < FAB_PARALLEL && completed + failed + active < fabLibsToDownload.length) scheduleNext();
          });
        }
      };

      await new Promise((resolve) => { done = resolve; scheduleNext(); });
    }

    // 检查 fabric-loader 核心库是否存在
    const fabCoreLibs = [];
    const fabMainLib = fullProfile.libraries.find((l) => l.name && l.name.startsWith('net.fabricmc:fabric-loader:'));
    if (fabMainLib) {
      const fp = fabMainLib.name.split(':');
      const fj = `${fp[1]}-${fp[2]}.jar`;
      fabCoreLibs.push(path.join(ctx.dirs.LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2], fj));
    }
    const fabMissing = fabCoreLibs.filter((f) => !fs.existsSync(f));
    if (fabMissing.length > 0) {
      console.warn(`[Fabric] 核心库文件暂缺 (${fabMissing.length}个): ${fabMissing.join(', ')}, 将由安装后验证补全`);
    }

    const jsonPath = path.join(versionDir, `${versionId}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(fullProfile, null, 2));

    console.log(`[Fabric] Installation complete: ${versionId}`);
    return { success: true, versionId: versionId, libsMissing: fabMissing.length };
  } catch (e) {
    console.error(`[Fabric] Installation failed: ${e.message}`);
    // 失败时清理已创建的版本目录
    try {
      const versionDir = path.join(ctx.dirs.VERSIONS_DIR, `fabric-loader-${loaderVersion}-${gameVersion}`);
      if (fs.existsSync(versionDir)) {
        fs.rmSync(versionDir, { recursive: true, force: true });
        console.log(`[Fabric] Cleaned up failed version directory: ${versionDir}`);
      }
    } catch (cleanupErr) {
      console.error(`[Fabric] Failed to cleanup version directory:`, cleanupErr.message);
    }
    return { success: false, error: e.message };
  }
}

/**
 * 将 Fabric 加载器合并到现有版本 JSON
 * @param {string} versionId - 目标版本 ID
 * @param {string} gameVersion - Minecraft 版本号
 * @param {string} loaderVersion - Fabric Loader 版本号
 * @param {Function|null} onProgress - 进度回调 (percent, message)
 * @returns {Promise<void>}
 * @throws {Error} 下载或合并失败时抛出
 */
async function mergeFabricLoaderToVersion(versionId, gameVersion, loaderVersion, onProgress = null) {
  const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
  const jsonPath = path.join(versionDir, `${versionId}.json`);

  // 获取 Fabric Loader 的 profile 数据，主源失败时回退到 BMCLAPI 镜像
  const metaUrl = `${ctx.urls.FABRIC_META_URL}/versions/loader/${gameVersion}/${loaderVersion}`;
  console.log(`[Fabric] Fetching profile for merge: ${metaUrl}`);
  let profileData;
  try {
    profileData = await http.fetchJSON(metaUrl);
  } catch (e) {
    const mirrorMetaUrl = `https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/${gameVersion}/${loaderVersion}`;
    console.log(`[Fabric] Retrying with mirror: ${mirrorMetaUrl}`);
    profileData = await http.fetchJSON(mirrorMetaUrl);
  }

  const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  // 从 launcherMeta 合并主类与库列表
  if (profileData.launcherMeta) {
    const launcherMeta = profileData.launcherMeta;
    if (launcherMeta.mainClass) {
      versionJson.mainClass = typeof launcherMeta.mainClass === 'string'
        ? launcherMeta.mainClass
        : (launcherMeta.mainClass.client || versionJson.mainClass);
    }
    if (launcherMeta.libraries) {
      const common = launcherMeta.libraries.common || [];
      const client = launcherMeta.libraries.client || [];
      const fabricLibs = [...common, ...client];
      // 为缺少 downloads.artifact.path 的库构造完整的下载信息
      for (const lib of fabricLibs) {
        if (!lib.downloads || !lib.downloads.artifact || !lib.downloads.artifact.path) {
          if (lib.name) {
            const parts = lib.name.split(':');
            if (parts.length >= 3) {
              const groupPath = parts[0].replace(/\./g, '/');
              const name = parts[1];
              const ver = parts[2];
              lib.downloads = lib.downloads || {};
              lib.downloads.artifact = lib.downloads.artifact || {};
              lib.downloads.artifact.path = `${groupPath}/${name}/${ver}/${name}-${ver}.jar`;
              const baseUrl = lib.url || 'https://maven.fabricmc.net/';
              lib.downloads.artifact.url = `${baseUrl}${groupPath}/${name}/${ver}/${name}-${ver}.jar`;
              console.log(`[Fabric] 构造库URL: ${lib.name} -> ${lib.downloads.artifact.url}`);
            }
          }
        } else if (lib.downloads?.artifact?.url) {
          console.log(`[Fabric] 库已有URL: ${lib.name} -> ${lib.downloads.artifact.url}`);
        }
      }
      versionJson.libraries = [...(versionJson.libraries || []), ...fabricLibs];
      console.log(`[Fabric] 添加了 ${fabricLibs.length} 个库到版本 ${versionId}`);

      // 添加 fabric-loader 主库
      if (profileData.loader && profileData.loader.maven) {
        const loaderMavenParts = profileData.loader.maven.split(':');
        if (loaderMavenParts.length >= 3) {
          const loaderGroup = loaderMavenParts[0].replace(/\./g, '/');
          const loaderName = loaderMavenParts[1];
          const loaderVer = loaderMavenParts[2];
          const loaderJarName = `${loaderName}-${loaderVer}.jar`;
          versionJson.libraries.push({
            name: profileData.loader.maven,
            url: 'https://maven.fabricmc.net/',
            downloads: {
              artifact: {
                path: `${loaderGroup}/${loaderName}/${loaderVer}/${loaderJarName}`,
                url: `https://maven.fabricmc.net/${loaderGroup}/${loaderName}/${loaderVer}/${loaderJarName}`,
                sha1: '',
                size: 0
              }
            }
          });
          console.log(`[Fabric] 添加 fabric-loader: ${profileData.loader.maven}`);
        }
      }

      // 添加 intermediary 中间映射库（version=0.0.0 表示无中间映射，跳过）
      if (profileData.intermediary && profileData.intermediary.maven && profileData.intermediary.version !== '0.0.0') {
        const interMavenParts = profileData.intermediary.maven.split(':');
        if (interMavenParts.length >= 3) {
          const interGroup = interMavenParts[0].replace(/\./g, '/');
          const interName = interMavenParts[1];
          const interVer = interMavenParts[2];
          const interJarName = `${interName}-${interVer}.jar`;
          versionJson.libraries.push({
            name: profileData.intermediary.maven,
            url: 'https://maven.fabricmc.net/',
            downloads: {
              artifact: {
                path: `${interGroup}/${interName}/${interVer}/${interJarName}`,
                url: `https://maven.fabricmc.net/${interGroup}/${interName}/${interVer}/${interJarName}`,
                sha1: '',
                size: 0
              }
            }
          });
          console.log(`[Fabric] 添加 intermediary: ${profileData.intermediary.maven}`);
        }
      }
    }
  }

  if (profileData.loader) {
    if (profileData.loader.mainClass && !versionJson.mainClass) {
      versionJson.mainClass = profileData.loader.mainClass;
    }
  }

  // 兜底主类：Fabric 客户端默认启动入口
  if (!versionJson.mainClass) {
    versionJson.mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
  }

  console.log(`[Fabric] 主类: ${versionJson.mainClass}`);
  console.log(`[Fabric] 开始下载库文件...`);

  // 过滤出需要下载的库（按 rules 与文件是否存在）
  const libsToDownload = (versionJson.libraries || []).filter((lib) => {
    if (lib.rules && !versions.evaluateRules(lib.rules)) return false;
    if (!lib.downloads?.artifact?.path) return false;
    const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
    return !fs.existsSync(libPath);
  });

  // 并发下载 Fabric 库
  const downloadErrors = [];
  if (libsToDownload.length > 0) {
    const settings = versions.loadSettingsCached();
    const FABRIC_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, libsToDownload.length);
    let completed = 0;
    let failed = 0;
    let active = 0;
    let done = null;

    const scheduleNext = () => {
      while (active < FABRIC_PARALLEL && completed + failed + active < libsToDownload.length) {
        const lib = libsToDownload[completed + failed + active];
        active++;
        (async () => {
          const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
          const libUrl = lib.downloads.artifact.url
            || `https://maven.fabricmc.net/${lib.downloads.artifact.path}`;
          console.log(`[Fabric] 下载库: ${lib.name || lib.downloads.artifact.path}`);
          await http.downloadFileWithMirror(libUrl, libPath);
          console.log(`[Fabric] 下载成功: ${lib.name}`);
        })().then(() => {
          completed++;
        }).catch((e) => {
          console.error(`[Fabric] 下载失败: ${lib.name} - ${e.message}`);
          downloadErrors.push({ name: lib.name, url: lib.downloads.artifact.url, error: e.message });
          failed++;
        }).finally(() => {
          active--;
          if (onProgress) {
            onProgress((completed + failed) / libsToDownload.length, `下载Fabric库 (${completed + failed}/${libsToDownload.length})...`);
          }
          if (active === 0 && completed + failed >= libsToDownload.length && done) done();
          else if (active < FABRIC_PARALLEL && completed + failed + active < libsToDownload.length) scheduleNext();
        });
      }
    };

    await new Promise((resolve) => { done = resolve; scheduleNext(); });
  }

  if (downloadErrors.length > 0) {
    console.error(`[Fabric] 有 ${downloadErrors.length} 个库下载失败:`);
    for (const err of downloadErrors) {
      console.error(`  - ${err.name}: ${err.url} (${err.error})`);
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
  versions._invalidateResolvedJsonCache(versionId);
  console.log(`[Fabric] Loader merged into version: ${versionId}`);
}

/**
 * 获取所有 Fabric Loader 版本列表
 * @returns {Promise<Array<{version: string, stable: boolean}>>}
 */
async function getFabricLoaderVersions() {
  try {
    // 同时请求官方源与 BMCLAPI 镜像，谁先返回用谁
    const data = await http.fetchWithRacing([
      {
        fetchFn: () => http.fetchJSON(`${ctx.urls.FABRIC_META_URL}/versions/loader`),
        label: '[Racing] Fabric Meta API'
      },
      {
        fetchFn: () => http.fetchJSON('https://bmclapi2.bangbang93.com/fabric-meta/versions/loader'),
        label: '[Racing] BMCLAPI Fabric Meta'
      }
    ]);
    console.log('[Racing] getFabricLoaderVersions 成功');
    return data.map((v) => ({
      version: v.version,
      stable: v.stable
    }));
  } catch (e) {
    console.warn(`[Racing] getFabricLoaderVersions 所有源失败: ${e.message}`);
    return [];
  }
}

/**
 * 获取指定 MC 版本可用的 Fabric Loader 版本列表
 * @param {string} gameVersion - Minecraft 版本号
 * @returns {Promise<Array<{version: string, stable: boolean}>>}
 */
async function getFabricLoaderVersionsForGame(gameVersion) {
  try {
    const data = await http.fetchWithRacing([
      {
        fetchFn: () => http.fetchJSON(`${ctx.urls.FABRIC_META_URL}/versions/loader/${gameVersion}`),
        label: `[Racing] Fabric Meta API (${gameVersion})`
      },
      {
        fetchFn: () => http.fetchJSON(`https://bmclapi2.bangbang93.com/fabric-meta/versions/loader/${gameVersion}`),
        label: `[Racing] BMCLAPI Fabric Meta (${gameVersion})`
      }
    ]);
    console.log(`[Racing] getFabricLoaderVersionsForGame(${gameVersion}) 成功`);
    return data.map((v) => ({
      version: v.loader.version,
      stable: v.loader.stable
    }));
  } catch (e) {
    console.warn(`[Racing] getFabricLoaderVersionsForGame(${gameVersion}) 所有源失败: ${e.message}`);
    return [];
  }
}

/**
 * 自动下载与 MC 版本兼容的 Fabric API 模组
 * @param {string} gameVersion - Minecraft 版本号
 * @param {string} versionId - 目标版本 ID（用于定位 mods 目录）
 * @param {Function|null} onProgress - 进度回调 (percent, message)
 * @returns {Promise<{success: boolean, fileName?: string, version?: string, message?: string}>}
 */
async function autoDownloadFabricApi(gameVersion, versionId, onProgress = null) {
  try {
    if (onProgress) onProgress(0, '正在获取最新 Fabric API...');
    console.log(`[FabricAPI] 搜索兼容 MC ${gameVersion} 的 Fabric API...`);

    // 通过 Modrinth API 查询兼容当前 MC 版本的 Fabric API 版本
    const searchUrl = `${ctx.urls.MODRINTH_API}/project/fabric-api/version?loaders=["fabric"]&game_versions=["${gameVersion}"]`;
    let versions;
    try {
      versions = await http.fetchJSON(searchUrl);
    } catch (e) {
      const mirrorUrl = `${ctx.urls.MODRINTH_API_MIRROR}/project/fabric-api/version?loaders=["fabric"]&game_versions=["${gameVersion}"]`;
      console.log(`[FabricAPI] 主API失败，尝试镜像: ${e.message}`);
      versions = await http.fetchJSON(mirrorUrl);
    }

    if (!versions || versions.length === 0) {
      console.log(`[FabricAPI] 未找到兼容 MC ${gameVersion} 的 Fabric API 版本`);
      return { success: false, message: '未找到兼容版本' };
    }

    const latestVersion = versions[0];
    const primaryFile = latestVersion.files?.find((f) => f.primary) || latestVersion.files?.[0];
    if (!primaryFile) {
      console.log(`[FabricAPI] 版本 ${latestVersion.version_number} 没有可下载文件`);
      return { success: false, message: '无可下载文件' };
    }

    const modsDir = versions.getVersionModsDir(versionId);
    if (!modsDir) {
      console.log(`[FabricAPI] 无法确定版本 ${versionId} 的 mods 目录`);
      return { success: false, message: '无法确定mods目录' };
    }
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

    const destPath = path.join(modsDir, primaryFile.filename);
    // 已存在则跳过下载
    if (fs.existsSync(destPath)) {
      console.log(`[FabricAPI] ${primaryFile.filename} 已存在，跳过下载`);
      return { success: true, message: '已存在', fileName: primaryFile.filename };
    }

    if (onProgress) onProgress(0.3, `下载 Fabric API ${latestVersion.version_number}...`);
    console.log(`[FabricAPI] 下载: ${primaryFile.filename} (${primaryFile.url})`);

    await http.downloadFileWithMirror(primaryFile.url, destPath, (p) => {
      if (onProgress) onProgress(0.3 + p.progress * 0.007, `下载 Fabric API...`);
    });

    console.log(`[FabricAPI] 下载完成: ${primaryFile.filename}`);
    if (onProgress) onProgress(1, `Fabric API 安装完成`);
    return { success: true, fileName: primaryFile.filename, version: latestVersion.version_number };
  } catch (e) {
    console.error(`[FabricAPI] 自动下载失败: ${e.message}`);
    return { success: false, message: e.message };
  }
}

module.exports = {
  installFabric,
  mergeFabricLoaderToVersion,
  getFabricLoaderVersions,
  getFabricLoaderVersionsForGame,
  autoDownloadFabricApi,
};
