/**
 * @file server/versions/shared.js - 共享依赖与基础工具函数
 * @description 提供 fs/path/ctx/utils/http 的统一引用，以及被多个子模块共用的
 *   叶子函数（loadExternalFolders / saveExternalFolders），用于打破潜在的循环依赖。
 */

const fs = require('fs');
const path = require('path');

const ctx = require('../context');
const utils = require('../utils');
const http = require('../http-client');

/**
 * 读取外部版本目录列表
 * @returns {Array<{path: string}>} 外部文件夹配置数组
 */
function loadExternalFolders() {
  try {
    if (fs.existsSync(ctx.dirs.EXTERNAL_FOLDERS_FILE)) {
      return JSON.parse(fs.readFileSync(ctx.dirs.EXTERNAL_FOLDERS_FILE, 'utf-8'));
    }
  } catch (e) {}
  return [];
}

/**
 * 保存外部版本目录列表
 * @param {Array<{path: string}>} folders - 外部文件夹配置数组
 */
function saveExternalFolders(folders) {
  fs.writeFileSync(ctx.dirs.EXTERNAL_FOLDERS_FILE, JSON.stringify(folders, null, 2));
}

module.exports = {
  fs,
  path,
  ctx,
  utils,
  http,
  loadExternalFolders,
  saveExternalFolders
};
