/**
 * @file server/dependencies/forge.js - Forge / NeoForge 核心库检查
 * @description 从原 dependencies.js 中提取的 Forge 核心依赖检查逻辑。
 *   包含 inheritsFrom 链上的 Forge 版本识别、新版 Forge 格式检测、
 *   以及各类 Forge / NeoForge 核心库文件的存在性与完整性校验。
 */

const { fs, path, ctx, utils, versions } = require('./_shared');

/**
 * 沿 inheritsFrom 链判断版本是否依赖 Forge（非 NeoForge）
 * @param {string} vid - 版本 ID
 * @param {Set<string>} [visited] - 已访问版本 ID 集合，防回环
 * @returns {boolean}
 */
function scanInheritsForge(vid, visited) {
  if (!vid || (visited && visited.has(vid))) return false;
  if (!visited) visited = new Set();
  const vl = vid.toLowerCase();
  if (vl.includes('forge') && !vl.includes('neoforge') && !vl.includes('neoforged')) return true;
  visited.add(vid);
  const vjPath = path.join(ctx.dirs.VERSIONS_DIR, vid, `${vid}.json`);
  if (!fs.existsSync(vjPath)) return false;
  try {
    const vj = JSON.parse(fs.readFileSync(vjPath, 'utf-8'));
    if (vj.inheritsFrom && !visited.has(vj.inheritsFrom)) {
      return scanInheritsForge(vj.inheritsFrom, visited);
    }
  } catch (_) {}
  return false;
}

/**
 * 检查 Forge / NeoForge 核心库文件完整性，将缺失项写入 result.forgeCore 与 result.missingFiles
 * @param {object} versionJson - 版本 JSON 对象
 * @param {string} versionId - 版本目录名
 * @param {string|null} externalVersionDir - 外部版本目录
 * @param {object} result - 依赖检查结果对象（将被修改）
 */
