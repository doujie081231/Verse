/**
 * @file server/crash-analyzer/analyze.js - 崩溃分析入口
 *   包含 analyze 方法（按优先级调用 Crit1 → Crit2 → Crit3），
 *   通过 Object.assign 挂载到 CrashAnalyzer.prototype 上。
 */

module.exports = {
  /**
   * 步骤 3：分析崩溃原因，按优先级依次执行 Crit1 → Crit2 → Crit3
   */
  analyze() {
    this.logAll = (this.logMc || '') + (this.logMcDebug || '') + (this.logHs || '') + (this.logCrash || '');

    // 按优先级分析：Crit1 命中即返回，否则继续 Crit2、Crit3
    this.analyzeCrit1();
    if (this.crashReasons.size > 0) return;

    this.analyzeCrit2();
    if (this.crashReasons.size > 0) return;

    this.analyzeCrit3();
  }
};
