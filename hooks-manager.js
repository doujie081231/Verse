const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACTION_PRIORITY = { deny: 3, ask: 2, allow: 1 };

class HooksManager {
    constructor() {
        this.hooks = new Map();
    }

    loadHooks(configPath) {
        let resolvedPath = configPath;
        if (!resolvedPath) {
            resolvedPath = path.join(process.cwd(), '.versepc', 'hooks.json');
        }
        try {
            if (!fs.existsSync(resolvedPath)) return this;
            const raw = fs.readFileSync(resolvedPath, 'utf-8');
            const config = JSON.parse(raw);
            if (!config.hooks || typeof config.hooks !== 'object') return this;
            for (const [event, hooks] of Object.entries(config.hooks)) {
                if (!Array.isArray(hooks)) continue;
                for (const hook of hooks) {
                    if (!hook.pattern || !hook.action) continue;
                    const id = hook.id || this._generateId();
                    this.hooks.set(id, {
                        id,
                        event,
                        pattern: hook.pattern,
                        condition: hook.condition || null,
                        action: hook.action,
                        reason: hook.reason || '',
                        source: 'config'
                    });
                }
            }
        } catch (e) {
            console.error('[HooksManager] Failed to load hooks config:', e.message);
        }
        return this;
    }

    executeBeforeHooks(toolName, args) {
        const matched = [];
        for (const [, hook] of this.hooks) {
            if (hook.event !== 'tool_call_before') continue;
            if (!this._matchPattern(toolName, hook.pattern)) continue;
            if (hook.condition && !this._evaluateCondition(hook.condition, toolName, args)) continue;
            matched.push(hook);
        }
        if (matched.length === 0) return { action: 'allow' };
        matched.sort((a, b) => (ACTION_PRIORITY[b.action] || 0) - (ACTION_PRIORITY[a.action] || 0));
        const top = matched[0];
        return { action: top.action, reason: top.reason || undefined, hookId: top.id };
    }

    addHook(event, pattern, handler) {
        const id = this._generateId();
        const hook = {
            id,
            event,
            pattern,
            condition: null,
            action: handler.action || 'allow',
            reason: handler.reason || '',
            handler: typeof handler === 'function' ? handler : handler.handler || null,
            source: 'dynamic'
        };
        this.hooks.set(id, hook);
        return id;
    }

    removeHook(id) {
        return this.hooks.delete(id);
    }

    listHooks() {
        const list = [];
        for (const [, hook] of this.hooks) {
            list.push({
                id: hook.id,
                event: hook.event,
                pattern: hook.pattern,
                condition: hook.condition,
                action: hook.action,
                reason: hook.reason,
                source: hook.source
            });
        }
        return list;
    }

    _matchPattern(toolName, pattern) {
        if (!pattern || !toolName) return false;
        const parts = pattern.split('|');
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('/') && trimmed.endsWith('/')) {
                try {
                    const regex = new RegExp(trimmed.slice(1, -1));
                    if (regex.test(toolName)) return true;
                } catch (e) {
                    continue;
                }
            } else if (trimmed.includes('*')) {
                const regexStr = '^' + trimmed
                    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                    .replace(/\*/g, '.*') + '$';
                try {
                    const regex = new RegExp(regexStr);
                    if (regex.test(toolName)) return true;
                } catch (e) {
                    continue;
                }
            } else {
                if (toolName === trimmed) return true;
            }
        }
        return false;
    }

    _evaluateCondition(condition, toolName, args) {
        if (!condition) return true;
        try {
            if (condition.includes('command contains')) {
                const match = condition.match(/command contains '(.+)'/);
                if (match && args) {
                    const target = match[1];
                    const command = args.command || args.cmd || '';
                    return command.includes(target);
                }
                return false;
            }
            if (condition.includes('args contains')) {
                const match = condition.match(/args contains '(.+)'/);
                if (match && args) {
                    const target = match[1];
                    const argStr = typeof args === 'string' ? args : JSON.stringify(args);
                    return argStr.includes(target);
                }
                return false;
            }
            if (condition.includes('path matches')) {
                const match = condition.match(/path matches '(.+)'/);
                if (match && args) {
                    const pattern = match[1];
                    const filePath = args.path || args.file_path || args.file || '';
                    return this._matchPattern(filePath, pattern);
                }
                return false;
            }
        } catch (e) {
            console.error('[HooksManager] Condition evaluation error:', e.message);
            return false;
        }
        return true;
    }

    _generateId() {
        return 'hook-' + crypto.randomBytes(6).toString('hex');
    }
}

let _instance = null;
function getHooksManager() {
    if (!_instance) {
        _instance = new HooksManager();
    }
    return _instance;
}

module.exports = { HooksManager, getHooksManager };
