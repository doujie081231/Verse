/**
 * @file server/java.js - Java 检测/下载功能模块
 * @description 从 server.js 抽取的 Java 版本检测、运行时选择、JDK 下载安装等功能。
 *   通过 ctx (./context) 访问共享状态，通过 utils (./utils) 访问工具函数，
 *   通过 http (./http-client) 访问 HTTP 请求功能，通过 versions (./versions) 访问版本管理。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec, spawn } = require('child_process');

const ctx = require('./context');
const utils = require('./utils');
const http = require('./http-client');
const versions = require('./versions');

/* 本地 saveSettings - 与 server.js 中行为一致 */

/**
 * 保存全局设置到磁盘并刷新缓存
 * @param {object} settings - 设置对象
 */
function saveSettings(settings) {
  ctx.caches._settingsCache = settings;
  ctx.caches._settingsCacheTime = Date.now();
  utils.safeWriteFileSync(ctx.dirs.SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/* Java 版本需求解析 */

/**
 * 获取版本所需的最低 Java 主版本号
 * @param {string} versionId - 版本 ID
 * @param {object} [versionJson=null] - 版本 JSON（已合并 inheritsFrom 链）
 * @returns {number} 最低 Java 主版本号
 */
function getRequiredJavaVersion(versionId, versionJson = null) {
  const range = getJavaVersionRange(versionId, versionJson);
  return range.min;
}

// 解析 MC 版本字符串为 { major, minor, patch }
function _parseMcVersion(verStr) {
  if (!verStr) return null;
  const parts = String(verStr).split(/[-_]/)[0].split('.').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2] || 0 };
}

// 比较两个 MC 版本字符串，返回 -1/0/1
function _compareVersion(aStr, bStr) {
  const a = _parseMcVersion(aStr);
  const b = _parseMcVersion(bStr);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * 检测版本 JSON 中的加载器信息（Forge/NeoForge/Fabric/OptiFine/LiteLoader/launchwrapper）
 * @param {string} versionId - 版本 ID
 * @param {object} versionJson - 已合并 inheritsFrom 链的版本 JSON
 * @returns {{isForge: boolean, isNeoForge: boolean, isFabric: boolean, isOptiFine: boolean, isLiteLoader: boolean, isLegacyLaunchwrapper: boolean, baseVersion: string, forgeVersion: string}}
 */
function getLoaderInfoForJava(versionId, versionJson) {
  const result = { isForge: false, isNeoForge: false, isFabric: false, isOptiFine: false, isLiteLoader: false, isLegacyLaunchwrapper: false, baseVersion: '', forgeVersion: '' };
  if (!versionJson) return result;

  const versionIdLower = (versionId || '').toLowerCase();
  const mainClassLower = (versionJson.mainClass || '').toLowerCase();
  const libsArr = versionJson.libraries || [];
  const gameArgsArr = versionJson.arguments?.game || [];
  const gameArgsStr = JSON.stringify(gameArgsArr).toLowerCase();
  const isBootStrap = mainClassLower.includes('bootstraplauncher');

  // 扫描整个合并后 JSON 文本检测 Forge：不仅检查 libraries，还检查 arguments、mainClass 等所有字段
  const fullJsonStr = JSON.stringify(versionJson).toLowerCase();

  // launchwrapper 是 Java 9+ 不兼容的旧版加载器主类
  result.isLegacyLaunchwrapper = mainClassLower === 'net.minecraft.launchwrapper.launch' ||
    mainClassLower.includes('launchwrapper');

  result.isFabric = mainClassLower.includes('fabric') || versionIdLower.includes('fabric') ||
    fullJsonStr.includes('net.fabricmc:fabric-loader') || fullJsonStr.includes('org.quiltmc:quilt-loader');
  result.isOptiFine = versionIdLower.includes('optifine') || fullJsonStr.includes('optifine:optifine');
  result.isLiteLoader = versionIdLower.includes('liteloader') || fullJsonStr.includes('liteloader');

  // NeoForge 检测
  result.isNeoForge = versionIdLower.includes('neoforge') || fullJsonStr.includes('net.neoforge') ||
    gameArgsStr.includes('--fml.neoforgeversion') ||
    (isBootStrap && fullJsonStr.includes('neoforged'));

  // Forge 检测
  result.isForge = !result.isNeoForge && (
    mainClassLower.includes('forge') || mainClassLower.includes('modlauncher') ||
    versionIdLower.includes('forge') || fullJsonStr.includes('minecraftforge') ||
    (isBootStrap && (gameArgsStr.includes('--fml.forgeversion') || fullJsonStr.includes('net.minecraftforge')))
  );

  // mainClass 是 launchwrapper 但未通过其他方式检测到 Forge 的版本（旧版 Forge / LiteLoader / 自定义整合包）仍需 Java 8
  if (result.isLegacyLaunchwrapper && !result.isForge && !result.isLiteLoader && !result.isOptiFine && !result.isFabric && !result.isNeoForge) {
    result.isForge = fullJsonStr.includes('forge') || gameArgsStr.includes('fml');
  }

  // 解析基础 MC 版本：使用 fullJsonStr（整个合并后 JSON）确保匹配继承链中的 Forge 库
  // 注意：artifact 名后必须直接跟 ':'，避免 'forge' 误匹配 'forgespi'（forgespi 版本号是 7.0.1，
  // 会污染 baseVersion 导致 Java 版本范围误判为 21+，而 MC 1.20.1 实际只需 Java 17）
  if (result.isForge || result.isNeoForge) {
    const forgeMatch = fullJsonStr.match(/net\.minecraftforge:(?:forge|fmlloader):(\d+\.\d+(?:\.\d+)?)/);
    if (forgeMatch) {
      result.baseVersion = forgeMatch[1];
      const forgeVerMatch = fullJsonStr.match(/net\.minecraftforge:(?:forge|fmlloader):([\d.]+(?:-\d+)?)/);
      result.forgeVersion = forgeVerMatch ? forgeVerMatch[1] : '';
    } else {
      const fmlArg = gameArgsArr.find((a) => typeof a === 'string' && a.startsWith('--fml.mcVersion'));
      if (fmlArg) {
        const idx = gameArgsArr.indexOf(fmlArg);
        if (idx >= 0 && idx + 1 < gameArgsArr.length) result.baseVersion = gameArgsArr[idx + 1];
      }
      const forgeVerArg = gameArgsArr.find((a) => typeof a === 'string' && a.startsWith('--fml.forgeVersion'));
      if (forgeVerArg) {
        const idx = gameArgsArr.indexOf(forgeVerArg);
        if (idx >= 0 && idx + 1 < gameArgsArr.length) result.forgeVersion = gameArgsArr[idx + 1];
      }
    }
  } else if (result.isFabric) {
    const fabricMatch = fullJsonStr.match(/net\.fabricmc:(?:fabric-loader|intermediary):(\d+\.\d+(?:\.\d+)?)/);
    if (fabricMatch) result.baseVersion = fabricMatch[1];
  }

  if (!result.baseVersion) {
    if (versionJson.inheritsFrom) result.baseVersion = versionJson.inheritsFrom;
    else {
      const idMatch = (versionId || '').match(/(\d+\.\d+(?:\.\d+)?)/);
      if (idMatch) result.baseVersion = idMatch[1];
    }
  }

  console.log(`[JavaDetect] versionId=${versionId}, isForge=${result.isForge}, isLegacyLaunchwrapper=${result.isLegacyLaunchwrapper}, baseVersion=${result.baseVersion}, forgeVersion=${result.forgeVersion}, mainClass=${versionJson.mainClass || 'none'}`);
  return result;
}

/**
 * 计算版本所需的 Java 版本范围（min/max），综合 JSON 声明、MC 版本、加载器约束
 * @param {string} versionId - 版本 ID
 * @param {object} [versionJson=null] - 已合并 inheritsFrom 链的版本 JSON
 * @returns {{min: number, max: number, source: string}} Java 主版本范围与来源
 */
function getJavaVersionRange(versionId, versionJson = null) {
  const result = { min: 8, max: 999, source: 'default' };

  const loader = getLoaderInfoForJava(versionId, versionJson);
  const ver = _parseMcVersion(loader.baseVersion);

  // 1. JSON 中明确要求的 javaVersion（优先级最高）
  if (versionJson && versionJson.javaVersion && versionJson.javaVersion.majorVersion) {
    const majorVer = parseInt(versionJson.javaVersion.majorVersion, 10);
    if (majorVer > 0) {
      if (majorVer <= 8) {
        result.min = Math.max(result.min, 8);
      } else {
        result.min = Math.max(result.min, majorVer);
      }
      result.source = 'json';
    }
  }

  if (versionJson && versionJson.complianceLevel !== undefined) {
    const level = parseInt(versionJson.complianceLevel, 10);
    if (level === 0) { result.min = Math.max(result.min, 8); }
    else if (level >= 1 && level <= 6) { result.min = Math.max(result.min, 8); }
    else if (level === 7) { result.min = Math.max(result.min, 17); }
    else if (level >= 8) { result.min = Math.max(result.min, 21); }
  }

  if (ver) {
    // 1.20.5+：Java 21+
    if (ver.major >= 2 || (ver.major === 1 && ver.minor > 20) || (ver.major === 1 && ver.minor === 20 && ver.patch >= 5)) {
      result.min = Math.max(result.min, 21);
      result.source = 'mc-version';
    }
    // 1.18+：Java 17+
    else if (ver.major === 1 && ver.minor >= 18) {
      result.min = Math.max(result.min, 17);
      result.source = 'mc-version';
    }
    // 1.17+：Java 16+
    else if (ver.major === 1 && ver.minor === 17) {
      result.min = Math.max(result.min, 16);
      result.source = 'mc-version';
    }
    // 1.12+：Java 8+
    else if (ver.major === 1 && ver.minor >= 12) {
      result.min = Math.max(result.min, 8);
      if (result.source === 'default') result.source = 'mc-version';
    }
  }

  // 2. LiteLoader：最高 Java 8（与 launchwrapper 一样使用旧版 class loader）
  if (loader.isLiteLoader) {
    result.max = Math.min(result.max, 8);
    result.source = 'liteloader';
  }

  // 3. Forge 分支
  if (loader.isForge || loader.isNeoForge) {
    if (ver) {
      if (ver.major === 1 && ((ver.minor === 6 && ver.patch >= 1) || ver.minor === 7 && ver.patch <= 2)) {
        // 1.6.1 - 1.7.2：必须 Java 7
        result.min = Math.max(result.min, 7);
        result.max = Math.min(result.max, 7);
        result.source = 'forge';
      } else if (ver.major === 1 && ver.minor <= 12) {
        // <= 1.12.2：Java 8（launchwrapper 与 Java 9+ 不兼容）
        result.min = Math.min(result.min, 8);
        result.max = Math.min(result.max, 8);
        if (result.source === 'default' || result.source === 'mc-version') result.source = 'forge';
      } else if (ver.major === 1 && ver.minor === 13) {
        // 1.13 - 1.14：Java 8 - 10
        result.max = Math.min(result.max, 10);
        if (result.source === 'default' || result.source === 'mc-version') result.source = 'forge';
      } else if (ver.major === 1 && ver.minor === 14) {
        result.max = Math.min(result.max, 10);
        if (result.source === 'default' || result.source === 'mc-version') result.source = 'forge';
      } else if (ver.major === 1 && ver.minor === 15) {
        // 1.15：Java 8 - 15
        result.max = Math.min(result.max, 15);
        if (result.source === 'default' || result.source === 'mc-version') result.source = 'forge';
      } else if (ver.major === 1 && ver.minor === 16) {
        // 1.16：Forge 34.x ~ 36.2.25 最高 Java 8u321；高版本（36.2.26+）支持 Java 17
        const forgeVer = String(loader.forgeVersion || '');
        const cmMin = _compareVersion(forgeVer, '34.0.0');
        const cmMax = _compareVersion('36.2.25', forgeVer);
        if (cmMin >= 0 && cmMax >= 0) {
          // 1.16 Forge 34.x ~ 36.2.25：必须 Java 8u141 ~ 8u320
          result.min = Math.max(result.min, 8);
          result.max = Math.min(result.max, 8);
          result.source = 'forge';
        }
      } else if (ver.major === 1 && ver.minor >= 17) {
        // 1.17+：Forge 已支持 Java 16+/17+
        if (ver.minor >= 18) result.min = Math.max(result.min, 17);
        else if (ver.minor === 17) result.min = Math.max(result.min, 16);
        if (result.source === 'default' || result.source === 'mc-version') result.source = 'forge';
      }
    }
  }

  // 4. OptiFine 强制约束
  if (loader.isOptiFine && ver) {
    if (ver.major === 1 && ver.minor < 7) {
      // <1.7：至多 Java 8
      result.max = Math.min(result.max, 8);
      result.source = 'optifine';
    } else if (ver.major === 1 && ver.minor >= 8 && ver.minor <= 11) {
      // 1.8 - 1.11：必须 Java 8
      result.min = Math.max(result.min, 8);
      result.max = Math.min(result.max, 8);
      result.source = 'optifine';
    } else if (ver.major === 1 && ver.minor === 12) {
      // 1.12：最高 Java 8
      result.max = Math.min(result.max, 8);
      result.source = 'optifine';
    } else if (ver.major === 1 && ver.minor === 18) {
      // 1.18 + OptiFine：最高 Java 18
      result.max = Math.min(result.max, 18);
      result.source = 'optifine';
    }
  }

  // 5. launchwrapper（旧版 Forge / LiteLoader / 自定义整合包）与 Java 9+ 不兼容
  //    AppClassLoader → URLClassLoader 强转在 Java 9+ 会崩溃，最高优先级安全约束
  if (loader.isLegacyLaunchwrapper) {
    result.max = Math.min(result.max, 8);
    result.source = 'launchwrapper';
  }

  // 兜底
  if (result.min > result.max) result.max = result.min;
  return result;
}

/* Java 版本信息检测 */

/**
 * 获取 Java 主版本号
 * @param {string} javaPath - java 可执行文件路径
 * @returns {number} Java 主版本号（如 8、17、21），失败返回 0
 */
function getJavaMajorVersion(javaPath) {
  return getJavaVersionInfo(javaPath).major;
}

/**
 * 执行 `java -version` 解析 Java 版本信息
 * @param {string} javaPath - java 可执行文件路径
 * @returns {{major: number, minor: number, version: string}} 版本信息，失败返回 major=0
 */
function getJavaVersionInfo(javaPath) {
  const result = { major: 0, minor: 0, version: 'unknown' };
  if (!javaPath || !fs.existsSync(javaPath)) return result;
  try {
    const output = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf8', timeout: 10000 });
    const m = (output || '').match(/version "([^"]+)"/) || (output || '').match(/version (\S+)/);
    if (m) {
      const versionStr = m[1];
      result.version = versionStr;
      if (versionStr.startsWith('1.')) {
        // 旧式版本号 1.8.0_301 → major=8, minor=301
        result.major = parseInt(versionStr.split('.')[1], 10) || 0;
        const upd = versionStr.match(/_(\d+)/);
        if (upd) result.minor = parseInt(upd[1], 10);
      } else {
        // 新式版本号 17.0.1 → major=17, minor=0
        result.major = parseInt(versionStr.split('.')[0], 10) || 0;
        const minorPart = versionStr.split('.')[1];
        if (minorPart) result.minor = parseInt(minorPart, 10) || 0;
      }
    }
  } catch (e) {
    // execSync 在非零退出码时抛错，但 stderr 里仍包含版本信息
    const errOutput = (e.stderr || e.stdout || e.output?.[2] || '').toString();
    const m = errOutput.match(/version "([^"]+)"/) || errOutput.match(/version (\S+)/);
    if (m) {
      const versionStr = m[1];
      result.version = versionStr;
      if (versionStr.startsWith('1.')) {
        result.major = parseInt(versionStr.split('.')[1], 10) || 0;
        const upd = versionStr.match(/_(\d+)/);
        if (upd) result.minor = parseInt(upd[1], 10);
      } else {
        result.major = parseInt(versionStr.split('.')[0], 10) || 0;
        const minorPart = versionStr.split('.')[1];
        if (minorPart) result.minor = parseInt(minorPart, 10) || 0;
      }
    }
  }
  return result;
}

