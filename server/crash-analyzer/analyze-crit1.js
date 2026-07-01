/**
 * @file server/crash-analyzer/analyze-crit1.js - 一级崩溃分析
 *   高置信度关键字匹配（Java 版本、Mod 解压、Mixin、内存、驱动等），
 *   通过 Object.assign 挂载到 CrashAnalyzer.prototype 上。
 */

const { CrashReason } = require('./constants');

module.exports = {
  /**
   * 一级分析：高置信度关键字匹配（Java 版本、Mod 解压、Mixin、内存、驱动等）
   */
  analyzeCrit1() {
    if (!this.logMc && !this.logHs && !this.logCrash) {
      this.appendReason(CrashReason.Unknown, ['未找到任何日志文件']);
      return;
    }

    // 崩溃报告中的关键字
    if (this.logCrash) {
      if (this.logCrash.includes('Unable to make protected final java.lang.Class java.lang.ClassLoader.defineClass')) {
        this.appendReason(CrashReason.JavaVersionTooHigh);
      }
      if (this.logCrash.includes('Failed loading config file ')) {
        this.appendReason(CrashReason.ModFileExtracted, [
          this.tryAnalyzeModName(this.regexSeek(this.logCrash, '(?<=Failed loading config file .+ for modid )[^\\n]+')?.trim()),
          this.regexSeek(this.logCrash, '(?<=Failed loading config file ).+(?= of type)')?.trim()
        ]);
      }
    }

    // 游戏日志中的关键字
    if (this.logMc) {
      if (this.logMc.includes('Unrecognized option:')) {
        this.appendReason(CrashReason.JavaVersionTooHigh);
      }
      if (this.logMc.includes('Found multiple arguments for option fml.forgeVersion, but you asked for only one')) {
        this.appendReason(CrashReason.ModLoaderVersionIncompatible);
      }
      if (this.logMc.includes('The driver does not appear to support OpenGL')) {
        this.appendReason(CrashReason.UsingOpenJ9);
      }
      if (this.logMc.includes('java.lang.ClassCastException: java.base/jdk')) {
        this.appendReason(CrashReason.UsingJDK);
      }
      if (this.logMc.includes('java.lang.ClassCastException: class jdk.')) {
        this.appendReason(CrashReason.UsingJDK);
      }
      // OptiFine 缺少 Forge 的多种 NoSuchMethodError 表现
      if (this.logMc.includes('TRANSFORMER/net.optifine/net.optifine.reflect.Reflector.<clinit>(Reflector.java)')) {
        this.appendReason(CrashReason.OptiFineMissingForge);
      }
      if (this.logMc.includes('java.lang.NoSuchMethodError: \'void net.minecraft.client.renderer.texture.SpriteContents.<init>()\'')) {
        this.appendReason(CrashReason.OptiFineMissingForge);
      }
      if (this.logMc.includes('java.lang.NoSuchMethodError: \'java.lang.String com.mojang.blaze3d.systems.RenderSystem.getBackendDescription\'')) {
        this.appendReason(CrashReason.OptiFineMissingForge);
      }
      if (this.logMc.includes('java.lang.NoSuchMethodError: \'void net.minecraft.client.renderer.block.model.BakedQuad.<init>()\'')) {
        this.appendReason(CrashReason.OptiFineMissingForge);
      }
      if (this.logMc.includes('java.lang.NoSuchMethodError: \'void net.minecraftforge.client.gui.overlay.ForgeGui.renderSelectedItemName\'')) {
        this.appendReason(CrashReason.OptiFineMissingForge);
      }
      if (this.logMc.includes('java.lang.NoSuchMethodError: \'void net.minecraft.world.level.DistanceManager\'')) {
        this.appendReason(CrashReason.OptiFineMissingForge);
      }
      if (this.logMc.includes('java.lang.NoSuchMethodError: net.minecraft.network.chat.FormattedText net.minecraft.client.gui.Font.ellipsize')) {
        this.appendReason(CrashReason.OptiFineMissingForge);
      }
      if (this.logMc.includes('Open J9 is not supported') || this.logMc.includes('OpenJ9 is incompatible') || this.logMc.includes('.J9VMInternals.')) {
        this.appendReason(CrashReason.UsingOpenJ9);
      }
      if (this.logMc.includes('java.lang.NoSuchFieldException: ucp')) {
        this.appendReason(CrashReason.JavaVersionTooHigh);
      }
      if (this.logMc.includes('because module java.base does not export')) {
        this.appendReason(CrashReason.JavaVersionTooHigh);
      }
      if (this.logMc.includes('java.lang.ClassNotFoundException: jdk.nashorn.api.scripting.NashornScriptEngineFactory')) {
        this.appendReason(CrashReason.JavaVersionTooHigh);
      }
      if (this.logMc.includes('java.lang.ClassNotFoundException: class jdk.')) {
        this.appendReason(CrashReason.JavaVersionTooHigh);
      }
      if (this.logMc.includes('The directories below appear to be extracted jar files. Fix this before you continue.')) {
        this.appendReason(CrashReason.ModFileExtracted);
      }
      // 游戏日志中的关键字匹配（续）
      if (this.logMc.includes('Extracted mod jars found, loading will NOT continue')) {
        this.appendReason(CrashReason.ModFileExtracted);
      }
      if (this.logMc.includes('java.lang.ClassNotFoundException: org.spongepowered.asm.launch.MixinTweaker')) {
        this.appendReason(CrashReason.MixinBootstrapError);
      }
      if (this.logMc.includes('Couldn\'t set pixel format')) {
        this.appendReason(CrashReason.PixelFormatNotAccelerated);
      }
      if (this.logMc.includes('java.lang.OutOfMemoryError') || this.logMc.includes('an out of memory error')) {
        this.appendReason(CrashReason.OutOfMemory);
      }
      if (this.logMc.includes('java.lang.RuntimeException: Shaders Mod detected. Please remove it, OptiFine has built-in support for shaders.')) {
        this.appendReason(CrashReason.ShadersModWithOptiFine);
      }
      if (this.logMc.includes('java.lang.NoSuchMethodError: sun.security.util.ManifestEntryVerifier') ||
        this.logMc.includes('java.lang.NoSuchMethodError: \'void sun.security.util.ManifestEntryVerifier\'')) {
        this.appendReason(CrashReason.ModLoaderVersionIncompatible);
      }
      if (this.logMc.includes('1282: Invalid operation')) {
        this.appendReason(CrashReason.OpenGL1282Error);
      }
      if (this.logMc.includes('signer information does not match signer information of other classes in the same package')) {
        this.appendReason(CrashReason.ModNameContainsSpecialChars,
          this.regexSeek(this.logMc, '(?<=class ")[^\'"]+(?="\'s signer information)')?.trim());
      }
      if (this.logMc.includes('Maybe try a lower resolution resourcepack?')) {
        this.appendReason(CrashReason.ModCyclicIssue);
      }
      if (this.logMc.includes('java.lang.NoSuchMethodError: net.minecraft.world.server.ChunkManager$ProxyTicketManager.shouldForceTickets(J)Z') && this.logMc.includes('OptiFine')) {
        this.appendReason(CrashReason.OptiFineIncompatible);
      }
      if (this.logMc.includes('Unsupported class file major version')) {
        this.appendReason(CrashReason.JavaTooOld);
      }
      if (this.logMc.includes('com.electronwill.nightconfig.core.io.ParsingException: Not enough data available') && !this.crashReasons.has(CrashReason.NightConfigBug)) {
        this.appendReason(CrashReason.NightConfigBug);
      }
      if (this.logMc.includes('Cannot find launch target fmlclient, unable to launch')) {
        this.appendReason(CrashReason.ForgeMissing);
      }
      if (this.logMc.includes('Invalid paths argument, contained no existing paths') && this.logMc.includes('libraries\\net\\minecraftforge\\fmlcore')) {
        this.appendReason(CrashReason.ForgeMissing);
      }
      if (this.logMc.includes('Invalid module name: \'\' is not a Java identifier')) {
        this.appendReason(CrashReason.ModNameDuplicate);
      }
      if (this.logMc.includes('has been compiled by a more recent version of the Java Runtime (class file version 55.0), this version of the Java Runtime only recognizes class file versions up to')) {
        this.appendReason(CrashReason.ModRequiresJava11);
      }
      if (this.logMc.includes('java.lang.RuntimeException: java.lang.NoSuchMethodException: no such method: sun.misc.Unsafe.defineAnonymousClass(Class,byte[],Object[])Class/invokeVirtual')) {
        this.appendReason(CrashReason.ModRequiresJava11);
      }
      if (this.logMc.includes('java.lang.IllegalArgumentException: The requested compatibility level JAVA_11 could not be set. Level is not supported by the active JRE or ASM version')) {
        this.appendReason(CrashReason.ModRequiresJava11);
      }
      if (this.logMc.includes('Unsupported major.minor version')) {
        this.appendReason(CrashReason.JavaTooOld);
      }
      if (this.logMc.includes('Invalid maximum heap size')) {
        this.appendReason(CrashReason.OutOfMemory);
      }
      if (this.logMc.includes('Could not reserve enough space')) {
        if (this.logMc.includes('for 1048576KB object heap')) {
          this.appendReason(CrashReason.OutOfMemory);
        } else {
          this.appendReason(CrashReason.OutOfMemory);
        }
      }
      // Mod 崩溃：从 "Caught exception from" 后提取 Mod 名
      if (this.logMc.includes('Caught exception from ')) {
        this.appendReason(CrashReason.ModCrashed,
          this.tryAnalyzeModName(this.regexSeek(this.logMc, '(?<=Caught exception from )[^\\n]+')?.trim()));
      }
      // 重复 Mod：多种关键字匹配，提取 .jar 文件名
      if (this.logMc.includes('DuplicateModsFoundException')) {
        this.appendReason(CrashReason.ModDuplicateModFiles,
          this.regexSeek(this.logMc, '(?<=\n\t[\\w]+ : [A-Za-z][^/\\n]+(/|\\\\)[^/\\\\\\n]+\\.jar', 'gi'));
      }
      if (this.logMc.includes('Found a duplicate mod')) {
        this.appendReason(CrashReason.ModDuplicateModFiles,
          this.regexSeek(this.logMc.includes('Found a duplicate mod[^\\n]+') ? this.logMc : '', '[^\\/]+\\.jar', 'gi'));
      }
      if (this.logMc.includes('Found duplicate mods')) {
        const modIds = this.regexSeek(this.logMc, '(?<=Mod ID: \')\\w+(?=\' from mod files:)');
        this.appendReason(CrashReason.ModDuplicateModFiles, modIds ? [...new Set(modIds.split('\n'))] : []);
      }
      if (this.logMc.includes('ModResolutionException: Duplicate')) {
        this.appendReason(CrashReason.ModDuplicateModFiles,
          this.regexSeek(this.logMc.includes('ModResolutionException: Duplicate[^\\n]+') ? this.logMc : '', '[^\\/]+\\.jar', 'gi'));
      }
      // 不兼容 Mod
      if (this.logMc.includes('Incompatible mods found!')) {
        this.appendReason(CrashReason.ModIncompatible,
          this.regexSeek(this.logMc, '(?<=Incompatible mods found![\\s\\S]+: )[\\s\\S]+?(?=\\tat )')?.replace('Some of your mods are incompatible with the game or each other!', '')?.trim());
      }
      // 缺少前置 Mod：提取依赖列表
      if (this.logMc.includes('Missing or unsupported mandatory dependencies:')) {
        const depMatch = this.regexSeek(this.logMc, '(?<=Missing or unsupported mandatory dependencies:)([\\n\\r]+\\t.*)+', 'gi');
        const deps = depMatch ? [...new Set(depMatch.split('\n').map((s) => s.trim()).filter((s) => s))] : [];
        this.appendReason(CrashReason.ModMissingDependency, deps);
      }
    }

    // JVM 崩溃日志中的关键字
    if (this.logHs) {
      if (this.logHs.includes('The system is out of physical RAM or swap space')) {
        this.appendReason(CrashReason.OutOfMemory);
      }
      if (this.logHs.includes('Out Of Memory Error')) {
        this.appendReason(CrashReason.OutOfMemory);
      }
      // EXCEPTION_ACCESS_VIOLATION：根据驱动库名区分显卡厂商
      if (this.logHs.includes('EXCEPTION_ACCESS_VIOLATION')) {
        if (this.logHs.includes('# C  [ig')) {
          this.appendReason(CrashReason.IntelDriverCrash);
        }
        if (this.logHs.includes('# C  [atio')) {
          this.appendReason(CrashReason.AMDDriverCrash);
        }
        if (this.logHs.includes('# C  [nvoglv')) {
          this.appendReason(CrashReason.NVidiaDriverCrash);
        }
      }
    }

    // 崩溃报告中的关键字
    if (this.logCrash) {
      if (this.logCrash.includes('maximum id range exceeded')) {
        this.appendReason(CrashReason.ModIdConflict);
      }
      if (this.logCrash.includes('java.lang.OutOfMemoryError')) {
        this.appendReason(CrashReason.OutOfMemory);
      }
      if (this.logCrash.includes('Pixel format not accelerated')) {
        this.appendReason(CrashReason.PixelFormatNotAccelerated);
      }
      if (this.logCrash.includes('Manually triggered debug crash')) {
        this.appendReason(CrashReason.ManuallyTriggeredCrash);
      }
      if (this.logCrash.includes('has mods that were not found') && this.regexCheck(this.logCrash, 'The Mod File [^\\n]+optifine\\OptiFine[^\\n]+ has mods that were not found')) {
        this.appendReason(CrashReason.OptiFineMissingForge);
      }
      // "-- MOD " 段落：提取 Mod 文件名或失败信息
      if (this.logCrash.includes('-- MOD ')) {
        const modStart = this.logCrash.indexOf('-- MOD ');
        const failStart = this.logCrash.indexOf('Failure message:');
        const logCrashMod = failStart > modStart ? this.logCrash.substring(modStart, failStart) : this.logCrash.substring(modStart);
        if (logCrashMod.toLowerCase().includes('.jar')) {
          this.appendReason(CrashReason.ModCrashed,
            this.tryAnalyzeModName(this.regexSeek(logCrashMod, '(?<=Mod File: ).+')?.trim()));
        } else {
          this.appendReason(CrashReason.ModNoInfo,
            this.regexSeek(this.logCrash, '(?<=Failure message: )[\\w\\W]+?(?=\\tMod)')?.replace(/\t/g, ' ')?.trim());
        }
      }
      if (this.logCrash.includes('Multiple entries with same key: ')) {
        this.appendReason(CrashReason.ModIdConflict,
          this.tryAnalyzeModName(this.regexSeek(this.logCrash, '(?<=Multiple entries with same key: )[^=]+')?.trim()));
      }
      if (this.logCrash.includes('LoaderExceptionModCrash: Caught exception from ')) {
        this.appendReason(CrashReason.ModCrashed,
          this.tryAnalyzeModName(this.regexSeek(this.logCrash, '(?<=LoaderExceptionModCrash: Caught exception from )[^\\n]+')?.trim()));
      }
      if (this.logCrash.includes('Failed loading config file ')) {
        this.appendReason(CrashReason.ModFileExtracted,
          [
            this.tryAnalyzeModName(this.regexSeek(this.logCrash, '(?<=Failed loading config file .+ for modid )[^\\n]+')?.trim()),
            this.regexSeek(this.logCrash, '(?<=Failed loading config file ).+(?= of type)')?.trim()
          ]);
      }
    }
  }
};
