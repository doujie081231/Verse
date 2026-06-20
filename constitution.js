const fs = require('fs');
const path = require('path');

const AUTHORITY_HIERARCHY = [
    { id: 'user_intent', label: '用户当前意图', priority: 1 },
    { id: 'project_rules', label: '项目规则', priority: 2 },
    { id: 'tool_evidence', label: '工具输出证据', priority: 3 },
    { id: 'memory', label: '记忆', priority: 4 }
];

const RULE_TYPE_WEIGHT = { invariant: 3, procedure: 2, preference: 1 };

const ACTION_WEIGHT = { deny: 3, require_verification: 2, warn: 1, allow: 0 };

const DEFAULT_PROTECTED_PATHS = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    '~/.ssh',
    '~/.aws',
    '~/.gnupg',
    '/etc',
    '/usr',
    '/System'
];

const DEFAULT_CONFIG = {
    version: '1.0',
    rules: [],
    protected_paths: DEFAULT_PROTECTED_PATHS,
    max_file_size_mb: 100,
    require_approval_for: ['bash', 'write_file', 'edit_file']
};

class Constitution {
    constructor() {
        this._rules = new Map();
        this._protectedPaths = [...DEFAULT_PROTECTED_PATHS];
        this._maxFileSizeMb = 100;
        this._requireApprovalFor = ['bash', 'write_file', 'edit_file'];
        this._version = '1.0';
        this._loaded = false;
        this._configPath = null;
        this._loadDefaults();
    }

    _loadDefaults() {
        const defaultRules = [
            {
                id: 'no-delete-unsafe',
                type: 'invariant',
                description: '禁止执行可能导致数据丢失的操作',
                pattern: 'rm -rf|format|mkfs',
                action: 'deny',
                priority: 1
            },
            {
                id: 'verify-before-modify',
                type: 'procedure',
                description: '修改文件前必须先验证',
                pattern: 'write_file|edit_file',
                action: 'require_verification',
                priority: 2
            }
        ];
        for (const rule of defaultRules) {
            this._rules.set(rule.id, { ...rule, source: 'default' });
        }
    }

    load(projectPath) {
        let configPath = projectPath;
        if (!configPath) {
            configPath = path.join(process.cwd(), '.versepc', 'constitution.json');
        }
        try {
            this._configPath = configPath;
            if (!fs.existsSync(configPath)) {
                this._saveDefault(configPath);
                this._loaded = true;
                return this;
            }
            const raw = fs.readFileSync(configPath, 'utf-8');
            const config = JSON.parse(raw);
            if (!config || typeof config !== 'object') return this;
            this._version = config.version || '1.0';
            if (Array.isArray(config.rules)) {
                for (const rule of config.rules) {
                    if (!rule.id || !rule.type) continue;
                    this._rules.set(rule.id, {
                        id: rule.id,
                        type: rule.type,
                        description: rule.description || '',
                        pattern: rule.pattern || '',
                        action: rule.action || 'allow',
                        priority: rule.priority || 99,
                        condition: rule.condition || null,
                        source: 'config'
                    });
                }
            }
            if (Array.isArray(config.protected_paths)) {
                this._protectedPaths = config.protected_paths;
            }
            if (typeof config.max_file_size_mb === 'number') {
                this._maxFileSizeMb = config.max_file_size_mb;
            }
            if (Array.isArray(config.require_approval_for)) {
                this._requireApprovalFor = config.require_approval_for;
            }
            this._loaded = true;
        } catch (e) {
            console.error('[Constitution] Failed to load config:', e.message);
        }
        return this;
    }

    _saveDefault(configPath) {
        try {
            const dir = path.dirname(configPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
        } catch (e) {
            console.error('[Constitution] Failed to save default config:', e.message);
        }
    }

    getAuthorityHierarchy() {
        return AUTHORITY_HIERARCHY.map(h => ({ ...h }));
    }

    checkAction(action, context) {
        const ctx = context || {};
        const matchedRules = [];
        for (const [, rule] of this._rules) {
            if (!this._matchRule(action, rule, ctx)) continue;
            matchedRules.push(rule);
        }
        if (matchedRules.length === 0) {
            return this._checkBuiltIn(action, ctx);
        }
        matchedRules.sort((a, b) => {
            const typeDiff = (RULE_TYPE_WEIGHT[b.type] || 0) - (RULE_TYPE_WEIGHT[a.type] || 0);
            if (typeDiff !== 0) return typeDiff;
            return (a.priority || 99) - (b.priority || 99);
        });
        const topRule = matchedRules[0];
        if (topRule.type === 'invariant') {
            return {
                allowed: topRule.action !== 'deny',
                action: topRule.action,
                reason: topRule.description,
                ruleId: topRule.id,
                matchedRules: matchedRules.map(r => r.id),
                overrideable: false
            };
        }
        if (ctx.userIntent) {
            return {
                allowed: true,
                action: 'allow',
                reason: '用户意图优先',
                ruleId: null,
                matchedRules: matchedRules.map(r => r.id),
                overrideable: true,
                userOverride: true
            };
        }
        return {
            allowed: topRule.action !== 'deny',
            action: topRule.action,
            reason: topRule.description,
            ruleId: topRule.id,
            matchedRules: matchedRules.map(r => r.id),
            overrideable: topRule.type === 'preference'
        };
    }

    _matchRule(action, rule, ctx) {
        if (!rule.pattern) return false;
        const patterns = rule.pattern.split('|');
        for (const p of patterns) {
            const trimmed = p.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('/') && trimmed.endsWith('/')) {
                try {
                    const regex = new RegExp(trimmed.slice(1, -1));
                    if (regex.test(action)) return true;
                } catch (e) {
                    continue;
                }
            } else if (action === trimmed || action.includes(trimmed)) {
                return true;
            }
        }
        return false;
    }

