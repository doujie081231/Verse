/**
 * @file server/modpack/curseforge.js - CurseForge 整合包导入
 * @description 解析 manifest.json，安装基础版本与模组加载器，下载 mods 与 overrides。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ctx = require('../context');
const utils = require('../utils');
const http = require('../http-client');
const versions = require('../versions');
const modloaders = require('../modloaders');

const { _dedupeVersionId, _cleanDownloadingResidue, isModpackPathSafe, _repairCorruptedModJars, relocateMisplacedResourcePacks, resolveConcurrency, computeModTimeout, createProgressUpdater, _saveModManifest } = require('./shared');
const { completeModpackDependencies } = require('./dep-completion');

/**
 * 导入 CurseForge 整合包（解析 manifest、安装基础版本与加载器、下载 mods 与 overrides）。
 * @param {object} zip - AdmZip 实例（已打开的整合包 zip）
 * @param {object} manifestEntry - manifest.json 的 zip entry
 * @param {string} filePath - 整合包文件路径
 * @param {(stage: string, message: string, percent: number, files?: Array, loader?: string) => void} progress - 进度回调
 * @param {string} [targetVersion=''] - 目标版本目录名（为空则自动生成）
 * @param {AbortSignal} [abortSignal=null] - 取消信号
 * @returns {Promise<{success: boolean, versionId?: string, name?: string, mcVersion?: string, error?: string, warning?: string, failedMods?: Array, loaderVersionId?: string, targetVersion?: string}>}
 */
