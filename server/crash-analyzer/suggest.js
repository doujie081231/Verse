/**
 * @file server/crash-analyzer/suggest.js - 修复建议生成
 *   包含 getAnalyzeResult 方法，
 *   通过 Object.assign 挂载到 CrashAnalyzer.prototype 上。
 */

const { CrashReason } = require('./constants');

module.exports = {
  /**
   * 汇总分析结果：按崩溃原因逐条生成修复建议
   * @param {boolean} isHandAnalyze - 是否手动导入分析
   * @returns {string} 拼接后的修复建议文本
   */
  getAnalyzeResult(isHandAnalyze) {
    if (!this.crashReasons.size) {
      if (isHandAnalyze) {
        return '分析完成：VersePC 无法确定崩溃原因。';
      } else {
        return `很抱歉，我们未能分析出该日志中的崩溃原因。${'\n'}如果你认为这应当被分析出，请提交反馈。`.trim();
      }
    }

    const results = [];
    // 每个崩溃原因对应一条修复建议
    for (const [reason, additional] of this.crashReasons) {
      switch (reason) {
        case CrashReason.JavaVersionTooHigh:
          results.push('当前 Java 版本过高，请降低 Java 版本后再试。\n请下载安装 Java 8 或 Java 11。');
          break;
        case CrashReason.ModFileExtracted:
          results.push('发现 Mod 文件被解压，请删除解压后的文件夹。\n请直接把 Mod 的 .jar 文件放进 Mod 文件夹，不要解压它。');
          break;
        case CrashReason.MixinBootstrapError:
          results.push('MixinBootstrap 错误，请尝试更新或移除相关 Mod。');
          break;
        case CrashReason.OutOfMemory:
          results.push('Minecraft 内存不足，请尝试增加游戏内存。\n如果仍然崩溃，可能是 Mod 过多或资源包过大导致的内存不足。\n\n建议：\n - 如果安装了过多 Mod，请尝试删除一些不必要的 Mod。\n - 如果使用了高分辨率资源包，请尝试使用更低分辨率的资源包。\n - 如果内存仍然不足，请尝试增加游戏内存（通常 4GB-8GB 足够）。');
          break;
        case CrashReason.UsingJDK:
          results.push('你正在使用 JDK 而不是 JRE，这可能导致游戏崩溃。\n请下载安装 Java 运行时环境（JRE）而不是 Java 开发工具包（JDK）。');
          break;
        case CrashReason.UsingOpenJ9:
          results.push('你正在使用 OpenJ9 Java，这可能导致游戏崩溃。\n请下载安装 Java 8 或 Java 11 的 HotSpot VM 版本。');
          break;
        case CrashReason.JavaTooOld:
          results.push('Java 版本过旧，请更新 Java。\n请下载安装最新版本的 Java 8 或 Java 11。');
          break;
        case CrashReason.ModDuplicateModFiles:
          results.push('发现重复的 Mod 文件，请删除重复的 Mod。\n请检查 Mod 文件夹，确保每个 Mod 只有一个文件。');
          break;
        case CrashReason.ModRequiresJava11:
          results.push('某些 Mod 需要 Java 11，请下载安装 Java 11。\n请在启动设置中将 Java 版本切换为 Java 11。');
          break;
        case CrashReason.ModMissingDependency:
          if (additional && additional.length > 0) {
            results.push(`发现缺少前置或版本不兼容的 Mod，请安装或更新以下前置 Mod：\n - ${additional.join('\n - ')}\n\n请安装缺少的前置 Mod 或更新到兼容的版本。`);
          } else {
            results.push('发现缺少前置或版本不兼容的 Mod，请检查日志文件中的详细信息。\n请安装缺少的前置 Mod 或更新到兼容的版本。');
          }
          break;
        case CrashReason.ModIncompatible:
          if (additional && additional.length === 1) {
            results.push(`VersePC 发现以下 Mod 可能导致崩溃：${additional[0]}\n请尝试删除或更新该 Mod。`);
          } else {
            results.push(`VersePC 发现以下 Mod 可能导致崩溃：\n - ${additional.join('\n - ')}\n\n请尝试删除或更新这些 Mod。`);
          }
          break;
        case CrashReason.ModCrashed:
          if (additional && additional.length === 1) {
            results.push(`发现 ${additional[0]} Mod 导致崩溃，请尝试删除或更新该 Mod。`);
          } else {
            results.push(`发现以下 Mod 导致崩溃：\n - ${additional.join('\n - ')}\n\n请尝试删除或更新这些 Mod。`);
          }
          break;
        case CrashReason.ModNoInfo:
          if (additional && additional.length === 1) {
            results.push(`发现 ${additional[0]} Mod 导致崩溃，但无法获取详细信息。\n请尝试删除或更新该 Mod。`);
          } else {
            results.push(`发现以下 Mod 导致崩溃，但无法获取详细信息：\n - ${additional.join('\n - ')}\n\n请尝试删除或更新这些 Mod。`);
          }
          break;
        case CrashReason.ModMixinError:
          if (!additional || additional.length === 0) {
            results.push('检测到 Mod Mixin 错误，请尝试更新或移除相关 Mod。\n通常这是因为 Mod 版本不兼容或 Mod 本身存在问题。');
          } else if (additional.length === 1) {
            results.push(`发现 ${additional[0]} Mod 的 Mixin 出错，请尝试更新或移除该 Mod。`);
          } else {
            results.push(`发现以下 Mod 的 Mixin 出错：\n - ${additional.join('\n - ')}\n\n请尝试更新或移除这些 Mod。`);
          }
          break;
        case CrashReason.ModNameContainsSpecialChars:
          if (additional && additional.length === 1) {
            results.push(`发现 Mod 名称包含特殊字符：${additional[0]}\n请重命名该 Mod 文件，移除特殊字符。`);
          } else {
            results.push(`发现以下 Mod 名称包含特殊字符：\n - ${additional.join('\n - ')}\n\n请重命名这些 Mod 文件，移除特殊字符。`);
          }
          break;
        case CrashReason.ModNameDuplicate:
          results.push('发现 Mod 名称重复，请检查并重命名 Mod 文件。\nMod 的文件名不能完全相同，即使它们位于不同的文件夹中。');
          break;
        case CrashReason.OptiFineIncompatible:
          results.push('发现 OptiFine 不兼容，请更新 OptiFine 或删除它。\nOptiFine 可能与当前版本的 Minecraft 或 Forge 不兼容。');
          break;
        case CrashReason.ShadersModWithOptiFine:
          results.push('发现 Shaders Mod 与 OptiFine 冲突，请删除 Shaders Mod。\nOptiFine 已内置光影支持，不需要额外的 Shaders Mod。');
          break;
        case CrashReason.ForgeMissing:
          results.push('发现 Forge 缺失，请重新安装 Forge。\n可能是 Forge 文件损坏或未正确安装。');
          break;
        case CrashReason.FabricCrash:
          if (additional && additional.length === 1) {
            results.push(`Fabric Mod ${additional[0]} 导致崩溃，请尝试删除或更新该 Mod。`);
          } else {
            results.push('Fabric Mod 崩溃，请检查日志文件中的详细信息。\n请尝试删除或更新最近安装的 Fabric Mod。');
          }
          break;
        case CrashReason.ForgeCrash:
          if (additional && additional.length === 1) {
            results.push(`Forge Mod ${additional[0]} 导致崩溃，请尝试删除或更新该 Mod。`);
          } else {
            results.push('Forge Mod 崩溃，请检查日志文件中的详细信息。\n请尝试删除或更新最近安装的 Forge Mod。');
          }
          break;
        case CrashReason.ModLoaderVersionIncompatible:
          results.push('Mod 加载器版本与 Mod 不兼容，请更新或降级加载器版本。\n请检查 Mod 的要求，并安装相应版本的 Forge 或 Fabric。');
          break;
        case CrashReason.NightConfigBug:
          results.push('发现 Night Config Bug，这是 Minecraft 的一个已知问题。\n请尝试更新 Forge 或删除相关配置文件。');
          break;
        case CrashReason.OpenGL1282Error:
          results.push('发现 OpenGL 1282 错误，这通常与显卡驱动有关。\n请尝试更新显卡驱动或降低游戏图形设置。');
          break;
        case CrashReason.ModIdConflict:
          if (additional && additional.length === 1) {
            results.push(`发现 Mod ID 冲突：${additional[0]}\n请删除其中一个冲突的 Mod。`);
          } else {
            results.push(`发现以下 Mod ID 冲突：\n - ${additional.join('\n - ')}\n\n请删除其中一个冲突的 Mod。`);
          }
          break;
        case CrashReason.InvalidPath:
          results.push('发现无效路径，请检查游戏安装路径。\n游戏路径中不能包含特殊字符或过长的路径。');
          break;
        case CrashReason.ModCyclicIssue:
          results.push('发现 Mod 循环依赖问题，请检查 Mod 的依赖关系。\n某些 Mod 可能相互依赖，导致无法加载。');
          break;
        case CrashReason.SecurityException:
          results.push('发现安全异常，请检查 Java 安全设置。\n可能是 Java 安全策略限制了某些操作。');
          break;
        case CrashReason.NativeLinkError:
          if (additional && additional.length > 0 && additional[0] !== '请检查游戏路径是否包含中文字符') {
            results.push(`无法加载本地库 ${additional[0]}。\n请检查游戏路径是否包含中文字符，或尝试重新安装整合包。\n如果是 Forge 整合包，可以在启动器中重新安装 Forge。`);
          } else {
            results.push('无法加载本地库（LWJGL Native），游戏路径可能包含中文字符。\n请将游戏移动到纯英文路径下，或在设置中修复游戏目录。');
          }
          break;
        case CrashReason.IntelDriverCrash:
        case CrashReason.AMDDriverCrash:
        case CrashReason.NVidiaDriverCrash:
          results.push('发现显卡驱动崩溃，请尝试更新显卡驱动。\n如果问题仍然存在，请尝试降低游戏图形设置或使用 Fast 模式而不是 Fancy 模式。');
          break;
        case CrashReason.PixelFormatNotAccelerated:
          results.push('发现像素格式未加速错误，这通常与显卡驱动有关。\n请尝试更新显卡驱动或降低游戏图形设置。');
          break;
        case CrashReason.ManuallyTriggeredCrash:
          results.push('发现手动触发的崩溃，这通常是为了测试目的。\n如果你不是故意触发此崩溃，请检查你的操作。');
          break;
        case CrashReason.Unknown:
          if (additional && additional.length > 0) {
            results.push(`发现未知错误：${additional[0]}`);
          } else {
            results.push('发现未知错误，请检查日志文件中的详细信息。');
          }
          break;
        default:
          results.push(`VersePC 检测到崩溃原因：${reason}\n请检查日志文件中的详细信息。`);
          break;
      }
    }

    return results.join('\n\n').trim();
  }
};
