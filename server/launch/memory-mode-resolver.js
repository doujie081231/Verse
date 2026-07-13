/**
 * @file server/launch/memory-mode-resolver.js - 内存模式决策纯函数（可测试）
 * @description 从 args-builder.js 提取的内存模式判断逻辑。
 *              核心问题：settings.maxMemory 默认 4096（来自 version-settings.js），
 *              若直接 `if (settings.maxMemory)` 判断会始终为真，绕过 auto 模式，
 *              导致 312 mods 的大型整合包在 4096MB 下 OOM 崩溃。
 *
 *              修复策略：
 *              1. 前端 launch_settings 优先级最高（用户在 UI 显式选择 auto/custom）
 *              2. 否则若 settings.maxMemory ≠ 4096（默认值），视为用户在旧版全局设置中改过 → custom
 *              3. 否则按 auto 走（让 memory-resolver 根据 mod 数量自动提高下限）
 */

const DEFAULT_LEGACY_MAX_MEMORY = 4096;

/**
 * 决策内存模式与 memoryValue
 * @param {Object} opts
 * @param {number} opts.settingsMaxMemory - 来自 version-settings.js 全局设置（默认 4096）
 * @param {boolean} opts.hasLaunchSettings - 前端是否存过 versepc_launch_settings
 * @param {string|null} opts.launchMemoryMode - 前端选择的 auto/custom
 * @param {number|null} opts.launchMemoryValue - 前端 custom 模式下填写的内存值
 * @returns {{memoryMode: string, memoryValue: number|null}}
 */
function resolveMemoryMode({ settingsMaxMemory, hasLaunchSettings, launchMemoryMode, launchMemoryValue }) {
  // 优先级 1：前端 launch_settings 显式选择
  if (hasLaunchSettings) {
    return {
      memoryMode: launchMemoryMode || 'auto',
      memoryValue: launchMemoryValue
    };
  }
  // 优先级 2：用户在旧版全局设置中改过 maxMemory（≠ 默认 4096）→ 视为 custom
  if (typeof settingsMaxMemory === 'number' && settingsMaxMemory !== DEFAULT_LEGACY_MAX_MEMORY) {
    return {
      memoryMode: 'custom',
      memoryValue: settingsMaxMemory
    };
  }
  // 优先级 3：默认走 auto，让 memory-resolver 根据 mod 数量自动决策
  return { memoryMode: 'auto', memoryValue: null };
}

module.exports = { resolveMemoryMode, DEFAULT_LEGACY_MAX_MEMORY };
