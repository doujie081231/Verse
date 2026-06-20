const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DANGEROUS_CMD_PATTERNS = [
    { pattern: /\brm\s+(-[a-zA-Z]*[rf]|-[a-zA-Z]*f[a-zA-Z]*r)\s+[\/~*]/i, label: '递归删除根目录/主目录/通配符' },
    { pattern: /\brm\s+(-[a-zA-Z]*[rf]|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/(?:\s|$)/, label: '递归删除根目录' },
    { pattern: /\brm\s+(-[a-zA-Z]*[rf]|-[a-zA-Z]*f[a-zA-Z]*r)\s+~(?:\s|$)/, label: '递归删除用户主目录' },
    { pattern: /\brm\s+(-[a-zA-Z]*[rf]|-[a-zA-Z]*f[a-zA-Z]*r)\s+\*(?:\s|$)/, label: '递归删除所有文件' },
    { pattern: /\bsudo\s+rm\b/i, label: 'sudo 提权删除' },
    { pattern: /\bsudo\s+mv\s+\//i, label: 'sudo 移动根目录文件' },
    { pattern: /\bchmod\s+777\s+\//i, label: '开放根目录权限' },
    { pattern: /\bformat\s+[a-zA-Z]:/i, label: '格式化磁盘' },
    { pattern: /\bdel\s+\/[sS]\b/, label: '递归删除文件' },
    { pattern: /\brd\s+\/[sS]\b/, label: '递归删除目录' },
    { pattern: /\brmdir\s+\/[sS]\b/i, label: '递归删除目录' },
    { pattern: /\bmkfs\b/i, label: '创建文件系统（格式化）' },
    { pattern: /\bdd\s+.*of=\/dev\//i, label: 'dd 写入设备' },
    { pattern: />\s*\/dev\/sd[a-z]/i, label: '重定向到磁盘设备' },
    { pattern: /\bshutdown\b|\breboot\b|\binit\s+0\b/i, label: '关机/重启系统' },
    { pattern: /\bkill\s+-9\s+1\b|\bkillall\b/i, label: '强制终止进程' },
    { pattern: /\breg\s+delete\b/i, label: '删除注册表项' },
    { pattern: /\bnet\s+user\s+.*\/delete\b/i, label: '删除系统用户' },
    { pattern: /\bTakeown\b|\bicacls\b.*\/grant\b/i, label: '修改系统文件权限' },
];

const SYSTEM_DIR_PATTERNS = [
    /(?:^|\s)(?:rm|del|rd|rmdir|mv|move|copy|xcopy)\s+[^\s]*(?:C:\\Windows|C:\\Program\s*Files|\/etc|\/usr|\/bin|\/sbin|\/var|\/boot|\/lib|\/sys|\/proc)/i,
    /(?:^|\s)(?:chmod|chown|chgrp)\s+[^\s]*(?:\/etc|\/usr|\/bin|\/sbin|\/var|\/boot|\/lib)/i,
];

const PROTECTED_PATHS = [
    process.env.SystemRoot || 'C:\\Windows',
    process.env['ProgramFiles'] || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    process.env.ProgramData || 'C:\\ProgramData',
    'C:\\Recovery',
    'C:\\$Recycle.Bin',
    'C:\\System Volume Information',
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft'),
];

const SENSITIVE_DIRS = [
    path.join(os.homedir(), '.ssh'),
    path.join(os.homedir(), '.aws'),
    path.join(os.homedir(), '.azure'),
    path.join(os.homedir(), '.kube'),
    path.join(os.homedir(), '.gnupg'),
    path.join(os.homedir(), '.config', 'git'),
    path.join(os.homedir(), 'Documents', 'PowerShell'),
    path.join(os.homedir(), 'Documents', 'WindowsPowerShell'),
];

const POLICY_CONFIGS = {
    restricted: {
        allowRead: true,
        allowWrite: false,
        allowExecute: false,
        allowNetwork: false,
        maxOutputBytes: 1024 * 1024,
        maxFileBytes: 0,
        timeoutMs: 10000,
    },
    moderate: {
        allowRead: true,
        allowWrite: true,
        allowExecute: true,
        allowNetwork: false,
        maxOutputBytes: 5 * 1024 * 1024,
        maxFileBytes: 100 * 1024 * 1024,
        timeoutMs: 60000,
    },
    full: {
        allowRead: true,
        allowWrite: true,
        allowExecute: true,
        allowNetwork: true,
        maxOutputBytes: 50 * 1024 * 1024,
        maxFileBytes: 100 * 1024 * 1024,
        timeoutMs: 300000,
    },
};

function _isDangerousCommand(command) {
    if (!command || typeof command !== 'string') return null;
    const trimmed = command.trim();
    for (const { pattern, label } of DANGEROUS_CMD_PATTERNS) {
        if (pattern.test(trimmed)) return { dangerous: true, reason: label, pattern: pattern.source };
    }
    for (const pattern of SYSTEM_DIR_PATTERNS) {
        if (pattern.test(trimmed)) return { dangerous: true, reason: '修改系统目录', pattern: pattern.source };
    }
    return null;
}

function _isPathProtected(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') return false;
    const resolved = path.resolve(targetPath).toLowerCase();
    for (const p of PROTECTED_PATHS) {
        const lower = p.toLowerCase();
        if (resolved === lower || resolved.startsWith(lower + path.sep)) return true;
    }
    return false;
}

function _isPathSensitive(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') return false;
    const resolved = path.resolve(targetPath).toLowerCase();
    for (const p of SENSITIVE_DIRS) {
        const lower = p.toLowerCase();
        if (resolved === lower || resolved.startsWith(lower + path.sep)) return true;
    }
    return false;
}

function _extractPathsFromCommand(command) {
    if (!command) return [];
    const paths = [];
    const pathPattern = /(?:[A-Za-z]:\\[^\s"'|>&]+|(?:\/[^\s"'|>&]+)+)/g;
    let match;
    while ((match = pathPattern.exec(command)) !== null) {
        paths.push(match[0]);
    }
    return paths;
}

function _buildSafeEnv(allowedVars) {
    const safe = {};
    const defaults = [
        'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
        'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'USERNAME',
        'NODE_ENV', 'ELECTRON_RUN_AS_NODE', 'APPDATA',
    ];
    const vars = allowedVars && allowedVars.length > 0 ? allowedVars : defaults;
    for (const key of vars) {
        if (process.env[key] !== undefined) {
            safe[key] = process.env[key];
        }
    }
    return safe;
}

class SandboxManager {
    constructor() {
        this._policy = 'full';
        this._policyConfig = { ...POLICY_CONFIGS.full };
        this._activeProcesses = new Map();
        this._processCounter = 0;
    }

    isSupported() {
        try {
            const platform = process.platform;
            if (platform !== 'win32') return { supported: false, reason: '仅支持 Windows 平台' };
            const sysRoot = process.env.SystemRoot || 'C:\\Windows';
            if (!fs.existsSync(sysRoot)) return { supported: false, reason: '无法定位系统根目录' };
            return { supported: true, platform: 'win32', arch: process.arch };
        } catch (e) {
            return { supported: false, reason: e.message };
        }
    }

    createSandbox(options = {}) {
        const support = this.isSupported();
        if (!support.supported) {
            return { success: false, error: support.reason };
        }

        const policy = options.policy || this._policy;
        const policyConfig = POLICY_CONFIGS[policy];
        if (!policyConfig) {
            return { success: false, error: `未知策略: ${policy}` };
        }

        const sandboxId = `sandbox_${Date.now().toString(36)}_${(++this._processCounter).toString(36)}`;
        const workDir = options.workDir || path.join(os.tmpdir(), 'versepc_sandbox', sandboxId);

        try {
            fs.mkdirSync(workDir, { recursive: true });
        } catch (e) {
            return { success: false, error: `创建工作目录失败: ${e.message}` };
        }

        const sandbox = {
            id: sandboxId,
            policy,
            config: { ...policyConfig },
            workDir,
            createdAt: Date.now(),
            env: _buildSafeEnv(options.envVars),
            active: true,
        };

        this._activeProcesses.set(sandboxId, sandbox);

        return { success: true, sandbox };
    }

    setPolicy(policy) {
        const valid = Object.keys(POLICY_CONFIGS);
        if (!valid.includes(policy)) {
            return { success: false, error: `无效策略，可选: ${valid.join(', ')}` };
        }
        this._policy = policy;
        this._policyConfig = { ...POLICY_CONFIGS[policy] };
        return { success: true, policy, config: this._policyConfig };
    }

    getPolicy() {
        return {
            name: this._policy,
            config: { ...this._policyConfig },
            available: Object.keys(POLICY_CONFIGS),
        };
    }

    executeInSandbox(command, options = {}) {
        const policy = options.policy || this._policy;
        const policyConfig = POLICY_CONFIGS[policy] || POLICY_CONFIGS.full;

        if (!policyConfig.allowExecute) {
            return Promise.resolve({
                success: false,
                error: `当前策略 "${policy}" 禁止执行命令`,
                policy,
            });
        }

        const dangerous = _isDangerousCommand(command);
        if (dangerous) {
            return Promise.resolve({
                success: false,
                error: `检测到危险操作: ${dangerous.reason}`,
                dangerous: true,
                detail: dangerous,
                policy,
            });
        }

        const paths = _extractPathsFromCommand(command);
        for (const p of paths) {
            if (_isPathProtected(p)) {
                return Promise.resolve({
                    success: false,
                    error: `禁止访问受保护的系统路径: ${p}`,
                    blockedPath: p,
                    policy,
                });
            }
            if (policy === 'restricted' && _isPathSensitive(p)) {
                return Promise.resolve({
                    success: false,
                    error: `当前策略下禁止访问敏感目录: ${p}`,
                    blockedPath: p,
                    policy,
                });
            }
        }

        if (policy === 'restricted') {
            const writeIndicators = [/>\s*\S/, />>\s*\S/, /\btee\b/, /\bcp\b/, /\bcopy\b/, /\bmove\b/, /\bmv\b/, /\bwrite\b/i, /\bcreate\b/i, /\bmkdir\b/i, /\bmkfile\b/i, /\becho\b.*>/, /\bsave\b/i, /\bdel\b/i, /\brm\b/i, /\brd\b/i, /\brmdir\b/i];
            for (const pat of writeIndicators) {
                if (pat.test(command)) {
                    return Promise.resolve({
                        success: false,
                        error: '当前策略为 restricted，禁止写入操作',
                        policy,
                    });
                }
            }
        }

        const timeoutMs = options.timeoutMs || policyConfig.timeoutMs;
        const maxOutputBytes = options.maxOutputBytes || policyConfig.maxOutputBytes;
        const workDir = options.workDir || path.join(os.tmpdir(), 'versepc_sandbox');

        try {
            fs.mkdirSync(workDir, { recursive: true });
        } catch (e) {
            return Promise.resolve({
                success: false,
                error: `创建执行目录失败: ${e.message}`,
                policy,
            });
        }

        return this._spawnProcess(command, {
            workDir,
            timeoutMs,
            maxOutputBytes,
            policy,
            policyConfig,
            envVars: options.envVars,
            shell: options.shell,
        });
    }

    _spawnProcess(command, opts) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            let stdout = '';
            let stderr = '';
            let killed = false;
            let timedOut = false;
            let outputTruncated = false;

            const shell = opts.shell !== undefined ? opts.shell : true;
            const env = _buildSafeEnv(opts.envVars);

            let proc;
            try {
                proc = spawn(command, [], {
                    shell,
                    cwd: opts.workDir,
                    env,
                    detached: true,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                });
            } catch (e) {
                resolve({
                    success: false,
                    error: `进程创建失败: ${e.message}`,
                    policy: opts.policy,
                });
                return;
            }

            const timer = setTimeout(() => {
                timedOut = true;
                try {
                    process.kill(-proc.pid, 'SIGTERM');
                } catch (e) {
                    try { proc.kill('SIGTERM'); } catch (e2) {}
                }
            }, opts.timeoutMs);

            const checkOutputLimit = (chunk) => {
                if (outputTruncated) return Buffer.alloc(0);
                const current = Buffer.byteLength(stdout + stderr, 'utf-8') + chunk.length;
                if (current > opts.maxOutputBytes) {
                    outputTruncated = true;
                    return chunk.slice(0, Math.max(0, opts.maxOutputBytes - Buffer.byteLength(stdout + stderr, 'utf-8')));
                }
                return chunk;
            };

            proc.stdout.on('data', (data) => {
                const chunk = checkOutputLimit(data);
                if (chunk.length > 0) stdout += chunk.toString('utf-8');
            });

            proc.stderr.on('data', (data) => {
                const chunk = checkOutputLimit(data);
                if (chunk.length > 0) stderr += chunk.toString('utf-8');
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                resolve({
                    success: false,
                    error: `进程错误: ${err.message}`,
                    stdout: stdout.substring(0, opts.maxOutputBytes),
                    stderr: stderr.substring(0, opts.maxOutputBytes),
                    elapsed: Date.now() - startTime,
                    policy: opts.policy,
                });
            });

            proc.on('close', (code, signal) => {
                clearTimeout(timer);
                resolve({
                    success: code === 0 && !timedOut,
                    exitCode: code,
                    signal,
                    stdout: stdout.substring(0, opts.maxOutputBytes),
                    stderr: stderr.substring(0, opts.maxOutputBytes),
                    elapsed: Date.now() - startTime,
                    timedOut,
                    outputTruncated,
                    killed,
                    policy: opts.policy,
                });
            });

            try {
                proc.unref();
            } catch (e) {}
        });
    }

    destroySandbox(sandboxId) {
        const sandbox = this._activeProcesses.get(sandboxId);
        if (!sandbox) {
            return { success: false, error: `沙盒不存在: ${sandboxId}` };
        }
        sandbox.active = false;
        this._activeProcesses.delete(sandboxId);
        try {
            if (sandbox.workDir && fs.existsSync(sandbox.workDir)) {
                fs.rmSync(sandbox.workDir, { recursive: true, force: true });
            }
        } catch (e) {}
        return { success: true, sandboxId };
    }

    listSandboxes() {
        const list = [];
        for (const [id, sandbox] of this._activeProcesses) {
            list.push({
                id,
                policy: sandbox.policy,
                workDir: sandbox.workDir,
                active: sandbox.active,
                createdAt: sandbox.createdAt,
            });
        }
        return list;
    }

    static get POLICY_CONFIGS() {
        return { ...POLICY_CONFIGS };
    }

    static get DANGEROUS_CMD_PATTERNS() {
        return [...DANGEROUS_CMD_PATTERNS];
    }

    static get PROTECTED_PATHS() {
        return [...PROTECTED_PATHS];
    }

    static get SENSITIVE_DIRS() {
        return [...SENSITIVE_DIRS];
    }
}

const sandboxManager = new SandboxManager();

module.exports = { SandboxManager, sandboxManager };
