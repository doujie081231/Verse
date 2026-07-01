/**
 * @file server/launch/memory-optimize-resolver.js - 启动前内存优化决策纯函数（可测试）
 * @description 从 process-manager.js 提取的决策逻辑。
 *
 *              问题：旧逻辑默认开启内存优化（DoRound PowerShell 脚本），
 *              该脚本会清空整个 Windows 系统文件缓存并执行 SetSystemInformation，
 *              期间整个系统卡顿 15-30 秒，导致 versepc UI 看似无响应。
 *
 *              修复策略：
 *              1. 默认关闭启动前内存优化（仅在用户显式开启时执行）
 *              2. 大内存机器（≥12GB）或大型整合包（modCount ≥ 100）时跳过优化
 *                 —— 这些场景下清空缓存反而会损害性能
 */

/**
 * 决策是否执行启动前内存优化
 * @param {Object} opts
 * @param {boolean|undefined} opts.autoMemoryOptimize - 用户全局设置（other_settings.autoMemoryOptimize）
 * @param {string} opts.versionMemOptimize - 版本独立设置（'global'|'on'|'off'）
 * @param {number} opts.totalMemMB - 系统物理内存（MB）
 * @param {number} opts.modCount - 版本 mods 数量
 * @param {number} opts.freeMB - 当前可用内存（MB）
 * @returns {boolean} 是否执行内存优化
 */
function shouldRunMemoryOptimize({ autoMemoryOptimize, versionMemOptimize, totalMemMB, modCount, freeMB }) {
  // 优先级 1：版本独立设置显式开关
  if (versionMemOptimize === 'on') return true;
  if (versionMemOptimize === 'off') return false;

  // 优先级 2：用户全局设置必须显式开启（默认关闭，旧逻辑是默认开启）
  // 旧代码：if (otherSettings.autoMemoryOptimize !== false) shouldOptimizeMemory = true;
  // 新代码：只有显式 === true 才执行
  if (autoMemoryOptimize !== true) return false;

  // 优先级 3：大内存机器跳过（≥12GB 物理内存时清空缓存弊大于利）
  if (totalMemMB >= 12288) return false;

  // 优先级 4：大型整合包跳过（mod 数量多时启动需要大量库文件，
  // 清空文件缓存会导致 mod loading 阶段所有 jar 重新从磁盘读取，更慢）
  if (modCount >= 100) return false;

  // 优先级 5：可用内存充足时跳过（>4GB free 时不需要优化）
  if (freeMB > 4096) return false;

  return true;
}

module.exports = { shouldRunMemoryOptimize };
