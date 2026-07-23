/**
 * @file main/file-safe.js
 * @description 安全文件读写工具 - 不依赖 electron，可被 main/ 和 server/ 共同复用。
 *
 * 提供带 .bak 备份恢复的原子写入 + JSON 安全读取。
 * 这是 safeWriteFileSync / safeReadJsonFile 的唯一实现（单一真理源），
 * main/store.js 和 server/utils.js 都从这里 re-export，避免两份实现不一致。
 */

const fs = require('fs');
const path = require('path');

/**
 * 安全写入文件 - 先备份再原子写入，防止写入中断导致文件损坏
 * 支持 string 和 Buffer 内容
 * @param {string} filePath - 目标文件路径
 * @param {string|Buffer} content - 文件内容
 */
function safeWriteFileSync(filePath, content) {
  const isString = typeof content === 'string';
  const bakPath = filePath + '.bak';
  try {
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, bakPath);
    }
  } catch (e) { console.warn('[file-safe] 备份失败:', filePath, e.message); }
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, content, isString ? 'utf8' : undefined);
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    console.error('[file-safe] 原子写入失败，降级直写:', filePath, e.message);
    try { fs.writeFileSync(filePath, content, isString ? 'utf8' : undefined); } catch (e2) {
      console.error('[file-safe] 直写也失败:', filePath, e2.message);
    }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e3) {}
  }
}

/**
 * 安全读取 JSON 文件 - 损坏时尝试从 .bak 恢复并自动回写
 * @param {string} filePath - 文件路径
 * @param {*} defaults - 文件不存在或损坏且无备份时返回的默认值
 * @returns {*} 解析后的对象，或默认值
 */
function safeReadJsonFile(filePath, defaults) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error(`[file-safe] 文件损坏: ${filePath}`, e.message);
    const bakPath = filePath + '.bak';
    try {
      if (fs.existsSync(bakPath)) {
        const bakRaw = fs.readFileSync(bakPath, 'utf8');
        const restored = JSON.parse(bakRaw);
        console.log(`[file-safe] 从备份恢复: ${bakPath}`);
        safeWriteFileSync(filePath, JSON.stringify(restored, null, 2));
        return restored;
      }
    } catch (e2) {
      console.warn(`[file-safe] 备份恢复失败: ${bakPath}`, e2.message);
    }
    console.warn(`[file-safe] 无可用备份，使用默认值: ${filePath}`);
  }
  return defaults;
}

module.exports = { safeWriteFileSync, safeReadJsonFile };
