/**
 * @file server/launch/memory-resolver.js - JVM 最大内存解析纯函数（可测试）
 * @description 从 args-builder.js 提取，根据内存模式/物理内存/mod 数量计算 JVM -Xmx。
 */

/**
 * 解析 JVM 最大内存（纯函数）
 * @param {Object} opts
 * @param {string} opts.memoryMode - 'auto' | 'custom'
 * @param {string|number|null} opts.memoryValue - custom 模式的内存值（MB）
 * @param {number} opts.totalMB - 物理内存（MB）
 * @param {number} opts.freeMB - 可用内存（MB）
 * @param {number} opts.modCount - mods jar 数量
 * @returns {number} maxMemMB
 */
function resolveMaxMemory({ memoryMode, memoryValue, totalMB, freeMB, modCount }) {
  if (memoryMode === 'custom') {
    return parseInt(memoryValue, 10) || 4096;
  }
  // auto 模式：根据物理内存按比例分配
  let autoMB;
  if (totalMB <= 4096) autoMB = Math.min(1024, totalMB - 1024);
  else if (totalMB <= 8192) autoMB = Math.floor(totalMB * 0.55);
  else if (totalMB <= 16384) autoMB = Math.floor(totalMB * 0.6);
  else autoMB = Math.floor(totalMB * 0.65);
  if (freeMB < 1024 && totalMB > 4096) autoMB = Math.min(autoMB, freeMB + 512);
  autoMB = Math.max(512, Math.min(autoMB, totalMB - 1536));
  autoMB = Math.max(autoMB, 512);
  autoMB = Math.min(autoMB, 32768);
  // [关键修复 2026-06-30] mod 数量多时提高内存下限，避免大型整合包 OOM 崩溃
  // 旧逻辑：仅按物理内存比例分配，312 个 mod 在默认 4096MB 下 mod loading 早期即 OOM
  if (modCount >= 200) autoMB = Math.max(autoMB, 8192);
  else if (modCount >= 100) autoMB = Math.max(autoMB, 6144);
  else if (modCount >= 50) autoMB = Math.max(autoMB, 5120);
  // 提高下限后仍受物理内存约束（保留系统占用），并避免超分配
  autoMB = Math.min(autoMB, totalMB - 1536);
  autoMB = Math.max(autoMB, 512);
  autoMB = Math.min(autoMB, 32768);
  autoMB = Math.floor(autoMB / 256) * 256;
  return autoMB;
}

module.exports = { resolveMaxMemory };
