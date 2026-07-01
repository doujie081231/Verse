/**
 * @file server/versions/version-merge.js - 参数去重、版本 JSON 合并、规则评估
 * @description 纯数据操作函数，不依赖文件系统或共享状态。
 */

// JVM 参数去重：先展开多值标志（--add-opens 等），再去重 -D/-X/-XX 开头的重复参数
function deduplicateJvmArgs(args) {
  if (!args || !Array.isArray(args) || args.length === 0) {
    return args || [];
  }

  const MULTI_VALUE_FLAGS = new Set(['--add-opens', '--add-exports', '--add-reads', '--add-modules']);
  const expanded = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg === 'string' && MULTI_VALUE_FLAGS.has(arg)) {
      const values = [];
      while (i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('-')) {
        i++;
        values.push(args[i]);
      }
      if (values.length === 0) {
        expanded.push(arg);
      } else {
        for (const v of values) { expanded.push(arg, v); }
      }
    } else {
      expanded.push(arg);
    }
  }

  const seenStringArgs = new Set();
  const result = [];

  for (let i = 0; i < expanded.length; i++) {
    const arg = expanded[i];

    if (typeof arg !== 'string') {
      result.push(arg);
      continue;
    }

    if (arg.startsWith('-D') || arg.startsWith('-X') || arg.startsWith('-XX')) {
      if (seenStringArgs.has(arg)) continue;
      seenStringArgs.add(arg);
      result.push(arg);
    } else {
      result.push(arg);
    }
  }

  return result;
}

// 游戏参数去重：对单值选项（如 --username）去重，保留首次出现的值
function deduplicateGameArgs(args) {
  if (!args || !Array.isArray(args) || args.length === 0) {
    return args || [];
  }

  const SINGLE_VALUE_OPTIONS = new Set([
    '--version', '--username', '--uuid', '--accessToken',
    '--userType', '--versionType', '--gameDir', '--assetsDir',
    '--assetIndex', '--width', '--height', '--server', '--port',
    '--xuid', '--clientId',
    '--launchTarget', '--fml.forgeVersion', '--fml.mcVersion',
    '--fml.forgeGroup', '--fml.mcpVersion', '--fml.neoForgeVersion',
    '--fml.neoFormVersion', '--fml.fmlVersion', '--fml.mcVersion'
  ]);

  const result = [];
  const seenOptions = new Set();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (typeof arg !== 'string') {
      result.push(arg);
      continue;
    }

    if (SINGLE_VALUE_OPTIONS.has(arg)) {
      if (seenOptions.has(arg)) {
        if (i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--')) {
          i++;
        }
        continue;
      }
      seenOptions.add(arg);
      result.push(arg);
      if (i + 1 < args.length && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--')) {
        result.push(args[i + 1]);
        i++;
      }
    } else {
      result.push(arg);
    }
  }

  return result;
}

