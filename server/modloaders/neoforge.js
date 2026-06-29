/**
 * @file server/modloaders/neoforge.js
 * @description NeoForge 加载器安装模块（从 server/modloaders.js 拆分）。
 *   包含 NeoForge 核心 jar 查找、NeoForge 安装、合并到版本 JSON、
 *   指定 MC 版本的 NeoForge 版本列表获取等功能。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ctx = require('../context');
const utils = require('../utils');
const http = require('../http-client');
const versions = require('../versions');

const { ensureBaseVersionInstalled, isLibValid, getNeoLibMirrorUrl, SERVER_DIR } = require('./shared');

/**
 * 从版本 JSON 和搜索路径中查找 NeoForge 核心库 JAR 文件。
 * @param {object} versionJson - 版本 JSON 对象
 * @param {string[]} searchBases - 库搜索根路径数组
 * @param {Array} gameArgs - 版本 JSON 的 arguments.game 数组
 * @returns {string[]} 找到的 JAR 文件绝对路径数组
 */
function findNeoForgeCoreJars(versionJson, searchBases, gameArgs) {
  console.log(`[findNeoForgeCoreJars] called, versionId=${versionJson.id}, gameArgsLen=${gameArgs.length}, searchBasesLen=${searchBases.length}`);
  let neoForgeVersion = '';
  let mcVersion = '';

  const neoForgeVerIdx = gameArgs.findIndex((a) => typeof a === 'string' && a === '--fml.neoForgeVersion');
  const mcVerIdx = gameArgs.findIndex((a) => typeof a === 'string' && a === '--fml.mcVersion');

  console.log(`[findNeoForgeCoreJars] neoForgeVerIdx=${neoForgeVerIdx} mcVerIdx=${mcVerIdx}`);

  if (neoForgeVerIdx >= 0 && neoForgeVerIdx + 1 < gameArgs.length) {
    neoForgeVersion = gameArgs[neoForgeVerIdx + 1];
  }
  if (mcVerIdx >= 0 && mcVerIdx + 1 < gameArgs.length) {
    mcVersion = gameArgs[mcVerIdx + 1];
  }
  if (!mcVersion && versionJson.clientVersion) {
    mcVersion = versionJson.clientVersion;
  }

  if (!neoForgeVersion) {
    const neoLib = (versionJson.libraries || []).find((l) =>
      l.name && l.name.startsWith('net.neoforged:neoforge:')
    );
    if (neoLib) {
      const parts = neoLib.name.split(':');
      if (parts.length >= 3) {
        neoForgeVersion = parts[2];
      }
    }
    if (!neoForgeVersion) {
      const versionDirName = versionJson.id || '';
      const neoMatch = versionDirName.match(/neoforge[_\-\s]*(\d+[\d.]*(?:\.\d+)*)/i);
      if (neoMatch) {
        neoForgeVersion = neoMatch[1];
      }
    }
    if (!neoForgeVersion) {
      const fmlLoaderLib = (versionJson.libraries || []).find((l) =>
        l.name && l.name.startsWith('net.neoforged.fancymodloader:loader:')
      );
      if (fmlLoaderLib) {
        const parts = fmlLoaderLib.name.split(':');
        if (parts.length >= 3) {
          neoForgeVersion = parts[2];
        }
      }
    }
  }

  if (!neoForgeVersion) {
    console.log(`[findNeoForgeCoreJars] neoForgeVersion empty, returning []`);
    return [];
  }

  console.log(`[findNeoForgeCoreJars] neoForgeVersion=${neoForgeVersion} mcVersion=${mcVersion}`);

  const result = [];
  const prefix = 'net/neoforged/neoforge';

  for (const base of searchBases) {
    if (!base) continue;
    const dirPath = path.join(base, prefix, neoForgeVersion);
    if (!fs.existsSync(dirPath)) continue;

    const candidates = [
      `neoforge-${neoForgeVersion}-universal.jar`,
      `neoforge-${neoForgeVersion}.jar`
    ];
    let found = false;
    for (const candidate of candidates) {
      const jarPath = path.join(dirPath, candidate);
      if (fs.existsSync(jarPath)) {
        result.push(jarPath);
        found = true;
        break;
      }
    }
    if (!found) {
      try {
        const files = fs.readdirSync(dirPath)
          .filter((f) => f.startsWith('neoforge-') && f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
        if (files.length > 0) {
          result.push(path.join(dirPath, files[0]));
        }
      } catch (e) {}
    }
    break;
  }

  if (result.length > 0) {
    console.log(`[Classpath] 自动添加NeoForge核心JAR (${result.length}): ${result.map((r) => path.basename(r)).join(', ')}`);
  } else {
    console.log(`[findNeoForgeCoreJars] no JAR found in searchBases, returning []`);
  }

  return result;
}

/**
 * 安装 NeoForge 加载器（解包 installer JAR、下载库、合并版本 JSON、运行处理器）。
 * @param {string} gameVersion - Minecraft 版本号，如 "1.20.1"
 * @param {string} neoVersion - NeoForge 版本号，如 "47.1.0" 或 "20.6.3-beta"
 * @param {(percent: number, message: string) => void} [onProgress] - 进度回调
 * @returns {Promise<{success: boolean, versionId?: string, libsMissing?: number, error?: string}>} 安装结果
 */
async function installNeoForge(gameVersion, neoVersion, onProgress = null) {
  const isLegacy = neoVersion.startsWith('1.20.1-');
  const packageName = isLegacy ? 'forge' : 'neoforge';
  const versionId = `${gameVersion}-NeoForge-${neoVersion}`;

  try {
    // 1. 确保原版已安装
    const baseResult = await ensureBaseVersionInstalled(gameVersion);
    if (baseResult.error) {
      return { success: false, error: baseResult.error };
    }

    const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    fs.mkdirSync(versionDir, { recursive: true });

    // 2. 下载安装器 JAR
    const installerPath = path.join(ctx.dirs.DATA_DIR, 'temp', `neoforge-installer-${neoVersion}.jar`);
    fs.mkdirSync(path.dirname(installerPath), { recursive: true });

    if (onProgress) onProgress(0, '正在下载NeoForge安装包...');

    const neoforgeMavenOfficial = 'https://maven.neoforged.net/releases/net/neoforged';
    const installerUrls = [
      `https://bmclapi2.bangbang93.com/maven/net/neoforged/${packageName}/${neoVersion}/${packageName}-${neoVersion}-installer.jar`,
      `${neoforgeMavenOfficial}/${packageName}/${neoVersion}/${packageName}-${neoVersion}-installer.jar`
    ];
    console.log(`[NeoForge] Downloading installer: ${installerUrls[0]}`);

    let installerOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const dlUrl = installerUrls[attempt % installerUrls.length];
      try {
        await http.downloadFileWithMirror(dlUrl, installerPath);
        const dlStat = fs.statSync(installerPath);
        if (dlStat.size < 64 * 1024) {
          console.error(`[NeoForge] Installer too small (${dlStat.size} bytes), retrying...`);
          try { fs.unlinkSync(installerPath); } catch (_) {}
          continue;
        }
        const fd = fs.openSync(installerPath, 'r');
        const buf = Buffer.alloc(4);
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        if (buf[0] !== 0x50 || buf[1] !== 0x4B || buf[2] !== 0x03 || buf[3] !== 0x04) {
          console.error(`[NeoForge] Installer ZIP magic invalid, retrying...`);
          try { fs.unlinkSync(installerPath); } catch (_) {}
          continue;
        }
        installerOk = true;
        break;
      } catch (e) {
        console.error(`[NeoForge] Installer download failed: ${e.message}`);
        try { fs.unlinkSync(installerPath); } catch (_) {}
      }
    }
    if (!installerOk) {
      throw new Error('NeoForge安装器下载失败，请检查网络');
    }

    if (onProgress) onProgress(0.1, '正在解包 NeoForge 安装器...');

    // 3. 直接从 JAR 中解压版本信息（像 XMCL 一样，不跑 Java 安装器）
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(installerPath);

    // 提取 install_profile.json
    let installProfile = null;
    try {
      const profileEntry = zip.getEntry('install_profile.json');
      if (profileEntry) installProfile = JSON.parse(profileEntry.getData().toString('utf8'));
    } catch (e) {
      console.warn(`[NeoForge] 读取 install_profile.json 失败: ${e.message}`);
    }

    // 提取 version.json（安装器自带的目标版本配置）
    let versionJsonData = null;
    try {
      const versionEntry = zip.getEntry('version.json');
      if (versionEntry) {
        versionJsonData = JSON.parse(versionEntry.getData().toString('utf8'));
        console.log(`[NeoForge] 从 installer 中读取 version.json, mainClass=${versionJsonData.mainClass}`);
      }
    } catch (e) {}

    // 如果 version.json 不在根目录，尝试从 installProfile.json 里找
    if (!versionJsonData && installProfile) {
      if (typeof installProfile.json === 'object' && installProfile.json !== null) {
        versionJsonData = installProfile.json;
      } else if (typeof installProfile.json === 'string' && installProfile.json) {
        const jsonFileName = installProfile.json.replace(/^\//, '');
        const jsonEntry = zip.getEntry(jsonFileName);
        if (jsonEntry) {
          try { versionJsonData = JSON.parse(jsonEntry.getData().toString('utf8')); } catch (e) {}
        }
      }
    }

    if (!versionJsonData) {
      throw new Error('NeoForge安装器中未找到 version.json，安装器可能已损坏');
    }

    // 4. 提取 client.lzma 作为 BINPATCH 数据（处理器需要用它来打补丁）
    const isLegacyPkg = neoVersion.startsWith('1.20.1-');
    const pkg = isLegacyPkg ? 'forge' : 'neoforge';
    const binpatchDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', pkg, neoVersion);
    const binpatchPath = path.join(binpatchDir, `${pkg}-${neoVersion}-clientdata.lzma`);
    let clientLzmaExtracted = false;
    try {
      const clientLzma = zip.getEntry('data/client.lzma');
      if (clientLzma) {
        if (!fs.existsSync(binpatchPath)) {
          fs.mkdirSync(binpatchDir, { recursive: true });
          fs.writeFileSync(binpatchPath, clientLzma.getData());
          console.log(`[NeoForge] 提取 client.lzma → ${binpatchPath}`);
          clientLzmaExtracted = true;
        } else {
          console.log(`[NeoForge] client.lzma 已存在: ${binpatchPath}`);
          clientLzmaExtracted = true;
        }
      } else {
        console.warn(`[NeoForge] 安装器中未找到 data/client.lzma`);
      }
    } catch (e) {
      console.warn(`[NeoForge] 提取 client.lzma 失败（非致命）: ${e.message}`);
    }

    // 5. Save install_profile.json with correct data paths for processors
    if (installProfile) {
      const installerLibDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', pkg, neoVersion);
      const installerLibPath = path.join(installerLibDir, `${pkg}-${neoVersion}-installer.jar`);
      if (!fs.existsSync(installerLibPath) && fs.existsSync(installerPath)) {
        fs.mkdirSync(installerLibDir, { recursive: true });
        fs.copyFileSync(installerPath, installerLibPath);
        console.log(`[NeoForge] Copied installer -> ${installerLibPath}`);
      }

      if (!installProfile.data) installProfile.data = {};

      // BINPATCH: use actual file path so processors can find client.lzma directly
      const effectiveLzmaPath = clientLzmaExtracted ? binpatchPath
        : (fs.existsSync(binpatchPath) ? binpatchPath : null);
      if (effectiveLzmaPath) {
        installProfile.data.BINPATCH = {
          client: effectiveLzmaPath,
          server: effectiveLzmaPath
        };
        console.log(`[NeoForge] BINPATCH set to: ${effectiveLzmaPath}`);
      } else {
        console.warn(`[NeoForge] WARNING: client.lzma not found at ${binpatchPath}`);
      }

      // INSTALLER: use actual file path
      const effectiveInstallerPath = fs.existsSync(installerLibPath) ? installerLibPath
        : (fs.existsSync(installerPath) ? installerPath : null);
      if (effectiveInstallerPath) {
        installProfile.data.INSTALLER = {
          client: effectiveInstallerPath,
          server: effectiveInstallerPath
        };
      }

      // PATCHED: use actual output path
      const patchedMavenPath = `net/neoforged/minecraft-client-patched/${neoVersion}/minecraft-client-patched-${neoVersion}.jar`;
      const patchedFullPath = path.join(ctx.dirs.LIBRARIES_DIR, patchedMavenPath);
      installProfile.data.PATCHED = {
        client: patchedFullPath,
        server: patchedFullPath
      };

      try {
        fs.writeFileSync(path.join(versionDir, 'install_profile.json'), JSON.stringify(installProfile, null, 2));
        console.log(`[NeoForge] install_profile.json updated with correct paths`);
      } catch (_) {}
    }

    // 6. 预下载 MOJMAPS（Forge/NeoForge 的处理器依赖此文件）
    if (installProfile && installProfile.data && installProfile.data.MOJMAPS) {
      try {
        const mojmapsRaw = installProfile.data.MOJMAPS.client;
        const mojmapsRef = typeof mojmapsRaw === 'string' ? mojmapsRaw
          : (Array.isArray(mojmapsRaw) ? mojmapsRaw[0] : (mojmapsRaw?.value || ''));
        const clean = mojmapsRef.replace(/[\[\]]/g, '');
        const parts = clean.split(':');
        if (parts.length >= 4) {
          const groupId = parts[0];
          const artifactId = parts[1];
          const libVersion = parts[2];
          const ext = parts.length > 4 ? parts[4] : (parts[3].includes('@') ? parts[3].split('@')[1] : 'txt');
          const groupPath = groupId.replace(/\./g, '/');
          const mappingsFileName = `${artifactId}-${libVersion}-mappings.${ext}`;
          const mappingsDir = path.join(ctx.dirs.LIBRARIES_DIR, groupPath, artifactId, libVersion);
          const mappingsPath = path.join(mappingsDir, mappingsFileName);

          if (!fs.existsSync(mappingsPath)) {
            console.log(`[NeoForge] 预下载 MOJMAPS: ${mappingsFileName}`);
            if (onProgress) onProgress(0.15, '正在下载 MOJMAPS 映射文件...');
            const mcVer = installProfile.version || gameVersion;
            const manifestBody = await http.httpGet('https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json');
            const manifest = JSON.parse(manifestBody);
            const verEntry = manifest.versions.find((v) => v.id === mcVer);
            if (verEntry) {
              const verJsonUrl = verEntry.url.replace('https://piston-meta.mojang.com/', 'https://bmclapi2.bangbang93.com/');
              const mcVerJson = JSON.parse(await http.httpGet(verJsonUrl));
              const cm = mcVerJson.downloads?.client_mappings;
              if (cm) {
                let cmUrl = cm.url.replace('https://piston-data.mojang.com/', 'https://bmclapi2.bangbang93.com/');
                fs.mkdirSync(mappingsDir, { recursive: true });
                await http.downloadFileWithMirror(cmUrl, mappingsPath);
                console.log(`[NeoForge] MOJMAPS 下载完成: ${mappingsPath}`);
              }
            }
          }
        }
      } catch (e) {
        console.warn(`[NeoForge] MOJMAPS 预下载失败: ${e.message}`);
      }
    }

    // 7. 合并版本 JSON：version.json (来自 installer) + install_profile 中的额外 libraries
    const versionJsonPath = path.join(versionDir, `${versionId}.json`);

    if (installProfile) {
      const profileLibs = installProfile.libraries || [];
      const versionLibs = versionJsonData.libraries || [];
      const existingNames = new Set(versionLibs.map((l) => l.name).filter(Boolean));
      for (const lib of profileLibs) {
        if (lib.name && !existingNames.has(lib.name)) {
          versionLibs.push(lib);
          existingNames.add(lib.name);
        }
      }
      versionJsonData.libraries = versionLibs;
      if (installProfile.mainClass && !versionJsonData.mainClass) {
        versionJsonData.mainClass = installProfile.mainClass;
      }
    }

    // 去掉自引用（installer 里的 net.neoforged:neoforge:xxx 是给 installer 自己用的，不需要出现在版本库里）
    const neoForgeMainPattern = new RegExp(`^net\\.neoforged:(neoforge|forge):${neoVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    versionJsonData.libraries = (versionJsonData.libraries || []).filter((lib) => {
      if (!lib.name) return true;
      return !neoForgeMainPattern.test(lib.name);
    });

    // 确保有必要的参数
    if (!versionJsonData.arguments) versionJsonData.arguments = {};
    if (!versionJsonData.arguments.game || versionJsonData.arguments.game.length === 0) {
      versionJsonData.arguments.game = ['--launchTarget', 'neoforgeclient', '--fml.neoForgeVersion', neoVersion, '--fml.mcVersion', gameVersion];
    }

    // [CRITICAL FIX - 2026-06-20] inheritsFrom 必须从 versionId 提取纯MC版本号（如 "26.2"），
    // 不能直接用 gameVersion 参数！因为 gameVersion 可能被前端传入 "26.2-forge-65.0.0" 这样的值，
    // 导致 inheritsFrom 指向错误的基础版本，NeoForge 启动时 AccessTransformerEngine 找不到方法。
    // 如果此段代码被修改导致 NeoForge 启动报 NoSuchMethodError，请优先检查 inheritsFrom 的值。
    const mcVerFromId = versionId.match(/^(\d+\.\d+(?:\.\d+)?)/);
    const cleanMcVer = mcVerFromId ? mcVerFromId[1] : gameVersion.split('.')[0] + '.' + (gameVersion.split('.')[1] || '0');
    const versionJson = {
      id: versionId,
      inheritsFrom: cleanMcVer,
      mainClass: versionJsonData.mainClass || 'cpw.mods.bootstraplauncher.BootstrapLauncher',
      type: 'release',
      libraries: [...versionJsonData.libraries],
      arguments: versionJsonData.arguments
    };

    // 8. 下载库文件
    if (onProgress) onProgress(0.3, '正在下载NeoForge库文件...');

    const neoLibsToDownload = [];
    for (const lib of (versionJson.libraries || [])) {
      const parts = lib.name ? lib.name.split(':') : [];
      let libPath = null;
      let expectedSha1 = null;

      if (lib.downloads?.artifact?.path) {
        libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
        expectedSha1 = lib.downloads.artifact.sha1 || null;
      } else if (lib.name && parts.length >= 3) {
        const groupPath = parts[0].replace(/\./g, path.sep);
        const lname = parts[1];
        const lver = parts[2];
        const classifier = parts.length >= 4 ? parts[3] : '';
        const jarName = classifier ? `${lname}-${lver}-${classifier}.jar` : `${lname}-${lver}.jar`;
        libPath = path.join(ctx.dirs.LIBRARIES_DIR, groupPath, lname, lver, jarName);
      }

      if (!libPath || isLibValid(libPath, -1, expectedSha1)) continue;

      if (lib.downloads?.artifact?.url) {
        const mirrorUrl = getNeoLibMirrorUrl(lib.downloads.artifact.url);
        neoLibsToDownload.push({ lib, url: mirrorUrl, fallbackUrl: lib.downloads.artifact.url, libPath, expectedSha1 });
      } else if (parts.length >= 3) {
        const mavenGroup = parts[0].replace(/\./g, '/');
        const lname = parts[1];
        const lver = parts[2];
        const classifier = parts.length >= 4 ? parts[3] : '';
        const jarName = classifier ? `${lname}-${lver}-${classifier}.jar` : `${lname}-${lver}.jar`;
        const isNeoLib = parts[0].includes('neoforged') || parts[0].includes('fancymodloader') || parts[0].includes('mixin');
        const officialUrl = lib.url || (isNeoLib ? 'https://maven.neoforged.net/releases/' : 'https://libraries.minecraft.net/');
        const dlUrl = `${officialUrl}${mavenGroup}/${lname}/${lver}/${jarName}`;
        const mirrorUrl = getNeoLibMirrorUrl(dlUrl);
        neoLibsToDownload.push({ lib, url: mirrorUrl, fallbackUrl: dlUrl, libPath, expectedSha1: null });
      }
    }

    let neoLibFailures = 0;
    if (neoLibsToDownload.length > 0) {
      const NEO_PARALLEL = 8;
      let completed = 0;
      let failed = 0;
      let active = 0;
      let done = null;

      const scheduleNext = () => {
        while (active < NEO_PARALLEL && completed + failed + active < neoLibsToDownload.length) {
          const item = neoLibsToDownload[completed + failed + active];
          active++;
          (async () => {
            let success = false;
            for (let retry = 0; retry < 3; retry++) {
              try {
                if (isLibValid(item.libPath, -1, item.expectedSha1)) { success = true; break; }
                if (fs.existsSync(item.libPath)) fs.unlinkSync(item.libPath);
                const dlUrl = retry === 0 ? item.url : item.fallbackUrl;
                await http.downloadFileWithMirror(dlUrl, item.libPath);
                if (isLibValid(item.libPath, -1, item.expectedSha1)) { success = true; break; }
                if (retry < 2) {
                  try { fs.unlinkSync(item.libPath); } catch (_) {}
                  await new Promise((r) => setTimeout(r, 3000 + retry * 2000));
                }
              } catch (e) {
                if (retry < 2) {
                  await new Promise((r) => setTimeout(r, 3000 + retry * 2000));
                } else {
                  console.log(`[NeoForge] Failed to download ${item.lib.name}: ${e.message}`);
                }
              }
            }
            if (!success) neoLibFailures++;
          })().then(() => { completed++; }).catch(() => { failed++; }).finally(() => {
            active--;
            if (active === 0 && completed + failed >= neoLibsToDownload.length && done) done();
            else if (active < NEO_PARALLEL && completed + failed + active < neoLibsToDownload.length) scheduleNext();
          });
        }
      };
      await new Promise((resolve) => { done = resolve; scheduleNext(); });
    }

    // 9. 写入版本 JSON
    fs.writeFileSync(versionJsonPath, JSON.stringify(versionJson, null, 2));
    versions._invalidateResolvedJsonCache(versionId);
    console.log(`[NeoForge] 版本JSON已生成: ${versionJsonPath}, libs=${(versionJson.libraries || []).length}, dlFailed=${neoLibFailures}`);

    // 10. 补全库 + 运行处理器（merge 函数还会下载缺失的库和执行二进制补丁）
    if (onProgress) onProgress(0.7, '补全 NeoForge 库和参数...');
    if (!fs.existsSync(binpatchPath)) {
      console.warn(`[NeoForge] clientdata.lzma 缺失 (${binpatchPath}), 尝试重新提取...`);
      let reextracted = false;
      if (fs.existsSync(installerPath)) {
        try {
          const retryZip = new AdmZip(installerPath);
          const retryEntry = retryZip.getEntry('data/client.lzma');
          if (retryEntry) {
            fs.mkdirSync(binpatchDir, { recursive: true });
            fs.writeFileSync(binpatchPath, retryEntry.getData());
            console.log(`[NeoForge] 重新提取成功: ${binpatchPath} (${fs.statSync(binpatchPath).size} bytes)`);
            reextracted = true;
          } else {
            console.warn(`[NeoForge] 安装器中无 data/client.lzma entry`);
          }
        } catch (e) { console.warn(`[NeoForge] 重新提取失败: ${e.message}`); }
      } else {
        console.warn(`[NeoForge] 安装器 JAR 也不存在: ${installerPath}`);
      }
      if (!reextracted) {
        const errMsg = `NeoForge 安装失败: clientdata.lzma 提取失败，请检查网络后重试安装`;
        if (onProgress) onProgress(1, errMsg);
        return { success: false, error: errMsg };
      }
    }
    const installerLibPath2 = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', pkg, neoVersion, `${pkg}-${neoVersion}-installer.jar`);
    if (!fs.existsSync(installerLibPath2) && fs.existsSync(installerPath)) {
      try {
        // [CRITICAL] ENOTDIR 修复 — 同 ensureDir，清理路径中的文件冲突。
        {
          const _d = path.dirname(installerLibPath2);
          for (const _p of _d.split(path.sep).map((_, _i, _a) => _a.slice(0, _i + 1).join(path.sep))) {
            if (_p) { try { const _s = fs.statSync(_p); if (!_s.isDirectory()) fs.unlinkSync(_p); } catch (_) {} }
          }
        }
        fs.mkdirSync(path.dirname(installerLibPath2), { recursive: true });
        fs.copyFileSync(installerPath, installerLibPath2);
        console.log(`[NeoForge] 复制 installer → ${installerLibPath2}`);
      } catch (_) {}
    }
    try { await mergeNeoForgeLoaderToVersion(versionId, gameVersion, neoVersion, onProgress); } catch (mergeErr) {
      console.warn(`[NeoForge] merge 补全失败: ${mergeErr.message}`);
    }

    const neoCoreJarRel = `net/neoforged/neoforge/${neoVersion}/neoforge-${neoVersion}-universal.jar`;
    const neoCoreJarPath = path.join(ctx.dirs.LIBRARIES_DIR, neoCoreJarRel);
    if (!fs.existsSync(neoCoreJarPath) || (await fs.promises.stat(neoCoreJarPath).catch(() => ({ size: 0 })).then((s) => s.size)) < 1024) {
      console.warn(`[NeoForge] 核心jar缺失或无效，尝试补下载: ${neoCoreJarPath}`);
      if (onProgress) onProgress(0.85, '补下载NeoForge核心文件...');
      const neoCoreUrls = [
        `https://maven.neoforged.net/releases/${neoCoreJarRel}`,
        `https://bmclapi2.bangbang93.com/maven/${neoCoreJarRel}`
      ];
      let coreOk = false;
      for (const url of neoCoreUrls) {
        try {
          fs.mkdirSync(path.dirname(neoCoreJarPath), { recursive: true });
          await http.downloadFile(url, neoCoreJarPath);
          if (fs.existsSync(neoCoreJarPath) && utils.isJarIntact(neoCoreJarPath)) {
            console.log(`[NeoForge] 核心jar补下载成功: ${url}`);
            coreOk = true;
            break;
          }
          console.warn(`[NeoForge] 下载后JAR无效: ${url}`);
          try { fs.unlinkSync(neoCoreJarPath); } catch (_) {}
        } catch (e) {
          console.warn(`[NeoForge] 核心jar下载失败: ${url} - ${e.message}`);
        }
      }
      if (!coreOk) {
        console.warn(`[NeoForge] 核心jar补下载全部失败`);
      } else {
        neoLibFailures = Math.max(0, neoLibFailures - 1);
      }
    }

    const patchedJarRel = `net/neoforged/minecraft-client-patched/${neoVersion}/minecraft-client-patched-${neoVersion}.jar`;
    const patchedJarLibPath = path.join(ctx.dirs.LIBRARIES_DIR, patchedJarRel);
    const patchedJarVerPath = path.join(versionDir, `${versionId}.jar`);
    if (!fs.existsSync(patchedJarLibPath) || (await fs.promises.stat(patchedJarLibPath).catch(() => ({ size: 0 })).then((s) => s.size)) < 1024) {
      if (fs.existsSync(patchedJarVerPath)) {
        try {
          // [CRITICAL] ENOTDIR 修复 — 同 ensureDir，清理路径中的文件冲突。
          {
            const _d = path.dirname(patchedJarLibPath);
            for (const _p of _d.split(path.sep).map((_, _i, _a) => _a.slice(0, _i + 1).join(path.sep))) {
              if (_p) { try { const _s = fs.statSync(_p); if (!_s.isDirectory()) fs.unlinkSync(_p); } catch (_) {} }
            }
          }
          fs.mkdirSync(path.dirname(patchedJarLibPath), { recursive: true });
          fs.copyFileSync(patchedJarVerPath, patchedJarLibPath);
          console.log(`[NeoForge] Patched JAR已复制到libraries: ${path.basename(patchedJarLibPath)}`);
        } catch (e) {
          console.warn(`[NeoForge] 复制patched JAR失败: ${e.message}`);
        }
      } else {
        console.warn(`[NeoForge] Patched JAR缺失: ${patchedJarLibPath} 且版本目录也无`);
      }
    }

    try { fs.unlinkSync(installerPath); } catch (_) {}

    // [CRITICAL FIX - 2026-06-20] 必须从文件重新读取最终版本 JSON，不能用上面的 versionJson 对象直接写入！
    // 因为 mergeNeoForgeLoaderToVersion 等后续函数可能已经修改了文件中的 JSON，
    // 但这里的 versionJson 变量还是旧的引用，直接写入会覆盖掉那些修改。
    try {
      const finalJson = JSON.parse(fs.readFileSync(path.join(versionDir, `${versionId}.json`), 'utf-8'));
      fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(finalJson, null, 2));
      console.log(`[NeoForge] Final version JSON written, libs=${(finalJson.libraries || []).length}`);
    } catch (_) {}

    if (onProgress) onProgress(1, 'NeoForge 安装完成');
    return { success: true, versionId: versionId, libsMissing: neoLibFailures };
  } catch (e) {
    console.error(`[NeoForge] Installation failed: ${e.message}`);
    try {
      const vDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
      if (fs.existsSync(vDir)) {
        fs.rmSync(vDir, { recursive: true, force: true });
        console.log(`[NeoForge] Cleaned up failed version directory: ${vDir}`);
      }
    } catch (cleanupErr) {
      console.error(`[NeoForge] Failed to cleanup version directory:`, cleanupErr.message);
    }
    return { success: false, error: e.message };
  }
}

