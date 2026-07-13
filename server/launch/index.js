/**
 * @file server/launch/index.js
 * @description 启动模块统一入口。将拆分后的子模块重新聚合导出，保持对外接口与原 server/launch.js 完全一致。
 *              server.js 的 require('./server/launch') 会自动解析到本文件。
 */
const shared = require('./shared');
const argsBuilder = require('./args-builder');
const processManager = require('./process-manager');
const launchGameModule = require('./launch-game');

module.exports = {
  preheatJvm: processManager.preheatJvm,
  applyPerformanceOptimizations: processManager.applyPerformanceOptimizations,
  analyzeExitCode: shared.analyzeExitCode,
  setGameLanguage: shared.setGameLanguage,
  applyWindowSettings: shared.applyWindowSettings,
  buildLaunchArguments: argsBuilder.buildLaunchArguments,
  launchGame: launchGameModule.launchGame,
  doLaunch: processManager.doLaunch,
  cleanupGameLogs: processManager.cleanupGameLogs
};
