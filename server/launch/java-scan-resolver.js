/**
 * @file server/launch/java-scan-resolver.js - Java 系统扫描决策纯函数（可测试）
 * @description 从 java-runtime.js selectJavaForVersion 提取的决策逻辑。
 *
 *              问题：旧逻辑在 candidates 里"已有满足要求的 Java"时跳过系统扫描，
 *              但"满足要求"（majorVersion >= min && <= max）不等于"最优"。
 *              例如 Forge 1.20.1 要 Java 17+，candidates 里有 jdk-25（满足要求），
 *              但系统 Program Files 里有 jdk-17（精确匹配，更优），
 *              旧逻辑会跳过系统扫描，错过 jdk-17，最终选了距离更远的 jdk-25
 *              或 Minecraft runtime 的 Java 21。
 *
 *              修复策略：只有当 candidates 里有"精确匹配"（majorVersion == requiredVersion）
 *              时才跳过系统扫描；否则继续扫描，让排序逻辑选出最优。
 */

/**
 * 决策是否跳过系统 Java 扫描
 * @param {Array<{majorVersion:number}>} candidates - 已找到的候选 Java
 * @param {number} requiredVersion - 版本要求的最低 Java 主版本
 * @param {number} maxVersion - 版本要求的最高 Java 主版本
 * @returns {boolean} true=跳过系统扫描，false=继续扫描
 */
function shouldSkipSystemScan(candidates, requiredVersion, maxVersion) {
  if (candidates.length === 0) return false;

  // 检查 candidates 里是否有"精确匹配"（majorVersion == requiredVersion）
  const hasExactMatch = candidates.some(
    (j) => j.majorVersion === requiredVersion && j.majorVersion <= maxVersion
  );

  // 只有精确匹配时才跳过系统扫描
  // 旧逻辑：candidates.some(j => j.majorVersion >= requiredVersion && j.majorVersion <= maxVersion)
  // 新逻辑：要求更严格——必须精确匹配
  return hasExactMatch;
}

module.exports = { shouldSkipSystemScan };
