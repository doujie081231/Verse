/**
 * @file server/dependencies/index.js - 依赖检查与下载模块聚合入口
 * @description 原 server/dependencies.js 拆分后的聚合入口，重新导出所有对外 API。
 *   调用方 require('./dependencies') 或 require('../dependencies') 会自动解析到本文件。
 *
 * 拆分结构：
 *   - _shared.js   共享的 require 与 modloaders 懒加载
 *   - check.js     checkDependencies 依赖完整性检查
 *   - forge.js     checkForgeCore Forge/NeoForge 核心库检查（由 check.js 内部调用）
 *   - download.js  downloadMissingDependencies 缺失文件下载
 *
 * 对外 API 与原 dependencies.js 完全一致：
 *   - checkDependencies(versionId, settings, externalVersionDir)
 *   - downloadMissingDependencies(missingFiles, onProgress, versionJson, maxThreads, externalVersionDir)
 */

const { checkDependencies } = require('./check');
const { downloadMissingDependencies } = require('./download');

module.exports = {
  checkDependencies,
  downloadMissingDependencies
};
