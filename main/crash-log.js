/**
 * @file main/crash-log.js
 * @description 崩溃日志 - 必须在所有其他代码之前加载，捕获最早期的启动错误。
 *
 * 监听 uncaughtException / unhandledRejection / exit 事件，
 * 将错误信息追加写入 crash.log，超过 5MB 时触发日志轮转。
 */

const _crashLogPath = require('path').join(
  process.env.APPDATA || require('path').join(require('os').homedir(), 'AppData', 'Roaming'),
  'VersePC', 'crash.log'
);
const _crashLogOldPath = _crashLogPath + '.old';
const _CRASH_LOG_MAX_SIZE = 5 * 1024 * 1024; // 5MB 触发轮转

// 私有函数：追加写入崩溃日志，超限时自动轮转（当前文件重命名为 .old）
function _writeCrashLog(message) {
  try {
    const _fs = require('fs');
    const _dir = require('path').dirname(_crashLogPath);
    if (!_fs.existsSync(_dir)) _fs.mkdirSync(_dir, { recursive: true });

    // 大小超限则轮转：当前文件重命名为 .old，新开当前文件
    try {
      const stat = _fs.statSync(_crashLogPath);
      if (stat.size > _CRASH_LOG_MAX_SIZE) {
        try { _fs.unlinkSync(_crashLogOldPath); } catch (e) {}
        _fs.renameSync(_crashLogPath, _crashLogOldPath);
      }
    } catch (e) {} // 文件不存在时 stat 会抛错，忽略

    _fs.appendFileSync(_crashLogPath, '[' + new Date().toISOString() + '] ' + message + '\n', 'utf8');
  } catch (e) {}
}

// 记录进程启动信息
_writeCrashLog('process started, pid=' + process.pid + ', argv=' + JSON.stringify(process.argv));
_writeCrashLog('__dirname=' + __dirname);
_writeCrashLog('process.execPath=' + process.execPath);
_writeCrashLog('APPDATA=' + (process.env.APPDATA || 'undefined'));
_writeCrashLog('platform=' + process.platform + ', arch=' + process.arch);

// 监听未捕获异常
process.on('uncaughtException', (err) => {
  _writeCrashLog('uncaughtException: ' + (err && err.stack || err));
});

// 监听未处理的 Promise 拒绝
process.on('unhandledRejection', (reason) => {
  _writeCrashLog('unhandledRejection: ' + (reason && reason.stack || reason));
});

// 监听进程退出（仅记录非正常退出）
process.on('exit', (code) => {
  if (code !== 0) _writeCrashLog('process exited with code ' + code);
});

module.exports = { _writeCrashLog, _crashLogPath };
