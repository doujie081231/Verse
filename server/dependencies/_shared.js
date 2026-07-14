/**
 * @file server/dependencies/_shared.js - 共享依赖与懒加载
 * @description dependencies 模块内部共享的 require 集合。
 *   所有子模块（check.js, forge.js, download.js）通过本文件获取公共依赖，
 *   避免重复 require 和循环引用。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ctx = require('../context');
const utils = require('../utils');
const http = require('../http-client');
const versions = require('../versions');
const java = require('../java');

// 懒加载 modloaders，避免循环引用
// modloaders 依赖 dependencies，如果顶层 require 会形成循环
let _modloaders = null;
function getModloaders() {
  if (!_modloaders) {
    _modloaders = require('../modloaders');
  }
  return _modloaders;
}

module.exports = {
  fs,
  path,
  execSync,
  ctx,
  utils,
  http,
  versions,
  java,
  _modloaders: getModloaders
};