function checkForgeCore(versionJson, versionId, externalVersionDir, result) {
  const hasForgeLibs = (libs) => (libs || []).some((l) =>
    l.name && (l.name.startsWith('net.minecraftforge:forge:') ||
      l.name.startsWith('net.minecraftforge:fmlloader:') ||
      l.name.startsWith('net.neoforged:neoforge:') ||
      l.name.startsWith('net.neoforged.fancymodloader:') ||
      (l.name.startsWith('net.minecraft:client:') && (l.name.endsWith(':srg') || l.name.endsWith(':extra')))));

  const _depVLower = versionId.toLowerCase();
  const _depIsNeo = _depVLower.includes('neoforge') || _depVLower.includes('neoforged');
  const _depHasForgeId = _depVLower.includes('forge') && !_depIsNeo;
  const _depHasForgeLibOnly = (versionJson.libraries || []).some((l) =>
    l.name && (l.name.startsWith('net.minecraftforge:forge:') || l.name.startsWith('net.minecraftforge:fmlloader:')));
  const isForgeVersion = _depHasForgeId || scanInheritsForge(versionId) || _depHasForgeLibOnly;
  result.forgeCore = { ok: true, missing: [], message: '' };

  if (isForgeVersion) {
    const forgeCoreLibs = [];
    const forgeLibraries = versionJson.libraries || [];

    const isNeoForgeVersion = (versionJson.libraries || []).some((l) => l.name && (l.name.startsWith('net.neoforged:neoforge:') || l.name.startsWith('net.neoforged.fancymodloader:')));
    const hasNeoForgeLibs = (versionJson.libraries || []).some((l) => l.name && l.name.startsWith('net.neoforged'));

    // [CRITICAL - 2026-06-21] MC 26+ 新版 Forge 格式检测
    // MC 26.2 + Forge 65.0.0 使用全新格式：Forge 核心嵌入在版本 JAR 中（39MB），
    // 不再有独立的 fmlcore、client-srg、client-extra 文件。
    // 特征：mainClass 是 net.minecraft.client.main.Main（不是 BootstrapLauncher），
    //       gameArgs 中没有 --fml.forgeVersion，libraries 中没有 net.minecraftforge 库。
    // 此时应跳过核心文件检查，因为版本 JAR 已包含所有 Forge 核心代码。
    // [AI-AUTOGEN-WARNING] 不要删除 isNewForgeFormat 检测逻辑，否则 MC 26+ Forge 版本
    // 会因 DepCheck 误报核心库缺失而无法启动。
    const gameArgs = versionJson.arguments?.game || [];
    const hasFmlArgs = gameArgs.some((a) => typeof a === 'string' && (a === '--fml.forgeVersion' || a === '--fml.mcVersion'));
    const hasBootstrapMain = (versionJson.mainClass || '').includes('bootstraplauncher') || (versionJson.mainClass || '').includes('BootstrapLauncher') || (versionJson.mainClass || '').includes('cpw.mods');
    const hasForgeLibsInJson = forgeLibraries.some((l) => l.name && (l.name.startsWith('net.minecraftforge:forge:') || l.name.startsWith('net.minecraftforge:fmlloader:') || l.name.startsWith('net.minecraftforge:fmlcore:')));
    const isNewForgeFormat = !isNeoForgeVersion && !hasFmlArgs && !hasBootstrapMain && !hasForgeLibsInJson;

    if (isNewForgeFormat) {
      result.forgeCore = { ok: true, missing: [], message: '新版Forge格式，核心已嵌入版本JAR' };
    } else {
      // 从 libraries 中定位各类 Forge 核心库
      const forgeClientLib = forgeLibraries.find((l) =>
        l.name && /^net\.minecraftforge:forge:\d/.test(l.name) && l.name.endsWith(':client')) ||
        forgeLibraries.find((l) =>
          l.name && /^net\.minecraftforge:forge:\d/.test(l.name) && l.name.split(':').length === 3);
      const forgeMainLib = forgeLibraries.find((l) =>
        l.name && /^net\.minecraftforge:forge:\d/.test(l.name) && l.name.split(':').length === 3);
      const neoForgeLib = forgeLibraries.find((l) => l.name && l.name.startsWith('net.neoforged:neoforge:'));
      const neoFmlLib = forgeLibraries.find((l) => l.name && l.name.startsWith('net.neoforged.fancymodloader:loader:'));
      const srgLib = forgeLibraries.find((l) =>
        l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':srg'));
      const extraLib = forgeLibraries.find((l) =>
        l.name && l.name.startsWith('net.minecraft:client:') && l.name.endsWith(':extra'));

      // 外部版本目录的 libraries 根，用于回退查找
      let externalRootForForge = null;
      if (externalVersionDir) {
        externalRootForForge = versions.findExternalRoot(externalVersionDir);
        if (!externalRootForForge) externalRootForForge = path.dirname(path.dirname(externalVersionDir));
      }

      // 按 maven 坐标计算本地/外部核心库目录
      const forgeCoreDir = (fp) => path.join(ctx.dirs.LIBRARIES_DIR, fp[0].replace(/\./g, path.sep), fp[1], fp[2]);
      const forgeCoreDirExt = (fp) => externalRootForForge ? path.join(externalRootForForge, 'libraries', fp[0].replace(/\./g, path.sep), fp[1], fp[2]) : null;

      // 在本地/外部目录中查找核心 JAR，找不到时返回本地路径（便于后续报缺失）
      const findForgeCoreFile = (fp, jarName) => {
        const localPath = path.join(forgeCoreDir(fp), jarName);
        if (fs.existsSync(localPath)) return localPath;
        const extDir = forgeCoreDirExt(fp);
        if (extDir) {
          const extPath = path.join(extDir, jarName);
          if (fs.existsSync(extPath)) return extPath;
        }
        return localPath;
      };

      if (forgeClientLib) {
        const fp = forgeClientLib.name.split(':');
        const cl = fp.length >= 4 ? `-${fp[3]}` : '';
        forgeCoreLibs.push({
          name: forgeClientLib.name,
          path: findForgeCoreFile(fp, `${fp[1]}-${fp[2]}${cl}.jar`),
          desc: 'Forge客户端核心'
        });
      }
      if (forgeMainLib && forgeMainLib !== forgeClientLib) {
        const fp = forgeMainLib.name.split(':');
        forgeCoreLibs.push({
          name: forgeMainLib.name,
          path: findForgeCoreFile(fp, `${fp[1]}-${fp[2]}.jar`),
          desc: 'Forge主核心'
        });
      }
      if (srgLib) {
        const sp = srgLib.name.split(':');
        forgeCoreLibs.push({
          name: srgLib.name,
          path: findForgeCoreFile(sp, `${sp[1]}-${sp[2]}-srg.jar`),
          desc: 'Minecraft SRG映射客户端'
        });
      }
      if (extraLib) {
        const ep = extraLib.name.split(':');
        forgeCoreLibs.push({
          name: extraLib.name,
          path: findForgeCoreFile(ep, `${ep[1]}-${ep[2]}-extra.jar`),
          desc: 'Minecraft额外客户端'
        });
      }
      if (neoForgeLib) {
        const fp = neoForgeLib.name.split(':');
        const cl = fp.length >= 4 ? `-${fp[3]}` : '';
        forgeCoreLibs.push({
          name: neoForgeLib.name,
          path: findForgeCoreFile(fp, `${fp[1]}-${fp[2]}${cl}.jar`),
          desc: 'NeoForge核心'
        });
      }
      if (neoFmlLib) {
        const fp = neoFmlLib.name.split(':');
        forgeCoreLibs.push({
          name: neoFmlLib.name,
          path: findForgeCoreFile(fp, `${fp[1]}-${fp[2]}.jar`),
          desc: 'NeoForge FML加载器'
        });
      }

      // libraries 中未直接找到核心库时，按版本号目录结构兜底搜索
      if (forgeCoreLibs.length === 0) {
        let forgeVerMatch = versionId.match(/^(.+)-[Nn]eo[Ff]orge-(.+)$/) || versionId.match(/^(.+)-[Ff]orge-(.+)$/);
        if (!forgeVerMatch && versionJson.inheritsFrom) {
          forgeVerMatch = versionJson.inheritsFrom.match(/^(.+)-[Nn]eo[Ff]orge-(.+)$/) || versionJson.inheritsFrom.match(/^(.+)-[Ff]orge-(.+)$/);
        }
        if (forgeVerMatch) {
          const mcVer = forgeVerMatch[1];
          const fVer = forgeVerMatch[2];
          const forgeSearchBases = [ctx.dirs.LIBRARIES_DIR];
          if (externalRootForForge) forgeSearchBases.unshift(path.join(externalRootForForge, 'libraries'));
          let forgeDirFound = false;
          // 1) Forge client jar
          for (const base of forgeSearchBases) {
            const forgeDir = path.join(base, 'net', 'minecraftforge', 'forge', `${mcVer}-${fVer}`);
            if (fs.existsSync(forgeDir)) {
              try {
                const files = fs.readdirSync(forgeDir);
                const clientJar = files.find((f) => f.endsWith('-client.jar'));
                if (clientJar) { forgeCoreLibs.push({ name: `forge-client:${mcVer}-${fVer}`, path: path.join(forgeDir, clientJar), desc: 'Forge客户端核心' }); forgeDirFound = true; }
              } catch (_) {}
              break;
            }
          }
          // 2) NeoForge jar
          for (const base of forgeSearchBases) {
            const neoDir = path.join(base, 'net', 'neoforged', 'neoforge', fVer);
            if (fs.existsSync(neoDir)) {
              try {
                const files = fs.readdirSync(neoDir);
                const neoJar = files.find((f) => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'));
                if (neoJar) { forgeCoreLibs.push({ name: `net.neoforged:neoforge:${fVer}`, path: path.join(neoDir, neoJar), desc: 'NeoForge核心' }); forgeDirFound = true; }
              } catch (_) {}
              break;
            }
          }
          // 3) Minecraft client srg/extra
          for (const base of forgeSearchBases) {
            const clientDir = path.join(base, 'net', 'minecraft', 'client');
            if (fs.existsSync(clientDir)) {
              try {
                for (const sd of fs.readdirSync(clientDir)) {
                  if (!sd.startsWith(`${mcVer}-`) && sd !== mcVer) continue;
                  const fullDir = path.join(clientDir, sd);
                  try { if (!fs.statSync(fullDir).isDirectory()) continue; } catch (_) { continue; }
                  const files = fs.readdirSync(fullDir);
                  const srgFile = files.find((f) => f.endsWith('-srg.jar'));
                  if (srgFile) forgeCoreLibs.push({ name: `client-srg:${sd}`, path: path.join(fullDir, srgFile), desc: 'Minecraft SRG映射客户端' });
                  const extraFile = files.find((f) => f.endsWith('-extra.jar'));
                  if (extraFile) forgeCoreLibs.push({ name: `client-extra:${sd}`, path: path.join(fullDir, extraFile), desc: 'Minecraft额外客户端' });
                }
              } catch (_) {}
              break;
            }
          }
          // 4) 新式Forge (1.13+, bootstraplauncher): 检查模块化核心库
          if ((versionJson.mainClass || '').includes('bootstraplauncher') || (versionJson.mainClass || '').includes('ForgeBootstrap')) {
            const fmlVersion = `${mcVer}-${fVer}`;
            const moduleNames = ['fmlcore', 'javafmllanguage', 'mclanguage', 'lowcodelanguage'];
            for (const modName of moduleNames) {
              const modPath = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', modName, fmlVersion, `${modName}-${fmlVersion}.jar`);
              if (!forgeCoreLibs.some((f) => f.path === modPath)) forgeCoreLibs.push({ name: `net.minecraftforge:${modName}:${fmlVersion}`, path: modPath, desc: `Forge模块:${modName}` });
            }
          }
          // 5) NeoForge 不需要 patching JARs；Forge 需要补 client-srg/client-extra/forge-client
          if (!_depIsNeo) {
            forgeCoreLibs.push({ name: `net.minecraftforge:forge:${mcVer}-${fVer}:client`, path: path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', `${mcVer}-${fVer}`, `forge-${mcVer}-${fVer}-client.jar`), desc: 'Forge客户端核心' });
            const clientBaseDir = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraft', 'client');
            let mcpDirName = null;
            try {
              if (fs.existsSync(clientBaseDir)) {
                const subdirs = fs.readdirSync(clientBaseDir).filter((d) => d.startsWith(`${mcVer}-`) && fs.statSync(path.join(clientBaseDir, d)).isDirectory());
                if (subdirs.length > 0) mcpDirName = subdirs[0];
              }
            } catch (_) {}
            if (mcpDirName) {
              forgeCoreLibs.push({ name: `net.minecraft:client:${mcpDirName}:srg`, path: path.join(clientBaseDir, mcpDirName, `client-${mcpDirName}-srg.jar`), desc: 'Minecraft SRG映射客户端' });
              forgeCoreLibs.push({ name: `net.minecraft:client:${mcpDirName}:extra`, path: path.join(clientBaseDir, mcpDirName, `client-${mcpDirName}-extra.jar`), desc: 'Minecraft额外客户端' });
            } else if (!((versionJson.mainClass || '').includes('bootstraplauncher') || (versionJson.mainClass || '').includes('ForgeBootstrap'))) {
              forgeCoreLibs.push({ name: `net.minecraft:client:${mcVer}:srg`, path: path.join(clientBaseDir, `${mcVer}-mcp`, `client-${mcVer}-mcp-srg.jar`), desc: 'Minecraft SRG映射客户端' });
              forgeCoreLibs.push({ name: `net.minecraft:client:${mcVer}:extra`, path: path.join(clientBaseDir, `${mcVer}-mcp`, `client-${mcVer}-mcp-extra.jar`), desc: 'Minecraft额外客户端' });
            }
          }
        }
      }

      // 校验所有核心库是否存在且 JAR 完整
      for (const fcl of forgeCoreLibs) {
        if (!fs.existsSync(fcl.path) || (fcl.path.endsWith('.jar') && !utils.isJarIntact(fcl.path))) {
          result.forgeCore.missing.push(fcl);
          console.warn(`[DepCheck] Forge核心库缺失: ${fcl.name} (${fcl.desc})`);
        }
      }

      if (result.forgeCore.missing.length > 0) {
        result.forgeCore.ok = false;
        const missingNames = result.forgeCore.missing.map((m) => m.desc || m.name).join('、');
        result.forgeCore.message = `${result.forgeCore.missing.length} 个Forge核心库文件缺失(${missingNames})，无法启动游戏。\n` +
          `修复建议:\n` +
          `1) 前往"版本设置 → 文件修复"自动修复缺失文件\n` +
          `2) 重新安装该Forge版本(版本设置 → 删除后重新安装)\n` +
          `3) 检查杀毒软件是否将Forge核心库文件误删并加入白名单\n` +
          `4) 如果使用自定义游戏目录,确认libraries文件夹完整`;
        // 为缺失的核心库构造 maven 下载 URL，并入 missingFiles
        for (const m of result.forgeCore.missing) {
          const existingEntry = result.missingFiles.find((f) => f.path === m.path);
          if (!existingEntry) {
            let forgeUrl = '';
            if (m.name && m.name.includes(':')) {
              const parts = m.name.split(':');
              if (parts.length >= 3) {
                const groupId = parts[0];
                const artifactId = parts[1];
                const version = parts[2];
                const groupPath = groupId.replace(/\./g, '/');
                const classifierSuffix = parts[3] ? `-${parts[3]}` : '';
                const mavenFile = `${artifactId}-${version}${classifierSuffix}.jar`;
                if (groupId === 'net.minecraft') {
                  forgeUrl = `https://libraries.minecraft.net/${groupPath}/${artifactId}/${version}/${mavenFile}`;
                } else {
                  forgeUrl = `https://maven.minecraftforge.net/${groupPath}/${artifactId}/${version}/${mavenFile}`;
                }
              }
            }
            result.missingFiles.push({
              type: 'forge_core',
              url: forgeUrl,
              path: m.path,
              sha1: '',
              size: 0,
              name: m.name,
              desc: m.desc,
              message: `Forge核心库缺失: ${m.desc} (${path.basename(m.path)})`
            });
          }
        }
        console.warn(`[DepCheck] Forge核心检查不通过: ${result.forgeCore.message}`);
      }
    } // end else !isNewForgeFormat
  }
}

module.exports = {
  checkForgeCore,
  scanInheritsForge
};
