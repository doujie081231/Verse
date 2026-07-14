/**
 * @file server/api/routes/mods/index.js
 * @description 模组管理路由聚合入口 - 从原 routes/mods.js 拆分而来
 */

const modList = require('./mod-list');
const modSearch = require('./mod-search');
const modDetail = require('./mod-detail');
const modDownload = require('./mod-download');
const modDependencies = require('./mod-dependencies');
const modManage = require('./mod-manage');
const modDialog = require('./mod-dialog');

/**
 * 注册模组管理相关路由
 * @param {Function} registerRoute - 路由注册函数
 * @param {Object} deps - 依赖对象（ctx/sendJSON/sendError/readBody/mods/modpack/accounts/utils/http/versions）
 * @returns {void}
 */
function register(registerRoute, deps) {
  modList.register(registerRoute, deps);
  modSearch.register(registerRoute, deps);
  modDetail.register(registerRoute, deps);
  modDownload.register(registerRoute, deps);
  modDependencies.register(registerRoute, deps);
  modManage.register(registerRoute, deps);
  modDialog.register(registerRoute, deps);
}

module.exports = { register };
