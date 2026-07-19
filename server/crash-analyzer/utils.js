/**
 * @file server/crash-analyzer/utils.js - 正则工具与崩溃原因追加工具
 *   这些方法会被挂载到 CrashAnalyzer.prototype 上，通过 this 访问实例状态。
 */

module.exports = {
  /**
   * 正则匹配并返回第一个匹配项的完整文本
   * @param {string} text - 待匹配文本
   * @param {string} pattern - 正则表达式字符串
   * @param {string} [flags=''] - 正则标志
   * @returns {string|null} 匹配到的文本，无匹配或出错时返回 null
   */
  regexSeek(text, pattern, flags = '') {
    if (!text) return null;
    try {
      const regex = new RegExp(pattern, flags);
      const match = text.match(regex);
      return match ? match[0] : null;
    } catch (e) {
      return null;
    }
  },

  /**
   * 正则检测文本是否匹配
   * @param {string} text - 待检测文本
   * @param {string} pattern - 正则表达式字符串
   * @param {string} [flags=''] - 正则标志
   * @returns {boolean} 是否匹配
   */
  regexCheck(text, pattern, flags = '') {
    if (!text) return false;
    try {
      const regex = new RegExp(pattern, flags);
      return regex.test(text);
    } catch (e) {
      return false;
    }
  },

  /**
   * 追加崩溃原因，additional 会去重后合并
   * @param {string} reason - CrashReason 枚举值
   * @param {string|string[]|null} [additional=null] - 附加信息（Mod 名等）
   */
  appendReason(reason, additional = null) {
    if (this.crashReasons.has(reason)) {
      if (additional !== null) {
        const items = [additional].flat();
        this.crashReasons.get(reason).push(...items);
        this.crashReasons.set(reason, [...new Set(this.crashReasons.get(reason))]);
      }
    } else {
      this.crashReasons.set(reason, additional ? [...new Set([additional].flat())] : []);
    }
  }
};
