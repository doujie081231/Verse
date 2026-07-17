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

  // 受物理内存约束（保留系统占用）
  autoMB = Math.min(autoMB, totalMB - 1536);

  // 关键修复：始终受当前可用内存约束，避免分配超过可用内存导致 OOM
  // 保留 1GB 给系统/启动器自身，防止游戏启动后系统内存不足被强制终止
  // 之前的逻辑只在 freeMB < 1024 时才约束，导致 7.49GB 可用时仍分配 9728MB，OOM 静默退出
  const safeFreeMB = Math.max(0, freeMB - 1024);
  if (autoMB > safeFreeMB) {
    autoMB = safeFreeMB;
  }

  // mod 数量多时提高内存下限，避免大型整合包 OOM 崩溃
  // 但下限同样受 safeFreeMB 约束，宁可降低下限也不能超过可用内存
  let modFloor = 2048;
  if (modCount >= 200) modFloor = 8192;
  else if (modCount >= 100) modFloor = 6144;
  else if (modCount >= 50) modFloor = 5120;
  modFloor = Math.min(modFloor, safeFreeMB);
  autoMB = Math.max(autoMB, modFloor);

  autoMB = Math.max(autoMB, 512);
  autoMB = Math.min(autoMB, 32768);
  autoMB = Math.floor(autoMB / 256) * 256;
  return autoMB;
}

module.exports = { resolveMaxMemory };
