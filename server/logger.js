/**
 * server/logger.js - 统一日志模块
 * ============================================================================
 * 提供 log/warn/error/debug（及 info）方法，同时输出到 console 与文件。
 *
 * 特性：
 *   - 日志级别：debug < info < warn < error
 *   - 默认级别：production 用 info，development 用 debug
 *   - 文件输出：ctx.dirs.LOGS_DIR/versepc.log
 *   - 按天轮转：跨天时旧文件重命名为 versepc.log.YYYY-MM-DD
 *   - 按大小轮转：超过 10MB 重命名为 versepc.log.1
 *   - 统一前缀格式：[时间] [级别] [模块名] 消息
 *
 * 用法：
 *   const logger = require('./logger').createLogger('Modpack');
 *   logger.info('xxx');        // [2026-07-02T10:00:00.000Z] [INFO] [Modpack] xxx
 *   logger.warn('警告内容');
 */

const fs = require('fs');
const path = require('path');

const ctx = require('./context');

// 日志级别权重
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const LOG_FILE_NAME = 'versepc.log';
const LOG_FILE_ROTATED = 'versepc.log.1';

// 根据环境确定默认级别：开发环境用 debug，其他用 info
function resolveDefaultLevel() {
    const env = process.env.NODE_ENV;
    if (env === 'dev' || env === 'development') return LEVELS.debug;
    return LEVELS.info;
}

let currentLevel = resolveDefaultLevel();

// 缓存已确保存在的日志目录，避免重复 mkdirSync
let _ensuredLogDir = null;
let _logFile = null;

function resolveLogFile() {
    const logDir = (ctx.dirs && ctx.dirs.LOGS_DIR) || path.join(ctx.dirs.DATA_DIR, 'logs');
    if (_ensuredLogDir !== logDir) {
        try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
        _ensuredLogDir = logDir;
        _logFile = path.join(logDir, LOG_FILE_NAME);
    }
    return _logFile;
}

function todayStr() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// 轮转：跨天按日期归档；单文件超 10MB 按大小归档
function rotateIfNeeded() {
    const logFile = _logFile;
    if (!logFile) return;
    try {
        if (!fs.existsSync(logFile)) return;
        const stat = fs.statSync(logFile);
        const today = todayStr();
        const fileDate = stat.mtime.toISOString().slice(0, 10);

        // 按天轮转：旧文件归档为 versepc.log.YYYY-MM-DD
        if (fileDate !== today) {
            let dated = path.join(path.dirname(logFile), `versepc.log.${fileDate}`);
            if (fs.existsSync(dated)) {
                dated = path.join(path.dirname(logFile), `versepc.log.${fileDate}.${Date.now()}`);
            }
            try { fs.renameSync(logFile, dated); } catch (_) {}
            return;
        }

        // 按大小轮转：超过 10MB 重命名为 versepc.log.1
        if (stat.size > MAX_FILE_SIZE) {
            const rotated = path.join(path.dirname(logFile), LOG_FILE_ROTATED);
            try { fs.renameSync(logFile, rotated); } catch (_) {}
        }
    } catch (_) {}
}

// 写入文件：appendFileSync 包在 try/catch 里，失败不影响业务
function writeToFile(line) {
    try {
        resolveLogFile();
        rotateIfNeeded();
        fs.appendFileSync(_logFile, line + '\n', 'utf8');
    } catch (_) {}
}

// 序列化参数：对象转 JSON，字符串原样保留
function serializeArgs(args) {
    return args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
        try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');
}

function formatLine(level, moduleName, args) {
    const ts = new Date().toISOString();
    const msg = serializeArgs(args);
    const modulePart = moduleName ? `[${moduleName}] ` : '';
    return `[${ts}] [${level.toUpperCase()}] ${modulePart}${msg}`;
}

function emit(level, moduleName, args) {
    if (LEVELS[level] < currentLevel) return;
    const line = formatLine(level, moduleName, args);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    writeToFile(line);
}

/**
 * 创建带模块前缀的 logger
 * @param {string} [moduleName] - 模块名，将作为日志前缀 [ModuleName]
 * @returns {{debug: Function, info: Function, log: Function, warn: Function, error: Function}}
 */
function createLogger(moduleName) {
    return {
        debug: (...args) => emit('debug', moduleName, args),
        info: (...args) => emit('info', moduleName, args),
        log: (...args) => emit('info', moduleName, args),
        warn: (...args) => emit('warn', moduleName, args),
        error: (...args) => emit('error', moduleName, args)
    };
}

module.exports = {
    createLogger,
    LEVELS
};