/* 模组加载器版本合并 - 将加载器特有的配置合并到版本 JSON 中 */

/**
 * 将 NeoForge 加载器配置合并到版本 JSON（提取 install_profile、合并库、下载缺失库、运行处理器打补丁）。
 * @param {string} versionId - 版本目录名，如 "1.20.1-NeoForge-47.1.0"
 * @param {string} gameVersion - Minecraft 版本号
 * @param {string} neoVersion - NeoForge 版本号
 * @param {(percent: number, message: string) => void} [onProgress] - 进度回调
 * @returns {Promise<void>}
 * @throws {Error} 当 clientdata.lzma 缺失时抛出
 */
async function mergeNeoForgeLoaderToVersion(versionId, gameVersion, neoVersion, onProgress = null) {
  const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
  const jsonPath = path.join(versionDir, `${versionId}.json`);
  const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

  // [CRITICAL FIX - 2026-06-20] 同样从 versionId 提取纯净的 MC 版本号。
  // 这个函数在 installNeoForge 之后被调用，负责合并 install_profile.json 中的运行时库。
  // 如果 inheritsFrom 写错（如 "26.2-forge-65.0.0"），launcher 会继承错误的基础版本，
  // 导致 NeoForge 的 access-transformers、earlydisplay 等关键库缺失，启动直接崩溃。
  const correctGameVersion = gameVersion.match(/^\d+\.\d+/) ? gameVersion.split('.')[0] + '.' + gameVersion.split('.').slice(1).find((p) => /^\d+$/.test(p) && parseInt(p) < 100) || gameVersion.split('.')[0] + '.' + (gameVersion.split('.')[1] || '0') : gameVersion;
  const mcVerMatch = versionId.match(/^(\d+\.\d+(?:\.\d+)?)/);
  const mcVer = mcVerMatch ? mcVerMatch[1] : (versionJson.inheritsFrom && versionJson.inheritsFrom.match(/^\d+\.\d+/) ? versionJson.inheritsFrom : correctGameVersion);
  versionJson.inheritsFrom = mcVer;
  console.log(`[NeoForge] inheritsFrom set to: ${mcVer} (gameVersion was: ${gameVersion})`);

  let profileLibs = [];
  let profileData = null;
  let installerMainClass = null;
  let installerArgs = null;

  if (onProgress) onProgress(0.1, '提取 NeoForge 安装器数据...');

  const ipPath = path.join(versionDir, 'install_profile.json');
  if (fs.existsSync(ipPath)) {
    try {
      const ipData = JSON.parse(fs.readFileSync(ipPath, 'utf-8'));
      profileLibs = ipData.libraries || [];
      profileData = ipData.data || null;
      console.log(`[NeoForge] read install_profile.json: libs=${profileLibs.length}, dataKeys=${profileData ? Object.keys(profileData).join(',') : 'none'}`);
    } catch (_) {}
  }

  if (profileLibs.length === 0) {
    const isLegacy = neoVersion.startsWith('1.20.1-');
    const pkg = isLegacy ? 'forge' : 'neoforge';
    const installerUrls = [
      `https://bmclapi2.bangbang93.com/maven/net/neoforged/${pkg}/${neoVersion}/${pkg}-${neoVersion}-installer.jar`,
      `https://maven.neoforged.net/releases/net/neoforged/${pkg}/${neoVersion}/${pkg}-${neoVersion}-installer.jar`
    ];
    const installerPath = path.join(ctx.dirs.DATA_DIR, 'temp', `neoforge-merge-${neoVersion}.jar`);
    fs.mkdirSync(path.dirname(installerPath), { recursive: true });

    let downloaded = false;
    for (const url of installerUrls) {
      try {
        if (onProgress) onProgress(0.15, `下载 NeoForge 安装器...`);
        await http.downloadFileWithMirror(url, installerPath, (p) => {
          if (onProgress && p) onProgress(0.15 + (p.progress || 0) * 0.1, `下载 NeoForge 安装器: ${p.progress || 0}%`);
        }, 3, null, 60000);
        downloaded = true;
        break;
      } catch (_) {}
    }

    if (downloaded) {
      try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(installerPath);
        const profileEntry = zip.getEntry('install_profile.json');
        if (profileEntry) {
          const ipData = JSON.parse(profileEntry.getData().toString('utf8'));
          profileLibs = ipData.libraries || [];
          profileData = ipData.data || null;
          try { fs.writeFileSync(ipPath, JSON.stringify(ipData, null, 2)); } catch (_) {}
        }
        const versionEntry = zip.getEntry('version.json');
        if (versionEntry) {
          const vData = JSON.parse(versionEntry.getData().toString('utf8'));
          installerMainClass = vData.mainClass || null;
          installerArgs = vData.arguments || null;
        }
        const clientLzmaEntry = zip.getEntry('data/client.lzma');
        if (clientLzmaEntry) {
          const isLegacy = neoVersion.startsWith('1.20.1-');
          const pkg = isLegacy ? 'forge' : 'neoforge';
          const clDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', pkg, neoVersion);
          const clPath = path.join(clDir, `${pkg}-${neoVersion}-clientdata.lzma`);
          if (!fs.existsSync(clPath)) {
            fs.mkdirSync(clDir, { recursive: true });
            fs.writeFileSync(clPath, clientLzmaEntry.getData());
            console.log(`[NeoForge] 提取 clientdata.lzma → ${clPath} (${fs.statSync(clPath).size} bytes)`);
          }
        } else {
          console.warn(`[NeoForge] 安装器中无 data/client.lzma`);
        }
      } catch (zipErr) {
        console.warn(`[NeoForge] 解压安装器失败: ${zipErr.message}`);
      }
      try { fs.unlinkSync(installerPath); } catch (_) {}
    }
  }

  if (profileLibs.length === 0) {
    try {
      const neoUrl = `${ctx.urls.NEOFORGE_API_URL}/versions/${encodeURIComponent(`net.neoforged:neoforge:${neoVersion}`)}?type=json`;
      let neoData;
      try {
        neoData = await http.fetchJSON(neoUrl, 3, 10000);
      } catch (e) {
        const mirrorNeoUrl = `https://bmclapi2.bangbang93.com/maven/api/maven/versions/${encodeURIComponent(`net.neoforged:neoforge:${neoVersion}`)}?type=json`;
        neoData = await http.fetchJSON(mirrorNeoUrl, 3, 10000);
      }
      installerMainClass = neoData.mainClass || installerMainClass;
      installerArgs = neoData.arguments || installerArgs;
      profileLibs = neoData.libraries || profileLibs;
    } catch (e) {
      console.warn(`[NeoForge] API也失败: ${e.message}`);
    }
  }

  versionJson.mainClass = installerMainClass || versionJson.mainClass || 'cpw.mods.bootstraplauncher.BootstrapLauncher';

  // XMCL: do NOT add data to version JSON
  // Keep data in install_profile.json only (used by processors, not needed at runtime)

  versionJson.arguments = versionJson.arguments || {};
  versionJson.arguments.game = versionJson.arguments.game || [];
  const hasFmlArgs = versionJson.arguments.game.some((a) => a === '--fml.neoForgeVersion');
  if (!hasFmlArgs) {
    if (installerArgs?.game) {
      versionJson.arguments.game.push(...installerArgs.game);
    } else {
      versionJson.arguments.game.push('--launchTarget', 'neoforgeclient', '--fml.neoForgeVersion', neoVersion, '--fml.mcVersion', gameVersion);
    }
  }
  if (installerArgs?.jvm) {
    const existingJvm = new Set(versionJson.arguments.jvm || []);
    for (const jvmArg of installerArgs.jvm) {
      if (!existingJvm.has(jvmArg)) {
        versionJson.arguments.jvm = versionJson.arguments.jvm || [];
        versionJson.arguments.jvm.push(jvmArg);
        existingJvm.add(jvmArg);
      }
    }
  }

  // [CRITICAL FIX - 2026-06-20] 将 install_profile.json 中的运行时库合并到版本 JSON 的 libraries 中。
  // NeoForge 的关键运行时库（如 net.neoforged:accesstransformers, earlydisplay, asm 等）
  // 只存在于 install_profile.json 的 libraries 里，不会自动出现在版本 JSON 中。
  // 如果删掉这段合并逻辑，NeoForge 启动时会报 NoSuchMethodError: AccessTransformerEngine.newEngine()
  if (profileLibs.length > 0) {
    const existingLibNames = new Set((versionJson.libraries || []).map((l) => l.name).filter(Boolean));
    let added = 0;
    for (const lib of profileLibs) {
      if (lib.name && !existingLibNames.has(lib.name)) {
        versionJson.libraries = versionJson.libraries || [];
        versionJson.libraries.push(lib);
        existingLibNames.add(lib.name);
        added++;
      }
    }
    console.log(`[NeoForge] 合并 install_profile 库: +${added}, total=${versionJson.libraries.length}`);
  }

  if (onProgress) onProgress(0.5, '下载 NeoForge 库文件...');

  const libsToDownload = (versionJson.libraries || []).filter((lib) => {
    if (lib.downloads?.artifact?.url) {
      const libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
      if (!fs.existsSync(libPath)) return true;
      const expectedSha1 = lib.downloads.artifact.sha1;
      const expectedSize = lib.downloads.artifact.size;
      if (expectedSize && fs.existsSync(libPath)) {
        try { if (fs.statSync(libPath).size === expectedSize) return false; } catch (_) {}
      }
      if (!expectedSha1) return false;
      return true;
    }
    if (lib.name) {
      const parts = lib.name.split(':');
      if (parts.length >= 3) {
        const gPath = parts[0].replace(/\./g, '/');
        const atIdx = parts[2].indexOf('@');
        const ext = atIdx >= 0 ? parts[2].substring(atIdx + 1) : 'jar';
        const ver = atIdx >= 0 ? parts[2].substring(0, atIdx) : parts[2];
        let classifier = '';
        if (parts[3]) {
          const atIdx3 = parts[3].indexOf('@');
          classifier = atIdx3 >= 0 ? parts[3].substring(0, atIdx3) : parts[3];
        }
        const fName = classifier ? `${parts[1]}-${ver}-${classifier}.${ext}` : `${parts[1]}-${ver}.${ext}`;
        const rPath = `${gPath}/${parts[1]}/${ver}/${fName}`;
        const lp = path.join(ctx.dirs.LIBRARIES_DIR, rPath);
        if (!fs.existsSync(lp)) {
          lib._mavenPath = rPath;
          lib._url = lib.url || null;
          return true;
        }
      }
    }
    return false;
  });

  if (libsToDownload.length > 0) {
    const settings = versions.loadSettingsCached();
    const NEO_PARALLEL = Math.min(parseInt(settings.maxThreads, 10) || 64, libsToDownload.length);
    let completed = 0;
    let failed = 0;
    let active = 0;
    let done = null;

    const scheduleNext = () => {
      while (active < NEO_PARALLEL && completed + failed + active < libsToDownload.length) {
        const lib = libsToDownload[completed + failed + active];
        active++;
        (async () => {
          let libPath, libUrls;
          if (lib._mavenPath) {
            libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib._mavenPath);
            libUrls = [];
            if (lib._url) libUrls.push(lib._url.replace(/\/$/, '') + '/' + lib._mavenPath.split('/').pop());
            libUrls.push(
              `https://maven.neoforged.net/releases/${lib._mavenPath}`,
              `https://maven.minecraftforge.net/${lib._mavenPath}`,
              `https://libraries.minecraft.net/${lib._mavenPath}`,
              `https://bmclapi2.bangbang93.com/maven/${lib._mavenPath}`
            );
          } else {
            libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
            libUrls = [lib.downloads.artifact.url];
          }
          const dir = path.dirname(libPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          let ok = false;
          for (const u of libUrls) {
            try { await http.downloadFileWithMirror(u, libPath, null, 2, null, 60000); ok = true; break; } catch (_) {}
          }
          if (!ok) throw new Error(`所有镜像源均失败: ${lib._mavenPath || lib.downloads?.artifact?.path}`);
          if (libPath.endsWith('.jar') && !utils.isJarIntact(libPath)) {
            throw new Error(`下载后JAR损坏: ${path.basename(libPath)}`);
          }
        })().then(() => {
          completed++;
        }).catch((e) => {
          const libId = lib._mavenPath || lib.downloads?.artifact?.path || lib.name;
          console.error(`[NeoForge] 库下载失败: ${libId} - ${e.message}`);
          try { if (lib._mavenPath) fs.unlinkSync(path.join(ctx.dirs.LIBRARIES_DIR, lib._mavenPath)); else fs.unlinkSync(path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path)); } catch (_) {}
          failed++;
        }).finally(() => {
          active--;
          if (onProgress) {
            onProgress(0.5 + 0.5 * (completed + failed) / libsToDownload.length, `下载NeoForge库 (${completed + failed}/${libsToDownload.length})...`);
          }
          if (active === 0 && completed + failed >= libsToDownload.length && done) done();
          else if (active < NEO_PARALLEL && completed + failed + active < libsToDownload.length) scheduleNext();
        });
      }
    };

    await new Promise((resolve) => { done = resolve; scheduleNext(); });
  }

  if (onProgress) onProgress(0.9, '执行 NeoForge 处理器...');

  const _isLegacy = neoVersion.startsWith('1.20.1-');
  const _pkg = _isLegacy ? 'forge' : 'neoforge';
  const _clientdataPath = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', _pkg, neoVersion, `${_pkg}-${neoVersion}-clientdata.lzma`);
  if (!fs.existsSync(_clientdataPath)) {
    const _errMsg = `NeoForge 安装失败: clientdata.lzma 缺失 (${_clientdataPath})，请检查网络后重试`;
    console.error(`[NeoForge] ${_errMsg}`);
    if (onProgress) onProgress(1, _errMsg);
    throw new Error(_errMsg);
  }

  try {
    if (onProgress) onProgress(0.92, '打补丁中...');

    const _scriptSrc = path.join(SERVER_DIR, 'server', 'modloaders', 'scripts', 'neoforge-processor.js');
    const _scriptDst = path.join(ctx.dirs.DATA_DIR, 'temp', 'neoforge-processor.js');
    try {
      fs.mkdirSync(path.dirname(_scriptDst), { recursive: true });
      if (fs.existsSync(_scriptDst)) { try { fs.unlinkSync(_scriptDst); } catch (_) {} }
      const _srcContent = fs.readFileSync(_scriptSrc, 'utf8');
      fs.writeFileSync(_scriptDst, _srcContent, 'utf8');
    } catch (_) {}

    await new Promise((resolveProc) => {
      const _args = [_scriptDst, '--root', ctx.dirs.DATA_DIR, '--libs', ctx.dirs.LIBRARIES_DIR, '--mcver', gameVersion, '--neover', neoVersion];
      console.log(`[NeoForge] Running: node ${_args.join(' ')}`);
      const _child = spawn('node', _args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
      let _stdout = '', _stderr = '';
      const _progressMap = [
        ['Running Processor', 0.93], ['Command:', 0.93],
        ['DOWNLOAD_MOJMAPS', 0.94], ['MERGE_MAPPING', 0.95],
        ['Splitting:', 0.96], ['Processing', 0.96],
        ['Sorting', 0.97], ['Remapping', 0.98],
        ['Injecting', 0.99], ['SUCCESS', 0.995]
      ];
      const _parseLine = (line) => {
        console.log(`[NeoForge] ${line}`);
        for (const [keyword, pct] of _progressMap) {
          if (line.includes(keyword)) {
            if (onProgress) onProgress(pct, line.substring(0, 80));
            break;
          }
        }
      };
      _child.stdout.on('data', (data) => {
        _stdout += data.toString();
        const lines = _stdout.split('\n');
        _stdout = lines.pop();
        for (const line of lines) _parseLine(line.trim());
      });
      _child.stderr.on('data', (data) => {
        _stderr += data.toString();
        const lines = _stderr.split('\n');
        _stderr = lines.pop();
        for (const line of lines) _parseLine(line.trim());
      });
      const _killTimer = setTimeout(() => { try { _child.kill('SIGKILL'); } catch (_) {} }, 240000);
      _child.on('close', (code) => {
        clearTimeout(_killTimer);
        if (_stdout.trim()) _parseLine(_stdout.trim());
        if (code !== 0) console.error(`[NeoForge] Script exited with code ${code}`);
        resolveProc();
      });
      _child.on('error', (err) => {
        clearTimeout(_killTimer);
        console.error(`[NeoForge] Script spawn error: ${err.message}`);
        resolveProc();
      });
    });

    const _logFile = path.join(ctx.dirs.DATA_DIR, 'temp', 'neoforge-processor.log');
    if (fs.existsSync(_logFile)) {
      try { console.log(`[NeoForge] Log:\n${fs.readFileSync(_logFile, 'utf8')}`); } catch (_) {}
    }

    const _patchedJar = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'neoforged', 'minecraft-client-patched', neoVersion, `minecraft-client-patched-${neoVersion}.jar`);
    if (fs.existsSync(_patchedJar)) {
      const _verJar = path.join(versionDir, `${versionId}.jar`);
      try { fs.copyFileSync(_patchedJar, _verJar); console.log(`[NeoForge] Copied patched JAR`); } catch (_) {}

      const _existingPatched = (versionJson.libraries || []).some((l) => l.name && l.name.includes('minecraft-client-patched'));
      if (!_existingPatched) {
        versionJson.libraries = versionJson.libraries || [];
        versionJson.libraries.push({
          name: `net.neoforged:minecraft-client-patched:${neoVersion}`,
          downloads: { artifact: { path: `net/neoforged/minecraft-client-patched/${neoVersion}/minecraft-client-patched-${neoVersion}.jar`, url: `https://maven.neoforged.net/releases/net/neoforged/minecraft-client-patched/${neoVersion}/minecraft-client-patched-${neoVersion}.jar` } }
        });
      }
    } else {
      console.warn(`[NeoForge] Patched JAR not found: ${_patchedJar}`);
    }
  } catch (procErr) {
    console.error(`[NeoForge] Processor异常: ${procErr.message}`);
  }

  fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
  versions._invalidateResolvedJsonCache(versionId);
  console.log(`[NeoForge] Loader merged: ${versionId}, libs=${(versionJson.libraries || []).length}, mainClass=${versionJson.mainClass}`);
}