/* Classpath Wrapper JAR */

/**
 * 生成仅含 MANIFEST.MF 的 wrapper JAR，用 Class-Path 把超长 classpath 转嫁出去
 * @param {string} classpathStr - 原始 classpath 字符串（分号或冒号分隔）
 * @param {string} wrapperJarPath - 输出 wrapper JAR 路径
 * @param {string} mainClass - 主类全限定名
 */
function createClasspathWrapperJar(classpathStr, wrapperJarPath, mainClass) {
  const separator = process.platform === 'win32' ? ';' : ':';
  const entries = classpathStr.split(separator).filter((e) => e.trim());
  const classPathLine = entries.map((e) => {
    let p = e.replace(/\\/g, '/');
    p = p.replace(/ /g, '%20');
    return p;
  }).join(' ');

  // JAR Manifest 规范：每行最多 70 字节，超出需按 69 字节续行（前导空格）
  function wrapManifestLine(line) {
    if (line.length <= 70) return line;
    let result = line.substring(0, 70);
    line = line.substring(70);
    while (line.length > 0) {
      const chunkSize = Math.min(69, line.length);
      result += '\r\n ' + line.substring(0, chunkSize);
      line = line.substring(chunkSize);
    }
    return result;
  }

  const classPathWrapped = wrapManifestLine(classPathLine);
  const manifest = `Manifest-Version: 1.0\r\nClass-Path: ${classPathWrapped}\r\nMain-Class: ${mainClass}\r\n`;

  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from(manifest, 'utf-8'));
  zip.writeZip(wrapperJarPath);

  console.log(`[Launch] Created wrapper JAR: ${wrapperJarPath}`);
  console.log(`[Launch] Wrapper: ${entries.length} classpath entries, mainClass=${mainClass}`);

  if (entries.length <= 20) {
    entries.forEach((e, i) => {
      const exists = fs.existsSync(e);
      console.log(`[Launch]   CP[${i}] ${exists ? 'OK' : 'MISS'} ${path.basename(e)}`);
    });
  } else {
    const missing = entries.filter((e) => !fs.existsSync(e));
    console.log(`[Launch]   存在: ${entries.length - missing.length}, 缺失: ${missing.length}`);
    if (missing.length > 0) {
      missing.slice(0, 5).forEach((m) => console.log(`[Launch]   MISSING: ${path.basename(m)}`));
    }
  }
}

/* Java 选择 */

/**
 * 为指定版本选择最合适的 Java 运行时：扫描用户设置、JAVA_DIR、runtime 目录、.minecraft/runtime、系统 PATH
 * @param {string} versionId - 版本 ID
 * @param {object} settings - 全局设置
 * @param {object} [versionJson=null] - 已合并的版本 JSON
 * @param {string} [externalVersionDir=null] - 外部版本目录
 * @returns {{javaPath: string, majorVersion: number, is64Bit: boolean, isJdk: boolean, source: string, warning?: string}}
 */
