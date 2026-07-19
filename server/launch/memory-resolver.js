/**
 * @file server/launch/memory-resolver.js - JVM 最大内存解析纯函数（可测试）
 * @description 从 args-builder.js 提取，根据内存模式/物理内存/mod 数量计算 JVM -Xmx。
 */

/**
 * 解析 JVM 最大内存（纯函数）
 *
 * 自动模式算法（物理内存基础值 + Mod 分级加成）：
 *   1. 基础值：物理内存的 1/4，对齐到 128MB，最小 256MB（保底，不依赖当前可用）
 *   2. Mod 加成：按 mod 数量算出 4 级目标值，分级累加（优先满足"勉强能跑"，再追加"富裕"）
 *      - mod 越多目标越高，避免大型整合包 OOM
 *   3. 受物理内存总量约束（分档保留系统/启动器自身占用）
 *   4. 封顶 16GB，避免极端值
 *
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

  // ----------------------------------------------------------------------
  // 1) 基础值：物理内存的 1/4，对齐到 128MB，保底 256MB
  //    不依赖当前可用内存，确保即使其他程序暂时占用高也能给游戏足够内存
  // ----------------------------------------------------------------------
  const PHYSICAL_RATIO = 0.25;
  const ALIGN_MB = 128;
  const MIN_BASE_MB = 256;
  let baseMB = Math.floor((totalMB * PHYSICAL_RATIO) / ALIGN_MB) * ALIGN_MB;
  baseMB = Math.max(baseMB, MIN_BASE_MB);

  // ----------------------------------------------------------------------
  // 2) Mod 加成：根据 mod 数量算 4 级目标值，分级累加
  //    各级目标值随 mod 数线性增长；用可用内存按比例逐级满足
  //    优先满足低级（勉强能跑），剩余可用再追加高级（富裕/材质光影）
  // ----------------------------------------------------------------------
  const modCountNum = Math.max(0, parseInt(modCount, 10) || 0);
  // 4 级目标（GB 单位设计，再转 MB）
  //   ramMininum : 无论如何也要保证的最低限度
  //   ramTarget1 : 估计能勉强带动
  //   ramTarget2 : 估计没啥问题
  //   ramTarget3 : 放一百万个材质和 Mod 和光影
  const ramMininumGB = 0.5 + modCountNum / 150;
  const ramTarget1GB = 1.5 + modCountNum / 90;
  const ramTarget2GB = 2.7 + modCountNum / 50;
  const ramTarget3GB = 4.5 + modCountNum / 25;

  const GB_TO_MB = 1024;
  let ramGiveMB = 0;
  // 用物理内存（而非当前可用）作为可用预算
  // 原因：当前可用受其他程序瞬时占用影响，不能反映游戏实际可用的长期内存
  //       用物理内存确保大整合包能拿到足够分配
  let ramAvailableGB = totalMB / GB_TO_MB;

  // 分 4 级累加：每级用可用内存按 Ratio 满足 Delta
  //   级1：100% 优先满足（最关键）
  //   级2：70%
  //   级3：40%
  //   级4：15%（剩余可用继续往上加，最高到 ramTarget3）
  const stages = [
    { deltaGB: ramTarget1GB,                       ratio: 1.0 },
    { deltaGB: ramTarget2GB - ramTarget1GB,        ratio: 0.7 },
    { deltaGB: ramTarget3GB - ramTarget2GB,        ratio: 0.4 },
    { deltaGB: ramTarget3GB,                       ratio: 0.15 }
  ];
  for (const s of stages) {
    ramGiveMB += Math.min(ramAvailableGB * s.ratio, s.deltaGB) * GB_TO_MB;
    ramAvailableGB -= s.deltaGB / s.ratio;
    if (ramAvailableGB < 0.1) break;
  }

  // 不低于最低限度（mod 多时尤其重要）
  ramGiveMB = Math.max(ramGiveMB, ramMininumGB * GB_TO_MB);

  // ----------------------------------------------------------------------
  // 3) 取基础值与 Mod 加成值的较大者
  //    - baseMB 保证即使 mod 少也有合理起步（物理内存 1/4）
  //    - ramGiveMB 保证大整合包能拿到足够内存
  // ----------------------------------------------------------------------
  let autoMB = Math.max(baseMB, Math.floor(ramGiveMB));

  // ----------------------------------------------------------------------
  // 4) 受物理内存总量约束（保留系统/启动器自身占用）
  //    不再受"当前可用内存"约束 —— 其他程序占用的内存并非持续占用，
  //    若强行按"当前可用"分配，会导致大型整合包（如含大量 3D 模型的整合包）
  //    永远拿不到足够内存而 OOM 崩溃。
  //    分档保留：
  //      - ≤4GB 物理：保留 1.5GB（系统紧张，多留给系统）
  //      - ≤8GB 物理：保留 2GB
  //      - >8GB 物理：保留 2.5GB（启动器+系统+其他程序常态占用）
  // ----------------------------------------------------------------------
  let SYSTEM_RESERVE_MB;
  if (totalMB <= 4096) SYSTEM_RESERVE_MB = 1536;
  else if (totalMB <= 8192) SYSTEM_RESERVE_MB = 2048;
  else SYSTEM_RESERVE_MB = 2560;
  const physicalCapMB = Math.max(totalMB - SYSTEM_RESERVE_MB, 512);
  autoMB = Math.min(autoMB, physicalCapMB);

  // ----------------------------------------------------------------------
  // 5) 封顶 16GB，避免极端配置下分配过多
  //    并对齐到 256MB
  // ----------------------------------------------------------------------
  autoMB = Math.max(autoMB, 512);
  autoMB = Math.min(autoMB, 16384);
  autoMB = Math.floor(autoMB / 256) * 256;
  return autoMB;
}

module.exports = { resolveMaxMemory };
