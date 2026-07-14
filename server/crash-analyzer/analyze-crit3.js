/**
 * @file server/crash-analyzer/analyze-crit3.js - 三级崩溃分析
 *   本地库加载失败、无效路径、Mod 实例创建失败、方块/实体崩溃，
 *   通过 Object.assign 挂载到 CrashAnalyzer.prototype 上。
 */

const { CrashReason } = require('./constants');

module.exports = {
  /**
   * 步骤 4：三次分析 - 本地库加载失败、无效路径、Mod 实例创建失败、方块/实体崩溃
   */
  analyzeCrit3() {
    if (this.logMc) {
      // UnsatisfiedLinkError：本地库加载失败，可能是路径含中文
      if (this.logMc.includes('UnsatisfiedLinkError') || this.logHs?.includes('UnsatisfiedLinkError')) {
        const linkLog = this.logMc.includes('UnsatisfiedLinkError') ? this.logMc : this.logHs;
        const libMatch = this.regexSeek(linkLog, '(?<=no )[^ ]+(?= in )') || this.regexSeek(linkLog, '(?<=UnsatisfiedLinkError: )[^\\n]+');
        this.appendReason(CrashReason.NativeLinkError, libMatch || '请检查游戏路径是否包含中文字符');
      }
      // 日志过短且无典型特征：判定为无效路径
      if (!(this.logMc.includes('at net.') || this.logMc.includes('INFO]')) && this.logHs === null && this.logCrash === null && this.logMc.length < 100) {
        this.appendReason(CrashReason.InvalidPath, this.logMc);
      }
      if (this.logMc.includes('Mod resolution failed')) {
        this.appendReason(CrashReason.ModMissingDependency);
      }
      if (this.logMc.includes('Failed to create mod instance.')) {
        this.appendReason(CrashReason.ModCrashed,
          this.tryAnalyzeModName(
            this.regexSeek(this.logMc, '(?<=Failed to create mod instance. ModID: )[^,]+'),
            this.regexSeek(this.logMc, '(?<=Failed to create mod instance. ModId )[^\\n]+(?= for )')?.trim()
          ));
      }
      if (this.logMc.includes('Warnings were found!') && !this.crashReasons.has(CrashReason.NightConfigBug)) {
        this.appendReason(CrashReason.NightConfigBug);
      }
    }

    if (this.logCrash) {
      // 方块位置崩溃：提取方块名与坐标
      if (this.logCrash.includes('\t' + 'Block location: World: ')) {
        this.appendReason(CrashReason.ModCrashed,
          this.regexSeek(this.logCrash, '(?<=\\tBlock: Block\\{)[^\\}]+') + ' ' +
          this.regexSeek(this.logCrash, '(?<=\\tBlock location: World: )\\([^\\)]+\\)'));
      }
      // 实体崩溃：提取实体类型与坐标
      if (this.logCrash.includes('\t' + 'Entity\'s Exact location: ')) {
        this.appendReason(CrashReason.ModCrashed,
          this.regexSeek(this.logCrash, '(?<=\\tEntity Type: )[^\\n]+(?= \\()') + ' (' +
          this.regexSeek(this.logCrash, '(?<=\\tEntity\'s Exact location: )[^\\n]+')?.trim() + ')');
      }
    }
  }
};
