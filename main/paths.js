/**
 * @file main/paths.js
 * @description 数据目录路径解析 - 唯一权威来源（single source of truth）。
 *
 * 解析优先级：
 *   1. exe 同目录的 data-config.json 指定的 dataDir（且该目录必须真实存在）
 *   2. 旧版用户目录 ~/.versepc（向后兼容，保证现有用户激活状态不丢失）
 *   3. exe 同目录的 data 子目录（新装便携版默认 / 兜底）
 *
 * 重要：server/context.js 及所有 main/ 模块都应 require 本模块复用解析逻辑，
 *   不得自行实现第二份 resolveDataDir，否则两份实现不一致会导致数据回退到 C 盘。
 *
 * 回退诊断：当 ① 失效走到 ② 或 ③ 时，会在最终数据目录写入 .path-resolution.log，
 *   便于排查"数据丢失/数据回到 C 盘"类问题，而非静默回退。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// portable target 运行时解压到临时目录，但会设置 PORTABLE_EXECUTABLE_DIR 指向真实 exe 路径
// 优先用它，这样便携版数据才能真正跟 exe 走（U 盘/任意目录）
const APP_DIR = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
const DATA_DIR_CONFIG_FILE = path.join(APP_DIR, 'data-config.json');
const DEFAULT_OLD_DATA_DIR = path.join(os.homedir(), '.versepc');

/**
 * 写回退诊断日志到最终数据目录（best-effort，失败不影响解析）
 * @param {string} reason - 回退原因
 * @param {string} resolvedDir - 最终解析到的数据目录
 */
function _logFallback(reason, resolvedDir) {
  try {
    if (!fs.existsSync(resolvedDir)) fs.mkdirSync(resolvedDir, { recursive: true });
    const logPath = path.join(resolvedDir, '.path-resolution.log');
    const line = '[' + new Date().toISOString() + '] ' + reason + '\n' +
      '  resolvedDir: ' + resolvedDir + '\n' +
      '  APP_DIR: ' + APP_DIR + '\n' +
      '  execPath: ' + process.execPath + '\n' +
      '  PORTABLE_EXECUTABLE_DIR: ' + (process.env.PORTABLE_EXECUTABLE_DIR || '(unset)') + '\n';
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (e) {}
}

/**
 * 解析数据目录路径（唯一权威实现）
 * @param {Object} [opts] - 测试注入用；生产代码不传，使用模块级 APP_DIR/DEFAULT_OLD_DATA_DIR
 * @param {string} [opts.appDir] - 自定义 exe 目录（覆盖 APP_DIR）
 * @param {string} [opts.oldDataDir] - 自定义旧版目录（覆盖 DEFAULT_OLD_DATA_DIR）
 * @returns {string} 数据目录绝对路径
 */
function resolveDataDir(opts) {
  const appDir = (opts && opts.appDir) || APP_DIR;
  const configPath = path.join(appDir, 'data-config.json');
  const oldDataDir = (opts && opts.oldDataDir) || DEFAULT_OLD_DATA_DIR;
  // 优先级 1: data-config.json 指定的 dataDir
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
      const cfg = JSON.parse(raw);
      if (cfg.dataDir && typeof cfg.dataDir === 'string' && fs.existsSync(cfg.dataDir)) {
        return cfg.dataDir;
      }
    }
  } catch (e) {}
  // 优先级 2: 旧版 ~/.versepc（向后兼容）
  if (fs.existsSync(oldDataDir)) {
    _logFallback('回退到旧版用户目录 ' + oldDataDir + '（data-config.json 缺失或无效，请检查是否为覆盖更新导致配置丢失）', oldDataDir);
    return oldDataDir;
  }
  // 优先级 3: exe 同目录 / data（首次安装或兜底）
  const fallback = path.join(appDir, 'data');
  _logFallback('使用 exe 同目录/data（首次安装，或 data-config.json 缺失且无旧版目录）', fallback);
  return fallback;
}

const DATA_DIR = resolveDataDir();

module.exports = {
  APP_DIR,
  DATA_DIR,
  DATA_DIR_CONFIG_FILE,
  DEFAULT_OLD_DATA_DIR,
  resolveDataDir,
  // 用户状态文件
  APP_STORE_FILE: path.join(DATA_DIR, 'app-store.json'),
  WINDOW_CONFIG_FILE: path.join(DATA_DIR, 'window-config.json'),
  UPDATE_CONFIG_FILE: path.join(DATA_DIR, 'update-config.json'),
  CRASH_LOG_FILE: path.join(DATA_DIR, 'crash.log'),
  // 派生目录
  VERSIONS_DIR: path.join(DATA_DIR, 'versions'),
  SETTINGS_FILE: path.join(DATA_DIR, 'settings.json'),
  // 是否为便携模式（数据目录不在 ~/.versepc）
  isPortable: DATA_DIR !== DEFAULT_OLD_DATA_DIR
};
