/**
 * mod-slug-map.js - Mod ID/名称到 slug 的映射表
 * 用于在 Modrinth API 搜索时，通过 mod ID 或中文名反查英文 slug。
 * 由 mod-chinese-names.js 的 translateChineseSearch 使用。
 */

// MOD_SLUG_MAP: mod 项目 ID 或名称 → Modrinth slug
// 合并时此文件被截断，保留空对象作为安全降级
// 后续可按需补充映射条目
const MOD_SLUG_MAP = {};