// 合并父版本与子版本 JSON：子版本字段优先，库去重合并，参数合并去重
function mergeVersionJson(parent, child) {
  const merged = { ...parent };
  const childKeys = Object.keys(child);

  for (const key of childKeys) {
    if (key === 'libraries') continue;
    if (key === 'arguments') continue;
    if (key === 'minecraftArguments') continue;
    if (key === 'downloads') continue;
    if (key === 'assetIndex') continue;
    if (key === 'javaVersion') {
      if (child[key] && child[key].majorVersion) {
        merged[key] = child[key];
      }
      continue;
    }
    if (child[key] !== undefined && child[key] !== null) {
      merged[key] = child[key];
    }
  }

  if (child.inheritsFrom) {
    merged.inheritsFrom = child.inheritsFrom;
  }
  if (child.id) {
    merged.id = child.id;
  }

  const childLibs = child.libraries || [];
  const parentLibs = parent.libraries || [];
  const childLibKeys = new Set();
  for (const lib of childLibs) {
    if (lib.name) {
      const parts = lib.name.split(':');
      if (parts.length >= 2) childLibKeys.add(parts[0] + ':' + parts[1]);
    }
  }
  // 过滤父版本库：如果子版本已有相同 group:artifact 的库则跳过
  // 同时处理命名变体（如 bootstraplauncher vs bootstrapslauncher 带/不带 s）
  const normalizedChildKeys = new Set();
  for (const key of childLibKeys) {
    normalizedChildKeys.add(key);
    // 生成规范化 key（去掉尾部 s 变体，如 bootstraplauncher↔bootstrapslauncher）
    const parts = key.split(':');
    if (parts.length >= 2) {
      const base = parts[1].replace(/s$/, ''); // 去掉末尾的 s
      normalizedChildKeys.add(`${parts[0]}:${base}`);
      normalizedChildKeys.add(`${parts[0]}:${base}s`); // 加回 s
    }
  }

  const filteredParentLibs = parentLibs.filter((lib) => {
    if (!lib.name) return true;
    const parts = lib.name.split(':');
    if (parts.length >= 2 && normalizedChildKeys.has(parts[0] + ':' + parts[1])) return false;
    // 也检查规范化后的名称
    if (parts.length >= 2) {
      const base = parts[1].replace(/s$/, '');
      if (normalizedChildKeys.has(`${parts[0]}:${base}`)) return false;
    }
    return true;
  });
  merged.libraries = [...childLibs, ...filteredParentLibs];

  merged.arguments = merged.arguments || {};
  const childJvm = child.arguments?.jvm || [];
  const parentJvm = parent.arguments?.jvm || [];
  const childGame = child.arguments?.game || [];
  const parentGame = parent.arguments?.game || [];

  if (child.minecraftArguments && !child.arguments?.jvm && !child.arguments?.game) {
    merged.arguments.jvm = parentJvm;
    merged.arguments.game = parentGame;
  } else {
    if (childJvm.length > 0 || parentJvm.length > 0) {
      merged.arguments.jvm = deduplicateJvmArgs([...childJvm, ...parentJvm]);
    }
    if (childGame.length > 0 || parentGame.length > 0) {
      merged.arguments.game = deduplicateGameArgs([...childGame, ...parentGame]);
    }
  }

  // 合并 Fabric/NeoForge 的非标准参数组
  for (const argGroupKey of ['default-user-jvm', 'default-user-game', 'default-jvm', 'default-game']) {
    const childGroup = child.arguments?.[argGroupKey] || [];
    const parentGroup = parent.arguments?.[argGroupKey] || [];
    if (childGroup.length > 0 || parentGroup.length > 0) {
      merged.arguments[argGroupKey] = [...childGroup, ...parentGroup];
    }
  }

  if (child.minecraftArguments) {
    merged.minecraftArguments = child.minecraftArguments;
  } else if (parent.minecraftArguments) {
    merged.minecraftArguments = parent.minecraftArguments;
  }

  if (child.mainClass) {
    merged.mainClass = child.mainClass;
  }

  if (child.downloads) {
    merged.downloads = { ...parent.downloads, ...child.downloads };
  }
  if (child.assetIndex) {
    merged.assetIndex = child.assetIndex;
  } else if (parent.assetIndex) {
    merged.assetIndex = parent.assetIndex;
  }
  if (child.javaVersion) {
    merged.javaVersion = child.javaVersion;
  } else if (parent.javaVersion) {
    merged.javaVersion = parent.javaVersion;
  }
  if (child.jar) {
    merged.jar = child.jar;
  } else if (parent.jar) {
    merged.jar = parent.jar;
  }
  if (child.assets) {
    merged.assets = child.assets;
  } else if (parent.assets) {
    merged.assets = parent.assets;
  }
  if (child.type) {
    merged.type = child.type;
  }

  // Fabric 主类但缺少 fabric-loader/intermediary 库时自动补齐
  if (merged.mainClass && merged.mainClass.startsWith('net.fabricmc')) {
    const libs = merged.libraries || [];
    const hasFabricLoader = libs.some((l) => l.name && l.name.startsWith('net.fabricmc:fabric-loader'));
    const hasIntermediary = libs.some((l) => l.name && l.name.startsWith('net.fabricmc:intermediary'));
    if (!hasFabricLoader || !hasIntermediary) {
      const versionId = child.id || merged.id || '';
      let loaderVer = '0.16.10';
      let mcVer = '';
      const versePcMatch = versionId.match(/fabric-loader-(\d+\.\d+\.\d+)-(.+)/);
      const fabricMatch = versionId.match(/-Fabric-(\d+\.\d+\.\d+)/);
      if (versePcMatch) { loaderVer = versePcMatch[1]; mcVer = versePcMatch[2]; }
      else if (fabricMatch) { loaderVer = fabricMatch[1]; }
      if (!mcVer) {
        const mcMatch = (merged.inheritsFrom || versionId).match(/(\d+\.\d+(?:\.\d+)?)/);
        if (mcMatch) mcVer = mcMatch[1];
      }
      const newLibs = [];
      if (!hasFabricLoader) {
        const loaderJarName = `fabric-loader-${loaderVer}.jar`;
        newLibs.push({
          name: `net.fabricmc:fabric-loader:${loaderVer}`,
          url: 'https://maven.fabricmc.net/',
          downloads: {
            artifact: {
              path: `net/fabricmc/fabric-loader/${loaderVer}/${loaderJarName}`,
              url: `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${loaderVer}/${loaderJarName}`
            }
          }
        });
      }
      if (!hasIntermediary && mcVer) {
        const interJarName = `intermediary-${mcVer}.jar`;
        newLibs.push({
          name: `net.fabricmc:intermediary:${mcVer}`,
          url: 'https://maven.fabricmc.net/',
          downloads: {
            artifact: {
              path: `net/fabricmc/intermediary/${mcVer}/${interJarName}`,
              url: `https://maven.fabricmc.net/net/fabricmc/intermediary/${mcVer}/${interJarName}`
            }
          }
        });
      }
      if (newLibs.length > 0) {
        merged.libraries = [...newLibs, ...libs];
      }
    }
  }

  return merged;
}

