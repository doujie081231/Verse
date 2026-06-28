// ============================================================================
// 共享状态中介层 (Shared State Mediator)
// ============================================================================
// 职责：
// 作为主进程各抽离模块之间的共享状态中介，避免循环依赖。
// 所有跨模块共享的“单例状态”统一通过本模块的 getter/setter 访问。
//
// 必须在所有其他 main/ 模块之前加载。
//
// 暴露的状态：
// - mainWindow       主窗口实例（createWindow 创建后写入，closed 时置 null）
// - apiHandler       server.js 的 handleNativeAPI/handleNativeSSE 引用
// - sseExecuteTool   SSE 服务器使用的工具执行函数引用
// - shuttingDown     应用关闭标志
// - serverModuleCache server.js 模块缓存
// - ssePort          SSE 服务器端口
// ============================================================================

let _mainWindow = null;
let _apiHandler = null;
let _sseExecuteTool = null;
let _shuttingDown = false;
let _serverModuleCache = null;
let _ssePort = 3001;

module.exports = {
    // 主窗口实例
    getMainWindow: () => _mainWindow,
    setMainWindow: (win) => { _mainWindow = win; },

    // server.js 的 API 处理函数引用
    getApiHandler: () => _apiHandler,
    setApiHandler: (handler) => { _apiHandler = handler; },

    // SSE 工具执行函数
    getSseExecuteTool: () => _sseExecuteTool,
    setSseExecuteTool: (fn) => { _sseExecuteTool = fn; },

    // 是否正在关闭应用
    getShuttingDown: () => _shuttingDown,
    setShuttingDown: (v) => { _shuttingDown = v; },

    // server.js 模块缓存
    getServerModuleCache: () => _serverModuleCache,
    setServerModuleCache: (cache) => { _serverModuleCache = cache; },

    // SSE 端口
    getSsePort: () => _ssePort,
    setSsePort: (port) => { _ssePort = port; },
};
