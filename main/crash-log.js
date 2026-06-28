// ============================================================================
// 崩溃日志 - 必须在所有其他代码之前，捕获最早期的启动错误
// ============================================================================
const _crashLogPath = require('path').join(
    process.env.APPDATA || require('path').join(require('os').homedir(), 'AppData', 'Roaming'),
    'VersePC', 'crash.log'
);
function _writeCrashLog(message) {
    try {
        const _fs = require('fs');
        const _dir = require('path').dirname(_crashLogPath);
        if (!_fs.existsSync(_dir)) _fs.mkdirSync(_dir, { recursive: true });
        _fs.appendFileSync(_crashLogPath, '[' + new Date().toISOString() + '] ' + message + '\n', 'utf8');
    } catch (e) {}
}
_writeCrashLog('process started, pid=' + process.pid + ', argv=' + JSON.stringify(process.argv));
_writeCrashLog('__dirname=' + __dirname);
_writeCrashLog('process.execPath=' + process.execPath);
_writeCrashLog('APPDATA=' + (process.env.APPDATA || 'undefined'));
_writeCrashLog('platform=' + process.platform + ', arch=' + process.arch);
process.on('uncaughtException', (err) => {
    _writeCrashLog('uncaughtException: ' + (err && err.stack || err));
});
process.on('unhandledRejection', (reason) => {
    _writeCrashLog('unhandledRejection: ' + (reason && reason.stack || reason));
});
process.on('exit', (code) => {
    if (code !== 0) _writeCrashLog('process exited with code ' + code);
});

module.exports = { _writeCrashLog, _crashLogPath };