/**
 * 获取指定 Minecraft 版本可用的 NeoForge/Forge 版本列表（优先 BMCLAPI，失败回退官方 Maven）。
 * @param {string} gameVersion - Minecraft 版本号，如 "1.20.1"
 * @returns {Promise<Array<{version: string, gameVersion: string, type: string}>>} 版本列表，首项为推荐版本
 */
async function getNeoForgeVersionsForGame(gameVersion) {
  const p = gameVersion.split('.');
  const mcMajor = parseInt(p[0], 10) || 0;
  const mcMinor = parseInt(p[1], 10) || 0;
  const neoPrefix = mcMajor + '.' + mcMinor;

  let allNeoForgeVersions = [];
  let allForgeVersions = [];
  let lastError = null;

  const fetchXmlVersions = async (url) => {
    const xml = await http.fetchText(url, 15000);
    const matches = xml.match(/<version>([^<]+)<\/version>/g) || [];
    return matches.map((v) => v.replace(/<\/?version>/g, ''));
  };

  try {
    const [neoVersions, forgeVersions] = await Promise.allSettled([
      fetchXmlVersions('https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml'),
      fetchXmlVersions('https://bmclapi2.bangbang93.com/maven/net/neoforged/forge/maven-metadata.xml')
    ]);
    if (neoVersions.status === 'fulfilled') allNeoForgeVersions = neoVersions.value;
    if (forgeVersions.status === 'fulfilled') allForgeVersions = forgeVersions.value;
  } catch (e) {
    lastError = e.message;
  }

  if (allNeoForgeVersions.length === 0 && allForgeVersions.length === 0) {
    try {
      const data = await http.fetchJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge', 15000);
      allNeoForgeVersions = data.versions || [];
    } catch (e) {
      lastError = e.message;
      console.warn(`[NeoForge] primary API failed: ${e.message}`);
    }
  }

  if (allNeoForgeVersions.length === 0 && allForgeVersions.length === 0) {
    console.error(`[NeoForge] 所有源均不可达，最后错误: ${lastError}`);
    return [];
  }

  const neoForgePrefix = /^\d+\.\d+/;
  const matched = [];
  const fallback = [];
  for (const ver of allNeoForgeVersions) {
    if (typeof ver !== 'string') continue;
    if (ver.startsWith(neoPrefix + '.')) {
      matched.push(ver);
    }
    if (!ver.includes('-beta') && !ver.includes('-alpha')) {
      fallback.push(ver);
    }
  }

  const forgeMatched = [];
  for (const ver of allForgeVersions) {
    if (typeof ver !== 'string') continue;
    if (ver.startsWith(gameVersion + '-') || ver.startsWith(gameVersion + '.')) {
      forgeMatched.push(ver);
    }
  }

  let result = matched.length > 0 ? matched : fallback.slice(-10);
  if (forgeMatched.length > 0) {
    for (const fv of forgeMatched) {
      if (!result.includes(fv)) result.push(fv);
    }
  }
  result = [...new Set(result)].filter((v) => typeof v === 'string').reverse();
  if (result.length > 0) {
    const stable = result.find((v) => !v.includes('-beta') && !v.includes('-alpha'));
    if (stable) {
      result = result.filter((v) => v !== stable);
      result.unshift(stable);
    }
    result[0] = { version: result[0], gameVersion, type: '推荐' };
  }
  const finalVersions = result.slice(0, 10).map((v, i) => {
    if (typeof v === 'string') return { version: v, gameVersion, type: i === 0 ? '推荐' : '' };
    return v;
  });

  console.log(`[NeoForge] Found ${finalVersions.length} versions for MC ${gameVersion}, prefix: ${neoPrefix}`);
  return finalVersions;
}

module.exports = {
  findNeoForgeCoreJars,
  installNeoForge,
  mergeNeoForgeLoaderToVersion,
  getNeoForgeVersionsForGame
};
