/**
 * @file server/versions/index.js - 版本管理模块聚合入口
 * @description 重新导出所有版本管理相关函数。require('../versions') 会自动解析到本文件，
 *   保持与原 server/versions.js 相同的对外接口。
 */

const shared = require('./shared');
const settings = require('./version-settings');
const merge = require('./version-merge');
const parse = require('./version-parse');
const list = require('./version-list');
const dir = require('./version-dir');
const manifest = require('./version-manifest');

module.exports = {
  // version-list.js
  watchVersionsDir: list.watchVersionsDir,
  loadVersions: list.loadVersions,
  saveVersions: list.saveVersions,
  findVersionChain: list.findVersionChain,
  cleanupVersionChain: list.cleanupVersionChain,
  cleanupIncompleteVersion: list.cleanupIncompleteVersion,
  isVersionComplete: list.isVersionComplete,
  validateInstalledVersions: list.validateInstalledVersions,
  fixModpackInheritsFrom: list.fixModpackInheritsFrom,
  correctVersionType: list.correctVersionType,
  scanExternalFolder: list.scanExternalFolder,
  getInstalledVersions: list.getInstalledVersions,
  getVersionLocalDetails: list.getVersionLocalDetails,

  // version-manifest.js
  getVersionManifest: manifest.getVersionManifest,
  getVersionDetails: manifest.getVersionDetails,

  // version-parse.js
  findVersionJson: parse.findVersionJson,
  resolveVersionJson: parse.resolveVersionJson,
  findExternalRoot: parse.findExternalRoot,
  findMainJar: parse.findMainJar,
  _invalidateResolvedJsonCache: parse._invalidateResolvedJsonCache,

  // version-settings.js
  loadSettingsCached: settings.loadSettingsCached,
  saveDiskCache: settings.saveDiskCache,
  loadVersionSettings: settings.loadVersionSettings,
  saveVersionSettings: settings.saveVersionSettings,

  // version-merge.js
  mergeVersionJson: merge.mergeVersionJson,
  deduplicateJvmArgs: merge.deduplicateJvmArgs,
  deduplicateGameArgs: merge.deduplicateGameArgs,
  evaluateRules: merge.evaluateRules,

  // version-dir.js
  resolveVersionIsolation: dir.resolveVersionIsolation,
  resolveExternalVersionDir: dir.resolveExternalVersionDir,
  getVersionGameDir: dir.getVersionGameDir,
  getVersionModsDir: dir.getVersionModsDir,
  getVersionSubDir: dir.getVersionSubDir,

  // shared.js
  loadExternalFolders: shared.loadExternalFolders,
  saveExternalFolders: shared.saveExternalFolders
};
