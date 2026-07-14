/**
 * @file server/http-client/file-ops.js - 文件操作工具
 * @description 安全删除文件、带重试的文件重命名（Windows AV 兼容）。
 */

const fs = require('fs');

// 安全删除文件：处理 Windows 只读属性和锁定文件（rename-to-old 回退）
function _tryRemoveFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    try { fs.chmodSync(filePath, 0o666); } catch (_) {}
    try { fs.unlinkSync(filePath); return; } catch (_) {}
    // unlink 失败（文件被锁定），尝试 rename 到 .old 后删除
    const oldPath = filePath + '.old.' + process.pid;
    try { fs.renameSync(filePath, oldPath); } catch (_) { return; }
    try { fs.unlinkSync(oldPath); } catch (_) {}
  } catch (_) {}
}

/**
 * 带重试的文件重命名：处理 Windows AV 锁定，最多重试 10 次，失败后回退 copy + delete
 * @param {string} src - 源文件路径
 * @param {string} dest - 目标文件路径
 * @returns {Promise<boolean>} 是否成功
 */
async function safeRename(src, dest) {
  // 诊断信息：用于失败日志中显示 src/dest 大小
  const _diag = () => {
    let dStat = null, sStat = null;
    try { sStat = fs.existsSync(src) ? fs.statSync(src) : null; } catch (_) {}
    try { dStat = fs.existsSync(dest) ? fs.statSync(dest) : null; } catch (_) {}
    return `src=${sStat ? sStat.size + 'B' : 'NA'} dest=${dStat ? dStat.size + 'B' : 'NA'}`;
  };

  // 尝试 rename，最多 10 次，累计等待约 55 秒
  for (let i = 0; i < 10; i++) {
    try {
      if (fs.existsSync(dest)) {
        try { fs.chmodSync(dest, 0o666); } catch (_) {}
        // [KEY FIX] Windows: 锁定的文件通常无法 delete，但可以 rename。
        // 先尝试将 dest 重命名为 .old，腾出目标路径，再写入新文件。
        const oldDest = dest + '.old.' + process.pid;
        try { fs.renameSync(dest, oldDest); } catch (_) {
          // rename 也失败，尝试 delete
          try { fs.unlinkSync(dest); } catch (_) {}
        }
      }
      fs.renameSync(src, dest);
      return true;
    } catch (e) {
      if (i < 9) {
        // 退避：每次最多 +1s，上限 10s
        const delay = Math.min(1000 * (i + 1), 10000);
        console.warn(`[Download] rename 重试 ${i + 1}/10 (${delay}ms): ${e.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  // rename 全部失败，尝试 copy + delete 作为回退
  try {
    if (fs.existsSync(dest)) {
      try { fs.chmodSync(dest, 0o666); } catch (_) {}
      // 同样先尝试 rename-to-old
      const oldDest = dest + '.old.' + process.pid;
      try { fs.renameSync(dest, oldDest); } catch (_) {
        try { fs.unlinkSync(dest); } catch (_) {}
      }
    }
    fs.copyFileSync(src, dest);
    try { fs.unlinkSync(src); } catch (_) {}
    return true;
  } catch (e) {
    // 最终回退：如果 dest 已存在且大小与 src 相同，视为成功（可能是上次下载已完成）
    try {
      if (fs.existsSync(dest) && fs.existsSync(src)) {
        const destSize = fs.statSync(dest).size;
        const srcSize = fs.statSync(src).size;
        if (destSize > 0 && destSize === srcSize) {
          console.warn(`[Download] safeRename: dest 已存在且大小匹配 (${destSize} bytes)，跳过 rename`);
          try { fs.unlinkSync(src); } catch (_) {}
          return true;
        }
      }
    } catch (_) {}
    console.error(`[Download] safeRename 最终失败: ${e.message} [${_diag()}]`);
    return false;
  }
}

module.exports = { _tryRemoveFile, safeRename };
