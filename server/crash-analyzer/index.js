/**
 * @file server/crash-analyzer/index.js - 崩溃日志分析模块聚合入口
 * @description 解析 Minecraft 崩溃报告、JVM 崩溃日志、游戏日志，
 *   按关键字匹配识别崩溃原因（Java 版本、Mod 冲突、驱动问题等）并给出修复建议。
 *
 *   本文件聚合各功能子模块，将方法挂载到 CrashAnalyzer.prototype 上，
 *   对外导出的 API（CrashAnalyzer / CrashReason）与原 server/crashAnalyzer.js 完全一致。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { CrashReason, DEFAULT_MINECRAFT_DIR } = require('./constants');
const utils = require('./utils');
const fileCollector = require('./file-collector');
const prepare = require('./prepare');
const analyze = require('./analyze');
const analyzeCrit1 = require('./analyze-crit1');
const analyzeCrit2 = require('./analyze-crit2');
const analyzeCrit3 = require('./analyze-crit3');
const modAnalyzer = require('./mod-analyzer');
const suggest = require('./suggest');
const output = require('./output');

/**
 * 崩溃日志分析器：收集日志 → 预处理 → 按关键字匹配崩溃原因 → 输出修复建议
 */
class CrashAnalyzer {
  /**
   * @param {string} [targetInstance=null] - 目标版本实例名
   * @param {string} [minecraftDir=null] - .minecraft 目录，默认用户主目录下
   */
  constructor(targetInstance = null, minecraftDir = null) {
    this.targetInstance = targetInstance;
    this.minecraftDir = minecraftDir || DEFAULT_MINECRAFT_DIR;
    this.tempFolder = path.join(os.tmpdir(), 'versepc-crash-' + Date.now());
    this.analyzeRawFiles = [];
    this.logMc = null;
    this.logMcDebug = null;
    this.logHs = null;
    this.logCrash = null;
    this.logAll = '';
    this.crashReasons = new Map();
    this.outputFiles = [];
    this.directFile = null;

    if (!fs.existsSync(this.tempFolder)) {
      fs.mkdirSync(this.tempFolder, { recursive: true });
    }
  }
}

// 将各子模块的方法挂载到原型上，保持原 API 行为不变
Object.assign(CrashAnalyzer.prototype,
  utils,
  fileCollector,
  prepare,
  analyze,
  analyzeCrit1,
  analyzeCrit2,
  analyzeCrit3,
  modAnalyzer,
  suggest,
  output
);

module.exports = {
  CrashAnalyzer,
  CrashReason
};
