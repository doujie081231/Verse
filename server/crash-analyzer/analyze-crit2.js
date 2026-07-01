/**
 * @file server/crash-analyzer/analyze-crit2.js - 二级崩溃分析
 *   Mixin 错误、Forge/Fabric 崩溃、可疑 Mod 提取，
 *   通过 Object.assign 挂载到 CrashAnalyzer.prototype 上。
 */

const { CrashReason } = require('./constants');

module.exports = {
  /**
   * 步骤 3：二次分析 - Mixin 错误、Forge/Fabric 崩溃、可疑 Mod 提取
   */
  analyzeCrit2() {
    // Mixin 错误分析闭包：识别 Mixin 失败并提取 Mod 名
    const mixinAnalyze = (logText) => {
      const isMixin = logText.includes('Mixin prepare failed ') || logText.includes('Mixin apply failed ') ||
        logText.includes('MixinApplyError') || logText.includes('MixinTransformerError') ||
        logText.includes('mixin.injection.throwables.') || logText.includes('.json] FAILED during )');

      if (!isMixin) return false;

      const modName = this.regexSeek(logText, '(?<=from mod )[^.\\/ ]+(?=\\] from)') ||
        this.regexSeek(logText, '(?<=for mod )[^.\\/ ]+(?= failed)');

      if (modName) {
        this.appendReason(CrashReason.ModMixinError, this.tryAnalyzeModName(modName.trim()));
        return true;
      }

      for (const jsonName of (logText.match(/(?<=^[^\t]+[ \[{(][^ \[{(]+\.json)/gm) || [])) {
        this.appendReason(CrashReason.ModMixinError,
          this.tryAnalyzeModName(jsonName.replace('mixins', 'mixin').replace('.mixin', '').replace('mixin.', '')));
        return true;
      }

      this.appendReason(CrashReason.ModMixinError);
      return true;
    };

    if (this.logMc) {
      const isMixin = mixinAnalyze(this.logMc);

      // Forge 崩溃：提取异常信息
      if (this.logMc.includes('An exception was thrown, the game will display an error screen and halt.')) {
        this.appendReason(CrashReason.ForgeCrash,
          this.regexSeek(this.logMc, '(?=the game will display an error screen and halt.[\\n\\r]+[\\s\\S]+?Exception: )[\\s\\S]+?(?=\\n\\tat)')?.trim());
      }
      // Fabric 崩溃：提取 "A potential solution" 列表
      if (this.logMc.includes('A potential solution has been determined:')) {
        const solMatch = this.logMc.match(/A potential solution has been determined:\n((\s+- [^\n]+\n?)+)/);
        if (solMatch && solMatch[1]) {
          const lines = solMatch[1].match(/^\s+- .+$/gm);
          this.appendReason(CrashReason.FabricModCrash, lines ? lines.join('\n') : null);
        }
      }
      if (this.logMc.includes('A potential solution has been determined, this may resolve your problem:')) {
        const solMatch = this.logMc.match(/A potential solution has been determined, this may resolve your problem:\n((\s+- [^\n]+\n?)+)/);
        if (solMatch && solMatch[1]) {
          const lines = solMatch[1].match(/^\s+- .+$/gm);
          this.appendReason(CrashReason.FabricModCrash, lines ? lines.join('\n') : null);
        }
      }
      if (this.logMc.includes('遇到错误，由于某些原因，无法继续加载。请检查日志文件以获取详细信息，或前往社区寻求帮助。')) {
        const solMatch = this.logMc.match(/遇到错误，由于某些原因，无法继续加载。请检查日志文件以获取详细信息，或前往社区寻求帮助。\n((\s+- [^\n]+\n?)+)/);
        if (solMatch && solMatch[1]) {
          const lines = solMatch[1].match(/^\s+- .+$/gm);
          this.appendReason(CrashReason.FabricModCrash, lines ? lines.join('\n') : null);
        }
      }
      if (!isMixin && this.logMc.includes('due to errors, provided by ')) {
        this.appendReason(CrashReason.ModCrashed,
          this.tryAnalyzeModName(this.regexSeek(this.logMc, "(?<=due to errors, provided by )[^']+")?.trim()));
      }
    }

    if (this.logCrash) {
      mixinAnalyze(this.logCrash);

      // Suspected Mod：提取可疑 Mod 名
      if (this.logCrash.includes('Suspected Mod')) {
        const susStart = this.logCrash.indexOf('Suspected Mod');
        const stackStart = this.logCrash.indexOf('Stacktrace', susStart);
        const suspectsRaw = stackStart > susStart ? this.logCrash.substring(susStart, stackStart) : this.logCrash.substring(susStart);
        if (!suspectsRaw.startsWith('s: None')) {
          const suspects = this.regexSeek(suspectsRaw, '(?<=\n\t[^(\t]+)([^\\n]+)');
          if (suspects && suspects.length > 0) {
            this.appendReason(CrashReason.ModCrashed, this.tryAnalyzeModName(suspects));
          }
        }
      }
    }
  }
};
