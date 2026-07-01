/**
 * @file server/versions/version-parse.js - 版本 JSON 查找、解析、继承链合并
 * @description 含版本 JSON 文件查找、加载器类型识别（detectVersionInfo）、
 *   主 JAR 查找（findMainJar）、继承链解析（resolveVersionJson）等。
 */

const { fs, path, ctx, loadExternalFolders } = require('./shared');
const { mergeVersionJson, deduplicateJvmArgs } = require('./version-merge');

// 清除指定版本的已解析 JSON 缓存
function _invalidateResolvedJsonCache(versionId) {
  ctx.caches._resolvedJsonCache.delete(versionId);
  ctx.caches._resolvedJsonCacheTime.delete(versionId);
}

// 在版本目录中查找版本 JSON 文件，必要时从 pack-info.json 补建
function findVersionJson(versionDir) {
  if (!fs.existsSync(versionDir) || !fs.statSync(versionDir).isDirectory()) return null;
  const dirName = path.basename(versionDir);
  const primaryJson = path.join(versionDir, `${dirName}.json`);
  if (fs.existsSync(primaryJson)) {
    try {
      const data = JSON.parse(fs.readFileSync(primaryJson, 'utf-8'));
      if (data.id || data.mainClass || data.inheritsFrom || data.libraries || data.minecraftArguments || data.arguments) {
        return primaryJson;
      }
    } catch (e) {}
  }
  try {
    const jsonFiles = fs.readdirSync(versionDir).filter((f) => f.endsWith('.json'));
    for (const jsonFile of jsonFiles) {
      const fullPath = path.join(versionDir, jsonFile);
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
        if (!data.id && !data.inheritsFrom) continue;
        if (data.mainClass || data.libraries || data.inheritsFrom || data.minecraftArguments || data.arguments) {
          return fullPath;
        }
      } catch (e) { continue; }
    }
  } catch (e) {}
  // 尝试从 pack-info.json 补建版本 JSON
  const packInfoPath = path.join(versionDir, 'pack-info.json');
  if (fs.existsSync(packInfoPath)) {
    try {
      const packInfo = JSON.parse(fs.readFileSync(packInfoPath, 'utf-8'));
      if (packInfo.mcVersion || packInfo.name) {
        let inheritsFrom = packInfo.mcVersion;
        if (packInfo.forgeVersion) inheritsFrom = `${packInfo.mcVersion}-forge-${packInfo.forgeVersion}`;
        else if (packInfo.neoforgeVersion) inheritsFrom = `${packInfo.mcVersion}-neoforge-${packInfo.neoforgeVersion}`;
        else if (packInfo.fabricVersion) inheritsFrom = `fabric-loader-${packInfo.fabricVersion}-${packInfo.mcVersion}`;
        const versionJson = {
          id: dirName,
          inheritsFrom: inheritsFrom || undefined,
          type: 'release',
          mainClass: inheritsFrom ? undefined : 'net.minecraft.client.main.Main',
          time: packInfo.importedAt || new Date().toISOString(),
          releaseTime: packInfo.importedAt || new Date().toISOString()
        };
        const vjPath = path.join(versionDir, `${dirName}.json`);
        fs.writeFileSync(vjPath, JSON.stringify(versionJson, null, 2));
        _invalidateResolvedJsonCache(dirName);
        return vjPath;
      }
    } catch (e) {}
  }
  return null;
}