    _checkBuiltIn(action, ctx) {
        if (ctx.targetPath) {
            const isProtected = this._isProtectedPath(ctx.targetPath);
            if (isProtected) {
                return {
                    allowed: false,
                    action: 'deny',
                    reason: '目标路径受保护',
                    ruleId: 'builtin-protected-path',
                    matchedRules: ['builtin-protected-path'],
                    overrideable: false
                };
            }
        }
        if (ctx.fileSizeMb && ctx.fileSizeMb > this._maxFileSizeMb) {
            return {
                allowed: false,
                action: 'deny',
                reason: `文件大小超过限制 (${this._maxFileSizeMb}MB)`,
                ruleId: 'builtin-file-size',
                matchedRules: ['builtin-file-size'],
                overrideable: false
            };
        }
        if (this._requireApprovalFor.includes(action)) {
            return {
                allowed: true,
                action: 'require_verification',
                reason: '该操作需要用户确认',
                ruleId: 'builtin-approval',
                matchedRules: ['builtin-approval'],
                overrideable: true
            };
        }
        return {
            allowed: true,
            action: 'allow',
            reason: null,
            ruleId: null,
            matchedRules: [],
            overrideable: true
        };
    }

    _isProtectedPath(targetPath) {
        try {
            const resolved = path.resolve(targetPath).toLowerCase();
            for (const protectedPath of this._protectedPaths) {
                const expanded = protectedPath.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '');
                const resolvedProtected = path.resolve(expanded).toLowerCase();
                if (resolved === resolvedProtected || resolved.startsWith(resolvedProtected + path.sep)) {
                    return true;
                }
            }
        } catch (e) {
            return false;
        }
        return false;
    }

    addRule(rule) {
        if (!rule || !rule.id || !rule.type) {
            return { success: false, error: '规则缺少必要字段 (id, type)' };
        }
        if (this._rules.has(rule.id)) {
            return { success: false, error: `规则 ${rule.id} 已存在` };
        }
        const newRule = {
            id: rule.id,
            type: rule.type,
            description: rule.description || '',
            pattern: rule.pattern || '',
            action: rule.action || 'allow',
            priority: rule.priority || 99,
            condition: rule.condition || null,
            source: 'dynamic'
        };
        this._rules.set(newRule.id, newRule);
        this._persistRule(newRule);
        return { success: true, rule: newRule };
    }

    removeRule(ruleId) {
        if (!this._rules.has(ruleId)) {
            return { success: false, error: `规则 ${ruleId} 不存在` };
        }
        const rule = this._rules.get(ruleId);
        if (rule.source === 'default') {
            return { success: false, error: '默认规则不可删除' };
        }
        this._rules.delete(ruleId);
        this._removePersistedRule(ruleId);
        return { success: true };
    }

    listRules() {
        const rules = [];
        for (const [, rule] of this._rules) {
            rules.push({
                id: rule.id,
                type: rule.type,
                description: rule.description,
                pattern: rule.pattern,
                action: rule.action,
                priority: rule.priority,
                source: rule.source
            });
        }
        rules.sort((a, b) => {
            const typeDiff = (RULE_TYPE_WEIGHT[b.type] || 0) - (RULE_TYPE_WEIGHT[a.type] || 0);
            if (typeDiff !== 0) return typeDiff;
            return (a.priority || 99) - (b.priority || 99);
        });
        return rules;
    }

    resolveConflict(conflicts) {
        if (!Array.isArray(conflicts) || conflicts.length === 0) {
            return { resolved: false, reason: '无冲突' };
        }
        const sorted = [...conflicts].sort((a, b) => {
            if (a.authoritySource && b.authoritySource) {
                const aHierarchy = AUTHORITY_HIERARCHY.find(h => h.id === a.authoritySource);
                const bHierarchy = AUTHORITY_HIERARCHY.find(h => h.id === b.authoritySource);
                if (aHierarchy && bHierarchy) {
                    return aHierarchy.priority - bHierarchy.priority;
                }
            }
            const aTypeWeight = RULE_TYPE_WEIGHT[a.type] || 0;
            const bTypeWeight = RULE_TYPE_WEIGHT[b.type] || 0;
            if (aTypeWeight !== bTypeWeight) return bTypeWeight - aTypeWeight;
            const aActionWeight = ACTION_WEIGHT[a.action] || 0;
            const bActionWeight = ACTION_WEIGHT[b.action] || 0;
            if (aActionWeight !== bActionWeight) return bActionWeight - aActionWeight;
            return (a.priority || 99) - (b.priority || 99);
        });
        const winner = sorted[0];
        const isInvariantOverride = sorted.some(
            (c, i) => i > 0 && c.type === 'invariant' && c.action === 'deny' && winner.type !== 'invariant'
        );
        if (isInvariantOverride) {
            const invariantWinner = sorted.find(c => c.type === 'invariant' && c.action === 'deny');
            if (invariantWinner) {
                return {
                    resolved: true,
                    winner: invariantWinner,
                    losers: sorted.filter(c => c !== invariantWinner),
                    reason: 'invariant 规则不可覆盖'
                };
            }
        }
        return {
            resolved: true,
            winner,
            losers: sorted.slice(1),
            reason: winner.reason || `${winner.authoritySource || winner.type} 优先级最高`
        };
    }

    generatePromptContext() {
        const rules = this.listRules();
        const invariantRules = rules.filter(r => r.type === 'invariant');
        const procedureRules = rules.filter(r => r.type === 'procedure');
        const preferenceRules = rules.filter(r => r.type === 'preference');
        const sections = [];
        sections.push('# 宪法规则系统');
        sections.push('');
        sections.push('## 权威层次（从高到低）');
        for (const h of AUTHORITY_HIERARCHY) {
            sections.push(`${h.priority}. ${h.label} (${h.id})`);
        }
        sections.push('');
        if (invariantRules.length > 0) {
            sections.push('## 不可变规则（始终生效，不可覆盖）');
            for (const r of invariantRules) {
                sections.push(`- [${r.id}] ${r.description} → ${r.action}`);
            }
            sections.push('');
        }
        if (procedureRules.length > 0) {
            sections.push('## 程序规则（条件生效）');
            for (const r of procedureRules) {
                sections.push(`- [${r.id}] ${r.description} → ${r.action}`);
            }
            sections.push('');
        }
        if (preferenceRules.length > 0) {
            sections.push('## 偏好规则（可被用户意图覆盖）');
            for (const r of preferenceRules) {
                sections.push(`- [${r.id}] ${r.description} → ${r.action}`);
            }
            sections.push('');
        }
        sections.push('## 受保护路径');
        for (const p of this._protectedPaths) {
            sections.push(`- ${p}`);
        }
        sections.push('');
        sections.push(`## 限制`);
        sections.push(`- 最大文件大小: ${this._maxFileSizeMb}MB`);
        sections.push(`- 需要确认的操作: ${this._requireApprovalFor.join(', ')}`);
        return sections.join('\n');
    }

    _persistRule(rule) {
        if (!this._configPath) return;
        try {
            let config = {};
            if (fs.existsSync(this._configPath)) {
                const raw = fs.readFileSync(this._configPath, 'utf-8');
                config = JSON.parse(raw);
            }
            if (!Array.isArray(config.rules)) config.rules = [];
            const existIndex = config.rules.findIndex(r => r.id === rule.id);
            const ruleData = {
                id: rule.id,
                type: rule.type,
                description: rule.description,
                pattern: rule.pattern,
                action: rule.action,
                priority: rule.priority
            };
            if (existIndex >= 0) {
                config.rules[existIndex] = ruleData;
            } else {
                config.rules.push(ruleData);
            }
            fs.writeFileSync(this._configPath, JSON.stringify(config, null, 2), 'utf-8');
        } catch (e) {
            console.error('[Constitution] Failed to persist rule:', e.message);
        }
    }

    _removePersistedRule(ruleId) {
        if (!this._configPath) return;
        try {
            if (!fs.existsSync(this._configPath)) return;
            const raw = fs.readFileSync(this._configPath, 'utf-8');
            const config = JSON.parse(raw);
            if (!Array.isArray(config.rules)) return;
            config.rules = config.rules.filter(r => r.id !== ruleId);
            fs.writeFileSync(this._configPath, JSON.stringify(config, null, 2), 'utf-8');
        } catch (e) {
            console.error('[Constitution] Failed to remove persisted rule:', e.message);
        }
    }
}

let _instance = null;
function getConstitution() {
    if (!_instance) {
        _instance = new Constitution();
    }
    return _instance;
}

module.exports = { Constitution, getConstitution };
