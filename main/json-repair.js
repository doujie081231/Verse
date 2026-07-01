/**
 * @file main/json-repair.js
 * @description JSON 自动修复 - 检测并修复损坏的配置/数据文件，
 * 支持从 .bak 恢复或重置为默认值。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { APP_STORE_FILE, WINDOW_CONFIG_FILE, SETTINGS_FILE, DATA_DIR, VERSIONS_DIR } = require('./paths');

// 与 main/store.js、main/window-manager.js 保持一致（便携模式下跟 exe 同目录）
const CONFIG_PATH = WINDOW_CONFIG_FILE;
const STORE_PATH = APP_STORE_FILE;

/**
 * 自动修复单个 JSON 文件
 * @param {string} filePath - 待修复文件绝对路径
 * @param {string} backupSuffix - 损坏文件备份后缀
 * @returns {Promise<boolean>} 文件正常或修复成功返回 true，无法修复返回 false
 */
async function autoRepairJsonFileAsync(filePath, backupSuffix) {
  try {
    await fs.promises.access(filePath);
    const content = await fs.promises.readFile(filePath, 'utf8');
    JSON.parse(content);
    return true;
  } catch (e) {
    // 文件不存在不算损坏，直接视为正常
    if (e.code === 'ENOENT') return true;
    console.error(`[AutoRepair] Detected corrupted file: ${filePath}`);
    // 先备份损坏文件
    try {
      const backupPath = filePath + backupSuffix;
      await fs.promises.copyFile(filePath, backupPath);
    } catch (backupErr) {
      console.error(`[AutoRepair] Backup failed:`, backupErr.message);
    }
    // 尝试从 .bak 恢复
    const bakPath = filePath + '.bak';
    try {
      await fs.promises.access(bakPath);
      const bakContent = await fs.promises.readFile(bakPath, 'utf8');
      JSON.parse(bakContent);
      await fs.promises.writeFile(filePath, bakContent);
      return true;
    } catch (bakErr) {
      console.error(`[AutoRepair] .bak recovery failed:`, bakErr.message);
    }
    // .bak 不可用，重置为默认内容
    try {
      const dir = path.dirname(filePath);
      await fs.promises.mkdir(dir, { recursive: true });
      const defaultContent = filePath.includes('window-config')
        ? JSON.stringify({ fullscreen: false, windowMode: true, windowWidth: 1200, windowHeight: 800 }, null, 2)
        : '{}';
      await fs.promises.writeFile(filePath, defaultContent);
    } catch (resetErr) {
      console.error(`[AutoRepair] Reset failed:`, resetErr.message);
    }
    return false;
  }
}

/**
 * 扫描并修复 VersePC 数据目录下的所有 JSON 文件
 * @returns {Promise<void>}
 */
async function repairVersePCDataAsync() {
  const dataDir = DATA_DIR;
  try { await fs.promises.access(dataDir); } catch { return; }
  await autoRepairJsonFileAsync(CONFIG_PATH, '.corrupted.json');
  await autoRepairJsonFileAsync(STORE_PATH, '.corrupted.json');
  try {
    await autoRepairJsonFileAsync(SETTINGS_FILE, '.corrupted.json');
  } catch (e) {}
  try {
    const accountsFile = path.join(dataDir, 'accounts.json');
    await autoRepairJsonFileAsync(accountsFile, '.corrupted.json');
  } catch (e) {}
  // 扫描 versions 目录下的 version.json
  try {
    await fs.promises.access(VERSIONS_DIR);
    const versions = await fs.promises.readdir(VERSIONS_DIR);
    for (const ver of versions) {
      const verPath = path.join(VERSIONS_DIR, ver);
      const stat = await fs.promises.stat(verPath);
      if (stat.isDirectory()) {
        const versionJson = path.join(verPath, 'version.json');
        await autoRepairJsonFileAsync(versionJson, '.corrupted.json');
      }
    }
  } catch (e) {
    console.error('[AutoRepair] Version scan error:', e.message);
  }
}

// 私有函数：通过 setImmediate 延迟执行数据修复，避免阻塞当前调用栈
function _deferredRepairData() {
  setImmediate(() => {
    repairVersePCDataAsync().catch(() => {});
  });
}

module.exports = { autoRepairJsonFileAsync, repairVersePCDataAsync, _deferredRepairData };
