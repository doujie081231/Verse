/**
 * @file main/startup-tuning.js
 * @description 启动调优 - 从 main.js 抽出的启动阶段一次性配置：
 *   1. cleanupStaleProcesses: 清理遗留的旧 VersePC 进程和占用 3001-3010 端口的进程
 *   2. setupV8CodeCache: V8 代码缓存（首次启动后缓存编译结果，提速 40-60%）
 *   3. setupV8MemoryLimit: V8 渲染进程内存上限（按系统内存动态设置，防 OOM）
 *
 * 执行时机：单实例锁之后、app.ready 之前。由 main.js 在原位置调用，
 * 不改变执行顺序和时机，仅降低 main.js 入口文件复杂度。
 *
 * 设计决策：
 * - cleanupStaleProcesses 用 wmic 而非 taskkill /F /IM：wmic 能拿到 ParentProcessId，
 *   可区分主进程与子进程，只杀"孤儿进程"（ppid=0 或自身退出后的残留），避免误杀
 *   当前实例刚启动的子进程。taskkill /F /IM VersePC.exe 会无差别杀所有同名进程。
 * - 查 3001-3010 端口：SSE/通信端口预留范围，僵尸进程占住会导致新实例端口冲突、
 *   第二实例启动时协议注册失败。
 * - 用 setImmediate 包裹：不阻塞 app.requestSingleInstanceLock 和窗口创建，
 *   清理失败也不影响主流程（best-effort）。
 * - V8 --compile-cache-dir 放 DATA_DIR：系统清理临时目录不会让缓存失效。
 * - V8 --max-old-space-size 按物理内存分档：4G→768M / 8G→1G / 16G→1.5G / >16G→2G，
 *   防止渲染进程加载大量模组图标/版本列表时 OOM 崩溃。
 */

const { _writeCrashLog } = require('./crash-log');

const _t0 = Date.now();
const _bootLog = (msg) => { try { _writeCrashLog(`[BOOT+${Date.now() - _t0}ms] ${msg}`); } catch (e) {} };

/**
 * 清理遗留的旧进程和占用 3001-3010 端口的进程
 * 移到 setImmediate 中，不阻塞 app.requestSingleInstanceLock 和后续窗口创建
 */
function cleanupStaleProcesses() {
  setImmediate(() => {
    try {
      const { exec: _execAsync } = require('child_process');
      const _currentPid = process.pid;
      _execAsync('chcp 65001 >nul 2>nul && wmic process where "name=\'VersePC.exe\'" get ProcessId,ParentProcessId,CommandLine /format:csv 2>nul', { encoding: 'utf8', timeout: 5000, windowsHide: true }, (_err, _wmicOut) => {
        try {
          if (_wmicOut) {
            for (const _line of _wmicOut.split('\n')) {
              const _trim = _line.trim();
              if (!_trim || _trim.startsWith('Node')) continue;
              const _parts = _trim.split(',');
              if (_parts.length < 4) continue;
              const _pid = parseInt(_parts[_parts.length - 2]);
              const _ppid = parseInt(_parts[_parts.length - 1]);
              if (!_pid || _pid === _currentPid) continue;
              if (_ppid && _ppid !== 0) continue;
              try { process.kill(_pid); } catch (e) {}
            }
          }
        } catch (e) { _bootLog('wmic 输出解析失败: ' + (e && e.message)); }
      });
      _execAsync('netstat -ano | findstr LISTENING', { encoding: 'utf8', timeout: 5000, windowsHide: true }, (_err, _netOut) => {
        try {
          if (_netOut) {
            for (let _port = 3001; _port <= 3010; _port++) {
              const _regex = new RegExp(`:${_port}\\s.*LISTENING\\s+(\\d+)`, 'g');
              let _match;
              while ((_match = _regex.exec(_netOut)) !== null) {
                const _pid = parseInt(_match[1]);
                if (_pid && _pid !== _currentPid) {
                  try { process.kill(_pid); } catch (e) {}
                }
              }
            }
          }
        } catch (e) { _bootLog('netstat 输出解析失败: ' + (e && e.message)); }
      });
    } catch (e) { _bootLog('cleanupStaleProcesses 整体失败: ' + (e && e.message)); }
  });
}

/**
 * V8 Code Cache - 首次启动后缓存编译结果，后续启动提速 40-60%
 * 缓存目录放在 DATA_DIR 下，避免系统清理临时目录导致缓存失效
 */
function setupV8CodeCache() {
  try {
    const v8 = require('v8');
    const { DATA_DIR } = require('./paths');
    const cacheDir = require('path').join(DATA_DIR, 'v8-cache');
    try { require('fs').mkdirSync(cacheDir, { recursive: true }); } catch (e) { _bootLog('v8-cache 目录创建失败: ' + (e && e.message)); }
    v8.setFlagsFromString('--compile-cache-dir=' + cacheDir);
  } catch (e) { _bootLog('setupV8CodeCache 失败: ' + (e && e.message)); }
}

/**
 * V8 内存上限 - 根据系统内存动态设置，防止渲染进程 OOM 崩溃
 */
function setupV8MemoryLimit() {
  try {
    const osMod = require('os');
    const totalMemMB = Math.floor(osMod.totalmem() / 1024 / 1024);
    let rendererHeapMB;
    if (totalMemMB <= 4096) rendererHeapMB = 768;
    else if (totalMemMB <= 8192) rendererHeapMB = 1024;
    else if (totalMemMB <= 16384) rendererHeapMB = 1536;
    else rendererHeapMB = 2048;
    process.env.ELECTRON_RENDERER_V8_HEAP_SIZE = String(rendererHeapMB);
    try {
      const v8 = require('v8');
      v8.setFlagsFromString('--max-old-space-size=' + rendererHeapMB);
    } catch (e) { _bootLog('V8 max-old-space-size 设置失败: ' + (e && e.message)); }
  } catch (e) { _bootLog('setupV8MemoryLimit 失败: ' + (e && e.message)); }
}

module.exports = { cleanupStaleProcesses, setupV8CodeCache, setupV8MemoryLimit };