// 在内部和外部目录中查找版本 JSON
function _findVersionJsonInAnyDir(versionId) {
  const internalPath = path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.json`);
  if (fs.existsSync(internalPath)) return internalPath;
  try {
    const externalFolders = loadExternalFolders();
    for (const folder of externalFolders) {
      if (!fs.existsSync(folder.path)) continue;
      const extPath = path.join(folder.path, 'versions', versionId, `${versionId}.json`);
      if (fs.existsSync(extPath)) return extPath;
      const extDir = path.join(folder.path, 'versions', versionId);
      const altJson = findVersionJson(extDir);
      if (altJson) return altJson;
    }
  } catch (_) {}
  return null;
}

// 沿 inheritsFrom 链合并父版本字段（库、参数等），最多 10 层防止循环
function _mergeInheritsChain(data, dirName) {
  const merged = { ...data };
  const visited = new Set();
  visited.add(data.id || dirName);
  let current = data;
  let depth = 0;
  while (current.inheritsFrom && depth < 10) {
    const parentId = current.inheritsFrom;
    if (visited.has(parentId)) break;
    visited.add(parentId);
    const parentJsonPath = _findVersionJsonInAnyDir(parentId);
    if (!parentJsonPath || !fs.existsSync(parentJsonPath)) break;
    try {
      const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
      for (const key of Object.keys(parentData)) {
        if (key === 'id' || key === 'inheritsFrom' || key === 'type') continue;
        if (merged[key] === undefined) {
          merged[key] = parentData[key];
        } else if (key === 'libraries' && Array.isArray(parentData[key])) {
          merged.libraries = [...parentData[key], ...(merged.libraries || [])];
        } else if (key === 'arguments' && typeof parentData[key] === 'object') {
          merged.arguments = merged.arguments || {};
          if (parentData[key].game && (!merged.arguments.game || merged.arguments.game.length === 0)) merged.arguments.game = parentData[key].game;
          if (parentData[key].jvm && (!merged.arguments.jvm || merged.arguments.jvm.length === 0)) merged.arguments.jvm = parentData[key].jvm;
        }
      }
      current = parentData;
    } catch (_) { break; }
    depth++;
  }
  return merged;
}

// 识别版本信息：判断加载器类型（Fabric/Forge/NeoForge/OptiFine/LiteLoader）、是否整合包、基础 MC 版本
function detectVersionInfo(data, dirName) {
  const merged = _mergeInheritsChain(data, dirName);
  const versionIdLower = (data.id || dirName).toLowerCase();
  const mainClassLower = (merged.mainClass || '').toLowerCase();
  const librariesStr = JSON.stringify(merged.libraries || []).toLowerCase();
  const gameArgsStr = JSON.stringify(merged.arguments?.game || []).toLowerCase();
  const isBootStrap = mainClassLower.includes('bootstraplauncher');
  const hasNeoForgeGameArg = gameArgsStr.includes('--fml.neoforgeversion');
  const hasForgeGameArg = gameArgsStr.includes('--fml.forgeversion');
  const isFabric = mainClassLower.includes('fabric') || versionIdLower.includes('fabric') ||
    librariesStr.includes('net.fabricmc:fabric-loader') || librariesStr.includes('org.quiltmc:quilt-loader');
  const isForge = (mainClassLower.includes('forge') || mainClassLower.includes('modlauncher') || versionIdLower.includes('forge') ||
    librariesStr.includes('minecraftforge') ||
    (isBootStrap && (hasForgeGameArg || librariesStr.includes('net.minecraftforge')))) &&
    !versionIdLower.includes('neoforge') && !librariesStr.includes('net.neoforge') && !hasNeoForgeGameArg;
  const isNeoForge = versionIdLower.includes('neoforge') || librariesStr.includes('net.neoforge') ||
    hasNeoForgeGameArg || (isBootStrap && librariesStr.includes('neoforged')) ||
    (isBootStrap && hasForgeGameArg && (librariesStr.includes('neoforge') || gameArgsStr.includes('neoforge')));
  const isOptiFine = versionIdLower.includes('optifine') || librariesStr.includes('optifine:optifine');
  const isLiteLoader = versionIdLower.includes('liteloader') || librariesStr.includes('liteloader');
  const isAprilFools = ctx.constants.APRIL_FOOLS_IDS.has(versionIdLower);

  const bareMcPattern = /^\d+\.\d+(\.\d+)?(-\d+)?$/;
  const loaderIdPattern = /^(?:fabric-loader-\d|quilt-loader-\d|\d+\.\d+(?:\.\d+)?-(?:forge|neoforge)-\d)/;
  const versionId = data.id || dirName;
  const hasNoLoaderFlags = !isFabric && !isForge && !isNeoForge && !isOptiFine && !isLiteLoader;
  const hasInheritsFrom = !!data.inheritsFrom;
  const inheritsFromNonMc = hasInheritsFrom && !bareMcPattern.test(data.inheritsFrom);
  const isContentVanilla = hasNoLoaderFlags && !isBootStrap && !hasForgeGameArg && !hasNeoForgeGameArg &&
    (mainClassLower.includes('net.minecraft.client.main') || mainClassLower === '') &&
    !librariesStr.includes('net.minecraftforge') && !librariesStr.includes('net.fabricmc') && !librariesStr.includes('net.neoforge');
  const isModpack = !bareMcPattern.test(versionId) && !loaderIdPattern.test(versionId) && (!isContentVanilla || inheritsFromNonMc);

  if (isModpack) {
    let loaderType = '';
    if (isForge) loaderType = 'Forge';
    else if (isFabric) loaderType = 'Fabric';
    else if (isNeoForge) loaderType = 'NeoForge';
    let resolvedIsForge = isForge, resolvedIsFabric = isFabric, resolvedIsNeoForge = isNeoForge;
    let resolvedIsOptiFine = isOptiFine, resolvedIsLiteLoader = isLiteLoader;
    // 整合包自身无加载器标志时，从父版本推断加载器类型
    if (!loaderType && data.inheritsFrom) {
      const parentJsonPath = _findVersionJsonInAnyDir(data.inheritsFrom);
      if (parentJsonPath) {
        try {
          const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
          const parentInfo = detectVersionInfo(parentData, data.inheritsFrom);
          if (parentInfo.isForge) { loaderType = 'Forge'; resolvedIsForge = true; }
          else if (parentInfo.isFabric) { loaderType = 'Fabric'; resolvedIsFabric = true; }
          else if (parentInfo.isNeoForge) { loaderType = 'NeoForge'; resolvedIsNeoForge = true; }
          if (parentInfo.isOptiFine) resolvedIsOptiFine = true;
          if (parentInfo.isLiteLoader) resolvedIsLiteLoader = true;
        } catch (_) {}
      }
    }
    let baseVersion = data.inheritsFrom || '';
    if (data.inheritsFrom) {
      const parentJsonPath2 = _findVersionJsonInAnyDir(data.inheritsFrom);
      if (parentJsonPath2 && fs.existsSync(parentJsonPath2)) {
        try {
          const parentData = JSON.parse(fs.readFileSync(parentJsonPath2, 'utf-8'));
          if (parentData.inheritsFrom && bareMcPattern.test(parentData.inheritsFrom)) {
            baseVersion = parentData.inheritsFrom;
          }
        } catch (_) {}
      }
    }
    // 从库列表或游戏参数中提取基础 MC 版本
    if (!baseVersion) {
      const mcVersionPattern = /(\d+\.\d+(?:\.\d+)?)/;
      if (isForge || isNeoForge) {
        const forgeMatch = librariesStr.match(/net\.minecraftforge:(?:forge|fmlloader):(\d+\.\d+(?:\.\d+)?)/);
        if (forgeMatch) baseVersion = forgeMatch[1];
        else {
          const fmlMatch = data.arguments?.game?.find((a) => typeof a === 'string' && a.startsWith('--fml.mcVersion'));
          if (fmlMatch) {
            const idx = data.arguments.game.indexOf(fmlMatch);
            if (idx >= 0 && idx + 1 < data.arguments.game.length) baseVersion = data.arguments.game[idx + 1];
          }
        }
      } else if (isFabric) {
        const fabricMatch = librariesStr.match(/net\.fabricmc:(?:fabric-loader|intermediary):(\d+\.\d+(?:\.\d+)?)/);
        if (fabricMatch) baseVersion = fabricMatch[1];
      }
      if (!baseVersion) {
        const idMatch = versionId.match(mcVersionPattern);
        if (idMatch) baseVersion = idMatch[1];
      }
    }
    return { isFabric: resolvedIsFabric, isForge: resolvedIsForge, isNeoForge: resolvedIsNeoForge, isOptiFine: resolvedIsOptiFine, isLiteLoader: resolvedIsLiteLoader, isModpack, modpackLoader: loaderType, baseVersion, isAprilFools };
  }

  if (data.inheritsFrom && !isFabric && !isForge && !isNeoForge && !isOptiFine && !isLiteLoader) {
    const parentJsonPath = path.join(ctx.dirs.VERSIONS_DIR, data.inheritsFrom, `${data.inheritsFrom}.json`);
    if (fs.existsSync(parentJsonPath)) {
      try {
        const parentData = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
        const parentInfo = detectVersionInfo(parentData, data.inheritsFrom);
        if (parentInfo.isForge || parentInfo.isFabric || parentInfo.isNeoForge || parentInfo.isOptiFine || parentInfo.isLiteLoader) {
          return { ...parentInfo, baseVersion: parentInfo.baseVersion || data.inheritsFrom, isAprilFools: parentInfo.isAprilFools || isAprilFools };
        }
      } catch (_) {}
    }
  }

  let baseVersion = data.inheritsFrom || data.id || dirName;
  if (!data.inheritsFrom) {
    const mcVersionPattern = /(\d+\.\d+(?:\.\d+)?(?:[_-]pre\d*|[-_]rc\d*|[-_]snapshot[-_]?\d*w\d*a?)?)/i;
    if (isForge || isNeoForge) {
      const forgeMatch = librariesStr.match(/net\.minecraftforge:(?:forge|fmlloader):(\d+\.\d+(?:\.\d+)?)/);
      if (forgeMatch) baseVersion = forgeMatch[1];
      else {
        const fmlMatch = data.arguments?.game?.find((a) => typeof a === 'string' && a.startsWith('--fml.mcVersion'));
        if (fmlMatch) {
          const idx = data.arguments.game.indexOf(fmlMatch);
          if (idx >= 0 && idx + 1 < data.arguments.game.length) baseVersion = data.arguments.game[idx + 1];
        }
      }
    } else if (isFabric) {
      const fabricMatch = librariesStr.match(/net\.fabricmc:(?:fabric-loader|intermediary):(\d+\.\d+(?:\.\d+)?)/);
      if (fabricMatch) baseVersion = fabricMatch[1];
    }
    if (baseVersion === data.id || baseVersion === dirName) {
      const idMatch = (data.id || dirName).match(mcVersionPattern);
      if (idMatch) baseVersion = idMatch[1];
    }
  }
  return { isFabric, isForge, isNeoForge, isOptiFine, isLiteLoader, isModpack: false, modpackLoader: '', baseVersion, isAprilFools };
}

// 向上查找外部根目录（含 versions 目录的根）
function findExternalRoot(versionDir) {
  let dir = versionDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'versions')) && fs.existsSync(path.join(dir, 'libraries'))) {
      return dir;
    }
    if (fs.existsSync(path.join(dir, 'versions')) && fs.existsSync(path.join(dir, 'assets'))) {
      return dir;
    }
    if (fs.existsSync(path.join(dir, 'versions'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// 查找版本主 JAR 文件：按多种候选路径搜索，沿 inheritsFrom 链递归，最后扫描版本目录
function findMainJar(versionJson, versionId, externalVersionDir = null, _visited = null) {
  const actualVersionId = versionId || versionJson.id || '';
  const jarName = versionJson.jar || versionJson.inheritsFrom || actualVersionId;

  const isExternal = !!externalVersionDir;
  let externalRoot = null;
  if (isExternal) {
    externalRoot = findExternalRoot(externalVersionDir);
    if (!externalRoot) externalRoot = path.dirname(path.dirname(externalVersionDir));
  }

  const searchPaths = [];

  if (versionJson.jar) {
    if (isExternal && externalRoot) {
      searchPaths.push(path.join(externalRoot, 'versions', versionJson.jar, `${versionJson.jar}.jar`));
    }
    searchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, versionJson.jar, `${versionJson.jar}.jar`));
  }

  if (isExternal) {
    if (externalRoot) {
      searchPaths.push(path.join(externalRoot, 'versions', actualVersionId, `${actualVersionId}.jar`));
    }
    searchPaths.push(path.join(externalVersionDir, `${actualVersionId}.jar`));
    const dirName = path.basename(externalVersionDir);
    searchPaths.push(path.join(externalVersionDir, `${dirName}.jar`));
    if (externalRoot && dirName !== actualVersionId) {
      searchPaths.push(path.join(externalRoot, 'versions', dirName, `${dirName}.jar`));
    }
  }

  searchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, actualVersionId, `${actualVersionId}.jar`));

  if (versionJson.inheritsFrom) {
    if (isExternal && externalRoot) {
      searchPaths.push(path.join(externalRoot, 'versions', versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`));
      searchPaths.push(path.join(path.dirname(externalVersionDir), versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`));
    }
    searchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, versionJson.inheritsFrom, `${versionJson.inheritsFrom}.jar`));
  }

  for (const p of searchPaths) {
    if (fs.existsSync(p)) return p;
  }

  // 外部根目录下按 jarId 扫描第一个含 jar 的版本目录
  if (isExternal && externalRoot) {
    for (const jarId of [versionJson.jar, versionJson.inheritsFrom, actualVersionId]) {
      if (!jarId) continue;
      const verDir = path.join(externalRoot, 'versions', jarId);
      if (fs.existsSync(verDir)) {
        try {
          const jars = fs.readdirSync(verDir).filter((f) => f.endsWith('.jar'));
          if (jars.length > 0) return path.join(verDir, jars[0]);
        } catch (e) {}
      }
    }
  }

  // 沿 inheritsFrom 链递归查找
  if (versionJson.inheritsFrom) {
    if (!_visited) _visited = new Set();
    if (_visited.has(versionJson.inheritsFrom)) {
      console.warn(`[FindMainJar] 继承链循环: ${[..._visited].join(' -> ')} -> ${versionJson.inheritsFrom}`);
      return null;
    }
    _visited.add(versionJson.inheritsFrom);

    const parentJsonPath = _findVersionJsonInAnyDir(versionJson.inheritsFrom);
    if (parentJsonPath && fs.existsSync(parentJsonPath)) {
      const parentBaseDir = path.dirname(parentJsonPath);
      try {
        const parentJson = JSON.parse(fs.readFileSync(parentJsonPath, 'utf-8'));
        const parentJar = findMainJar(parentJson, versionJson.inheritsFrom, parentBaseDir, _visited);
        if (parentJar) return parentJar;
      } catch (e) {}
      try {
        const jars = fs.readdirSync(parentBaseDir).filter((f) => f.endsWith('.jar') && !f.endsWith('-sources.jar'));
        if (jars.length > 0) return path.join(parentBaseDir, jars[0]);
      } catch (e) {}
    }
  }

  // 最终兜底：扫描所有版本目录，寻找带 client 下载地址的 JSON 对应的 jar
  {
    const allDirs = [
      path.join(ctx.dirs.VERSIONS_DIR, actualVersionId),
      ...(versionJson.inheritsFrom ? [path.join(ctx.dirs.VERSIONS_DIR, versionJson.inheritsFrom)] : [])
    ];
    if (isExternal && externalVersionDir) {
      allDirs.push(externalVersionDir);
      if (versionJson.inheritsFrom) {
        const parentJson = _findVersionJsonInAnyDir(versionJson.inheritsFrom);
        if (parentJson) allDirs.push(path.dirname(parentJson));
      }
    }
    const visitedParents = _visited || new Set();
    for (const d of allDirs) {
      if (visitedParents.has(path.basename(d))) continue;
      if (!fs.existsSync(d)) continue;
      try {
        const jsonFiles = fs.readdirSync(d).filter((f) => f.endsWith('.json'));
        for (const jf of jsonFiles) {
          try {
            const jData = JSON.parse(fs.readFileSync(path.join(d, jf), 'utf-8'));
            if (jData.downloads?.client?.url) {
              const clientPath = path.join(d, jf.replace('.json', '.jar'));
              if (fs.existsSync(clientPath)) return clientPath;
              const innerJars = fs.readdirSync(d).filter((f) => f.endsWith('.jar') && !f.endsWith('-sources.jar'));
              if (innerJars.length > 0) return path.join(d, innerJars[0]);
            }
          } catch (_) {}
        }
      } catch (_) {}
    }
  }

  console.warn(`[FindMainJar] 未找到主JAR: versionId=${actualVersionId}, jar=${versionJson.jar || '无'}, inheritsFrom=${versionJson.inheritsFrom || '无'}, extDir=${externalVersionDir || '无'}`);
  console.warn(`[FindMainJar] 搜索路径:`, searchPaths.map((p) => `${p}(${fs.existsSync(p)})`).join(', '));
  return null;
}

// 从版本 ID 推断加载器对应的基础 MC 版本（NeoForge/Forge）
function detectModLoaderParent(data, externalVersionDir) {
  try {
    const versionId = data.id || '';

    if (versionId.toLowerCase().includes('neoforge') || versionId.toLowerCase().includes('neoforged')) {
      const m = versionId.match(/^(\d+\.\d+(?:\.\d+)?)/);
      if (m) return m[1];
    }

    if (versionId.toLowerCase().includes('forge') && !versionId.toLowerCase().includes('neoforge')) {
      const m = versionId.match(/^(\d+\.\d+(?:\.\d+)?)/);
      if (m) return m[1];
    }

    return null;
  } catch (e) {
    console.error('[DetectParent] 异常:', e.message);
    return null;
  }
}

// 解析版本 JSON：沿 inheritsFrom 链合并父版本，带 TTL 缓存，支持外部目录
function resolveVersionJson(versionId, externalVersionDir = null, visited = null) {
  if (!visited) visited = new Set();
  if (visited.has(versionId)) return null;
  visited.add(versionId);

  const cached = ctx.caches._resolvedJsonCache.get(versionId);
  const cachedTime = ctx.caches._resolvedJsonCacheTime.get(versionId);
  if (cached && cachedTime && (Date.now() - cachedTime < ctx.caches.RESOLVED_JSON_CACHE_TTL)) {
    return JSON.parse(JSON.stringify(cached));
  }

  let versionDir, jsonFile;
  if (externalVersionDir) {
    versionDir = externalVersionDir;
    jsonFile = findVersionJson(versionDir);
  } else {
    versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    jsonFile = findVersionJson(versionDir);
  }
  if (!jsonFile || !fs.existsSync(jsonFile)) return null;

  const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
  // 无 inheritsFrom 时尝试从版本 ID 推断父版本（仅内存修正，不写盘）
  if (!data.inheritsFrom) {
    const detectedParent = detectModLoaderParent(data, externalVersionDir);
    if (detectedParent) {
      data.inheritsFrom = detectedParent;
    }
  }
  if (data.inheritsFrom) {
    let parentVersionDir = null;
    const searchPaths = [];
    if (externalVersionDir) {
      const externalRoot = findExternalRoot(externalVersionDir);
      if (externalRoot) {
        searchPaths.push(path.join(externalRoot, 'versions', data.inheritsFrom));
      }
      searchPaths.push(path.join(path.dirname(externalVersionDir), data.inheritsFrom));
      const externalFolders = loadExternalFolders();
      for (const folder of externalFolders) {
        if (!fs.existsSync(folder.path)) continue;
        const candidate = path.join(folder.path, 'versions', data.inheritsFrom);
        if (!searchPaths.includes(candidate)) searchPaths.push(candidate);
      }
    }
    searchPaths.push(path.join(ctx.dirs.VERSIONS_DIR, data.inheritsFrom));

    for (const searchDir of searchPaths) {
      if (findVersionJson(searchDir)) {
        parentVersionDir = searchDir;
        break;
      }
    }

    if (parentVersionDir) {
      const isParentExternal = parentVersionDir !== path.join(ctx.dirs.VERSIONS_DIR, data.inheritsFrom);
      const parentJson = resolveVersionJson(data.inheritsFrom, isParentExternal ? parentVersionDir : null, visited);
      if (parentJson) {
        const result = mergeVersionJson(parentJson, data);
        if (result && !result.error) {
          ctx.caches._resolvedJsonCache.set(versionId, JSON.parse(JSON.stringify(result)));
          ctx.caches._resolvedJsonCacheTime.set(versionId, Date.now());
        }
        return result;
      }
    }

    console.warn(`[ResolveVersion] Parent version not found: ${data.inheritsFrom}`);
  }
  if (data && !data.error) {
    if (data.arguments?.jvm) {
      data.arguments.jvm = deduplicateJvmArgs(data.arguments.jvm);
    }
    ctx.caches._resolvedJsonCache.set(versionId, JSON.parse(JSON.stringify(data)));
    ctx.caches._resolvedJsonCacheTime.set(versionId, Date.now());
  }
  return data;
}

module.exports = {
  _invalidateResolvedJsonCache,
  findVersionJson,
  _findVersionJsonInAnyDir,
  _mergeInheritsChain,
  detectVersionInfo,
  detectModLoaderParent,
  findExternalRoot,
  findMainJar,
  resolveVersionJson
};
