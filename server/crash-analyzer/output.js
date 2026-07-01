/**
 * @file server/crash-analyzer/output.js - 分析结果输出
 *   包含 output 方法，
 *   通过 Object.assign 挂载到 CrashAnalyzer.prototype 上。
 */

module.exports = {
  /**
   * 输出最终分析结果
   * @param {boolean} isManualAnalyze - 是否手动导入分析
   * @param {string[]|null} [extraFiles=null] - 额外文件列表（保留参数）
   * @returns {Promise<object>} 包含 detail/files/crashReasons/logMc/logHs/logCrash 的结果对象
   */
  async output(isManualAnalyze, extraFiles = null) {
    const detail = this.getAnalyzeResult(isManualAnalyze);

    return {
      detail,
      files: this.outputFiles,
      crashReasons: Array.from(this.crashReasons.entries()).map(([reason, additional]) => ({
        reason,
        additional
      })),
      logMc: this.logMc,
      logHs: this.logHs,
      logCrash: this.logCrash
    };
  }
};
