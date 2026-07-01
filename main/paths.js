/**
 * @file main/paths.js
 * @description 便携模式路径解析 - 集中管理用户状态文件路径。
 *
 * 解析优先级：
 *   1. exe 同目录的 data-config.json 指定的 dataDir
 *   2. 旧版用户目录 ~/.versepc（向后兼容，保证现有用户激活状态不丢失）
 *   3. exe 同目录的 data 子目录（新装便携版默认）
 *
 * 这样老用户升级后继续读 ~/.versepc，新用户走便携模式。
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
 * 解析数据目录路径
 * @returns {string} 数据目录绝对路径
 */
function resolveDataDir() {
  try {
    if (fs.existsSync(DATA_DIR_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(DATA_DIR_CONFIG_FILE, 'utf8'));
      if (cfg.dataDir && typeof cfg.dataDir === 'string' && fs.existsSync(cfg.dataDir)) {
        return cfg.dataDir;
      }
    }
  } catch (e) {}
  if (fs.existsSync(DEFAULT_OLD_DATA_DIR)) return DEFAULT_OLD_DATA_DIR;
  return path.join(APP_DIR, 'data');
}

const DATA_DIR = resolveDataDir();

module.exports = {
  APP_DIR,
  DATA_DIR,
  DATA_DIR_CONFIG_FILE,
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
