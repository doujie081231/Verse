const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SNAPSHOT_BASE_DIR = path.join(os.homedir(), '.versepc', 'snapshots');
const MAX_SNAPSHOTS = 50;

class SnapshotManager {
    constructor() {
        this._snapshots = [];
        this._ensureDir();
        this._loadSnapshots();
    }

    _ensureDir() {
        try {
            fs.mkdirSync(SNAPSHOT_BASE_DIR, { recursive: true });
        } catch (e) {}
    }

    _loadSnapshots() {
        try {
            if (!fs.existsSync(SNAPSHOT_BASE_DIR)) return;
            const entries = fs.readdirSync(SNAPSHOT_BASE_DIR, { withFileTypes: true });
            this._snapshots = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const metaPath = path.join(SNAPSHOT_BASE_DIR, entry.name, 'meta.json');
                if (!fs.existsSync(metaPath)) continue;
                try {
                    const data = fs.readFileSync(metaPath, 'utf-8');
                    const meta = JSON.parse(data);
                    this._snapshots.push(meta);
                } catch (e) {}
            }
            this._snapshots.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        } catch (e) {
            this._snapshots = [];
        }
    }

    _generateId() {
        return crypto.randomUUID();
    }

    _getSnapshotDir(id) {
        return path.join(SNAPSHOT_BASE_DIR, id);
    }

    _readJsonFile(filePath) {
        try {
            if (!fs.existsSync(filePath)) return null;
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }

    _writeJsonFile(filePath, data) {
        try {
            const dir = path.dirname(filePath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {}
    }

    _backupFile(filePath, snapshotDir) {
        try {
            if (!fs.existsSync(filePath)) return null;
            const content = fs.readFileSync(filePath, 'utf-8');
            const relativePath = filePath.replace(/[:\\\/]/g, '_');
            const backupPath = path.join(snapshotDir, 'files', relativePath);
            fs.mkdirSync(path.dirname(backupPath), { recursive: true });
            fs.writeFileSync(backupPath, content, 'utf-8');
            return { originalPath: filePath, backupPath, timestamp: Date.now() };
        } catch (e) {
            return null;
        }
    }

    _restoreFile(backupInfo) {
        try {
            if (!backupInfo || !fs.existsSync(backupInfo.backupPath)) return false;
            const content = fs.readFileSync(backupInfo.backupPath, 'utf-8');
            const dir = path.dirname(backupInfo.originalPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(backupInfo.originalPath, content, 'utf-8');
            return true;
        } catch (e) {
            return false;
        }
    }

    _enforceLimit() {
        if (this._snapshots.length <= MAX_SNAPSHOTS) return;
        const sorted = [...this._snapshots].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const toDelete = sorted.slice(0, this._snapshots.length - MAX_SNAPSHOTS);
        for (const meta of toDelete) {
            this._deleteSnapshotDir(meta.id);
        }
        this._snapshots = this._snapshots.filter(s => !toDelete.find(d => d.id === s.id));
    }

    _deleteSnapshotDir(id) {
        try {
            const dir = this._getSnapshotDir(id);
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        } catch (e) {}
    }

    createSnapshot(label) {
        try {
            const id = this._generateId();
            const snapshotDir = this._getSnapshotDir(id);
            fs.mkdirSync(snapshotDir, { recursive: true });

            const meta = {
                id,
                timestamp: Date.now(),
                label: label || '',
                messageCount: 0,
                changeCount: 0,
                toolCallCount: 0
            };

            this._writeJsonFile(path.join(snapshotDir, 'meta.json'), meta);
            this._writeJsonFile(path.join(snapshotDir, 'messages.json'), []);
            this._writeJsonFile(path.join(snapshotDir, 'changes.json'), []);
            this._writeJsonFile(path.join(snapshotDir, 'toolcalls.json'), []);

            this._snapshots.push(meta);
            this._enforceLimit();

            return { id, snapshotDir };
        } catch (e) {
            return null;
        }
    }

    listSnapshots() {
        try {
            return this._snapshots.map(s => ({
                id: s.id,
                timestamp: s.timestamp,
                label: s.label,
                messageCount: s.messageCount,
                changeCount: s.changeCount,
                toolCallCount: s.toolCallCount
            }));
        } catch (e) {
            return [];
        }
    }

    restoreSnapshot(snapshotId) {
        try {
            const snapshotDir = this._getSnapshotDir(snapshotId);
            if (!fs.existsSync(snapshotDir)) return { success: false, error: 'Snapshot not found' };

            const meta = this._readJsonFile(path.join(snapshotDir, 'meta.json'));
            const messages = this._readJsonFile(path.join(snapshotDir, 'messages.json'));
            const changes = this._readJsonFile(path.join(snapshotDir, 'changes.json'));

            if (Array.isArray(changes)) {
                for (const change of changes) {
                    if (change.backupPath && change.originalPath) {
                        this._restoreFile(change);
                    }
                }
            }

            return {
                success: true,
                messages: messages || [],
                changes: changes || [],
                meta: meta || {}
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    getSnapshotDiff(snapshotId) {
        try {
            const snapshotDir = this._getSnapshotDir(snapshotId);
            if (!fs.existsSync(snapshotDir)) return { exists: false };

            const meta = this._readJsonFile(path.join(snapshotDir, 'meta.json'));
            const messages = this._readJsonFile(path.join(snapshotDir, 'messages.json')) || [];
            const changes = this._readJsonFile(path.join(snapshotDir, 'changes.json')) || [];
            const toolcalls = this._readJsonFile(path.join(snapshotDir, 'toolcalls.json')) || [];

            const fileDiffs = [];
            if (Array.isArray(changes)) {
                for (const change of changes) {
                    if (!change.originalPath) continue;
                    let currentContent = null;
                    try {
                        if (fs.existsSync(change.originalPath)) {
                            currentContent = fs.readFileSync(change.originalPath, 'utf-8');
                        }
                    } catch (e) {}
                    let snapshotContent = null;
                    if (change.backupPath && fs.existsSync(change.backupPath)) {
                        try {
                            snapshotContent = fs.readFileSync(change.backupPath, 'utf-8');
                        } catch (e) {}
                    }
                    fileDiffs.push({
                        path: change.originalPath,
                        hasChanged: currentContent !== snapshotContent,
                        snapshotTime: change.timestamp
                    });
                }
            }

            return {
                exists: true,
                meta: meta || {},
                messageCount: messages.length,
                changeCount: changes.length,
                toolCallCount: toolcalls.length,
                fileDiffs
            };
        } catch (e) {
            return { exists: false, error: e.message };
        }
    }

    deleteSnapshot(snapshotId) {
        try {
            const index = this._snapshots.findIndex(s => s.id === snapshotId);
            if (index === -1) return false;
            this._deleteSnapshotDir(snapshotId);
            this._snapshots.splice(index, 1);
            return true;
        } catch (e) {
            return false;
        }
    }

    autoSnapshot(toolName, toolArgs) {
        try {
            const result = this.createSnapshot(`auto_${toolName || 'unknown'}_${Date.now()}`);
            if (!result) return null;
            const snapshotDir = result.snapshotDir;
            const toolcallsPath = path.join(snapshotDir, 'toolcalls.json');
            const toolcalls = [toolName, toolArgs];
            this._writeJsonFile(toolcallsPath, toolcalls);
            return result.id;
        } catch (e) {
            return null;
        }
    }

    updateSnapshotMessages(snapshotId, messages) {
        try {
            const snapshotDir = this._getSnapshotDir(snapshotId);
            if (!fs.existsSync(snapshotDir)) return false;
            this._writeJsonFile(path.join(snapshotDir, 'messages.json'), messages || []);
            const metaPath = path.join(snapshotDir, 'meta.json');
            const meta = this._readJsonFile(metaPath) || {};
            meta.messageCount = Array.isArray(messages) ? messages.length : 0;
            this._writeJsonFile(metaPath, meta);
            const idx = this._snapshots.findIndex(s => s.id === snapshotId);
            if (idx !== -1) this._snapshots[idx].messageCount = meta.messageCount;
            return true;
        } catch (e) {
            return false;
        }
    }

    updateSnapshotChanges(snapshotId, filePath, backupInfo) {
        try {
            const snapshotDir = this._getSnapshotDir(snapshotId);
            if (!fs.existsSync(snapshotDir)) return false;
            const changesPath = path.join(snapshotDir, 'changes.json');
            const changes = this._readJsonFile(changesPath) || [];
            changes.push({
                originalPath: filePath,
                backupPath: backupInfo ? backupInfo.backupPath : null,
                timestamp: Date.now()
            });
            this._writeJsonFile(changesPath, changes);
            const metaPath = path.join(snapshotDir, 'meta.json');
            const meta = this._readJsonFile(metaPath) || {};
            meta.changeCount = changes.length;
            this._writeJsonFile(metaPath, meta);
            const idx = this._snapshots.findIndex(s => s.id === snapshotId);
            if (idx !== -1) this._snapshots[idx].changeCount = meta.changeCount;
            return true;
        } catch (e) {
            return false;
        }
    }

    backupFileForSnapshot(snapshotId, filePath) {
        try {
            const snapshotDir = this._getSnapshotDir(snapshotId);
            if (!fs.existsSync(snapshotDir)) return null;
            return this._backupFile(filePath, snapshotDir);
        } catch (e) {
            return null;
        }
    }

    restoreSingleFile(snapshotId, filePath) {
        try {
            const snapshotDir = this._getSnapshotDir(snapshotId);
            if (!fs.existsSync(snapshotDir)) return false;
            const changesPath = path.join(snapshotDir, 'changes.json');
            const changes = this._readJsonFile(changesPath) || [];
            const change = changes.find(c => c.originalPath === filePath);
            if (!change || !change.backupPath) return false;
            return this._restoreFile(change);
        } catch (e) {
            return false;
        }
    }

    clearAll() {
        try {
            for (const meta of this._snapshots) {
                this._deleteSnapshotDir(meta.id);
            }
            this._snapshots = [];
            return true;
        } catch (e) {
            return false;
        }
    }
}

const instance = new SnapshotManager();

module.exports = { SnapshotManager, snapshotManager: instance };