function selectJavaForVersion(versionId, settings, versionJson = null, externalVersionDir = null) {
  if (!versionJson) {
    versionJson = versions.resolveVersionJson(versionId, externalVersionDir);
  }
  const range = getJavaVersionRange(versionId, versionJson);
  const requiredVersion = range.min;
  const maxVersion = range.max;
  console.log(`[Java] 版本 ${versionId} 需要Java ${requiredVersion}${maxVersion < 999 ? '~' + maxVersion : '+'} (来源: ${range.source})`);

  let candidates = [];
  const javaExeName = process.platform === 'win32' ? 'java.exe' : 'java';

  if (settings.javaPath && fs.existsSync(settings.javaPath)) {
    const info = getJavaVersionInfo(settings.javaPath);
    console.log(`[Java] 用户设置: ${settings.javaPath} (版本=${info.major})`);
    candidates.push({ path: settings.javaPath, majorVersion: info.major, minorVersion: info.minor, is64Bit: true, isJdk: true, source: 'user_setting' });
  }

  console.log(`[Java] 直接扫描 JAVA_DIR...`);
  if (fs.existsSync(ctx.dirs.JAVA_DIR)) {
    try {
      const javaDirs = fs.readdirSync(ctx.dirs.JAVA_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const jd of javaDirs) {
        const javaExe = path.join(ctx.dirs.JAVA_DIR, jd.name, 'bin', javaExeName);
        if (!fs.existsSync(javaExe)) continue;
        const info = getJavaVersionInfo(javaExe);
        if (info.major > 0) {
          const norm = javaExe.toLowerCase().replace(/\\/g, '/');
          if (!candidates.some((c) => c.path.toLowerCase().replace(/\\/g, '/') === norm)) {
            candidates.push({ path: javaExe, majorVersion: info.major, minorVersion: info.minor, is64Bit: true, isJdk: true, source: 'bundled' });
            console.log(`[Java]   JAVA_DIR发现: ${javaExe} (版本=${info.major})`);
          }
        }
      }
    } catch (e) {}
  }

  const runtimeDir = path.join(ctx.dirs.DATA_DIR, 'runtime');
  if (fs.existsSync(runtimeDir)) {
    const _scanRuntimeDir = (dir, depth) => {
      if (depth <= 0 || !fs.existsSync(dir)) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const subDir = path.join(dir, entry.name);
          if (entry.name.toLowerCase() === 'bin') {
            const javaExe = path.join(subDir, javaExeName);
            if (fs.existsSync(javaExe)) {
              const info = getJavaVersionInfo(javaExe);
              if (info.major > 0) {
                const norm = javaExe.toLowerCase().replace(/\\/g, '/');
                if (!candidates.some((c) => c.path.toLowerCase().replace(/\\/g, '/') === norm)) {
                  candidates.push({ path: javaExe, majorVersion: info.major, minorVersion: info.minor, is64Bit: true, isJdk: true, source: 'bundled' });
                  console.log(`[Java]   runtime发现: ${javaExe} (版本=${info.major})`);
                }
              }
            }
          } else {
            _scanRuntimeDir(subDir, depth - 1);
          }
        }
      } catch (e) {}
    };
    _scanRuntimeDir(runtimeDir, 5);
  }

  const mcRuntime = path.join(ctx.dirs.MINECRAFT_DIR, 'runtime');
  if (fs.existsSync(mcRuntime)) {
    const _scanMcRuntime = (dir, depth) => {
      if (depth <= 0 || !fs.existsSync(dir)) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const subDir = path.join(dir, entry.name);
          if (entry.name.toLowerCase() === 'bin') {
            const javaExe = path.join(subDir, javaExeName);
            if (fs.existsSync(javaExe)) {
              const info = getJavaVersionInfo(javaExe);
              if (info.major > 0) {
                const norm = javaExe.toLowerCase().replace(/\\/g, '/');
                if (!candidates.some((c) => c.path.toLowerCase().replace(/\\/g, '/') === norm)) {
                  candidates.push({ path: javaExe, majorVersion: info.major, minorVersion: info.minor, is64Bit: true, isJdk: true, source: 'bundled' });
                  console.log(`[Java]   .minecraft/runtime发现: ${javaExe} (版本=${info.major})`);
                }
              }
            }
          } else {
            _scanMcRuntime(subDir, depth - 1);
          }
        }
      } catch (e) {}
    };
    _scanMcRuntime(mcRuntime, 5);
  }

  const mcRuntimeRoaming = path.join(process.env.APPDATA || '', '.minecraft', 'runtime');
  if (fs.existsSync(mcRuntimeRoaming)) {
    const _scanRoaming = (dir, depth) => {
      if (depth <= 0 || !fs.existsSync(dir)) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const subDir = path.join(dir, entry.name);
          if (entry.name.toLowerCase() === 'bin') {
            const javaExe = path.join(subDir, javaExeName);
            if (fs.existsSync(javaExe)) {
              const info = getJavaVersionInfo(javaExe);
              if (info.major > 0) {
                const norm = javaExe.toLowerCase().replace(/\\/g, '/');
                if (!candidates.some((c) => c.path.toLowerCase().replace(/\\/g, '/') === norm)) {
                  candidates.push({ path: javaExe, majorVersion: info.major, minorVersion: info.minor, is64Bit: true, isJdk: true, source: 'bundled' });
                  console.log(`[Java]   Roaming/.minecraft/runtime发现: ${javaExe} (版本=${info.major})`);
                }
              }
            }
          } else {
            _scanRoaming(subDir, depth - 1);
          }
        }
      } catch (e) {}
    };
    _scanRoaming(mcRuntimeRoaming, 5);
  }

  console.log(`[Java] 快速扫描完成，找到 ${candidates.length} 个候选Java`);

  let systemJava = [];
  let bundledJava = [];

  if (candidates.some((j) => j.majorVersion >= requiredVersion && j.majorVersion <= maxVersion)) {
    console.log(`[Java] 快速扫描已找到满足要求的Java，跳过系统扫描`);
  } else {
    console.log(`[Java] 快速扫描未找到，执行系统扫描...`);
    systemJava = detectSystemJava();
    bundledJava = detectBundledJava();
    console.log(`[Java] 系统扫描: bundled=${bundledJava.length}, system=${systemJava.length}`);
    for (const j of [...bundledJava, ...systemJava]) {
      const norm = j.path.toLowerCase().replace(/\\/g, '/');
      if (!candidates.some((c) => c.path.toLowerCase().replace(/\\/g, '/') === norm)) {
        candidates.push(j);
      }
    }
  }

  console.log(`[Java] 合并后候选总数: ${candidates.length}`);
  candidates.forEach((j, i) => {
    console.log(`  ${i + 1}. ${j.path} - 主版本: ${j.majorVersion}, 64位: ${j.is64Bit}, 来源: ${j.source}`);
  });

  const suitable = candidates.filter((j) => j.majorVersion >= requiredVersion && j.majorVersion <= maxVersion);
  console.log(`[Java] 满足范围要求的Java (${suitable.length}个):`);
  suitable.forEach((j, i) => {
    console.log(`  ${i + 1}. ${j.path} - 主版本: ${j.majorVersion}, 来源: ${j.source}`);
  });

  if (suitable.length === 0) {
    // 候选全空时的备用检测：where java、注册表、常见安装路径深度扫描
    console.log(`[Java] ====== Java 选择失败诊断 ======`);
    console.log(`[Java] 版本: ${versionId}, 需求范围: ${requiredVersion}~${maxVersion} (来源: ${range.source})`);
    console.log(`[Java] bundled检测: ${bundledJava.length}个, system检测: ${systemJava.length}个, 合计候选: ${candidates.length}`);
    candidates.forEach((j, i) => {
      console.log(`[Java]   候选${i + 1}: ${j.path} (主版本=${j.majorVersion}, 64位=${j.is64Bit}, 来源=${j.source})`);
    });

    console.log(`[Java] 尝试备用检测: where java...`);
    try {
      const { execSync } = require('child_process');
      const whereOut = execSync('where java 2>nul', { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const whereLines = whereOut.split(/\r?\n/).filter((l) => l.trim());
      for (const line of whereLines) {
        const trimmed = line.trim();
        if (trimmed && fs.existsSync(trimmed)) {
          const info = getJavaVersionInfo(trimmed);
          console.log(`[Java]   where发现: ${trimmed} (版本=${info.major})`);
          if (info.major >= requiredVersion && info.major <= maxVersion) {
            console.log(`[Java] ====== 备用检测成功 ======`);
            return trimmed;
          }
        }
      }
    } catch (e) {}

    console.log(`[Java] 尝试备用检测: 注册表...`);
    if (process.platform === 'win32') {
      try {
        const { execSync: _execSync } = require('child_process');
        const regOutput = _execSync(
          'reg query "HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment" /s 2>nul',
          { encoding: 'utf8', timeout: 5000, windowsHide: true }
        );
        const javaHomeMatches = regOutput.matchAll(/JavaHome\s+REG_SZ\s+(.+)/gi);
        for (const m of javaHomeMatches) {
          const javaHome = m[1].trim();
          const javaExe = path.join(javaHome, 'bin', 'java.exe');
          if (fs.existsSync(javaExe)) {
            const info = getJavaVersionInfo(javaExe);
            console.log(`[Java]   注册表发现: ${javaExe} (版本=${info.major})`);
            if (info.major >= requiredVersion && info.major <= maxVersion) return javaExe;
          }
        }
      } catch (e) {}
      try {
        const { execSync: _execSync } = require('child_process');
        const regOutput64 = _execSync(
          'reg query "HKLM\\SOFTWARE\\Wow6432Node\\JavaSoft\\Java Runtime Environment" /s 2>nul',
          { encoding: 'utf8', timeout: 5000, windowsHide: true }
        );
        const javaHomeMatches64 = regOutput64.matchAll(/JavaHome\s+REG_SZ\s+(.+)/gi);
        for (const m of javaHomeMatches64) {
          const javaHome = m[1].trim();
          const javaExe = path.join(javaHome, 'bin', 'java.exe');
          if (fs.existsSync(javaExe)) {
            const info = getJavaVersionInfo(javaExe);
            console.log(`[Java]   注册表(32位)发现: ${javaExe} (版本=${info.major})`);
            if (info.major >= requiredVersion && info.major <= maxVersion) return javaExe;
          }
        }
      } catch (e) {}
    }

    console.log(`[Java] 尝试备用检测: 扫描常见路径和 .minecraft/runtime...`);
    const appData = process.env['APPDATA'] || '';
    const localAppData = process.env['LOCALAPPDATA'] || '';
    const fallbackSearchPaths = [
      'C:\\Program Files\\Java', 'C:\\Program Files (x86)\\Java',
      'C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\AdoptOpenJDK',
      'C:\\Program Files\\Zulu', 'C:\\Program Files\\BellSoft',
      'D:\\Java', 'E:\\Java',
      path.join(process.env.USERPROFILE || '', '.jdks'),
      path.join(process.env.USERPROFILE || '', 'scoop', 'apps'),
      path.join(appData, '.minecraft', 'runtime'),
      path.join(appData, '.hmcl', 'runtime'),
      path.join(localAppData, 'BakaXL', 'JavaRuntime'),
      path.join(appData, '.versepc', 'runtime'),
    ];
    const javaExeName = process.platform === 'win32' ? 'java.exe' : 'java';
    const checkedPaths = new Set();
    function _fallbackDeepSearch(dir, depth) {
      if (depth <= 0 || !fs.existsSync(dir)) return null;
      const normDir = dir.toLowerCase().replace(/\\/g, '/');
      if (checkedPaths.has(normDir)) return null;
      checkedPaths.add(normDir);
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const subDir = path.join(dir, entry.name);
          if (entry.name.toLowerCase() === 'bin') {
            const javaExe = path.join(subDir, javaExeName);
            if (fs.existsSync(javaExe)) {
              const info = getJavaVersionInfo(javaExe);
              console.log(`[Java]   深度扫描发现: ${javaExe} (版本=${info.major})`);
              if (info.major >= requiredVersion && info.major <= maxVersion) return javaExe;
            }
          } else {
            const result = _fallbackDeepSearch(subDir, depth - 1);
            if (result) return result;
          }
        }
      } catch (e) {}
      return null;
    }
    for (const sp of fallbackSearchPaths) {
      if (!fs.existsSync(sp)) continue;
      const found = _fallbackDeepSearch(sp, 6);
      if (found) {
        console.log(`[Java] ====== 备用深度扫描成功 ======`);
        return found;
      }
    }

    console.log(`[Java] ====== 所有检测均失败 ======`);
    return null;
  }

  // 排序策略：1) 主版本距离要求最近 2) 启动器自带 Java 优先 3) 64 位优先 4) 用户设置优先 5) 范围内最高小版本号
  suitable.sort((a, b) => {
    const aDist = Math.abs(a.majorVersion - requiredVersion) - (a.source === 'user_setting' ? 1 : 0);
    const bDist = Math.abs(b.majorVersion - requiredVersion) - (b.source === 'user_setting' ? 1 : 0);
    if (aDist !== bDist) return aDist - bDist;

    const aInLauncher = (a.path || '').toLowerCase().includes(ctx.dirs.DATA_DIR.toLowerCase()) ? 0 : 1;
    const bInLauncher = (b.path || '').toLowerCase().includes(ctx.dirs.DATA_DIR.toLowerCase()) ? 0 : 1;
    if (aInLauncher !== bInLauncher) return aInLauncher - bInLauncher;

    if (a.is64Bit !== b.is64Bit) return a.is64Bit ? -1 : 1;
    if (a.source === 'user_setting' && b.source !== 'user_setting') return -1;
    if (b.source === 'user_setting' && a.source !== 'user_setting') return 1;
    // 同主版本优先选较高小版本（如 Java 8u362 > 8u51）
    if (a.majorVersion === b.majorVersion) {
      return (b.minorVersion || 0) - (a.minorVersion || 0);
    }
    // 不同主版本优先选择较低的（避免 Java 17 跑 1.12 兼容问题）
    return a.majorVersion - b.majorVersion;
  });

  const chosen = suitable[0];
  console.log(`[Java] 选择Java: ${chosen.path} (主版本: ${chosen.majorVersion}, 来源: ${chosen.source})`);

  const userSetting = candidates.find((j) => j.source === 'user_setting');
  if (userSetting && chosen.path !== userSetting.path) {
    console.log(`[Java] 注意: 自动选择了更匹配的Java ${chosen.majorVersion}，而非用户设置的Java ${userSetting.majorVersion}`);
  }

  return chosen.path;
}

