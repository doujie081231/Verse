/**
 * @file server/java/index.js - Java 模块聚合入口
 * @description 重新导出 java/* 下所有子模块的函数。
 *   调用方 require('../java') 会通过 Node.js 模块解析机制命中本文件。
 */

const version = require('./java-version');
const detect = require('./java-detect');
const runtime = require('./java-runtime');
const download = require('./java-download');
const custom = require('./java-custom');

module.exports = {
  ...version,
  ...detect,
  ...runtime,
  ...download,
  ...custom
};