async function _importCurseForge(zip, manifestEntry, filePath, progress, targetVersion = '', abortSignal = null) {
  const settings = versions.loadSettingsCached();
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch (e) {
    console.error(`[CurseForge] 解析 manifest.json 失败:`, e.message);
    return { success: false, error: '解析 manifest.json 失败: ' + e.message };
  }

  const packName  = (manifest.name || path.basename(filePath, path.extname(filePath))).replace(/[<>:"/\\|?*]/g, '_');
  const mcVersion = manifest.minecraft && manifest.minecraft.version ? manifest.minecraft.version : '';
  const loaders   = manifest.minecraft && manifest.minecraft.modLoaders ? manifest.minecraft.modLoaders : [];
  const modLoader = loaders.length > 0 ? loaders[0].id : '';

  let forgeVerCF = '', fabricVerCF = '', neoforgeVerCF = '';
  const mlLower = (modLoader || '').toLowerCase();

  if (/^forge[-]?(\d)/.test(mlLower)) {
    const mlParts = (modLoader || '').split('-');
    forgeVerCF = mlParts[0].toLowerCase() === 'forge' ? mlParts.slice(1).join('-') : mlParts.join('-').replace(/^forge/i, '');
  } else if (/^neoforge[-]?(\d)/.test(mlLower)) {
    const mlParts = (modLoader || '').split('-');
    neoforgeVerCF = mlParts[0].toLowerCase() === 'neoforge' ? mlParts.slice(1).join('-') : mlParts.join('-').replace(/^neoforge/i, '');
  } else if (/^fabric[-]?loader[-]?(\d)/.test(mlLower)) {
    const mlParts = (modLoader || '').split('-');
    if (mlParts[0].toLowerCase() === 'fabric' && mlParts[1] && mlParts[1].toLowerCase() === 'loader') {
      fabricVerCF = mlParts.slice(2).join('-');
    } else if (mlParts[0].toLowerCase() === 'fabric') {
      fabricVerCF = mlParts.slice(1).join('-').replace(/^loader[-]?/i, '');
    } else {
      fabricVerCF = mlParts.join('-').replace(/^fabric[-]?loader[-]?/i, '');
    }
  } else if (/^fabric[-]?(\d)/.test(mlLower)) {
    const mlParts = (modLoader || '').split('-');
    fabricVerCF = mlParts[0].toLowerCase() === 'fabric' ? mlParts.slice(1).join('-') : mlParts.join('-').replace(/^fabric/i, '');
  }

  progress('prepare', `整合包: ${packName}  MC: ${mcVersion}`, 8);

  let versionId;
  let versionDir;

  if (targetVersion) {
    const cleanTargetId = targetVersion.replace(/ \[外部\d*\]/, '');
    const existingDir = path.join(ctx.dirs.VERSIONS_DIR, cleanTargetId);
    if (fs.existsSync(existingDir)) {
      versionId = cleanTargetId;
      versionDir = existingDir;
    } else {
      const extFolders = versions.loadExternalFolders();
      for (const folder of extFolders) {
        if (!fs.existsSync(folder.path)) continue;
        const extVers = versions.scanExternalFolder(folder.path);
        const extV = extVers.find((v) => v.id === cleanTargetId);
        if (extV) {
          versionId = cleanTargetId;
          versionDir = extV.externalVersionDir;
          break;
        }
      }
    }
    if (!versionDir) {
      versionId = _dedupeVersionId(packName);
      versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    }
  } else {
    versionId = _dedupeVersionId(packName);
    versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
  }

  const isNewVersionDirCF = !fs.existsSync(path.join(versionDir, `${versionId}.json`));

  if (!fs.existsSync(versionDir)) {
    fs.mkdirSync(versionDir, { recursive: true });
  }

  // CurseForge API Key：优先使用用户配置的 Key，无配置时使用内置公共 Key 兜底
  // 与 mod-search / mod-download 等模块保持一致，避免整合包导入时无法获取下载链接
  const cfApiKey = settings.curseforgeApiKey || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';

  let loaderVersionId = null;

  if (isNewVersionDirCF) {
    progress('base', '正在准备基础版本...', 5);
    const baseResult = await modloaders.ensureBaseVersionInstalled(mcVersion, (msg, pct) => {
      progress('base', msg || '正在准备基础版本...', 5 + Math.min(pct, 100) * 0.15);
    });
    if (baseResult.error) {
      try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (e) {}
      return { success: false, versionId, error: baseResult.error };
    }

    if (forgeVerCF || neoforgeVerCF || fabricVerCF) {
      progress('loader-install', '正在安装模组加载器...', 20);
      try {
        if (forgeVerCF) {
          loaderVersionId = `${mcVersion}-forge-${forgeVerCF}`;
          const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
          if (!fs.existsSync(lvJson) || !modloaders.verifyLoaderLibs(loaderVersionId)) {
            if (fs.existsSync(lvJson) && !modloaders.verifyLoaderLibs(loaderVersionId)) {
              try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
            }
            const ir = await modloaders.installForge(mcVersion, forgeVerCF, (p, msg) => {
              progress('loader-install', msg || '正在安装Forge...', 20 + p * 15);
            });
            if (!ir.success) throw new Error(ir.error);
          }
        } else if (neoforgeVerCF) {
          loaderVersionId = `${mcVersion}-neoforge-${neoforgeVerCF}`;
          const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
          if (!fs.existsSync(lvJson) || !modloaders.verifyLoaderLibs(loaderVersionId)) {
            if (fs.existsSync(lvJson) && !modloaders.verifyLoaderLibs(loaderVersionId)) {
              try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
            }
            const ir = await modloaders.installNeoForge(mcVersion, neoforgeVerCF, (p, msg) => {
              progress('loader-install', msg || '正在安装NeoForge...', 20 + p * 15);
            });
            if (!ir.success) throw new Error(ir.error);
          }
        } else if (fabricVerCF) {
          loaderVersionId = `fabric-loader-${fabricVerCF}-${mcVersion}`;
          const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
          let fabricNeedInstall = !fs.existsSync(lvJson);
          if (!fabricNeedInstall) {
            if (!modloaders.verifyLoaderLibs(loaderVersionId)) {
              fabricNeedInstall = true;
            } else {
              try {
                const existingJson = JSON.parse(fs.readFileSync(lvJson, 'utf-8'));
                const hasFabricLoader = (existingJson.libraries || []).some((l) => l.name && l.name.startsWith('net.fabricmc:fabric-loader'));
                if (!hasFabricLoader) {
                  fabricNeedInstall = true;
                }
              } catch (_) { fabricNeedInstall = true; }
            }
          }
          if (fabricNeedInstall) {
            if (fs.existsSync(lvJson)) {
              try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
            }
            const ir = await modloaders.installFabric(mcVersion, fabricVerCF, (p, msg) => {
              progress('loader-install', msg || '正在安装Fabric...', 20 + p * 15);
            });
            if (!ir.success) throw new Error(ir.error);
          }
        }
      } catch (e) {
        console.error(`[CurseForge] 模组加载器安装失败:`, e.message);
        try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (ce) {}
        return { success: false, versionId, error: e.message };
      }
    }

    progress('version-config', '正在创建版本配置...', 35);

    if (loaderVersionId) {
      let cfLoaderMainClass = '';
      try {
        const cfLvJsonPath = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
        if (fs.existsSync(cfLvJsonPath)) {
          const cfLvJson = JSON.parse(fs.readFileSync(cfLvJsonPath, 'utf-8'));
          cfLoaderMainClass = cfLvJson.mainClass || '';
        }
      } catch (_cfLvErr) {}
      const versionJson = {
        id: versionId,
        inheritsFrom: loaderVersionId,
        type: 'release',
        time: new Date().toISOString(),
        releaseTime: new Date().toISOString()
      };
      if (cfLoaderMainClass) versionJson.mainClass = cfLoaderMainClass;
      fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
      versions._invalidateResolvedJsonCache(versionId);
      // [关键修复] 复制继承版本（Forge/NeoForge/Fabric）的主 jar 到新版本目录，
      // 命名为 ${versionId}.jar。原因：Forge 的 ignoreList 等启动参数使用
      // ${version_name}.jar 占位符，启动时会被替换为 ${versionId}.jar。
      // 若整合包版本ID（如"剑与王国"）与继承版本ID（如"1.20.1-forge-47.4.20"）不同，
      // 替换后的文件名在 classpath 中不存在，导致 patched jar 未被 ignoreList 跳过，
      // 被 JPMS 加载为自动模块，与 minecraft 模块 split package 冲突，游戏启动即崩溃。
      // 复制 jar 后，${versionId}.jar 存在，占位符替换能正确匹配，从源头消除冲突。
      if (loaderVersionId) {
        try {
          const _srcLoaderJar = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.jar`);
          const _dstVersionJar = path.join(versionDir, `${versionId}.jar`);
          if (fs.existsSync(_srcLoaderJar) && !fs.existsSync(_dstVersionJar)) {
            fs.copyFileSync(_srcLoaderJar, _dstVersionJar);
            console.log(`[CurseForge] 已复制主 jar 到版本目录: ${versionId}.jar`);
          }
        } catch (_jarCopyErr) {
          console.warn(`[CurseForge] 复制主 jar 失败 (非致命): ${_jarCopyErr.message}`);
        }
      }
    } else {
      const versionJson = {
        id: versionId,
        inheritsFrom: mcVersion || undefined,
        type: 'release',
        mainClass: 'net.minecraft.client.main.Main',
        time: new Date().toISOString(),
        releaseTime: new Date().toISOString()
      };
      fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
      versions._invalidateResolvedJsonCache(versionId);
      // 无加载器场景：复制原版 jar 到新版本目录，原因同上
      if (mcVersion) {
        try {
          const _srcVanillaJar = path.join(ctx.dirs.VERSIONS_DIR, mcVersion, `${mcVersion}.jar`);
          const _dstVersionJar = path.join(versionDir, `${versionId}.jar`);
          if (fs.existsSync(_srcVanillaJar) && !fs.existsSync(_dstVersionJar)) {
            fs.copyFileSync(_srcVanillaJar, _dstVersionJar);
            console.log(`[CurseForge] 已复制原版 jar 到版本目录: ${versionId}.jar`);
          }
        } catch (_jarCopyErr) {
          console.warn(`[CurseForge] 复制原版 jar 失败 (非致命): ${_jarCopyErr.message}`);
        }
      }
    }

    progress('loader', '模组加载器就绪', 40);
  }

  let _cfBackupDir = null;
  if (!isNewVersionDirCF) {
    try {
      const existingModsDir = path.join(versionDir, 'mods');
      if (fs.existsSync(existingModsDir)) {
        _cfBackupDir = versionDir + '.backup_' + Date.now();
        fs.cpSync(existingModsDir, path.join(_cfBackupDir, 'mods'), { recursive: true });
      }
    } catch (bkErr) {
      console.warn(`[CurseForge] 备份 mods 目录失败 (非致命): ${bkErr.message}`);
      _cfBackupDir = null;
    }
  }

  try {
    progress('extract', '解压覆盖文件...', 40, [], '');
    const entries = zip.getEntries();
    const overrideFiles = [];
    let cfExtractYieldCounter = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (!isModpackPathSafe(entry.entryName)) continue;
      if (entry.entryName.startsWith('overrides/')) {
        const relPath = entry.entryName.slice('overrides/'.length);
        const destPath = path.join(versionDir, relPath);
        const resolvedDest = path.resolve(destPath);
        const resolvedBase = path.resolve(versionDir);
        if (!resolvedDest.startsWith(resolvedBase + path.sep) && resolvedDest !== resolvedBase) {
          console.warn(`[Modpack] CurseForge路径遍历已拦截: ${relPath}`);
          continue;
        }
        await utils.asyncEnsureDir(destPath);
        let cfExtractOk = false;
        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            await fs.promises.writeFile(destPath, entry.getData());
            cfExtractOk = true;
            break;
          } catch (e) {
            console.warn(`[Modpack] CF解压 ${relPath} 第 ${attempt} 次失败: ${e.message}`);
            if (attempt < 5) await new Promise((r) => setTimeout(r, (attempt - 1) * 2000));
          }
        }
        if (cfExtractOk) overrideFiles.push({ name: relPath, status: 'completed', progress: 100 });
        if (++cfExtractYieldCounter % 50 === 0) await utils.yieldToEventLoop();
      }
    }

    // 提取整合包根目录的图标文件（pack.png / icon.png / logo.png）到版本目录，用于版本卡片展示
    try {
      const _cfRootIconNames = ['pack.png', 'icon.png', 'logo.png'];
      for (const _entry of entries) {
        if (_entry.isDirectory) continue;
        const _entryName = _entry.entryName.replace(/\\/g, '/');
        if (_cfRootIconNames.includes(_entryName)) {
          const _destIconPath = path.join(versionDir, _entryName);
          if (!fs.existsSync(_destIconPath)) {
            await fs.promises.writeFile(_destIconPath, _entry.getData());
            utils._writeImportLog(`提取整合包图标: ${_entryName}`);
          }
          break;
        }
      }
    } catch (_cfIconErr) {
      console.warn(`[Modpack] CurseForge 提取根目录图标失败（非致命）: ${_cfIconErr.message}`);
    }

    // 修正：mods 目录下误放的资源包 zip 移到 resourcepacks（整合包作者打包结构错误时自动修复）
    try {
      const relocated = relocateMisplacedResourcePacks(versionDir);
      if (relocated.relocated.length > 0) {
        console.log(`[Modpack] 检测到 ${relocated.relocated.length} 个资源包 zip 误放在 mods 目录，已自动移动到 resourcepacks: ${relocated.relocated.join(', ')}`);
      }
    } catch (e) {
      console.warn(`[Modpack] 资源包重定位失败（非致命）: ${e.message}`);
    }

    try {
      const vsPath = path.join(versionDir, 'version-settings.json');
      let vs = {};
      if (fs.existsSync(vsPath)) vs = JSON.parse(fs.readFileSync(vsPath, 'utf-8'));
      if (!vs.isolation || vs.isolation === 'global') {
        vs.isolation = 'on';
        fs.writeFileSync(vsPath, JSON.stringify(vs, null, 2));
      }
    } catch (_) {}

    const cfFiles = manifest.files || [];
    const modsDir = path.join(versionDir, 'mods');
    utils.ensureDir(path.join(modsDir, 'dummy.txt'));

    // 清理上次导入失败留下的 .downloading 残留文件，避免续传死循环
    _cleanDownloadingResidue(versionDir);

    const cfModFiles = cfFiles.map((f) => ({ name: `Mod #${f.projectID}`, status: 'pending', progress: 0 }));
    progress('mods', `下载 Mod 文件 (共 ${cfFiles.length} 个)...`, 50, [...overrideFiles, ...cfModFiles], '');

    let cfDownloadedCount = 0;
    let cfFailedCount = 0;
    let cfInFlight = 0;
    const CF_PARALLEL = resolveConcurrency(settings);
    const _cfAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: CF_PARALLEL + 8, maxFreeSockets: 16, timeout: 120000 });

    const { update: cfUpdateOverall } = createProgressUpdater({
      modFiles: cfModFiles,
      overrideFiles,
      modCount: cfFiles.length,
      progress,
      getDoneCount: () => cfDownloadedCount,
      getInFlight: () => cfInFlight
    });

    const dlCFMod = async (file, index) => {
      cfInFlight++;
      if (abortSignal && abortSignal.aborted) { cfInFlight--; cfUpdateOverall(); return; }
      const projectID = file.projectID;
      const fileID    = file.fileID;
      const fileSize  = file.fileLength || 0;
      if (cfModFiles[index]) { cfModFiles[index].status = 'downloading'; cfModFiles[index].progress = 0; }
      cfUpdateOverall();

      let cfDownloaded = false;
      const MAX_CF_ROUNDS = 3;

      for (let round = 0; round < MAX_CF_ROUNDS && !cfDownloaded; round++) {
        if (abortSignal && abortSignal.aborted) break;
        if (round > 0) {
          if (cfModFiles[index]) { cfModFiles[index].status = 'downloading'; cfModFiles[index].progress = 0; }
          await new Promise((r) => setTimeout(r, 3000 + round * 2000 + Math.random() * 2000));
        }

        if (!cfApiKey) {
          if (cfModFiles[index]) { cfModFiles[index].status = 'failed'; cfModFiles[index].error = 'API Key 未设置'; }
          break;
        }

        try {
          if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');
          let fileInfo = _cfFileInfoMap[fileID] ? { data: _cfFileInfoMap[fileID] } : null;
          if (!fileInfo && round === 0) {
            fileInfo = await http.fetchJSON(`${ctx.urls.CURSEFORGE_API}/mods/${projectID}/files/${fileID}`, { 'x-api-key': cfApiKey });
          }
          const downloadUrl = fileInfo && fileInfo.data ? fileInfo.data.downloadUrl : null;
          if (downloadUrl) {
            const fileName = path.basename(downloadUrl);
            const destPath = path.join(modsDir, fileName);
            if (cfModFiles[index]) { cfModFiles[index].name = fileName; cfModFiles[index]._destPath = destPath; }

            if (utils.isJarIntactDeep(destPath)) {
              cfDownloaded = true;
            } else {
              const perTryAbort = new AbortController();
              const cfTimeout = computeModTimeout(fileInfo?.data?.fileLength || fileSize || 0);
              const perTryTimeout = setTimeout(() => { try { perTryAbort.abort(); } catch (_) {} },
                Math.max(120000, cfTimeout + 30000));
              if (abortSignal) {
                abortSignal.addEventListener('abort', () => { try { perTryAbort.abort(); } catch (_) {} }, { once: true });
              }
              try {
                const allUrls = http.getMirrorUrls(downloadUrl);
                for (const mirrorUrl of allUrls) {
                  if (cfDownloaded || perTryAbort.signal.aborted) break;
                  try {
                    await http._dlSingle(mirrorUrl, destPath, {
                      onProgress: (p) => {
                        if (p && cfModFiles[index]) {
                          cfModFiles[index].progress = Math.round(p.progress || 0);
                          cfModFiles[index].downloaded = p.downloaded || 0;
                          cfModFiles[index].speed = p.speed || '';
                        }
                        cfUpdateOverall();
                      },
                      retries: 3,
                      stallTimeout: 45000,
                      abortSignal: perTryAbort.signal,
                      timeout: computeModTimeout(fileInfo?.data?.fileLength || 0),
                      agent: _cfAgent
                    });
                    if (utils.isJarIntact(destPath)) {
                      if (cfModFiles[index]) {
                        cfModFiles[index]._destPath = destPath;
                        try { cfModFiles[index]._modId = utils.readJarModId(destPath); } catch (_) {}
                        try {
                          const fi = fileInfo && fileInfo.data ? fileInfo.data : (_cfFileInfoMap[fileID] || null);
                          if (fi) {
                            cfModFiles[index]._fileInfo = {
                              id: fi.id || fileID,
                              fileName: fileName || fi.fileName || '',
                              downloadUrl: fi.downloadUrl || '',
                              fileLength: fi.fileLength || 0,
                              sha1: (fi.hashes || []).find((h) => h.algo === 'Sha1')?.value || ''
                            };
                          }
                        } catch (_) {}
                      }
                      cfDownloaded = true;
                      break;
                    } else {
                      try { fs.unlinkSync(destPath); } catch (_) {}
                    }
                  } catch (e) {
                    if (abortSignal && abortSignal.aborted) break;
                    try { fs.unlinkSync(destPath); } catch (_) {}
                  }
                }
              } finally {
                clearTimeout(perTryTimeout);
              }
            }
          } else {
            console.warn(`[CurseForge] 无法获取下载URL: ${projectID}:${fileID}`);
            if (cfModFiles[index]) { cfModFiles[index].status = 'failed'; cfModFiles[index].error = 'CurseForge 未提供下载链接'; }
            break;
          }
        } catch (e) {
          if (abortSignal && abortSignal.aborted) break;
          console.warn(`[CurseForge] 下载失败(round ${round + 1}):`, projectID, fileID, e.message);
        }
      }

      if (!cfDownloaded && !(abortSignal && abortSignal.aborted) && cfApiKey) {
        try {
          let cfLoaderTypeFilter = '';
          if (forgeVerCF) cfLoaderTypeFilter = '&modLoaderType=1';
          else if (fabricVerCF) cfLoaderTypeFilter = '&modLoaderType=4';
          else if (neoforgeVerCF) cfLoaderTypeFilter = '&modLoaderType=5';
          const allFilesRes = await http.fetchJSON(`${ctx.urls.CURSEFORGE_API}/mods/${projectID}/files?gameVersion=${mcVersion}${cfLoaderTypeFilter}`, { 'x-api-key': cfApiKey });
          if (allFilesRes && allFilesRes.data && Array.isArray(allFilesRes.data)) {
            const mcVer = mcVersion;
            const matchingFiles = allFilesRes.data.filter((f) =>
              f.gameVersions && f.gameVersions.includes(mcVer) &&
              f.downloadUrl && f.fileName && f.fileName.endsWith('.jar')
            );
            for (const altFile of matchingFiles.slice(0, 3)) {
              if (cfDownloaded) break;
              const destPath = path.join(modsDir, altFile.fileName);
              if (cfModFiles[index]) { cfModFiles[index].name = altFile.fileName; cfModFiles[index]._destPath = destPath; }
              if (utils.isJarIntact(destPath)) { cfDownloaded = true; break; }
              try {
                await http._dlSingle(altFile.downloadUrl, destPath, {
                  onProgress: (p) => {
                    if (p && cfModFiles[index]) cfModFiles[index].progress = Math.round(p.progress || 0);
                    cfUpdateOverall();
                  },
                  retries: 2,
                  abortSignal,
                  timeout: 300000,
                  agent: _cfAgent
                });
                if (utils.isJarIntact(destPath)) {
                  if (cfModFiles[index]) {
                    cfModFiles[index]._destPath = destPath;
                    try { cfModFiles[index]._modId = utils.readJarModId(destPath); } catch (_) {}
                    try {
                      cfModFiles[index]._fileInfo = {
                        id: altFile.id || fileID,
                        fileName: altFile.downloadUrl ? path.basename(altFile.downloadUrl) : (altFile.fileName || path.basename(destPath)),
                        downloadUrl: altFile.downloadUrl || '',
                        fileLength: altFile.fileLength || 0,
                        sha1: (altFile.hashes || []).find((h) => h.algo === 'Sha1')?.value || ''
                      };
                    } catch (_) {}
                  }
                  cfDownloaded = true;
                } else {
                  try { fs.unlinkSync(destPath); } catch (_) {}
                }
              } catch (_) {
                try { fs.unlinkSync(destPath); } catch (_) {}
              }
            }
          }
        } catch (_) {}
      }

      if (cfDownloaded) {
        if (cfModFiles[index]) { cfModFiles[index].status = 'completed'; cfModFiles[index].progress = 100; }
        cfDownloadedCount++;
      } else if (cfModFiles[index]) {
        // 清理当前 mod 的 .downloading 残留文件，避免下次导入续传死循环
        try { const _tmpFile = cfModFiles[index]._destPath + '.downloading'; if (fs.existsSync(_tmpFile)) fs.unlinkSync(_tmpFile); } catch (_) {}
        if (abortSignal && abortSignal.aborted) {
          cfModFiles[index].status = 'failed'; cfModFiles[index].error = '已取消';
        } else {
          cfModFiles[index].status = 'failed'; cfModFiles[index].error = '下载失败';
          cfFailedCount++;
          console.error(`[CurseForge] Mod ${projectID}:${fileID} 最终下载失败`);
          // 熔断保护：仅当失败率超过 40% 且失败数明显大于成功数时才取消
          // 避免前期少量失败就触发熔断导致整个整合包下载失败
          const totalAttempts = cfDownloadedCount + cfFailedCount;
          const failRatio = cfFailedCount / Math.max(totalAttempts, 1);
          if (cfFailedCount > Math.max(20, cfFiles.length * 0.4) && failRatio > 0.75) {
            console.error(`[CurseForge] 失败率过高(${cfFailedCount}/${totalAttempts} = ${(failRatio * 100).toFixed(1)}%)，取消剩余下载`);
            if (abortSignal) try { abortSignal.abort(); } catch (_) {}
          }
        }
      }
      cfInFlight--;
      cfUpdateOverall();
    };

    const _cfFileInfoMap = {};
    if (cfApiKey && cfFiles.length > 0) {
      progress('mods', `正在获取 ${cfFiles.length} 个 Mod 的下载信息...`, 50, [...overrideFiles, ...cfModFiles], '');
      const _cfBatchSize = 50;
      for (let bi = 0; bi < cfFiles.length; bi += _cfBatchSize) {
        if (abortSignal && abortSignal.aborted) break;
        const batch = cfFiles.slice(bi, bi + _cfBatchSize);
        try {
          const batchRes = await http.fetchJSONWithMethod(`${ctx.urls.CURSEFORGE_API}/mods/files`, 'POST',
            JSON.stringify({ fileIds: batch.map((f) => f.fileID) }),
            { 'x-api-key': cfApiKey, 'Content-Type': 'application/json' });
          if (batchRes && batchRes.data) {
            for (const fi of batchRes.data) _cfFileInfoMap[fi.id] = fi;
          }
        } catch (e) {
          console.warn(`[CurseForge] 批量获取文件信息失败: ${e.message}，将逐个获取`);
        }
      }
    }

    let cfTaskIdx = 0;
    const runNextCfMod = async () => {
      while (cfTaskIdx < cfFiles.length) {
        if (abortSignal && abortSignal.aborted) break;
        const idx = cfTaskIdx++;
        await dlCFMod(cfFiles[idx], idx);
      }
    };
    const cfPool = [];
    for (let p = 0; p < Math.min(CF_PARALLEL, cfFiles.length); p++) {
      cfPool.push(runNextCfMod());
    }
    await Promise.all(cfPool);
    try { _cfAgent.destroy(); } catch (_) {}
    if (abortSignal && abortSignal.aborted) throw new Error('下载已取消');

    // 保存失败模组列表，方便用户后续补下载或排查
    const _cfFailedModsList = [];
    for (let i = 0; i < cfFiles.length; i++) {
      if (cfModFiles[i] && cfModFiles[i].status === 'failed') {
        _cfFailedModsList.push({
          projectID: cfFiles[i].projectID,
          fileID: cfFiles[i].fileID,
          name: cfModFiles[i].name || `Mod #${cfFiles[i].projectID}`,
          error: cfModFiles[i].error || '下载失败'
        });
      }
    }
    if (_cfFailedModsList.length > 0) {
      try {
        const failedListPath = path.join(versionDir, 'failed-mods.json');
        fs.writeFileSync(failedListPath, JSON.stringify({
          packName,
          mcVersion,
          totalMods: cfFiles.length,
          failedCount: _cfFailedModsList.length,
          downloadedCount: cfDownloadedCount,
          failedAt: new Date().toISOString(),
          failedMods: _cfFailedModsList,
          note: '这些模组在导入时下载失败，可重新导入整合包补下载，或手动从 CurseForge 下载后放入 mods 文件夹'
        }, null, 2));
        console.log(`[CurseForge] 已保存失败模组列表: ${failedListPath} (${_cfFailedModsList.length}/${cfFiles.length})`);
      } catch (e) {
        console.warn(`[CurseForge] 保存失败模组列表失败: ${e.message}`);
      }
    }

    // 保存模组清单，供启动前校验与自动修复
    try {
      const manifestMods = [];
      for (let i = 0; i < cfFiles.length; i++) {
        const m = cfModFiles[i];
        if (m && m.status === 'completed' && m._fileInfo) {
          manifestMods.push({
            projectID: cfFiles[i].projectID,
            fileID: cfFiles[i].fileID,
            fileName: m._fileInfo.fileName || m.name || '',
            downloadUrl: m._fileInfo.downloadUrl || '',
            fileLength: m._fileInfo.fileLength || 0,
            sha1: m._fileInfo.sha1 || '',
            modId: m._modId || null
          });
        }
      }
      _saveModManifest(versionDir, manifestMods);
    } catch (e) {
      console.warn(`[CurseForge] 保存模组清单失败: ${e.message}`);
    }

    progress('repair', '正在修复损坏的模组文件...', 88);
    const cfRepairResult = await _repairCorruptedModJars(versionDir);
    if (cfRepairResult.failed > 0) {
      console.warn(`[CurseForge] ${cfRepairResult.failed} 个模组文件损坏且无法修复，游戏启动时可能报错`);
    }

    // 依赖补全：扫描所有 mod 的依赖声明，自动下载缺失的前置依赖
    // 解决整合包作者漏写依赖 mod 导致游戏启动崩溃的问题
    try {
      const _cfDepLoader = fabricVerCF ? 'fabric' : (forgeVerCF ? 'forge' : (neoforgeVerCF ? 'neoforge' : 'forge'));
      const cfDepResult = await completeModpackDependencies(versionDir, mcVersion, _cfDepLoader, settings, progress);
      if (cfDepResult.downloaded > 0) {
        console.log(`[CurseForge] 依赖补全: ${cfDepResult.downloaded} 个缺失依赖已自动下载`);
      }
      if (cfDepResult.failed > 0) {
        console.warn(`[CurseForge] 依赖补全: ${cfDepResult.failed} 个依赖未找到: ${cfDepResult.failedDeps.join(', ')}`);
      }
    } catch (cfDepErr) {
      console.warn(`[CurseForge] 依赖补全过程异常(非致命): ${cfDepErr.message}`);
    }

    if (loaderVersionId && mcVersion) {
      const lt = fabricVerCF ? 'fabric' : (forgeVerCF || neoforgeVerCF ? 'forge' : null);
      const cv = fabricVerCF || forgeVerCF || neoforgeVerCF;
      if (lt && cv) {
        await modloaders.ensureLoaderCompat(versionId, versionDir, mcVersion, cv, lt, progress, abortSignal);
      }
    }

    progress('verify', '正在验证整合包完整性...', 90, [...overrideFiles, ...cfModFiles], '');
    const cfVerifyResult = await modloaders.verifyImportLibs(versionId, progress, abortSignal);
    if (!cfVerifyResult.ok) {
      console.error(`[CurseForge] 库文件补全失败: ${cfVerifyResult.missing} 个文件缺失`);
      versions.cleanupVersionChain(versionId);
      return { success: false, versionId, error: `整合包库文件补全失败: ${cfVerifyResult.missing} 个文件缺失，请检查网络后重试` };
    }

    const cfMergedJson = versions.resolveVersionJson(versionId);

    if (cfMergedJson && cfMergedJson.assetIndex) {
      progress('assets', '正在下载游戏资源...', 93, [], '');
      try {
        const cfAssetIndexInfo = cfMergedJson.assetIndex;
        const cfAssetIndexPath = path.join(ctx.dirs.ASSETS_DIR, 'indexes', `${cfAssetIndexInfo.id}.json`);
        if (!fs.existsSync(cfAssetIndexPath) || (cfAssetIndexInfo.sha1 && !(await utils.verifyFileSha1(cfAssetIndexPath, cfAssetIndexInfo.sha1)))) {
          const cfIdxDir = path.dirname(cfAssetIndexPath);
          if (!fs.existsSync(cfIdxDir)) fs.mkdirSync(cfIdxDir, { recursive: true });
          if (fs.existsSync(cfAssetIndexPath)) fs.unlinkSync(cfAssetIndexPath);
          await http.downloadFileWithMirror(cfAssetIndexInfo.url, cfAssetIndexPath);
        }
        if (fs.existsSync(cfAssetIndexPath)) {
          const cfAssetIndexData = JSON.parse(fs.readFileSync(cfAssetIndexPath, 'utf-8'));
          const cfAssetObjects = cfAssetIndexData.objects || {};
          const cfAssetEntries = Object.entries(cfAssetObjects);
          let cfMissingAssets = [];
          for (const [name, info] of cfAssetEntries) {
            const hash = info.hash;
            const subDir = hash.substring(0, 2);
            const aPath = path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash);
            if (!fs.existsSync(aPath)) {
              cfMissingAssets.push({ name, hash, subDir, size: info.size });
            }
          }
          if (cfMissingAssets.length > 0) {
            const CF_ASSET_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, 64);
            let cfAssetDone = 0;
            const cfAssetTotal = cfMissingAssets.length;
            progress('assets', `下载游戏资源 (0/${cfAssetTotal})`, 93, [], '');
            const runCfAssetBatch = async () => {
              while (cfMissingAssets.length > 0) {
                if (abortSignal && abortSignal.aborted) break;
                const asset = cfMissingAssets.pop();
                const targetDir = path.join(ctx.dirs.ASSETS_DIR, 'objects', asset.subDir);
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                const targetPath = path.join(targetDir, asset.hash);
                try {
                  await http.downloadFileWithMirror(`https://resources.download.minecraft.net/${asset.subDir}/${asset.hash}`, targetPath);
                } catch (e) {
                  console.warn(`[CurseForge] 资源 ${asset.name} 下载失败: ${e.message}`);
                }
                cfAssetDone++;
                const pct = 93 + Math.round((cfAssetDone / cfAssetTotal) * 4);
                progress('assets', `下载游戏资源 (${cfAssetDone}/${cfAssetTotal})`, Math.min(pct, 97), [], '');
              }
            };
            const cfAssetPool = [];
            for (let i = 0; i < Math.min(CF_ASSET_PARALLEL, cfAssetTotal); i++) cfAssetPool.push(runCfAssetBatch());
            await Promise.all(cfAssetPool);
            progress('assets', `游戏资源下载完成 (${cfAssetTotal}/${cfAssetTotal})`, 97, [], '');
          }
        }
      } catch (e) {
        console.warn(`[CurseForge] 资源下载异常(非致命): ${e.message}`);
      }
    }

    if (cfMergedJson && cfMergedJson.inheritsFrom) {
      const cfMainJarId = cfMergedJson.jar || cfMergedJson.inheritsFrom;
      const cfMainJarPath = path.join(ctx.dirs.VERSIONS_DIR, cfMainJarId, `${cfMainJarId}.jar`);
      if (!fs.existsSync(cfMainJarPath)) {
        let cfJarUrl = cfMergedJson.downloads?.client?.url;
        if (!cfJarUrl) {
          try {
            const cfBaseJsonPath = path.join(ctx.dirs.VERSIONS_DIR, cfMainJarId, `${cfMainJarId}.json`);
            if (fs.existsSync(cfBaseJsonPath)) {
              const cfBaseJson = JSON.parse(fs.readFileSync(cfBaseJsonPath, 'utf8'));
              cfJarUrl = cfBaseJson?.downloads?.client?.url;
            }
          } catch (_) {}
        }
        if (cfJarUrl) {
          progress('assets', '正在下载客户端JAR...', 97, [], '');
          let cfJarOk = false;
          for (let jarAttempt = 0; jarAttempt < 3 && !cfJarOk; jarAttempt++) {
            try {
              const cfJarDir = path.dirname(cfMainJarPath);
              if (!fs.existsSync(cfJarDir)) fs.mkdirSync(cfJarDir, { recursive: true });
              await http.downloadFileWithMirror(cfJarUrl, cfMainJarPath);
              cfJarOk = true;
            } catch (e) {
              console.warn(`[CurseForge] 客户端JAR下载失败(${jarAttempt + 1}/3): ${e.message}`);
              try { if (fs.existsSync(cfMainJarPath)) fs.unlinkSync(cfMainJarPath); } catch (_) {}
              if (jarAttempt < 2) await new Promise((r) => setTimeout(r, 2000));
            }
          }
          if (!cfJarOk) console.warn(`[CurseForge] 客户端JAR下载最终失败(非致命)，启动时会自动补全`);
        }
      }
    }
    if (cfMergedJson && (forgeVerCF || neoforgeVerCF)) {
      const cfForgeCoreCheck = [];
      const cfMergedLibs = cfMergedJson.libraries || [];
      const forgeClientLib = cfMergedLibs.find((l) =>
        l.name && /^net\.minecraftforge:forge:\d/.test(l.name) &&
        (l.name.endsWith(':client') || l.name.split(':').length === 3));
      const srgLib = cfMergedLibs.find((l) =>
        l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':srg'));
      const extraLib = cfMergedLibs.find((l) =>
        l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':extra'));
      const coreDir = (fp) => path.join(ctx.dirs.LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2]);
      if (forgeClientLib) {
        const fp = forgeClientLib.name.split(':');
        const cl = fp.length >= 4 ? `-${fp[3]}` : '';
        const p = path.join(coreDir(fp), `${fp[1]}-${fp[2]}${cl}.jar`);
        if (!fs.existsSync(p) || !utils.isJarIntact(p)) cfForgeCoreCheck.push({ name: 'forge-client.jar', path: p });
      }
      if (srgLib) {
        const sp = srgLib.name.split(':');
        const p = path.join(coreDir(sp), `${sp[1]}-${sp[2]}-srg.jar`);
        if (!fs.existsSync(p) || !utils.isJarIntact(p)) cfForgeCoreCheck.push({ name: 'client-srg.jar', path: p });
      }
      if (extraLib) {
        const ep = extraLib.name.split(':');
        const p = path.join(coreDir(ep), `${ep[1]}-${ep[2]}-extra.jar`);
        if (!fs.existsSync(p) || !utils.isJarIntact(p)) cfForgeCoreCheck.push({ name: 'client-extra.jar', path: p });
      }
      if (cfForgeCoreCheck.length > 0) {
        const missingNames = cfForgeCoreCheck.map((f) => f.name).join(', ');
        console.error(`[CurseForge] Forge核心文件验证失败: ${cfForgeCoreCheck.length}个缺失: ${missingNames}`);
        versions.cleanupVersionChain(versionId);
        return { success: false, versionId, error: `Forge核心文件生成失败: 缺失 ${missingNames}。请检查Java环境和网络后重试。` };
      }
    }

    const cfFailedMods = cfModFiles.filter((m) => m.status === 'failed');
    cfFailedCount = cfFailedMods.length;

    const packInfo = {
      name: packName, versionId: versionId, mcVersion, packFormat: 'curseforge',
      modLoader, forgeVersion: forgeVerCF || '', fabricVersion: fabricVerCF || '', neoforgeVersion: neoforgeVerCF || '',
      importedAt: new Date().toISOString(), sourceFile: filePath,
      targetVersion: targetVersion || '',
      pendingMods: cfApiKey ? [] : cfFiles.map((f) => ({ projectID: f.projectID, fileID: f.fileID }))
    };
    fs.writeFileSync(path.join(versionDir, 'pack-info.json'), JSON.stringify(packInfo, null, 2));

    progress('done', `整合包 "${packName}" 导入完成！`, 100);
    const cfWarning = cfApiKey ? undefined : 'CurseForge Mod 文件需要 API Key，overrides 已解压。请在设置中配置 CurseForge API Key 后重新导入。';
    let failWarning = undefined;
    if (cfFailedCount > 0) {
      const failedModNames = cfFailedMods.map((m) => m.name || m.projectID).join(', ');
      failWarning = `${cfFailedCount}/${cfFiles.length} 个Mod下载失败: ${failedModNames}。请检查网络后重试。`;
      console.warn(`[CurseForge] Mod下载汇总: ${cfFiles.length - cfFailedCount}成功 ${cfFailedCount}失败`);
      console.warn(`[CurseForge] 失败的模组: ${failedModNames}`);
    }
    return {
      success: true, name: packName, versionId, mcVersion, targetVersion: targetVersion || '',
      warning: cfWarning || failWarning || undefined,
      failedMods: cfFailedCount > 0 ? cfFailedMods : undefined,
      loaderVersionId: loaderVersionId || null
    };
  } catch (e) {
    console.error('[CurseForge] 导入失败:', e);
    if (_cfBackupDir) {
      try {
        const restoredModsDir = path.join(_cfBackupDir, 'mods');
        if (fs.existsSync(restoredModsDir)) {
          const currentModsDir = path.join(versionDir, 'mods');
          if (fs.existsSync(currentModsDir)) fs.rmSync(currentModsDir, { recursive: true, force: true });
          fs.cpSync(restoredModsDir, currentModsDir, { recursive: true });
        }
        fs.rmSync(_cfBackupDir, { recursive: true, force: true });
      } catch (rbErr) {
        console.error(`[CurseForge] 回滚失败: ${rbErr.message}`);
      }
    }
    versions.cleanupVersionChain(versionId);
    return { success: false, versionId, error: e.message || '未知错误' };
  }
  if (_cfBackupDir) {
    try { fs.rmSync(_cfBackupDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { _importCurseForge };
