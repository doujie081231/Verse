/**
 * VersePC - Minecraft Launcher
 * Copyright (c) 2026 豆杰. All Rights Reserved.
 *
 * AI TRAINING PROHIBITED: This code is protected by copyright law.
 * Unauthorized use for AI model training, machine learning datasets,
 * or any form of artificial intelligence training is strictly prohibited.
 *
 * This software is proprietary and confidential.
 * Any unauthorized reproduction or distribution is prohibited.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execSync } = require('child_process');

const SKILLS_DIR = path.join(os.homedir(), '.versepc', 'skills');
const REMOTE_INDEX_URL = 'https://raw.githubusercontent.com/VersePC/skill-hub/main/index.json';
const REQUIRED_FIELDS = ['id', 'name', 'version', 'description', 'tools', 'entry'];

class SkillManager {
    constructor(pluginManager) {
        this.skills = new Map();
        this.pluginManager = pluginManager || null;
        this._ensureSkillsDir();
    }

    _ensureSkillsDir() {
        try {
            fs.mkdirSync(SKILLS_DIR, { recursive: true });
        } catch (e) {}
    }

    _readManifest(skillDir) {
        const manifestPath = path.join(skillDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch (e) {
            return null;
        }
    }

    _validateManifest(manifest) {
        if (!manifest || typeof manifest !== 'object') return { valid: false, error: 'manifest 格式无效' };
        for (const field of REQUIRED_FIELDS) {
            if (!manifest[field]) return { valid: false, error: `缺少必要字段: ${field}` };
        }
        if (!Array.isArray(manifest.tools)) return { valid: false, error: 'tools 必须是数组' };
        if (manifest.tools.length === 0) return { valid: false, error: 'tools 不能为空' };
        for (const tool of manifest.tools) {
            if (!tool.name) return { valid: false, error: 'tool 缺少 name 字段' };
        }
        return { valid: true };
    }

    _resolveEntryPath(skillDir, entry) {
        const rawEntry = entry || 'index.js';
        const resolved = path.resolve(skillDir, rawEntry);
        if (!resolved.startsWith(path.resolve(skillDir) + path.sep) && resolved !== path.resolve(skillDir)) {
            return null;
        }
        return resolved;
    }

    _httpGet(url) {
        return new Promise((resolve, reject) => {
            const maxSize = 10 * 1024 * 1024;
            let size = 0;
            const req = https.get(url, { headers: { 'User-Agent': 'VersePC/1.0' }, timeout: 15000 }, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    const location = res.headers.location;
                    if (location) {
                        this._httpGet(location).then(resolve).catch(reject);
                        return;
                    }
                }
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                const chunks = [];
                res.on('data', chunk => {
                    size += chunk.length;
                    if (size > maxSize) {
                        req.destroy();
                        reject(new Error('Response too large'));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
        });
    }

    async _httpGetString(url) {
        const buf = await this._httpGet(url);
        return buf.toString('utf-8');
    }

    async _httpGetJson(url) {
        const text = await this._httpGetString(url);
        return JSON.parse(text);
    }

    _parseSkillSource(skillSource) {
        if (!skillSource || typeof skillSource !== 'string') return null;
        const trimmed = skillSource.trim();

        if (fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory()) {
            return { type: 'local', path: trimmed };
        }

        const ghMatch = trimmed.match(/^github:([^/]+)\/([^/@]+)(?:@(.+))?$/);
        if (ghMatch) {
            return { type: 'github', owner: ghMatch[1], repo: ghMatch[2], branch: ghMatch[3] || 'main' };
        }

        const ghUrlMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/(.+))?$/);
        if (ghUrlMatch) {
            return { type: 'github', owner: ghUrlMatch[1], repo: ghUrlMatch[2], branch: ghUrlMatch[3] || 'main' };
        }

        if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
            return { type: 'url', url: trimmed };
        }

        return null;
    }

    _getRawUrl(owner, repo, branch, filePath) {
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    }

    loadSkills() {
        this.skills.clear();
        if (!fs.existsSync(SKILLS_DIR)) return this;
        const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillDir = path.join(SKILLS_DIR, entry.name);
            const manifest = this._readManifest(skillDir);
            if (!manifest) continue;
            const validation = this._validateManifest(manifest);
            if (!validation.valid) {
                console.error(`[SkillManager] Invalid skill "${entry.name}":`, validation.error);
                continue;
            }
            const resolvedEntry = this._resolveEntryPath(skillDir, manifest.entry);
            if (!resolvedEntry) {
                console.error(`[SkillManager] Entry path traversal blocked for "${entry.name}"`);
                continue;
            }
            const hasEntry = fs.existsSync(resolvedEntry);
            const statePath = path.join(skillDir, '.state.json');
            let state = { enabled: true };
            try {
                if (fs.existsSync(statePath)) {
                    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                }
            } catch (e) {}
            this.skills.set(manifest.id, {
                manifest,
                dir: skillDir,
                hasEntry,
                enabled: state.enabled !== false
            });
        }
        return this;
    }

    async searchSkills(query) {
        const results = [];
        const q = (query || '').toLowerCase().trim();

        for (const [id, skill] of this.skills) {
            if (!q) {
                results.push({ id, name: skill.manifest.name, version: skill.manifest.version, description: skill.manifest.description, tags: skill.manifest.tags || [], source: 'local', installed: true });
                continue;
            }
            const haystack = [
                skill.manifest.name || '',
                skill.manifest.description || '',
                id,
                ...(skill.manifest.tags || [])
            ].join(' ').toLowerCase();
            if (haystack.includes(q)) {
                results.push({ id, name: skill.manifest.name, version: skill.manifest.version, description: skill.manifest.description, tags: skill.manifest.tags || [], source: 'local', installed: true });
            }
        }

        try {
            const remoteIndex = await this._httpGetJson(REMOTE_INDEX_URL);
            const remoteSkills = Array.isArray(remoteIndex) ? remoteIndex : (remoteIndex.skills || []);
            for (const remote of remoteSkills) {
                if (!remote.id) continue;
                if (this.skills.has(remote.id)) continue;
                if (q) {
                    const haystack = [
                        remote.name || '',
                        remote.description || '',
                        remote.id,
                        ...(remote.tags || [])
                    ].join(' ').toLowerCase();
                    if (!haystack.includes(q)) continue;
                }
                results.push({
                    id: remote.id,
                    name: remote.name || remote.id,
                    version: remote.version || '1.0.0',
                    description: remote.description || '',
                    tags: remote.tags || [],
                    source: 'remote',
                    installed: false,
                    repo: remote.repo || null
                });
            }
        } catch (e) {}

        return results;
    }

    async installSkill(skillSource) {
        const source = this._parseSkillSource(skillSource);
        if (!source) throw new Error('无法识别技能来源: ' + skillSource);

        let manifest = null;
        let skillFiles = {};

        if (source.type === 'local') {
            manifest = this._readManifest(source.path);
            if (!manifest) throw new Error('本地技能目录中未找到有效的 manifest.json');
            const validation = this._validateManifest(manifest);
            if (!validation.valid) throw new Error(validation.error);
            const resolvedEntry = this._resolveEntryPath(source.path, manifest.entry);
            if (!resolvedEntry || !fs.existsSync(resolvedEntry)) throw new Error('入口文件不存在: ' + manifest.entry);
            const targetDir = path.join(SKILLS_DIR, manifest.id);
            if (fs.existsSync(targetDir)) throw new Error('技能已存在: ' + manifest.id);
            this._copyDirSync(source.path, targetDir);
            this.skills.set(manifest.id, { manifest, dir: targetDir, hasEntry: true, enabled: true });
            return { success: true, id: manifest.id, name: manifest.name, source: 'local' };
        }

        if (source.type === 'github') {
            const manifestUrl = this._getRawUrl(source.owner, source.repo, source.branch, 'manifest.json');
            try {
                const text = await this._httpGetString(manifestUrl);
                manifest = JSON.parse(text);
            } catch (e) {
                throw new Error('无法从 GitHub 获取 manifest.json: ' + e.message);
            }
            const validation = this._validateManifest(manifest);
            if (!validation.valid) throw new Error(validation.error);

            const targetDir = path.join(SKILLS_DIR, manifest.id);
            if (fs.existsSync(targetDir)) throw new Error('技能已存在: ' + manifest.id);
            fs.mkdirSync(targetDir, { recursive: true });

            try {
                fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
                const entryUrl = this._getRawUrl(source.owner, source.repo, source.branch, manifest.entry);
                const entryContent = await this._httpGetString(entryUrl);
                fs.writeFileSync(path.join(targetDir, manifest.entry), entryContent, 'utf-8');

                const filesToFetch = manifest.files || [];
                for (const file of filesToFetch) {
                    if (file === 'manifest.json' || file === manifest.entry) continue;
                    try {
                        const fileUrl = this._getRawUrl(source.owner, source.repo, source.branch, file);
                        const fileContent = await this._httpGetString(fileUrl);
                        const filePath = path.join(targetDir, file);
                        const fileDir = path.dirname(filePath);
                        fs.mkdirSync(fileDir, { recursive: true });
                        fs.writeFileSync(filePath, fileContent, 'utf-8');
                    } catch (e) {}
                }
            } catch (e) {
                this._removeDirSync(targetDir);
                throw new Error('下载技能文件失败: ' + e.message);
            }

            this.skills.set(manifest.id, { manifest, dir: targetDir, hasEntry: true, enabled: true });
            return { success: true, id: manifest.id, name: manifest.name, source: 'github' };
        }

        if (source.type === 'url') {
            try {
                const text = await this._httpGetString(source.url);
                manifest = JSON.parse(text);
            } catch (e) {
                throw new Error('无法从 URL 获取 manifest.json: ' + e.message);
            }
            const validation = this._validateManifest(manifest);
            if (!validation.valid) throw new Error(validation.error);
            throw new Error('URL 类型暂仅支持 manifest 获取，完整安装请使用 GitHub 来源');
        }

        throw new Error('不支持的来源类型');
    }

    uninstallSkill(skillId) {
        const skill = this.skills.get(skillId);
        if (!skill) throw new Error('技能不存在: ' + skillId);
        try {
            this._removeDirSync(skill.dir);
        } catch (e) {
            throw new Error('删除技能目录失败: ' + e.message);
        }
        this.skills.delete(skillId);
        return { success: true, id: skillId };
    }

    getSkillDetails(skillId) {
        const skill = this.skills.get(skillId);
        if (!skill) return null;
        const resolvedEntry = this._resolveEntryPath(skill.dir, skill.manifest.entry);
        return {
            id: skill.manifest.id,
            name: skill.manifest.name,
            version: skill.manifest.version,
            description: skill.manifest.description,
            author: skill.manifest.author || '',
            tags: skill.manifest.tags || [],
            tools: skill.manifest.tools.map(t => ({ name: t.name, description: t.description || '', risk: t.risk || 'safe' })),
            dependencies: skill.manifest.dependencies || [],
            entry: skill.manifest.entry,
            hasEntry: skill.hasEntry,
            enabled: skill.enabled,
            dir: skill.dir
        };
    }

    listSkills() {
        const list = [];
        for (const [id, skill] of this.skills) {
            list.push({
                id,
                name: skill.manifest.name,
                version: skill.manifest.version,
                description: skill.manifest.description,
                author: skill.manifest.author || '',
                tags: skill.manifest.tags || [],
                enabled: skill.enabled,
                toolCount: (skill.manifest.tools || []).length
            });
        }
        return list;
    }

    enableSkill(skillId) {
        const skill = this.skills.get(skillId);
        if (!skill) throw new Error('技能不存在: ' + skillId);
        skill.enabled = true;
        this._saveSkillState(skill.dir, true);
        if (this.pluginManager) {
            this._syncToPluginManager(skillId, skill, true);
        }
        return { success: true, id: skillId, enabled: true };
    }

    disableSkill(skillId) {
        const skill = this.skills.get(skillId);
        if (!skill) throw new Error('技能不存在: ' + skillId);
        skill.enabled = false;
        this._saveSkillState(skill.dir, false);
        if (this.pluginManager) {
            this._syncToPluginManager(skillId, skill, false);
        }
        return { success: true, id: skillId, enabled: false };
    }

    async createSkill(manifest) {
        if (!manifest || typeof manifest !== 'object') throw new Error('manifest 无效');
        const id = manifest.id;
        if (!id) throw new Error('manifest 必须包含 id 字段');
        const targetDir = path.join(SKILLS_DIR, id);
        if (fs.existsSync(targetDir)) throw new Error('技能已存在: ' + id);

        const fullManifest = {
            id,
            name: manifest.name || id,
            version: manifest.version || '1.0.0',
            description: manifest.description || '',
            author: manifest.author || '',
            tags: manifest.tags || [],
            tools: manifest.tools || [],
            dependencies: manifest.dependencies || [],
            entry: manifest.entry || 'index.js'
        };

        const validation = this._validateManifest(fullManifest);
        if (!validation.valid) throw new Error(validation.error);

        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(fullManifest, null, 2), 'utf-8');

        const entryFile = fullManifest.entry;
        const entryPath = path.join(targetDir, entryFile);
        if (!fs.existsSync(entryPath)) {
            const entryDir = path.dirname(entryPath);
            if (entryDir !== targetDir) fs.mkdirSync(entryDir, { recursive: true });
            const toolNames = fullManifest.tools.map(t => t.name);
            const skeleton = this._generateEntrySkeleton(id, toolNames);
            fs.writeFileSync(entryPath, skeleton, 'utf-8');
        }

        this.skills.set(id, { manifest: fullManifest, dir: targetDir, hasEntry: true, enabled: true });
        return { success: true, id, name: fullManifest.name, dir: targetDir };
    }

    async updateSkill(skillId) {
        const skill = this.skills.get(skillId);
        if (!skill) throw new Error('技能不存在: ' + skillId);
        const manifestPath = path.join(skill.dir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) throw new Error('manifest.json 不存在');

        let currentManifest = null;
        try {
            currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch (e) {
            throw new Error('读取 manifest.json 失败');
        }

        const sourceUrl = currentManifest.source;
        if (!sourceUrl) throw new Error('该技能没有记录来源信息，无法自动更新');

        const source = this._parseSkillSource(sourceUrl);
        if (!source || source.type !== 'github') throw new Error('当前仅支持 GitHub 来源的技能更新');

        try {
            const remoteManifestUrl = this._getRawUrl(source.owner, source.repo, source.branch, 'manifest.json');
            const remoteManifest = await this._httpGetJson(remoteManifestUrl);
            const validation = this._validateManifest(remoteManifest);
            if (!validation.valid) throw new Error('远程 manifest 无效: ' + validation.error);

            if (remoteManifest.version === currentManifest.version) {
                return { success: true, id: skillId, updated: false, message: '已是最新版本' };
            }

            fs.writeFileSync(manifestPath, JSON.stringify(remoteManifest, null, 2), 'utf-8');

            const entryUrl = this._getRawUrl(source.owner, source.repo, source.branch, remoteManifest.entry);
            const entryContent = await this._httpGetString(entryUrl);
            fs.writeFileSync(path.join(skill.dir, remoteManifest.entry), entryContent, 'utf-8');

            const filesToFetch = remoteManifest.files || [];
            for (const file of filesToFetch) {
                if (file === 'manifest.json' || file === remoteManifest.entry) continue;
                try {
                    const fileUrl = this._getRawUrl(source.owner, source.repo, source.branch, file);
                    const fileContent = await this._httpGetString(fileUrl);
                    const filePath = path.join(skill.dir, file);
                    const fileDir = path.dirname(filePath);
                    fs.mkdirSync(fileDir, { recursive: true });
                    fs.writeFileSync(filePath, fileContent, 'utf-8');
                } catch (e) {}
            }

            skill.manifest = remoteManifest;
            return { success: true, id: skillId, updated: true, oldVersion: currentManifest.version, newVersion: remoteManifest.version };
        } catch (e) {
            throw new Error('更新失败: ' + e.message);
        }
    }

    _saveSkillState(skillDir, enabled) {
        const statePath = path.join(skillDir, '.state.json');
        try {
            fs.writeFileSync(statePath, JSON.stringify({ enabled }, null, 2), 'utf-8');
        } catch (e) {}
    }

    _syncToPluginManager(skillId, skill, enabled) {
        if (!this.pluginManager) return;
        try {
            const pmPlugin = this.pluginManager.plugins.get(skillId);
            if (pmPlugin) {
                pmPlugin.manifest.enabled = enabled;
            } else if (enabled && skill.hasEntry) {
                const resolvedEntry = this._resolveEntryPath(skill.dir, skill.manifest.entry);
                if (!resolvedEntry) return;
                let impl = {};
                try { impl = require(resolvedEntry); } catch (e) {}
                this.pluginManager.plugins.set(skillId, { manifest: { ...skill.manifest, enabled: true }, impl, dir: skill.dir });
            }
        } catch (e) {}
    }

    _copyDirSync(src, dest) {
        fs.mkdirSync(dest, { recursive: true });
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                this._copyDirSync(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    }

    _removeDirSync(dir) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._removeDirSync(fullPath);
            } else {
                fs.unlinkSync(fullPath);
            }
        }
        fs.rmdirSync(dir);
    }

    _generateEntrySkeleton(skillId, toolNames) {
        const lines = [];
        lines.push('async function execute(toolName, args, context) {');
        lines.push('    switch (toolName) {');
        for (const name of toolNames) {
            lines.push(`        case '${name}':`);
            lines.push(`            return JSON.stringify({ status: 'ok', message: '${name} executed' });`);
        }
        lines.push('        default:');
        lines.push(`            return JSON.stringify({ status: 'error', error: 'Unknown tool: ' + toolName });`);
        lines.push('    }');
        lines.push('}');
        lines.push('');
        lines.push('module.exports = { execute };');
        lines.push('');
        return lines.join('\n');
    }

    registerWithPluginManager(pluginManager) {
        if (!pluginManager) return;
        this.pluginManager = pluginManager;
        for (const [id, skill] of this.skills) {
            if (!skill.enabled) continue;
            if (!skill.hasEntry) continue;
            if (pluginManager.plugins.has(id)) continue;
            const resolvedEntry = this._resolveEntryPath(skill.dir, skill.manifest.entry);
            if (!resolvedEntry) continue;
            let impl = {};
            try {
                if (fs.existsSync(resolvedEntry)) impl = require(resolvedEntry);
            } catch (e) {}
            pluginManager.plugins.set(id, {
                manifest: { ...skill.manifest, enabled: true },
                impl,
                dir: skill.dir
            });
        }
    }
}

let _instance = null;
function getSkillManager(pluginManager) {
    if (!_instance) {
        _instance = new SkillManager(pluginManager);
        _instance.loadSkills();
    }
    return _instance;
}

module.exports = { SkillManager, getSkillManager };