/* 依赖检查缓存失效 */

/**
 * 清除指定版本的依赖检查缓存
 * @param {string} versionId - 版本 ID
 */
function invalidateDepCheckCache(versionId) {
  for (const key of ctx.caches._depCheckCache.keys()) {
    if (key.startsWith(versionId + ':')) {
      ctx.caches._depCheckCache.delete(key);
    }
  }
}

/* 系统 Java 检测 */

/**
 * 扫描系统已安装的 Java（PATH、注册表、常见安装目录、第三方启动器 runtime）
 * @returns {Array<{path: string, majorVersion: number, minorVersion: number, is64Bit: boolean, isJdk: boolean, source: string}>}
 */
function detectSystemJava() {
  const results = [];
  const foundPaths = new Set();

  function addJavaEntry(javaExe, source) {
    const normalized = javaExe.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
    if (foundPaths.has(normalized)) return;
    foundPaths.add(normalized);

    if (!fs.existsSync(javaExe)) return;

    try {
      const folder = path.dirname(javaExe);
      const folderLower = folder.toLowerCase();
      // 排除 FinalShell、Paranoia 等携带 JDK 的非 Java 工具，避免误识别
      if (folderLower.includes('finalshell') || folderLower.includes('paranoia')) return;
      if (fs.existsSync(path.join(folder, 'pdf-bookmark'))) return;

      let version = 'unknown';
      let majorVersion = 0;
      let minorVersion = 0;

      const javaHome = path.dirname(folder);
      const releaseFile = path.join(javaHome, 'release');
      if (fs.existsSync(releaseFile)) {
        try {
          const content = fs.readFileSync(releaseFile, 'utf8');
          const match = content.match(/JAVA_VERSION="([^"]+)"/);
          if (match) {
            version = match[1];
            if (version.startsWith('1.')) {
              majorVersion = parseInt(version.split('.')[1], 10);
              const upd = version.match(/_(\d+)/);
              if (upd) minorVersion = parseInt(upd[1], 10);
            } else {
              majorVersion = parseInt(version.split('.')[0], 10);
              const minorPart = version.split('.')[1];
              if (minorPart) minorVersion = parseInt(minorPart, 10) || 0;
            }
          }
        } catch (e) {}
      }

      // release 文件缺失或解析失败时，回退到 java -version
      if (majorVersion <= 0) {
        try {
          const versionOutput = execSync(`"${javaExe}" -version 2>&1`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
          const versionMatch = versionOutput.match(/version "([^"]+)"/) || versionOutput.match(/version (\S+)/);
          if (!versionMatch) return;
          version = versionMatch[1];
          if (version.startsWith('1.')) {
            majorVersion = parseInt(version.split('.')[1], 10);
            const upd = version.match(/_(\d+)/);
            if (upd) minorVersion = parseInt(upd[1], 10);
          } else {
            majorVersion = parseInt(version.split('.')[0], 10);
            const minorPart = version.split('.')[1];
            if (minorPart) minorVersion = parseInt(minorPart, 10) || 0;
          }
        } catch (e) {}
      }

      if (isNaN(majorVersion) || majorVersion <= 0) return;

      const isJdk = fs.existsSync(path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'));

      // 通过 -XshowSettings:properties 检测 64 位；失败则回退到 -version 输出文本匹配
      let is64Bit = true;
      try {
        const archOutput = execSync(`"${javaExe}" -XshowSettings:properties -version 2>&1`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
        is64Bit = archOutput.includes('os.arch = x86_64') || archOutput.includes('os.arch = amd64') || archOutput.includes('64-bit');
      } catch (e) {
        try {
          const vOutput = execSync(`"${javaExe}" -version 2>&1`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
          is64Bit = vOutput.includes('64-Bit') || vOutput.includes('64-bit');
        } catch (e2) {}
      }

      results.push({
        path: javaExe,
        version: version,
        majorVersion: majorVersion,
        minorVersion: minorVersion,
        is64Bit: is64Bit,
        isJdk: isJdk,
        source: source,
        javaHome: javaHome
      });
    } catch (e) {}
  }

  // 递归扫描文件夹，命中 bin/java 或疑似 Java 目录名时调用 addJavaEntry
  function searchFolderForJava(basePath, depth) {
    if (depth <= 0 || !fs.existsSync(basePath)) return;
    try {
      const entries = fs.readdirSync(basePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirName = entry.name.toLowerCase();
        const fullPath = path.join(basePath, entry.name);
        const javaExeName = process.platform === 'win32' ? 'java.exe' : 'java';

        if (dirName === 'bin') {
          const javaExe = path.join(fullPath, javaExeName);
          if (fs.existsSync(javaExe)) {
            addJavaEntry(javaExe, 'system');
          }
          continue;
        }

        const isJavaRelated = ['java', 'jdk', 'jre', 'jvm', 'runtime', 'adopt', 'temurin', 'corretto', 'zulu', 'openjdk', 'graalvm', 'liberica', 'microsoft', 'amazon', 'sapmachine', 'dragonwell', 'bisheng', 'windows-x64', 'windows-arm64', 'windows-x86'].some((kw) => dirName.includes(kw));
        const isVersionDir = /^jdk[-_]?\d/i.test(dirName) || /^jre[-_]?\d/i.test(dirName) || /^\d+([._]\d+)*$/i.test(dirName);

        if (isJavaRelated || isVersionDir) {
          const javaExe = path.join(fullPath, 'bin', javaExeName);
          if (fs.existsSync(javaExe)) {
            addJavaEntry(javaExe, 'system');
          }
          searchFolderForJava(fullPath, depth - 1);
        }
      }
    } catch (e) {}
  }

  // 1. 环境变量 JAVA_HOME / JDK_HOME
  if (process.env.JAVA_HOME) {
    const javaHome = process.env.JAVA_HOME.replace(/["']/g, '').replace(/\\$/, '').replace(/\/$/, '');
    const javaExe = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    addJavaEntry(javaExe, 'system');
  }

  if (process.env.JDK_HOME) {
    const jdkHome = process.env.JDK_HOME.replace(/["']/g, '').replace(/\\$/, '').replace(/\/$/, '');
    const javaExe = path.join(jdkHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    addJavaEntry(javaExe, 'system');
  }

  // 2. PATH 中的 java；若父目录疑似 Java 目录也尝试 bin/java
  if (process.env.PATH) {
    const pathDirs = process.env.PATH.split(path.delimiter);
    for (const dir of pathDirs) {
      const trimmed = dir.trim().replace(/["']/g, '');
      if (!trimmed) continue;
      const javaExe = path.join(trimmed, process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(javaExe)) {
        addJavaEntry(javaExe, 'system');
      }
      const parentDir = path.dirname(trimmed);
      if (trimmed.toLowerCase().includes('java') || trimmed.toLowerCase().includes('jdk')) {
        const parentJavaExe = path.join(parentDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        addJavaEntry(parentJavaExe, 'system');
      }
    }
  }

  // 3. Windows：注册表 + Program Files + AppData + Microsoft Store + where java + 全盘扫描
  if (process.platform === 'win32') {
    try {
      const regOutput = execSync(
        `reg query "HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment" /s 2>nul || reg query "HKLM\\SOFTWARE\\JavaSoft\\JDK" /s 2>nul || reg query "HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit" /s 2>nul`,
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const javaHomeMatches = regOutput.matchAll(/JavaHome\s+REG_SZ\s+(.+)/gi);
      for (const m of javaHomeMatches) {
        const javaHome = m[1].trim();
        addJavaEntry(path.join(javaHome, 'bin', 'java.exe'), 'system');
      }
    } catch (e) {}

    try {
      const regOutput64 = execSync(
        `reg query "HKLM\\SOFTWARE\\Wow6432Node\\JavaSoft\\Java Runtime Environment" /s 2>nul || reg query "HKLM\\SOFTWARE\\Wow6432Node\\JavaSoft\\JDK" /s 2>nul`,
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const javaHomeMatches = regOutput64.matchAll(/JavaHome\s+REG_SZ\s+(.+)/gi);
      for (const m of javaHomeMatches) {
        const javaHome = m[1].trim();
        addJavaEntry(path.join(javaHome, 'bin', 'java.exe'), 'system');
      }
    } catch (e) {}

    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    for (const pf of [programFiles, programFilesX86]) {
      if (fs.existsSync(pf)) {
        try {
          fs.readdirSync(pf).forEach((d) => {
            const dirLower = d.toLowerCase();
            if (['java', 'jdk', 'jre', 'adopt', 'temurin', 'corretto', 'zulu', 'amazon', 'microsoft', 'sapmachine', 'bellsoft', 'graalvm', 'dragonwell'].some((kw) => dirLower.includes(kw))) {
              searchFolderForJava(path.join(pf, d), 2);
            }
          });
        } catch (e) {}
      }
    }

    const appData = process.env['APPDATA'] || '';
    const localAppData = process.env['LOCALAPPDATA'] || '';
    const userProfile = process.env['USERPROFILE'] || '';

    if (appData) searchFolderForJava(appData, 2);
    if (localAppData) searchFolderForJava(localAppData, 2);

    const minecraftRuntime = path.join(appData, '.minecraft', 'runtime');
    if (fs.existsSync(minecraftRuntime)) {
      searchFolderForJava(minecraftRuntime, 3);
    }

    const launcherRuntime = path.join(ctx.dirs.DATA_DIR, 'runtime');
    if (fs.existsSync(launcherRuntime)) {
      searchFolderForJava(launcherRuntime, 3);
    }

    // JetBrains Toolbox 自带 JBR
    const jbrPaths = [
      path.join(localAppData, 'JetBrains', 'Toolbox', 'apps', 'JBR'),
      path.join(programFiles, 'JetBrains'),
    ];
    for (const jbrPath of jbrPaths) {
      if (fs.existsSync(jbrPath)) {
        searchFolderForJava(jbrPath, 3);
      }
    }

    const additionalPaths = [
      'C:\\Java', 'D:\\Java', 'E:\\Java', 'F:\\Java',
      path.join(userProfile, 'Java'),
      path.join(userProfile, '.jdks'),
      path.join(localAppData, 'Programs'),
      path.join(userProfile, '.sdkman', 'candidates', 'java'),
      path.join(userProfile, 'scoop', 'apps', 'openjdk'),
      'C:\\ProgramData\\Oracle\\Java',
      path.join(appData, '.hmcl', 'runtime'),
      path.join(localAppData, 'BakaXL', 'JavaRuntime'),
      path.join(appData, '.minecraft', 'runtime'),
    ];

    for (const searchPath of additionalPaths) {
      if (fs.existsSync(searchPath)) {
        searchFolderForJava(searchPath, 3);
      }
    }

    if (userProfile) searchFolderForJava(userProfile, 2);

    // Microsoft Store 版 Minecraft 自带 runtime
    const msStorePaths = [
      path.join(localAppData, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'),
      path.join(localAppData, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime', 'java-runtime-gamma', 'windows-x64'),
      path.join(localAppData, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime', 'java-runtime-gold', 'windows-x64'),
    ];
    for (const msPath of msStorePaths) {
      if (fs.existsSync(msPath)) {
        searchFolderForJava(msPath, 3);
      }
    }

    try {
      const whereOutput = execSync('where java 2>nul', { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const whereLines = whereOutput.split(/\r?\n/).filter((l) => l.trim());
      for (const line of whereLines) {
        const trimmed = line.trim();
        if (trimmed && fs.existsSync(trimmed)) {
          addJavaEntry(trimmed, 'system');
        }
      }
    } catch (e) {}

    // 全盘扫描各盘根目录下的 Java / JDK / Runtime 目录
    try {
      const drives = execSync('wmic logicaldisk get caption /value 2>nul', { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const driveMatches = drives.matchAll(/Caption=(\w:)/gi);
      for (const dm of driveMatches) {
        const driveRoot = dm[1] + '\\';
        try {
          fs.readdirSync(driveRoot).forEach((d) => {
            const dirLower = d.toLowerCase();
            if (['java', 'jdk', 'jre', 'runtime'].some((kw) => dirLower === kw || dirLower === kw + 's')) {
              searchFolderForJava(path.join(driveRoot, d), 2);
            }
          });
        } catch (e) {}
      }
    } catch (e) {}
  }

  // 4. macOS：/Library/Java/JavaVirtualMachines、Homebrew、java_home 工具、which
  if (process.platform === 'darwin') {
    const homeDir = process.env.HOME || '~';

    const macJavaPaths = [
      '/Library/Java/JavaVirtualMachines',
      '/opt/homebrew/opt',
      '/opt/homebrew/Cellar',
      '/usr/local/opt',
      path.join(homeDir, '.sdkman', 'candidates', 'java'),
      path.join(homeDir, '.jdks'),
      path.join(homeDir, 'Library', 'Java', 'JavaVirtualMachines'),
      path.join(homeDir, '.minecraft', 'runtime'),
      path.join(ctx.dirs.DATA_DIR, 'runtime'),
    ];

    for (const searchPath of macJavaPaths) {
      if (fs.existsSync(searchPath)) {
        searchFolderForJava(searchPath, 3);
      }
    }

    try {
      const javaHomeOutput = execSync('/usr/libexec/java_home -V 2>&1', { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const javaHomeMatches = javaHomeOutput.matchAll(/"([^"]+)"\s+\(([^)]+)\)/g);
      for (const m of javaHomeMatches) {
        const jhPath = m[1];
        const javaExe = path.join(jhPath, 'bin', 'java');
        if (fs.existsSync(javaExe)) {
          addJavaEntry(javaExe, 'system');
        }
      }
    } catch (e) {}

    try {
      const whichOutput = execSync('which -a java 2>/dev/null', { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const whichLines = whichOutput.split('\n').filter((l) => l.trim());
      for (const line of whichLines) {
        const trimmed = line.trim();
        if (trimmed && fs.existsSync(trimmed)) {
          addJavaEntry(trimmed, 'system');
        }
      }
    } catch (e) {}
  }

  return results;
}

/* Temurin 镜像 URL */

/**
 * 把 GitHub Adoptium Temurin 下载 URL 转为国内镜像 URL 数组（USTC/TUNA/ISCAS）
 * @param {string} githubUrl - GitHub 原始下载 URL
 * @param {string} [osName='windows'] - 操作系统名
 * @param {string} [arch='x64'] - 架构
 * @returns {string[]|string} 镜像 URL 数组；无法解析时返回原 URL
 */
function getTemurinMirrorUrl(githubUrl, osName = 'windows', arch = 'x64') {
  if (!githubUrl) return githubUrl;
  let majorVer, tag, fileName;
  const githubMatch = githubUrl.match(/github\.com\/adoptium\/temurin(\d+)-binaries\/releases\/download\/(.+?)\/(.+)$/);
  if (githubMatch) {
    majorVer = githubMatch[1];
    tag = githubMatch[2];
    fileName = githubMatch[3];
  } else if (githubUrl.includes('release-assets.githubusercontent.com')) {
    const assetMatch = githubUrl.match(/OpenJDK(\d+)U[^/]*?_(jdk_[^\?]+)/);
    if (!assetMatch) {
      const fnMatch = githubUrl.match(/[?&](\w[\w.%-]+\.zip)/);
      if (fnMatch) {
        const fn = decodeURIComponent(fnMatch[1]);
        const vmMatch = fn.match(/OpenJDK(\d+)U/);
        if (vmMatch) {
          majorVer = vmMatch[1];
          fileName = fn;
          tag = `jdk-${fn.replace(/^OpenJDK\d+U-jdk_/, '').replace(/_hotspot_/, '+').replace(/\.zip$/, '').replace(/_/g, '.')}`;
        }
      }
      if (!majorVer) return githubUrl;
    } else {
      majorVer = assetMatch[1];
      const rawFileName = assetMatch[2];
      fileName = rawFileName.split('?')[0];
      const verParts = fileName.match(/(\d+\.\d+\.\d+\+\d+)/);
      tag = verParts ? `jdk-${verParts[1]}` : '';
    }
  } else {
    return githubUrl;
  }
  if (!majorVer || !fileName) return githubUrl;
  const mirrors = [
    `https://mirrors.ustc.edu.cn/adoptium/releases/temurin${majorVer}-binaries/${tag}/${fileName}`,
    `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/releases/temurin${majorVer}-binaries/${tag}/${fileName}`,
    `https://mirror.iscas.ac.cn/adoptium/releases/temurin${majorVer}-binaries/${tag}/${fileName}`
  ];
  return mirrors;
}

/* Liberica JDK 最新版本 */

/**
 * 从 BellSoft 官网爬取指定主版本的最新 Liberica JDK 下载信息
 * @param {number} majorVersion - Java 主版本号
 * @returns {Promise<{downloadUrl: string, fileName: string, size: number}|null>}
 */
async function getLibericaLatestVersion(majorVersion) {
  const arch = process.platform === 'win32' ? 'amd64' : (process.arch === 'arm64' ? 'aarch64' : 'amd64');
  const os = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');
  const pkgType = process.platform === 'win32' ? 'zip' : 'tar.gz';

  const pageUrl = 'https://bell-sw.com/pages/downloads/';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(pageUrl, { signal: controller.signal });
    clearTimeout(timer);
    const html = await resp.text();

    // 从页面 HTML 中提取所有匹配主版本的 Liberica JDK 版本号
    const versionRegex = /bellsoft-jdk([\d.u+b]+)-linux-amd64\.tar\.gz/g;
    const allVersions = [];
    let m;
    while ((m = versionRegex.exec(html)) !== null) {
      const ver = m[1];
      const major = parseInt(ver.split('.')[0], 10);
      if (major === majorVersion) allVersions.push(ver);
    }
    if (allVersions.length === 0) return null;

    allVersions.sort().reverse();
    const latestVer = allVersions[0];

    const testFileName = `bellsoft-jdk${latestVer}-${os}-${arch}.${pkgType}`;
    const testUrl = `${ctx.urls.LIBERICA_BASE}${latestVer.replace(/\+/g, '%2B')}/${testFileName}`;

    // HEAD 请求验证可用性并获取文件大小
    const h2 = new AbortController();
    const t2 = setTimeout(() => h2.abort(), 8000);
    const r2 = await fetch(testUrl, { method: 'HEAD', signal: h2.signal });
    clearTimeout(t2);

    if (!r2.ok) {
      // + 号未编码的备选 URL
      const altUrl = `${ctx.urls.LIBERICA_BASE}${latestVer}/${testFileName}`;
      const h3 = new AbortController();
      const t3 = setTimeout(() => h3.abort(), 8000);
      const r3 = await fetch(altUrl, { method: 'HEAD', signal: h3.signal });
      clearTimeout(t3);
      if (!r3.ok) return null;
      const size = parseInt(r3.headers.get('content-length'), 10) || 0;
      return { downloadUrl: altUrl, fileName: testFileName, size };
    }

    const size = parseInt(r2.headers.get('content-length'), 10) || 0;
    return { downloadUrl: testUrl, fileName: testFileName, size };
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

/* JDK 异步下载 */

/**
 * 异步下载并安装指定主版本的 JDK（Temurin 优先，Liberica 兜底）
 * @param {number} majorVersion - 目标 Java 主版本号（如 8、17、21）
 * @param {string} sessionId - 安装会话 ID，用于取消控制与状态写入
 * @param {string} sessionFile - 会话状态文件路径
 * @param {number} [mirrorIndex=0] - 当前使用的镜像索引（保留参数）
 * @param {AbortSignal|null} [abortSignal=null] - 取消信号
 * @returns {Promise<void>} 完成时无返回值；状态通过 sessionFile 同步
 */
async function downloadJavaAsync(majorVersion, sessionId, sessionFile, mirrorIndex = 0, abortSignal = null) {
  const isAborted = () => abortSignal && abortSignal.aborted;
  const checkAbort = (msg) => { if (isAborted()) throw new Error(msg || '下载已取消'); };
  const updateStatus = (status, progress, message = '', speed = 0, downloadedBytes = 0, totalBytes = 0) => {
    try {
      fs.writeFileSync(sessionFile, JSON.stringify({
        status,
        progress,
        majorVersion,
        message,
        speed,
        downloadedBytes,
        totalBytes,
        timestamp: Date.now()
      }));
    } catch (e) {}
  };

  let lastPct = 10;
  try {
    updateStatus('fetching', 5, '正在获取JDK下载信息...');

    // 平台与架构映射：Mojang 风格 platformKey → Adoptium 风格 arch/osName
    const archMap = { 'windows-x64': 'x64', 'windows-arm64': 'aarch64', 'linux': 'x64', 'linux-i386': 'x86', 'mac-os': 'x64', 'mac-os-arm64': 'aarch64' };
    const platformKey = utils.getPlatformKey();
    const arch = archMap[platformKey] || 'x64';
    const osName = process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux');

    let downloadUrl = '';
    let fileName = '';
    let totalSize = 0;

    // 候选镜像：USTC、TUNA、ISCAS（并行探测延迟，选最快者）
    const mirrorBases = [
      `https://mirrors.ustc.edu.cn/adoptium/releases/temurin${majorVersion}-binaries/`,
      `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/releases/temurin${majorVersion}-binaries/`,
      `https://mirror.iscas.ac.cn/adoptium/releases/temurin${majorVersion}-binaries/`
    ];

    // 并行探测每个镜像：拉取目录列表 → 解析最新 JDK 目录 → HEAD 验证文件可下
    const probeResults = await Promise.allSettled(mirrorBases.map(async (mirrorBase) => {
      const hostname = new URL(mirrorBase).hostname;
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const resp = await fetch(mirrorBase, { signal: controller.signal });
        clearTimeout(timer);
        if (!resp.ok) return { hostname, ok: false, latency: Infinity };
        const html = await resp.text();
        // 同时匹配 jdk8uXXXbY 与 jdk-X.Y.Z+N 两种目录命名
        const dirRegex = /href="[^"]*?(jdk8u\d+b\d+|jdk-\d+\.\d+\.\d+(?:%2B|\+)\d+)[^"]*?"/g;
        const dirs = [];
        let dm;
        while ((dm = dirRegex.exec(html)) !== null) dirs.push(decodeURIComponent(dm[1]));
        if (dirs.length === 0) return { hostname, ok: false, latency: Infinity };
        // 倒序后取第一个，即最新版本目录
        dirs.sort().reverse();
        const latestDir = dirs[0];
        let testFileName;
        const vm8 = latestDir.match(/jdk(\d+u\d+b\d+)/);
        if (vm8) {
          // Java 8 旧式命名：OpenJDK8U-jdk_x64_windows_hotspot_8uXXXbY.zip
          testFileName = `OpenJDK${majorVersion}U-jdk_${arch}_${osName}_hotspot_${vm8[1]}.zip`;
        } else {
          // Java 9+ 新式命名：OpenJDK17U-jdk_x64_windows_hotspot_17.0.1_12.zip
          const vm = latestDir.match(/jdk-(\d+)\.(\d+)\.(\d+)\+(\d+)/);
          if (!vm) return { hostname, ok: false, latency: Infinity };
          testFileName = `OpenJDK${majorVersion}U-jdk_${arch}_${osName}_hotspot_${vm[2]}.${vm[3]}_${vm[4]}.zip`;
        }
        const testUrl = mirrorBase + latestDir + '/' + testFileName;
        // HEAD 请求验证可用性并取文件大小
        const h2 = new AbortController();
        const t2 = setTimeout(() => h2.abort(), 5000);
        const r2 = await fetch(testUrl, { method: 'HEAD', signal: h2.signal });
        clearTimeout(t2);
        if (!r2.ok) return { hostname, ok: false, latency: Infinity };
        const latency = Date.now() - start;
        let size = 0;
        if (r2.headers.get('content-length')) size = parseInt(r2.headers.get('content-length'), 10) || 0;
        return { hostname, ok: true, latency, dir: latestDir, fileName: testFileName, baseUrl: mirrorBase, size };
      } catch (e) {
        clearTimeout(timer);
        return { hostname, ok: false, latency: Infinity };
      }
    }));

    // 按延迟升序排序，取最快的可用镜像
    const available = probeResults.filter((r) => r.status === 'fulfilled' && r.value.ok).map((r) => r.value);
    available.sort((a, b) => a.latency - b.latency);

    if (available.length > 0) {
      const best = available[0];
      console.log(`[Java] 最快镜像: ${best.hostname} (${best.latency}ms)`);
      updateStatus('fetching', 5, `已选择最快镜像: ${best.hostname}`);
      downloadUrl = best.baseUrl + best.dir + '/' + best.fileName;
      fileName = best.fileName;
      totalSize = best.size;
    }

    // 镜像全部不可用时回退到 Adoptium 官方 API
    if (!downloadUrl) {
      updateStatus('fetching', 5, '正在请求Adoptium官方API...');
      const apiUrl = `${ctx.urls.TEMURIN_API}/assets/latest/${majorVersion}/hotspot?architecture=${arch}&image_type=jdk&os=${osName}&vendor=eclipse`;
      console.log(`[Java] 请求Adoptium API: ${apiUrl}`);
      try {
        // API 请求加 20s 超时保护，避免长时间挂起
        const apiResponse = await Promise.race([
          http.fetchJSONWithMethod(apiUrl, 'GET'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('API timeout (20s)')), 20000))
        ]);
        if (apiResponse && apiResponse.length > 0 && apiResponse[0].binary && apiResponse[0].binary.package && apiResponse[0].binary.package.link) {
          const latest = apiResponse[0];
          downloadUrl = latest.binary.package.link;
          fileName = latest.binary.package.name || `jdk-${majorVersion}.zip`;
          totalSize = latest.binary.package.size || 0;
          console.log(`[Java] API返回下载链接: ${downloadUrl.substring(0, 80)}...`);
        }
      } catch (e) {
        console.warn(`[Java] Adoptium API失败: ${e.message}`);
      }
    }

    // 官方 API 也失败时，最后尝试 BellSoft Liberica
    if (!downloadUrl) {
      updateStatus('fetching', 5, '正在尝试BellSoft Liberica...');
      try {
        const bellsoftVersion = await getLibericaLatestVersion(majorVersion);
        if (bellsoftVersion) {
          downloadUrl = bellsoftVersion.downloadUrl;
          fileName = bellsoftVersion.fileName;
          totalSize = bellsoftVersion.size || 0;
          console.log(`[Java] Liberica JDK ${majorVersion}: ${downloadUrl.substring(0, 80)}...`);
        }
      } catch (e) {
        console.warn(`[Java] BellSoft Liberica失败: ${e.message}`);
      }
    }

    if (!downloadUrl) {
      throw new Error(`未找到JDK ${majorVersion}的下载信息，所有源均不可用（请检查网络连接或VPN）`);
    }

    // GitHub 直链在国内通常无法访问，转换为国内镜像数组
    let downloadMirrors = [];
    if (downloadUrl.includes('github.com/adoptium/') || downloadUrl.includes('release-assets.githubusercontent.com')) {
      const mirrors = getTemurinMirrorUrl(downloadUrl, osName, arch);
      if (Array.isArray(mirrors)) {
        downloadMirrors = mirrors;
        console.log(`[Java] GitHub URL检测到，生成${downloadMirrors.length}个国内镜像`);
        downloadMirrors.forEach((m) => console.log(`  -> ${m.substring(0, 80)}`));
      } else if (typeof mirrors === 'string' && mirrors !== downloadUrl) {
        downloadMirrors = [mirrors];
      }
    }

    console.log(`[Java] 文件大小: ${totalSize} bytes`);

    const tempFile = path.join(os.tmpdir(), fileName);

    const jdkSource = downloadUrl.includes('bell-sw.com') ? 'Liberica' : 'Temurin';
    updateStatus('downloading', 10, `正在下载${jdkSource} JDK ${majorVersion}...`);

    // 进度百分比计算：服务端返回 totalBytes 时按真实大小算，否则用峰值估算
    let peakBytes = 0;
    const calcPct = (progress) => {
      const tb = progress.totalBytes > 0 ? progress.totalBytes : totalSize;
      if (tb > 0) {
        const pct = Math.min(80, Math.floor((progress.bytesDownloaded / tb) * 70) + 10);
        lastPct = Math.max(lastPct, pct);
      } else {
        // 无总大小时，用已下载峰值 ×1.15 估算总量
        peakBytes = Math.max(peakBytes, progress.bytesDownloaded);
        const estimatedTotal = peakBytes * 1.15;
        if (estimatedTotal > 0) {
          const pct = Math.min(79, Math.floor((progress.bytesDownloaded / estimatedTotal) * 70) + 10);
          lastPct = Math.max(lastPct, pct);
        }
      }
      return lastPct;
    };
    const formatProgress = (progress) => {
      const tb = progress.totalBytes > 0 ? progress.totalBytes : totalSize;
      const dlMB = (progress.bytesDownloaded / 1024 / 1024).toFixed(1);
      if (tb > 0) {
        const totalMB = (tb / 1024 / 1024).toFixed(1);
        return `正在下载${jdkSource} JDK ${majorVersion}... ${dlMB}MB / ${totalMB}MB`;
      }
      return `正在下载${jdkSource} JDK ${majorVersion}... ${dlMB}MB 已下载`;
    };
    // 平滑速度：用 0.7/0.3 加权移动平均，避免数值抖动
    let _lastDlBytes = 0, _lastDlTime = Date.now(), _smoothSpeed = 0;
    const onDlProgress = (progress) => {
      const now = Date.now();
      const dt = (now - _lastDlTime) / 1000;
      let speed = progress.speed || 0;
      // 至少 0.5s 间隔才计算本地速度，避免抖动
      if (dt >= 0.5) {
        const localSpeed = (progress.bytesDownloaded - _lastDlBytes) / dt;
        speed = speed > 0 ? Math.max(speed, localSpeed) : localSpeed;
        _lastDlBytes = progress.bytesDownloaded;
        _lastDlTime = now;
      }
      _smoothSpeed = _smoothSpeed > 0 ? _smoothSpeed * 0.7 + speed * 0.3 : speed;
      updateStatus('downloading', calcPct(progress), formatProgress(progress), Math.max(_smoothSpeed, speed), progress.bytesDownloaded, progress.totalBytes || totalSize);
    };

    // 分块下载优先；失败时回退到单线程依次尝试所有镜像 + 原始 URL
    await http.downloadFileChunked(downloadMirrors.length > 0 ? downloadMirrors[0] : downloadUrl, tempFile, { onProgress: onDlProgress, timeout: 600000, retries: 3, mirrors: downloadMirrors.length > 0 ? downloadMirrors : null, abortSignal }).catch(async (err) => {
      checkAbort('下载已取消');
      console.log(`[Java] 分块下载失败: ${err.message}，回退单线程`);
      const fallbackUrls = downloadMirrors.length > 0 ? [...downloadMirrors, downloadUrl] : [downloadUrl];
      let lastErr = err;
      for (const url of fallbackUrls) {
        try {
          checkAbort('下载已取消');
          console.log(`[Java] 尝试单线程下载: ${url.substring(0, 80)}...`);
          await http._dlSingle(url, tempFile, { onProgress: onDlProgress, timeout: 600000, retries: 2, stallTimeout: 30000, abortSignal });
          return;
        } catch (e) {
          console.warn(`[Java] 单线程下载失败: ${e.message}`);
          lastErr = e;
        }
      }
      throw lastErr;
    });

    checkAbort('下载已取消');
    updateStatus('extracting', 85, '正在解压JDK...');

    if (!fs.existsSync(ctx.dirs.JAVA_DIR)) fs.mkdirSync(ctx.dirs.JAVA_DIR, { recursive: true });

    // 临时解压目录，解压后再重命名为最终目标目录
    const extractDir = path.join(ctx.dirs.JAVA_DIR, '_java_extract');
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });

    if (process.platform === 'win32') {
      // Windows：优先 PowerShell Expand-Archive，失败时回退 adm-zip
      await new Promise((resolve, reject) => {
        // PowerShell 单引号转义：' → ''
        const psCmd = `Expand-Archive -Path '${tempFile.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`;
        const child = spawn('powershell', ['-Command', psCmd], { timeout: 300000, windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => {
          if (code === 0) resolve();
          else {
            // PowerShell 退出码非 0：回退到 adm-zip 纯 JS 解压
            console.log(`[Java] PowerShell解压失败(code=${code}), 尝试adm-zip...`);
            try {
              const AdmZip = require('adm-zip');
              const zip = new AdmZip(tempFile);
              zip.extractAllTo(extractDir, true);
              resolve();
            } catch (e2) {
              reject(new Error('解压失败: ' + (e2.message || stderr)));
            }
          }
        });
        child.on('error', (err) => {
          // PowerShell 进程启动失败（如系统禁用脚本）：同样回退 adm-zip
          console.log(`[Java] PowerShell启动失败, 尝试adm-zip...`);
          try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(tempFile);
            zip.extractAllTo(extractDir, true);
            resolve();
          } catch (e2) {
            reject(new Error('解压失败: ' + e2.message));
          }
        });
      });
    } else {
      // Linux/macOS：使用系统 tar 解压
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xzf', tempFile, '-C', extractDir], { timeout: 300000 });
        child.on('close', (code) => { code === 0 ? resolve() : reject(new Error(`tar解压失败, code=${code}`)); });
        child.on('error', reject);
      });
    }

    // 解压后的目录结构通常是 extractDir/<jdk-dir>/bin/java，找到含 bin/java 的子目录
    const subDirs = fs.readdirSync(extractDir);
    const jreDir = subDirs.find((d) => {
      const sub = path.join(extractDir, d);
      return fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
    });

    const targetPath = path.join(ctx.dirs.JAVA_DIR, `jdk-${majorVersion}`);
    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });

    // 三种重命名策略：找到 jreDir 优先用；否则单子目录直接用；最后兜底整体改名
    if (jreDir) fs.renameSync(path.join(extractDir, jreDir), targetPath);
    else if (subDirs.length === 1) fs.renameSync(path.join(extractDir, subDirs[0]), targetPath);
    else fs.renameSync(extractDir, targetPath);

    // 清理临时文件
    try { fs.unlinkSync(tempFile); } catch (e) {}
    try { if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}

    const javaExe = path.join(targetPath, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (!fs.existsSync(javaExe)) throw new Error('安装失败：找不到java可执行文件');

    // 配置系统环境变量（仅 Windows，失败不影响安装结果）
    updateStatus('configuring', 92, '正在配置Java环境变量...');
    try {
      await configureJavaEnv(targetPath, majorVersion);
      console.log(`[Java] 环境变量配置成功: ${targetPath}`);
    } catch (envErr) {
      console.warn(`[Java] 环境变量配置失败(不影响使用): ${envErr.message}`);
    }

    updateStatus('completed', 100, `Temurin JDK ${majorVersion} 安装成功！环境变量已配置。`);
    console.log(`[Java] JDK ${majorVersion} 安装成功: ${targetPath}`);

    // 自动更新全局 javaPath：当前未设置或新版本更高时覆盖
    try {
      const settings = versions.loadSettingsCached();
      const javaExeWin = path.join(targetPath, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      let updatePath = false;
      if (!settings.javaPath || !fs.existsSync(settings.javaPath)) {
        updatePath = true;
      } else {
        const currentMajor = getJavaMajorVersion(settings.javaPath);
        if (majorVersion > currentMajor && currentMajor > 0) {
          updatePath = true;
          console.log(`[Java] 当前默认Java ${currentMajor} < 新安装的Java ${majorVersion}，更新默认路径`);
        }
      }
      if (updatePath) {
        settings.javaPath = javaExeWin;
        saveSettings(settings);
        console.log(`[Java] 已自动配置javaPath: ${javaExeWin} (版本: ${majorVersion})`);
      }
    } catch (setErr) {
      console.warn('[Java] 自动配置javaPath失败:', setErr.message);
    }

  } catch (e) {
    console.error('[Java] 下载失败:', e.message);
    if (isAborted()) {
      updateStatus('cancelled', lastPct, '下载已取消');
    } else {
      updateStatus('error', lastPct, `安装失败: ${e.message}`);
    }
  } finally {
    ctx.sessions.javaDownloadAbortControllers.delete(sessionId);
  }
}

/* Java 环境变量配置 */

/**
 * 配置系统环境变量（PATH、JAVA_HOME），仅 Windows 有效
 * @param {string} javaHome - JDK 安装根目录
 * @param {number} majorVersion - Java 主版本号（用于版本比较）
 * @returns {Promise<{success: boolean, javaHome?: string, binPath?: string, message?: string}>}
 */
function configureJavaEnv(javaHome, majorVersion) {
  if (process.platform !== 'win32') {
    console.log('[JavaEnv] 非Windows平台，跳过系统环境变量配置');
    return Promise.resolve({ success: false, message: '非Windows平台，跳过环境变量配置' });
  }

  const javaBinDir = path.join(javaHome, 'bin');
  if (!fs.existsSync(javaBinDir)) {
    return Promise.reject(new Error(`Java bin目录不存在: ${javaBinDir}`));
  }

  // 把 exec 包成 Promise，便于在 async 流程里 await
  const execAsync = (cmd) => new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout.trim());
    });
  });

  return (async () => {
    // 路径归一化：统一小写、斜杠、去尾斜杠，用于 PATH 去重比较
    const normalizedJavaBin = javaBinDir.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

    // 1. 系统 PATH：检查是否已包含，未包含则追加
    try {
      const currentPath = await execAsync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path', 'Machine')"`);
      const pathEntries = currentPath.split(';').filter((p) => p.trim() !== '');
      const alreadyInPath = pathEntries.some((p) =>
        p.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') === normalizedJavaBin
      );

      if (alreadyInPath) {
        console.log(`[JavaEnv] ${javaBinDir} 已在系统PATH中，跳过`);
      } else {
        // 末尾已有 ; 时直接拼接，否则补一个分隔符
        const newPath = currentPath.endsWith(';')
          ? currentPath + javaBinDir
          : currentPath + ';' + javaBinDir;
        await execAsync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', '${newPath.replace(/'/g, "''")}', 'Machine')"`);
        console.log(`[JavaEnv] 已将 ${javaBinDir} 添加到系统PATH`);
      }
    } catch (e) {
      console.warn(`[JavaEnv] PATH配置失败(不影响): ${e.message}`);
    }

    // 2. JAVA_HOME：仅在不存在或新版本更高时更新，避免覆盖更高版本
    try {
      const currentJavaHome = await execAsync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine')"`);
      const normalizedJavaHome = javaHome.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
      const currentJavaHomeNorm = currentJavaHome.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

      if (currentJavaHome && currentJavaHomeNorm !== normalizedJavaHome) {
        // 从路径中提取主版本号比较：jdk-17、jdk8 等命名都按数字解析
        const existingMajorMatch = currentJavaHome.match(/jdk[-]?(\d+)/i);
        const newMajorMatch = javaHome.match(/jdk[-]?(\d+)/i);
        const existingMajor = existingMajorMatch ? parseInt(existingMajorMatch[1], 10) : 0;
        const newMajor = newMajorMatch ? parseInt(newMajorMatch[1], 10) : 0;

        if (newMajor >= existingMajor) {
          await execAsync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('JAVA_HOME', '${javaHome.replace(/'/g, "''")}', 'Machine')"`);
          console.log(`[JavaEnv] 已更新JAVA_HOME: ${javaHome}`);
        } else {
          console.log(`[JavaEnv] 现有JAVA_HOME(${currentJavaHome})版本更高，保留不变`);
        }
      } else if (!currentJavaHome) {
        await execAsync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('JAVA_HOME', '${javaHome.replace(/'/g, "''")}', 'Machine')"`);
        console.log(`[JavaEnv] 已设置JAVA_HOME: ${javaHome}`);
      }
    } catch (e) {
      console.warn(`[JavaEnv] JAVA_HOME配置失败(不影响): ${e.message}`);
    }

    // 3. 用户 PATH：作为系统 PATH 的补充，确保当前用户命令行也能用
    try {
      const currentUserPath = await execAsync(`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path', 'User')"`);
      const userPathEntries = currentUserPath.split(';').filter((p) => p.trim() !== '');
      const inUserPath = userPathEntries.some((p) =>
        p.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') === normalizedJavaBin
      );
      if (!inUserPath) {
        const newUserPath = currentUserPath.endsWith(';')
          ? currentUserPath + javaBinDir
          : currentUserPath + ';' + javaBinDir;
        await execAsync(`powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', '${newUserPath.replace(/'/g, "''")}', 'User')"`);
        console.log(`[JavaEnv] 已将 ${javaBinDir} 添加到用户PATH`);
      }
    } catch (e) {
      console.warn(`[JavaEnv] 用户PATH配置失败(不影响): ${e.message}`);
    }

    // 4. 当前进程环境变量：让本进程后续 spawn 的子进程立即生效
    try {
      process.env.PATH = javaBinDir + ';' + (process.env.PATH || '');
      process.env.JAVA_HOME = javaHome;
      console.log(`[JavaEnv] 当前进程环境变量已更新`);
    } catch (e) {
      console.warn(`[JavaEnv] 进程环境变量更新失败: ${e.message}`);
    }

    return { success: true, javaHome, binPath: javaBinDir };
  })();
}

/* Bundled Java 检测 */

/**
 * 扫描启动器自带目录与 Mojang runtime 目录，查找已安装的 Java 运行时
 * @returns {Array<{path: string, version: string, majorVersion: number, minorVersion: number, is64Bit: boolean, isJdk: boolean, source: string, javaHome: string}>} 检测到的 Java 列表
 */
function detectBundledJava() {
  const results = [];
  if (!fs.existsSync(ctx.dirs.JAVA_DIR)) return results;

  const javaExeNames = process.platform === 'win32' ? ['java.exe', 'javaw.exe'] : ['java'];

  // 递归在目录树中查找 bin/java（或 bin/javaw.exe），找到即返回
  const findJavaInDir = (dir, maxDepth, currentDepth = 0) => {
    if (currentDepth > maxDepth || !fs.existsSync(dir)) return;
    try {
      for (const javaExeName of javaExeNames) {
        const directJavaExe = path.join(dir, 'bin', javaExeName);
        if (fs.existsSync(directJavaExe)) {
          const javaHome = dir;
          // release 文件比 exec java -version 快得多，优先解析
          const versionFile = path.join(javaHome, 'release');
          let version = 'unknown';
          let majorVersion = 0;
          let minorVersion = 0;

          if (fs.existsSync(versionFile)) {
            const content = fs.readFileSync(versionFile, 'utf8');
            const match = content.match(/JAVA_VERSION="([^"]+)"/);
            if (match) {
              version = match[1];
              if (version.startsWith('1.')) {
                // 旧式 1.8.0_301
                majorVersion = parseInt(version.split('.')[1], 10);
                const upd = version.match(/_(\d+)/);
                if (upd) minorVersion = parseInt(upd[1], 10);
              } else {
                // 新式 17.0.1
                majorVersion = parseInt(version.split('.')[0], 10);
                const minorPart = version.split('.')[1];
                if (minorPart) minorVersion = parseInt(minorPart, 10) || 0;
              }
            }
          }

          // release 文件缺失或解析失败时，回退执行 java -version
          if (majorVersion <= 0) {
            const info = getJavaVersionInfo(directJavaExe);
            version = info.version;
            majorVersion = info.major;
            minorVersion = info.minor;
          }

          if (majorVersion > 0) {
            // 通过是否存在 javac 判断是 JDK 还是 JRE
            const isJdk = fs.existsSync(path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'));
            const normalized = directJavaExe.toLowerCase().replace(/\\/g, '/');
            // 去重：相同路径（不区分大小写、斜杠）只保留一条
            if (!results.some((r) => r.path.toLowerCase().replace(/\\/g, '/') === normalized)) {
              results.push({
                path: directJavaExe,
                version,
                majorVersion,
                minorVersion,
                is64Bit: true,
                isJdk,
                source: 'bundled',
                javaHome
              });
            }
          }
          return;
        }
      }
      // 当前目录无 bin/java，递归子目录
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          findJavaInDir(path.join(dir, entry.name), maxDepth, currentDepth + 1);
        }
      }
    } catch (e) {}
  };

  const javaDirs = fs.readdirSync(ctx.dirs.JAVA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const javaDirName of javaDirs) {
    // [CRITICAL - 2026-06-21] macOS 的 Java 运行时结构是 jre.bundle/Contents/Home/bin/java，
    // 比 Windows/Linux 多 2 层（.bundle 和 Contents/Home），所以 maxDepth 必须 >= 6。
    // 之前是 4，导致 macOS 上下载了 Java 但检测不到，游戏启动失败。
    findJavaInDir(path.join(ctx.dirs.JAVA_DIR, javaDirName), 6);
  }

  // 同时搜索 runtime 目录（Minecraft 官方 Java 运行时安装位置）
  const runtimeDir = path.join(ctx.dirs.DATA_DIR, 'runtime');
  if (fs.existsSync(runtimeDir)) {
    findJavaInDir(runtimeDir, 6);
  }

  return results;
}

/* Java 运行时列表 */

/**
 * 拉取 Mojang 官方 Java 运行时清单
 * @returns {Promise<object>} 按平台 key 索引的运行时映射
 */
async function getJavaRuntimeList() {
  const data = await http.fetchJSON(ctx.urls.JAVA_RUNTIME_URL);
  const platformKey = utils.getPlatformKey();
  return data[platformKey] || {};
}

/* Java 镜像 URL */

/**
 * 根据 mirror.urlMap 把原始 URL 替换为镜像 URL；未命中映射则原样返回
 * @param {string} originalUrl - 原始下载 URL
 * @param {object} mirror - 镜像配置对象，需含 urlMap 字段
 * @returns {string} 替换后的 URL
 */
function getJavaMirrorUrl(originalUrl, mirror) {
  if (!mirror || !mirror.urlMap) return originalUrl;
  for (const [original, replacement] of Object.entries(mirror.urlMap)) {
    if (originalUrl.startsWith(original)) {
      return originalUrl.replace(original, replacement);
    }
  }
  return originalUrl;
}

/* Java 运行时下载 */

/**
 * 下载并安装 Mojang 官方 Java 运行时组件（递归尝试多个镜像）
 * @param {string} component - 运行时组件名（如 java-runtime-gamma）
 * @param {(progress: object) => void} [onProgress] - 进度回调
 * @param {number} [mirrorIndex=0] - 当前使用的镜像索引，失败时递增
 * @returns {Promise<{path: string, version: string, component: string, source: string, javaHome: string}>}
 */
async function downloadJavaRuntime(component, onProgress, mirrorIndex = 0) {
  const mirror = ctx.mirrors.JAVA_DOWNLOAD_MIRRORS[mirrorIndex] || ctx.mirrors.JAVA_DOWNLOAD_MIRRORS[0];

  try {
    const runtimeList = await getJavaRuntimeList();
    const runtimeInfo = runtimeList[component];

    if (!runtimeInfo || runtimeInfo.length === 0) {
      throw new Error(`Java runtime ${component} not available for this platform`);
    }

    const runtime = runtimeInfo[0];
    let manifestUrl = runtime.manifest.url;
    if (mirror) {
      manifestUrl = getJavaMirrorUrl(manifestUrl, mirror);
    }

    // 阶段 1：拉取 manifest 文件
    if (onProgress) {
      onProgress({
        file: 'manifest',
        current: 0,
        total: 0,
        progress: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        speed: 0,
        source: mirror ? mirror.name : 'Mojang官方'
      });
    }

    const manifest = await http.fetchJSON(manifestUrl);

    // 阶段 2：解析文件清单，预计算总字节数
    const targetDir = path.join(ctx.dirs.JAVA_DIR, component);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const files = manifest.files || {};
    const fileEntries = Object.entries(files);
    const totalFiles = fileEntries.length;
    let downloadedFiles = 0;
    let totalBytes = 0;
    let downloadedBytes = 0;
    let lastTime = Date.now();
    let lastSpeedBytes = 0;
    let speed = 0;
    const fileBytes = {};

    for (const [filePath, fileInfo] of fileEntries) {
      if (fileInfo.downloads && fileInfo.downloads.raw) {
        const sz = fileInfo.downloads.raw.size || 0;
        totalBytes += sz;
        fileBytes[filePath] = sz;
      }
    }

    // 阶段 3：并发下载（最多 8 路），通过共享 idx 队列分配任务
    const CONCURRENT = 8;
    let idx = 0;

    async function downloadNext() {
      while (idx < fileEntries.length) {
        // 用闭包变量 i 锁定本次取到的下标，避免并发下 idx++ 造成重复处理
        const i = idx++;
        const [filePath, fileInfo] = fileEntries[i];
        const destPath = path.join(targetDir, filePath);
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        if (fileInfo.downloads && fileInfo.downloads.raw) {
          const download = fileInfo.downloads.raw;
          let downloadUrl = download.url;
          if (mirror) downloadUrl = getJavaMirrorUrl(downloadUrl, mirror);

          await http.downloadFile(downloadUrl, destPath, (progress) => {
            const now = Date.now();
            const elapsed = now - lastTime;
            // 累加增量字节用于总进度计算
            const incrementalBytes = (progress.bytesDownloaded || 0);
            downloadedBytes += incrementalBytes;
            // 至少 500ms 才更新速度，避免抖动
            if (elapsed >= 500) {
              speed = Math.round((downloadedBytes - lastSpeedBytes) * 1000 / elapsed);
              lastTime = now;
              lastSpeedBytes = downloadedBytes;
            }
            if (onProgress) {
              onProgress({
                file: path.basename(filePath),
                current: downloadedFiles + 1,
                total: totalFiles,
                progress: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
                downloadedBytes,
                totalBytes,
                speed,
                source: mirror ? mirror.name : 'Mojang官方'
              });
            }
          }, 3, null);
        } else {
          // 无 raw 下载项的文件（如目录占位）写空文件
          fs.writeFileSync(destPath, '');
        }

        // 非Windows 平台需要补可执行位
        if (fileInfo.executable && process.platform !== 'win32') {
          try { fs.chmodSync(destPath, 0o755); } catch (e) {}
        }

        downloadedFiles++;
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENT, totalFiles); w++) {
      workers.push(downloadNext());
    }
    await Promise.all(workers);

    return {
      path: path.join(targetDir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
      version: runtime.version.name,
      component,
      source: mirror ? mirror.name : 'Mojang官方',
      javaHome: targetDir
    };
  } catch (e) {
    // 当前镜像失败时递归尝试下一个镜像，直到用尽所有镜像
    if (mirrorIndex < ctx.mirrors.JAVA_DOWNLOAD_MIRRORS.length - 1) {
      console.log(`Java download from ${mirror ? mirror.name : 'default'} failed, trying next mirror...`);
      return downloadJavaRuntime(component, onProgress, mirrorIndex + 1);
    }
    throw e;
  }
}

/* 自动安装 Java */

/**
 * 自动检测并安装满足需求的 Java：先扫本地，未找到则提示手动安装
 * @param {number} [requiredVersion=17] - 所需的最低 Java 主版本号
 * @returns {Promise<{installed: boolean, javaPath?: string, version?: string, majorVersion?: number, needManual?: boolean, message?: string, sessionId?: string}>}
 */
async function autoInstallJava(requiredVersion = 17) {
  const systemJava = detectSystemJava();
  const bundledJava = detectBundledJava();
  const allJava = [...bundledJava, ...systemJava];

  // 已有满足版本要求的 Java：直接返回路径，无需安装
  const suitable = allJava.find((j) => j.majorVersion >= requiredVersion);
  if (suitable) {
    return { installed: false, javaPath: suitable.path, version: suitable.version, majorVersion: suitable.majorVersion };
  }

  // 未找到合适 Java：创建会话提示用户手动安装
  const sessionId = `java-auto-${Date.now()}`;
  ctx.sessions.javaInstallSessions.set(sessionId, {
    status: 'need_manual',
    progress: 0,
    message: `未找到合适的Java运行环境（需要 Java ${requiredVersion}），请在设置中手动安装或配置Java路径`,
    component: '',
    source: '',
    speed: 0
  });

  return { installed: false, needManual: true, message: `未找到合适的Java运行环境（需要 Java ${requiredVersion}），请在设置中手动安装或配置Java路径`, sessionId };
}

/* 导出 */

module.exports = {
  getRequiredJavaVersion,
  _parseMcVersion,
  _compareVersion,
  getLoaderInfoForJava,
  getJavaVersionRange,
  getJavaMajorVersion,
  getJavaVersionInfo,
  createClasspathWrapperJar,
  selectJavaForVersion,
  invalidateDepCheckCache,
  detectSystemJava,
  getTemurinMirrorUrl,
  getLibericaLatestVersion,
  downloadJavaAsync,
  configureJavaEnv,
  detectBundledJava,
  getJavaRuntimeList,
  getJavaMirrorUrl,
  downloadJavaRuntime,
  autoInstallJava
};