/**
 * 评估 Mojang 版本 JSON 的 rules 数组，决定某条库/参数是否在当前环境生效
 * @param {Array<{action: string, os?: object, features?: object}>} rules - 规则数组
 * @param {object} [extraVars={}] - 额外变量（如 hasCustomResolution）
 * @returns {boolean} 是否允许
 */
function evaluateRules(rules, extraVars = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = null;
  let hasAllowRule = false;
  for (const rule of rules) {
    const action = rule.action;
    if (action === 'allow') hasAllowRule = true;
    let ruleMatched = true;

    if (rule.os) {
      const osName = rule.os.name;
      const isCurrentOS = (process.platform === 'win32' && osName === 'windows') ||
                         (process.platform === 'darwin' && osName === 'osx') ||
                         (process.platform === 'linux' && osName === 'linux');

      let osMatch = isCurrentOS;

      if (rule.os.arch) {
        const isCurrentArch = (rule.os.arch === 'x86' && process.arch === 'ia32') ||
                             (rule.os.arch === 'x64' && process.arch === 'x64');
        osMatch = osMatch && isCurrentArch;
      }

      if (rule.os.version) {
        // 用正则匹配系统版本号；过长的输入直接判负，避免 ReDoS
        const osVersion = require('os').release();
        try {
          const regex = new RegExp(rule.os.version);
          const testResult = regex.test(osVersion);
          osMatch = osMatch && testResult;
        } catch (e) {
          osMatch = false;
        }
        if (osVersion.length > 256) {
          osMatch = false;
        }
      }

      ruleMatched = osMatch;
    }

    if (rule.features) {
      // demo 用户当前不支持
      if (rule.features.is_demo_user) {
        ruleMatched = ruleMatched && false;
      }
      if (rule.features.has_custom_resolution) {
        ruleMatched = ruleMatched && !!extraVars.hasCustomResolution;
      }
      // quick play 系列特性当前一律不匹配
      if (rule.features.has_quick_plays_support) {
        ruleMatched = false;
      }
      if (rule.features.is_quick_play_singleplayer) {
        ruleMatched = false;
      }
      if (rule.features.is_quick_play_multiplayer) {
        ruleMatched = false;
      }
      if (rule.features.is_quick_play_realms) {
        ruleMatched = false;
      }
    }

    if (!rule.os && !rule.features) {
      ruleMatched = true;
    }

    if (ruleMatched) {
      allowed = action === 'allow';
    }
  }
  if (allowed !== null) return allowed;
  return !hasAllowRule;
}

module.exports = {
  deduplicateJvmArgs,
  deduplicateGameArgs,
  mergeVersionJson,
  evaluateRules
};
