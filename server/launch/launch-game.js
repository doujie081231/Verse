/**
 * @file server/launch/launch-game.js
 * @description 启动入口模块。从原 server/launch.js 拆分而来。
 *              包含：launchGame（启动入口，含依赖检查与 Forge 修复）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const ctx = require('../context');
const utils = require('../utils');
const http = require('../http-client');
const versions = require('../versions');
const java = require('../java');
const dependencies = require('../dependencies');
const modloaders = require('../modloaders');
const natives = require('../natives');
const argsBuilder = require('./args-builder');
const processManager = require('./process-manager');

// 将跨模块函数绑定到本地名（保持 launchGame 内部调用不变）
const buildLaunchArguments = argsBuilder.buildLaunchArguments;
const doLaunch = processManager.doLaunch;

/* 启动游戏（入口） */
/**
 * 启动游戏主入口：完成版本解析、依赖检查、Forge 核心库修复后调用 doLaunch
 * @param {string} versionId - 版本 ID（可能含 [外部N] 标记）
 * @param {object} settings - 启动设置
 * @param {object} account - 账户信息
 * @param {boolean} [checkOnly=false] - 仅校验文件是否就绪，不真正启动
 * @returns {Promise<{success:boolean,error?:string,sessionId?:string,pid?:number,...}>} 启动结果
 */
async function launchGame(versionId, settings, account, checkOnly = false) {
  try {
    let externalVersionDir = null;
    const cleanVersionId = versionId.replace(/ \[外部\d*\]/, '');

    // 在外部整合包目录中匹配对应版本
    const externalFolders = versions.loadExternalFolders();
    for (const folder of externalFolders) {
      if (!fs.existsSync(folder.path)) continue;
      const extVersions = versions.scanExternalFolder(folder.path);
      const extVer = extVersions.find((v) => v.id === cleanVersionId || v.id === versionId ||
        path.basename(v.externalVersionDir || '') === cleanVersionId ||
        path.basename(v.externalVersionDir || '') === versionId);
      if (extVer) {
        externalVersionDir = extVer.externalVersionDir;
        break;
      }
    }

    console.log(`[LaunchGame] 版本: ${versionId}, 外部目录: ${externalVersionDir || '无'}`);

    // 路径合法性检查：! 与 ; 在 Windows classpath 中有特殊含义，必须拒绝
    const versionDirPath = externalVersionDir || path.join(ctx.dirs.VERSIONS_DIR, cleanVersionId);
    if (versionDirPath.includes('!') || versionDirPath.includes(';')) {
      return { success: false, error: '版本路径包含非法字符' };
    }

    if (cleanVersionId.includes('!') || cleanVersionId.includes(';')) {
      return { success: false, error: '版本路径包含非法字符（! 或 ;），可能导致启动失败，请修改版本名称后重试' };
    }

    let actualGameDir;
    if (externalVersionDir) {
      actualGameDir = externalVersionDir;
    } else {
      const settingsVersionId = cleanVersionId;
      const effectiveIsolation = versions.resolveVersionIsolation(settingsVersionId);
      if (effectiveIsolation) {
        actualGameDir = path.join(ctx.dirs.VERSIONS_DIR, cleanVersionId);
      } else {
        actualGameDir = settings.gameDir || ctx.dirs.DATA_DIR;
      }
    }
    const gameDirBasename = path.basename(actualGameDir);
    if (gameDirBasename.includes('!') || gameDirBasename.includes(';')) {
      return { success: false, error: `游戏路径中不可包含 ! 或 ;（${actualGameDir}）` };
    }
    const javaPathToCheck = settings.javaPath || '';
    if (javaPathToCheck) {
      const javaDir = path.dirname(javaPathToCheck);
      if (javaDir.includes('!') || javaDir.includes(';')) {
        return { success: false, error: `Java路径中不可包含 ! 或 ;（${javaPathToCheck}）` };
      }
    }

    const versionJson = versions.resolveVersionJson(cleanVersionId, externalVersionDir);
    if (!versionJson) {
      return { success: false, error: `找不到版本 ${versionId} 的JSON文件`, details: { versionId, externalVersionDir } };
    }

    // 外部整合包版本若缺 inheritsFrom，按版本号推断父版本并写回 JSON
    if (externalVersionDir && !versionJson.inheritsFrom) {
      const m = cleanVersionId.match(/^(\d+\.\d+(?:\.\d+)?)/);
      if (m) {
        const parentVer = m[1];
        versionJson.inheritsFrom = parentVer;
        try {
          const jp = versions.findVersionJson(externalVersionDir);
          if (jp) {
            const raw = JSON.parse(fs.readFileSync(jp, 'utf-8'));
            if (!raw.inheritsFrom) {
              raw.inheritsFrom = parentVer;
              fs.writeFileSync(jp, JSON.stringify(raw, null, 2));
              console.log(`[LaunchGame] 已修正 inheritsFrom: ${parentVer}`);
            }
          }
        } catch (e) {
          console.warn(`[LaunchGame] 写回 inheritsFrom 失败: ${e.message}`);
        }
      }
    }

    console.log(`[LaunchGame] JSON已解析, mainClass: ${versionJson.mainClass}, inheritsFrom: ${versionJson.inheritsFrom}`);

    // 启动前验证 Natives 完整性，缺失时自动重新解压
    {
      const nativesDir = natives.getNativesFolder(cleanVersionId);
      const criticalNatives = ['lwjgl.dll', 'lwjgl_opengl.dll', 'lwjgl_glfw.dll', 'lwjgl_stb.dll', 'lwjgl_tinyfd.dll',
        'openal.dll', 'jinput-dx8.dll', 'jinput-raw.dll'];
      const missingNatives = criticalNatives.filter((n) => {
        if (process.platform === 'win32') return !fs.existsSync(path.join(nativesDir, n));
        if (process.platform === 'darwin') return !fs.existsSync(path.join(nativesDir, n.replace('.dll', '.dylib')));
        return !fs.existsSync(path.join(nativesDir, n.replace('.dll', '.so')));
      });
      if (missingNatives.length > 0 && missingNatives.length < 6) {
        console.log(`[LaunchGame] 检测到 ${missingNatives.length} 个缺失Natives: ${missingNatives.join(', ')}，尝试重新解压...`);
        try {
          natives.extractNatives(versionJson, cleanVersionId, externalVersionDir);
          const recheckMissing = criticalNatives.filter((n) => {
            if (process.platform === 'win32') return !fs.existsSync(path.join(nativesDir, n));
            if (process.platform === 'darwin') return !fs.existsSync(path.join(nativesDir, n.replace('.dll', '.dylib')));
            return !fs.existsSync(path.join(nativesDir, n.replace('.dll', '.so')));
          });
          if (recheckMissing.length > 0) {
            console.warn(`[LaunchGame] 重新解压后仍有 ${recheckMissing.length} 个Natives缺失: ${recheckMissing.join(', ')}`);
          } else {
            console.log(`[LaunchGame] Natives重新解压成功`);
          }
        } catch (e) {
          console.error(`[LaunchGame] Natives重新解压失败: ${e.message}`);
        }
      } else if (missingNatives.length >= 6) {
        console.warn(`[LaunchGame] ⚠ 大量Natives缺失(${missingNatives.length}个)，可能影响游戏启动`);
      }
    }

    let depCheck = await dependencies.checkDependencies(cleanVersionId, settings, externalVersionDir);

    // 递归扫描继承链中所有版本的 libraries，捕获 dependencies 模块漏检的库
    const scanLibsRecursive = (verId, visited = new Set()) => {
      if (visited.has(verId)) return [];
      visited.add(verId);
      let jsonPath = path.join(ctx.dirs.VERSIONS_DIR, verId, `${verId}.json`);
      if (!fs.existsSync(jsonPath) && externalVersionDir) {
        const extRoot = versions.findExternalRoot(externalVersionDir);
        if (extRoot) {
          const extJson = path.join(extRoot, 'versions', verId, `${verId}.json`);
          if (fs.existsSync(extJson)) jsonPath = extJson;
        }
        if (!fs.existsSync(jsonPath)) {
          const dirJson = path.join(path.dirname(externalVersionDir), verId, `${verId}.json`);
          if (fs.existsSync(dirJson)) jsonPath = dirJson;
        }
      }
      if (!fs.existsSync(jsonPath)) return [];
      let data;
      try {
        data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      } catch (e) {
        return [];
      }
      const extLibBase = externalVersionDir ? versions.findExternalRoot(externalVersionDir) : null;
      const libs = (data.libraries || []).map((l) => {
        if (l.rules && !versions.evaluateRules(l.rules)) return null;
        if (l.natives) return null;
        if (l.downloads?.artifact?.path) {
          const relPath = l.downloads.artifact.path;
          const localPath = path.join(ctx.dirs.LIBRARIES_DIR, relPath);
          if (fs.existsSync(localPath)) return { name: l.name, path: localPath, url: l.downloads.artifact.url, sha1: l.downloads.artifact.sha1, size: l.downloads.artifact.size, maven: null };
          if (extLibBase) {
            const extPath = path.join(extLibBase, 'libraries', relPath);
            if (fs.existsSync(extPath)) return { name: l.name, path: extPath, url: l.downloads.artifact.url, sha1: l.downloads.artifact.sha1, size: l.downloads.artifact.size, maven: null };
          }
          return { name: l.name, path: localPath, url: l.downloads.artifact.url, sha1: l.downloads.artifact.sha1, size: l.downloads.artifact.size, maven: null };
        }
        if (l.name) {
          const p = l.name.split(':');
          if (p.length >= 3) {
            const gp = p[0].replace(/\./g, path.sep);
            const cl = p.length >= 4 ? `-${p[3]}` : '';
            const jn = `${p[1]}-${p[2]}${cl}.jar`;
            const mavenRelPath = path.join(gp, p[1], p[2], jn);
            const localMavenPath = path.join(ctx.dirs.LIBRARIES_DIR, mavenRelPath);
            if (fs.existsSync(localMavenPath)) return { name: l.name, path: localMavenPath, url: l.url || '', sha1: '', size: 0, maven: { group: p[0], artifact: p[1], version: p[2], classifier: p[3] || '' } };
            if (extLibBase) {
              const extMavenPath = path.join(extLibBase, 'libraries', mavenRelPath);
              if (fs.existsSync(extMavenPath)) return { name: l.name, path: extMavenPath, url: l.url || '', sha1: '', size: 0, maven: { group: p[0], artifact: p[1], version: p[2], classifier: p[3] || '' } };
            }
            return { name: l.name, path: localMavenPath, url: l.url || '', sha1: '', size: 0, maven: { group: p[0], artifact: p[1], version: p[2], classifier: p[3] || '' } };
          }
        }
        return null;
      }).filter(Boolean);

      const parentLibs = data.inheritsFrom ? scanLibsRecursive(data.inheritsFrom, visited) : [];
      return [...libs, ...parentLibs];
    };

    const allChainLibs = scanLibsRecursive(cleanVersionId);
    const extraMissing = [];
    for (const lib of allChainLibs) {
      if (!fs.existsSync(lib.path)) {
        let dlUrl = lib.url;
        // 缺 url 但有 maven 坐标时，按 group 推测官方仓库
        if (!dlUrl && lib.maven) {
          const { group, artifact, version, classifier } = lib.maven;
          const mg = group.replace(/\./g, '/');
          const cl = classifier ? `-${classifier}` : '';
          const jn = `${artifact}-${version}${cl}.jar`;
          const base = group.includes('neoforged') ? 'https://maven.neoforged.net/'
            : (group.includes('forge') ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/');
          dlUrl = `${base}${mg}/${artifact}/${version}/${jn}`;
        }
        if (dlUrl) {
          extraMissing.push({ type: 'library', url: dlUrl, path: lib.path, sha1: lib.sha1, size: lib.size, name: lib.name || path.basename(lib.path) });
        }
      }
    }

    if (extraMissing.length > 0) {
      console.log(`[Launch] 二次扫描发现 ${extraMissing.length} 个额外缺失库: ${extraMissing.map((f) => f.name).join(', ')}`);
      depCheck.missingFiles = [...depCheck.missingFiles.filter((f) => f.type !== 'library'), ...extraMissing];
      depCheck.libraries.missing = extraMissing;
      depCheck.libraries.ok = false;
      depCheck.libraries.message = `二次扫描: ${extraMissing.length} 个库文件缺失`;
    }

    if (!depCheck.java.ok) {
      return { success: false, error: depCheck.java.message, needDownload: false, depCheck };
    }

    if (!depCheck.versionJson.ok) {
      return { success: false, error: depCheck.versionJson.message, needDownload: false, depCheck };
    }

    if (!depCheck.parentVersion.ok) {
      return { success: false, error: depCheck.parentVersion.message, needDownload: true, depCheck };
    }

    // Forge 核心库缺失时的多级修复链：NeoForge 直接下载 → Maven → 重装 Forge → 复制 .minecraft → 深度搜索
    if (!depCheck.forgeCore.ok) {
      const forgeMissing = (depCheck.forgeCore.missing || [])
        .map((m) => `  - ${m.desc}: ${path.basename(m.path)}`)
        .join('\n');
      console.warn(`[LaunchGame] Forge核心库缺失 (${depCheck.forgeCore.missing.length}个)，尝试自动修复...`);

      let forgeRepaired = false;

      // 第一级：NeoForge universal JAR 直接从 Maven 仓库补下载
      {
        const neoMissing = (depCheck.forgeCore.missing || []).filter((m) =>
          m.path && m.path.includes(path.join('net', 'neoforged', 'neoforge')) && path.basename(m.path).includes('universal'));
        for (const m of neoMissing) {
          const relPath = path.relative(ctx.dirs.LIBRARIES_DIR, m.path).replace(/\\/g, '/');
          const neoUrls = [
            `https://maven.neoforged.net/releases/${relPath}`,
            `https://bmclapi2.bangbang93.com/maven/${relPath}`
          ];
          console.log(`[LaunchGame] 尝试补下载NeoForge核心JAR: ${path.basename(m.path)}`);
          let neoOk = false;
          for (const url of neoUrls) {
            try {
              if (!fs.existsSync(path.dirname(m.path))) fs.mkdirSync(path.dirname(m.path), { recursive: true });
              await http.downloadFile(url, m.path);
              if (fs.existsSync(m.path) && utils.isJarIntact(m.path)) {
                console.log(`[LaunchGame] NeoForge核心JAR补下载成功: ${path.basename(m.path)} (from ${url})`);
                neoOk = true;
                break;
              }
              console.warn(`[LaunchGame] 下载后JAR无效: ${url}`);
              try {
                fs.unlinkSync(m.path);
              } catch (_) {}
            } catch (e) {
              console.warn(`[LaunchGame] NeoForge核心JAR下载失败: ${url} - ${e.message}`);
            }
          }
          if (neoOk) {
            forgeRepaired = true;
          }
        }
      }

      // 第二级：Maven 直接下载 Forge 核心库；失败则重装 Forge 重新生成补丁 JAR
      {
        let mvForgeVer = '';
        let mvMcVer = '';
        for (const chainId of [cleanVersionId, versionJson.inheritsFrom].filter(Boolean)) {
          if (chainId.toLowerCase().includes('forge')) {
            const m = chainId.match(/^(.+)-neoforge-(.+)$/) || chainId.match(/^(.+)-forge-(.+)$/);
            if (m) {
              mvMcVer = m[1];
              mvForgeVer = m[2];
              break;
            }
          }
        }
        if (!mvForgeVer) {
          // 从游戏参数中提取 Forge/MC 版本
          const gArgs = versionJson.arguments?.game || [];
          const fvi = gArgs.findIndex((a) => typeof a === 'string' && (a === '--fml.forgeVersion' || a === '--fml.neoForgeVersion'));
          const mvi = gArgs.findIndex((a) => typeof a === 'string' && a === '--fml.mcVersion');
          if (fvi >= 0 && fvi + 1 < gArgs.length) mvForgeVer = gArgs[fvi + 1];
          if (mvi >= 0 && mvi + 1 < gArgs.length) mvMcVer = gArgs[mvi + 1];
        }
        if (mvForgeVer && mvMcVer) {
          console.log(`[LaunchGame] 尝试Maven直接下载Forge核心库 (${mvMcVer}-forge-${mvForgeVer})...`);
          const mvResult = await modloaders.downloadForgeCoreLibsFromMaven(`${mvMcVer}-${mvForgeVer}`);
          if (mvResult.failed === 0) {
            const stillMissing = (depCheck.forgeCore.missing || []).filter((m) => !fs.existsSync(m.path));
            if (stillMissing.length === 0) {
              console.log(`[LaunchGame] Maven直接下载修复成功!`);
              forgeRepaired = true;
            }
          } else {
            console.warn(`[LaunchGame] Maven直接下载仍有${mvResult.failed}个缺失，继续尝试其他方式...`);
          }

          if (!forgeRepaired) {
            // 补丁 JAR 不在 Maven 上，需重装 Forge 重新生成
            console.log(`[LaunchGame] 补丁JAR不在Maven上，重装Forge以重新生成...`);
            try {
              const baseJar = path.join(ctx.dirs.VERSIONS_DIR, mvMcVer, `${mvMcVer}.jar`);
              if (!fs.existsSync(baseJar)) {
                console.log(`[LaunchGame] 原版JAR缺失，先下载 ${mvMcVer}.jar...`);
                try {
                  await modloaders.ensureBaseVersionInstalled(mvMcVer);
                } catch (e) {
                  console.warn(`[LaunchGame] 下载原版JAR失败: ${e.message}`);
                }
              }
              const fiResult = await modloaders.installForge(mvMcVer, mvForgeVer, (p, msg) => {});
              if (fiResult && fiResult.success) {
                const stillMissing = (depCheck.forgeCore.missing || []).filter((m) => !fs.existsSync(m.path));
                if (stillMissing.length === 0) {
                  console.log(`[LaunchGame] Forge重装修复成功!`);
                  forgeRepaired = true;
                } else {
                  console.warn(`[LaunchGame] Forge重装后仍有${stillMissing.length}个缺失文件`);
                }
              }
            } catch (e) {
              console.warn(`[LaunchGame] Forge重装失败: ${e.message}`);
            }
          }
        }
      }

      // 第三级：通过版本 JSON 中的 Forge 标识重装 Forge（含 BMCLAPI 镜像回退）
      for (const chainId of [cleanVersionId, versionJson.inheritsFrom].filter(Boolean)) {
        if (forgeRepaired) break;
        if (!chainId.toLowerCase().includes('forge')) continue;
        let forgeJsonPath = path.join(ctx.dirs.VERSIONS_DIR, chainId, `${chainId}.json`);
        if (!fs.existsSync(forgeJsonPath) && externalVersionDir) {
          const extRoot = versions.findExternalRoot(externalVersionDir);
          if (extRoot) {
            const extJson = path.join(extRoot, 'versions', chainId, `${chainId}.json`);
            if (fs.existsSync(extJson)) forgeJsonPath = extJson;
          }
        }
        if (!fs.existsSync(forgeJsonPath)) continue;
        try {
          const forgeJson = JSON.parse(fs.readFileSync(forgeJsonPath, 'utf-8'));
          const forgeMatch = chainId.match(/^(.+)-forge-(.+)$/);
          if (!forgeMatch) continue;
          const mcVer = forgeMatch[1];
          const forgeVer = forgeMatch[2];
          const baseJarPath = path.join(ctx.dirs.VERSIONS_DIR, mcVer, `${mcVer}.jar`);
          if (!fs.existsSync(baseJarPath)) {
            console.log(`[LaunchGame] 原版JAR缺失 (${mcVer}.jar)，先下载再重装Forge...`);
            try {
              await modloaders.ensureBaseVersionInstalled(mcVer);
            } catch (e) {
              console.warn(`[LaunchGame] 下载原版JAR失败: ${e.message}`);
            }
          }
          console.log(`[LaunchGame] 尝试重新安装Forge ${mcVer}-${forgeVer}来修复核心文件`);
          let repairResult = await modloaders.installForge(mcVer, forgeVer, (p, msg) => {
            console.log(`[LaunchGame] 修复进度: ${Math.round(p * 100)}% - ${msg || ''}`);
          });
          if (!repairResult.success) {
            console.log(`[LaunchGame] 主源修复失败，尝试BMCLAPI镜像...`);
            repairResult = await modloaders.installForge(mcVer, forgeVer, (p, msg) => {
              console.log(`[LaunchGame] BMCLAPI镜像修复进度: ${Math.round(p * 100)}% - ${msg || ''}`);
            }, 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge');
          }
          if (repairResult.success) {
            const stillMissing = (depCheck.forgeCore.missing || []).filter((m) => !fs.existsSync(m.path));
            if (stillMissing.length === 0) {
              console.log(`[LaunchGame] Forge核心文件自动修复成功!`);
              forgeRepaired = true;
            } else {
              console.warn(`[LaunchGame] 修复后仍有 ${stillMissing.length} 个文件缺失`);
            }
          } else {
            console.warn(`[LaunchGame] Forge自动修复失败: ${repairResult.error}`);
          }
        } catch (repairErr) {
          console.warn(`[LaunchGame] Forge自动修复异常: ${repairErr.message}`);
        }
      }

      // 第四级：从本机 .minecraft libraries 目录复制已有文件
      if (!forgeRepaired) {
        const altMinecraftDir = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
        if (fs.existsSync(altMinecraftDir)) {
          let altCopied = 0;
          for (const m of (depCheck.forgeCore.missing || [])) {
            if (fs.existsSync(m.path)) continue;
            const relPath = path.relative(ctx.dirs.LIBRARIES_DIR, m.path).replace(/\\/g, '/');
            const altLibPath = path.join(altMinecraftDir, 'libraries', relPath);
            if (fs.existsSync(altLibPath)) {
              try {
                if (!fs.existsSync(path.dirname(m.path))) fs.mkdirSync(path.dirname(m.path), { recursive: true });
                fs.copyFileSync(altLibPath, m.path);
                if (fs.existsSync(m.path) && (!m.path.endsWith('.jar') || utils.isJarIntact(m.path))) {
                  altCopied++;
                } else {
                  try {
                    fs.unlinkSync(m.path);
                  } catch (_) {}
                }
              } catch (_) {}
            }
          }
          if (altCopied > 0) {
            const stillMissing = (depCheck.forgeCore.missing || []).filter((m) => !fs.existsSync(m.path));
            if (stillMissing.length === 0) {
              console.log(`[LaunchGame] 从.minecraft复制修复成功!`);
              forgeRepaired = true;
            }
          }
        }
      }

      // 第五级：深度搜索其他启动器/自定义游戏目录的 libraries
      if (!forgeRepaired) {
        const forgeSearchDirs = [];
        if (externalVersionDir) {
          const extRoot = versions.findExternalRoot(externalVersionDir);
          if (extRoot) forgeSearchDirs.push(path.join(extRoot, 'libraries'));
        }
        forgeSearchDirs.push(ctx.dirs.LIBRARIES_DIR);
        const homeLib = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', 'libraries');
        if (fs.existsSync(homeLib) && !forgeSearchDirs.includes(homeLib)) forgeSearchDirs.push(homeLib);
        // 扫描其他启动器的库目录
        const hmclLib = path.join(os.homedir(), 'AppData', 'Roaming', '.hmcl', 'libraries');
        if (fs.existsSync(hmclLib) && !forgeSearchDirs.includes(hmclLib)) forgeSearchDirs.push(hmclLib);
        const bakaLib = path.join(os.homedir(), 'AppData', 'Roaming', '.bakalx', 'libraries');
        if (fs.existsSync(bakaLib) && !forgeSearchDirs.includes(bakaLib)) forgeSearchDirs.push(bakaLib);
        // 也扫描常见的自定义游戏目录
        const customDirs = [path.join(os.homedir(), '.pcl'), path.join(os.homedir(), 'Documents', 'PCL'), path.join(os.homedir(), 'PCL')];
        for (const cd of customDirs) {
          if (!fs.existsSync(cd)) continue;
          try {
            const subs = fs.readdirSync(cd).filter((s) => fs.statSync(path.join(cd, s)).isDirectory());
            for (const s of subs) {
              const cl = path.join(cd, s, 'libraries');
              if (fs.existsSync(cl) && !forgeSearchDirs.includes(cl)) forgeSearchDirs.push(cl);
            }
          } catch (_) {}
        }

        let deepCopied = 0;
        for (const m of (depCheck.forgeCore.missing || [])) {
          if (fs.existsSync(m.path)) continue;
          const basename = path.basename(m.path);
          const parentDir = path.dirname(m.path);
          const grandParent = path.dirname(parentDir);
          const verDirName = path.basename(parentDir);
          const libType = path.basename(grandParent);
          const libGroup = path.basename(path.dirname(grandParent));

          for (const searchDir of forgeSearchDirs) {
            if (!fs.existsSync(searchDir)) continue;
            try {
              const typeDir = path.join(searchDir, libGroup, libType);
              if (!fs.existsSync(typeDir)) continue;
              const versionDirs = fs.readdirSync(typeDir).filter((d) => {
                try {
                  return fs.statSync(path.join(typeDir, d)).isDirectory();
                } catch (_) {
                  return false;
                }
              });
              for (const vd of versionDirs) {
                const candidatePath = path.join(typeDir, vd, basename);
                if (fs.existsSync(candidatePath)) {
                  try {
                    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
                    fs.copyFileSync(candidatePath, m.path);
                    if (fs.existsSync(m.path) && (!m.path.endsWith('.jar') || utils.isJarIntact(m.path))) {
                      deepCopied++;
                      console.log(`[LaunchGame] 深度搜索修复: ${basename} (来源: ${candidatePath})`);
                    } else {
                      try {
                        fs.unlinkSync(m.path);
                      } catch (_) {}
                    }
                  } catch (_) {}
                  break;
                }
              }
              if (fs.existsSync(m.path)) break;
            } catch (_) {}
          }
        }
        if (deepCopied > 0) {
          const stillMissing = (depCheck.forgeCore.missing || []).filter((m) => !fs.existsSync(m.path));
          if (stillMissing.length === 0) {
            console.log(`[LaunchGame] 深度搜索修复成功!`);
            forgeRepaired = true;
          }
        }
      }

      // 所有修复策略失败：拒绝启动并返回修复指引
      if (!forgeRepaired) {
        const missingDetail = (depCheck.forgeCore.missing || [])
          .map((m) => `  - ${m.desc || m.name}: ${path.basename(m.path)}`)
          .join('\n');
        const forgeErrorMsg = `Forge 核心库文件缺失 (${depCheck.forgeCore.missing.length}个)，无法启动游戏。\n` +
          `缺失文件:\n${missingDetail}\n\n` +
          `修复建议:\n` +
          `1) 前往"版本设置 → 文件修复"自动修复\n` +
          `2) 重新安装该Forge版本\n` +
          `3) 检查杀毒软件是否将Forge文件拦截并加入白名单`;
        console.error(`[LaunchGame] Forge核心库缺失，自动修复失败，拒绝启动`);
        console.error(`[LaunchGame] 修复建议: 1)文件修复 2)重新安装Forge 3)检查杀毒白名单`);
        return {
          success: false,
          error: forgeErrorMsg,
          needDownload: false,
          depCheck,
          repairHint: 'forge_core_missing'
        };
      }
    }

    // 兜底检查：直接扫描继承链中所有版本的 libraries，确认 Forge 核心 JAR 存在
    const chainIds = [];
    {
      let current = cleanVersionId;
      const chainVisited = new Set();
      const chainSearchBases = [ctx.dirs.VERSIONS_DIR];
      if (externalVersionDir) {
        const extRoot = versions.findExternalRoot(externalVersionDir);
        if (extRoot) chainSearchBases.unshift(path.join(extRoot, 'versions'));
        chainSearchBases.unshift(path.join(path.dirname(externalVersionDir), current));
        const extFolders = versions.loadExternalFolders();
        for (const f of extFolders) {
          if (fs.existsSync(path.join(f.path, 'versions'))) chainSearchBases.push(path.join(f.path, 'versions'));
        }
      }
      while (current && !chainVisited.has(current)) {
        chainVisited.add(current);
        chainIds.push(current);
        let vjFound = false;
        for (const base of chainSearchBases) {
          const vjPath = path.join(base, current, `${current}.json`);
          if (fs.existsSync(vjPath)) {
            try {
              const vj = JSON.parse(fs.readFileSync(vjPath, 'utf-8'));
              current = vj.inheritsFrom || null;
              vjFound = true;
              break;
            } catch (_) {
              break;
            }
          }
        }
        if (!vjFound) break;
      }
    }
    const forgeSafeChain = chainIds.some((id) => id.toLowerCase().includes('forge'));
    if (forgeSafeChain) {
      const forgeSafeMissing = [];
      let externalRootSafe = null;
      if (externalVersionDir) {
        externalRootSafe = versions.findExternalRoot(externalVersionDir);
        if (!externalRootSafe) externalRootSafe = path.dirname(path.dirname(externalVersionDir));
      }
      // 检查版本 JSON 中声明的 Forge 核心 JAR（client-srg/client-extra/forge-*）
      for (const lib of (versionJson.libraries || [])) {
        if (!lib.name) continue;
        const fp = lib.name.split(':');
        if (fp.length < 3) continue;
        const gp = fp[0].replace(/\./g, path.sep);
        const cl = fp.length >= 4 ? `-${fp[3]}` : '';
        const jn = `${fp[1]}-${fp[2]}${cl}.jar`;
        const isForgeCore = (fp[0] === 'net.minecraftforge' && fp[1] === 'forge' && cl) ||
          (fp[0] === 'net.minecraft' && fp[1] === 'client' && (cl === '-srg' || cl === '-extra'));
        if (isForgeCore) {
          const localPath = path.join(ctx.dirs.LIBRARIES_DIR, gp, fp[1], fp[2], jn);
          if (externalRootSafe) {
            const extPath = path.join(externalRootSafe, 'libraries', gp, fp[1], fp[2], jn);
            if (fs.existsSync(extPath) && (!extPath.endsWith('.jar') || utils.isJarIntact(extPath))) continue;
          }
          if (!fs.existsSync(localPath) || !utils.isJarIntact(localPath)) {
            forgeSafeMissing.push({ desc: jn, path: localPath });
          }
        }
      }
      if (forgeSafeMissing.length > 0) {
        const missingNames = forgeSafeMissing.map((f) => f.desc).join(', ');
        console.warn(`[LaunchGame] 兜底检查发现Forge核心库缺失 (${forgeSafeMissing.length}个): ${missingNames}`);

        let safeRepaired = false;
        // 兜底修复：重装 Forge（主源 → BMCLAPI 镜像）
        for (const chainId of chainIds) {
          if (safeRepaired) break;
          if (!chainId.toLowerCase().includes('forge')) continue;
          const forgeMatch = chainId.match(/^(.+)-forge-(.+)$/);
          if (!forgeMatch) continue;
          const mcVer = forgeMatch[1];
          const forgeVer = forgeMatch[2];
          console.log(`[LaunchGame] 兜底修复: 重新安装Forge ${mcVer}-${forgeVer}`);
          try {
            let repairResult = await modloaders.installForge(mcVer, forgeVer, (p, msg) => {
              console.log(`[LaunchGame] 兜底修复进度: ${Math.round(p * 100)}%`);
            });
            if (!repairResult.success) {
              console.log(`[LaunchGame] 兜底修复主源失败，尝试BMCLAPI镜像...`);
              repairResult = await modloaders.installForge(mcVer, forgeVer, (p, msg) => {
                console.log(`[LaunchGame] 兜底BMCLAPI修复进度: ${Math.round(p * 100)}%`);
              }, 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge');
            }
            if (repairResult.success) {
              const stillMissing = forgeSafeMissing.filter((f) => !fs.existsSync(f.path) || !utils.isJarIntact(f.path));
              if (stillMissing.length === 0) {
                console.log(`[LaunchGame] 兜底修复成功!`);
                safeRepaired = true;
              }
            }
          } catch (_) {}
        }

        // 兜底修复失败：尝试从 .minecraft 复制
        if (!safeRepaired) {
          const altMinecraftDir = path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft');
          if (fs.existsSync(altMinecraftDir)) {
            for (const f of forgeSafeMissing) {
              if (fs.existsSync(f.path)) continue;
              const relPath = path.relative(ctx.dirs.LIBRARIES_DIR, f.path).replace(/\\/g, '/');
              const altLibPath = path.join(altMinecraftDir, 'libraries', relPath);
              if (fs.existsSync(altLibPath)) {
                try {
                  if (!fs.existsSync(path.dirname(f.path))) fs.mkdirSync(path.dirname(f.path), { recursive: true });
                  fs.copyFileSync(altLibPath, f.path);
                  if (fs.existsSync(f.path) && (!f.path.endsWith('.jar') || utils.isJarIntact(f.path))) {
                    safeRepaired = true;
                  } else {
                    try {
                      fs.unlinkSync(f.path);
                    } catch (_) {}
                  }
                } catch (_) {}
              }
            }
            if (safeRepaired) {
              const stillMissing = forgeSafeMissing.filter((f) => !fs.existsSync(f.path) || !utils.isJarIntact(f.path));
              if (stillMissing.length > 0) safeRepaired = false;
            }
          }
        }

        if (!safeRepaired) {
          return {
            success: false,
            error: `Forge 核心库文件缺失 (${forgeSafeMissing.length}个)，无法启动游戏。\n缺失文件: ${missingNames}\n请在版本设置中使用"文件修复"功能，或重新安装该版本。`,
            needDownload: false,
            depCheck,
            repairHint: 'forge_core_missing'
          };
        }
      }
    }

    // 缺失文件分类：核心库必须修复，非核心库可跳过自动下载直接启动
    const nonForgeCoreMissing = depCheck.missingFiles.filter((f) => f.type !== 'forge_core');
    if (nonForgeCoreMissing.length > 0) {
      const _LAUNCH_CORE_PREFIXES = ['net.minecraftforge', 'net.neoforged', 'cpw.mods', 'net.minecraft'];
      const criticalMissing = nonForgeCoreMissing.filter((f) => f.type === 'main_jar' || f.type === 'parent_version' || f.type === 'native' || f.type === 'asset' || f.type === 'asset_index');
      const nonCoreLibMissing = nonForgeCoreMissing.filter((f) => f.type === 'library' && f.name && !_LAUNCH_CORE_PREFIXES.some((p) => f.name.split(':')[0].startsWith(p)));
      const coreLibMissing = nonForgeCoreMissing.filter((f) => f.type === 'library' && f.name && _LAUNCH_CORE_PREFIXES.some((p) => f.name.split(':')[0].startsWith(p)));

      if (criticalMissing.length === 0 && coreLibMissing.length === 0 && nonCoreLibMissing.length > 0) {
        // 仅非核心库缺失时跳过下载直接启动，避免阻塞整合包大体积可选库
        console.log(`[LaunchGame] 跳过非核心库自动下载 (${nonCoreLibMissing.length}个)，直接尝试启动`);
        for (const f of nonCoreLibMissing) {
          console.log(`[LaunchGame] 非核心库缺失(不影响启动): ${f.name || f.path}`);
        }
      } else {
        // 启动后台下载会话，前端可通过 sessionId 跟踪进度
        const sessionId = `launch-${Date.now()}`;
        ctx.sessions.launchSessions.set(sessionId, {
          status: 'downloading',
          progress: 0,
          message: `正在下载 ${nonForgeCoreMissing.length} 个缺失文件..`,
          totalFiles: nonForgeCoreMissing.length,
          completedFiles: 0,
          currentFile: '',
          errors: [],
          versionId
        });

        console.log(`[LaunchGame] 缺失 ${nonForgeCoreMissing.length} 个文件，启动后台下载...`);
        const _bgDlVersionJson = versionJson;
        const _bgDlExternalDir = externalVersionDir;
        const _bgDlCleanId = cleanVersionId;
        (async () => {
          try {
            await dependencies.downloadMissingDependencies(nonForgeCoreMissing, (p) => {
              if (!ctx.sessions.launchSessions.has(sessionId)) return;
              const sess = ctx.sessions.launchSessions.get(sessionId);
              if (p.progress !== undefined) sess.progress = p.progress;
              if (p.file) sess.currentFile = p.file;
              if (p.current !== undefined) sess.completedFiles = p.current;
              if (p.total !== undefined) sess.totalFiles = p.total;
              if (p.speed !== undefined) sess.speed = p.speed;
              if (p.msg) sess.message = p.msg;
              if (p.message) sess.message = p.message;
              if (p.activeDownloads) sess.activeDownloads = p.activeDownloads;
              if (p.failed !== undefined) sess.failed = p.failed;
              if (p.status === 'completed' || p.status === 'completed_with_errors') sess.status = 'completed';
              if (p.status === 'failed') {
                sess.status = 'failed';
                sess.message = p.message || p.msg || '下载失败';
              }
            }, _bgDlVersionJson, null, _bgDlExternalDir);
            const sess = ctx.sessions.launchSessions.get(sessionId);
            if (sess) {
              sess.status = 'completed';
              sess.message = '缺失文件下载完成';
            }
            console.log(`[LaunchGame] 后台下载完成，缓存已失效`);
            java.invalidateDepCheckCache(_bgDlCleanId);
          } catch (dlErr) {
            console.error(`[LaunchGame] 后台下载失败: ${dlErr.message}`);
            const sess = ctx.sessions.launchSessions.get(sessionId);
            if (sess) {
              sess.status = 'failed';
              sess.message = '下载失败: ' + dlErr.message;
            }
          }
        })();

        return {
          success: true,
          needDownload: true,
          sessionId,
          totalFiles: nonForgeCoreMissing.length,
          message: `正在下载 ${nonForgeCoreMissing.length} 个缺失文件...`
        };
      }
    }

    if (checkOnly) {
      return { success: true, ready: true, message: '所有文件就绪，可以启动' };
    }

    return doLaunch(cleanVersionId, versionJson, settings, account, externalVersionDir, versionId);
  } catch (e) {
    console.error(`[LaunchGame] 异常: ${e.message}`);
    console.error(`[LaunchGame] 堆栈: ${e.stack}`);
    const errDetail = { versionId, error: e.message, stack: e.stack, timestamp: new Date().toISOString() };
    try {
      if (!fs.existsSync(ctx.dirs.LOGS_DIR)) fs.mkdirSync(ctx.dirs.LOGS_DIR, { recursive: true });
      fs.writeFileSync(path.join(ctx.dirs.LOGS_DIR, `launch-error-${Date.now()}.json`), JSON.stringify(errDetail, null, 2), 'utf-8');
    } catch (_) {}
    return {
      success: false,
      error: `启动流程异常: ${e.message}`,
      details: errDetail
    };
  }
}

module.exports = { launchGame };
