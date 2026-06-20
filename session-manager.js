const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SESSION_BASE_DIR = path.join(os.homedir(), '.versepc', 'sessions');
const MAX_ACTIVE_SESSIONS = 100;
const SESSIONS_INDEX_FILE = path.join(SESSION_BASE_DIR, 'index.json');

class SessionManager {
    constructor() {
        this._sessions = new Map();
        this._ensureDir();
        this._loadSessionsIndex();
    }

    _ensureDir() {
        try {
            fs.mkdirSync(SESSION_BASE_DIR, { recursive: true });
        } catch (e) {}
    }

    _loadSessionsIndex() {
        try {
            if (!fs.existsSync(SESSIONS_INDEX_FILE)) return;
            const data = fs.readFileSync(SESSIONS_INDEX_FILE, 'utf-8');
            const index = JSON.parse(data);
            if (!Array.isArray(index)) return;
            for (const entry of index) {
                this._sessions.set(entry.id, entry);
            }
        } catch (e) {
            this._sessions = new Map();
        }
    }

    _saveSessionsIndex() {
        try {
            const index = Array.from(this._sessions.values()).map(s => ({
                id: s.id,
                userId: s.userId,
                title: s.title,
                status: s.status,
                created_at: s.created_at,
                updated_at: s.updated_at,
                messageCount: s.metadata.messageCount
            }));
            fs.writeFileSync(SESSIONS_INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
        } catch (e) {}
    }

    _getSessionFilePath(sessionId) {
        return path.join(SESSION_BASE_DIR, `${sessionId}.json`);
    }

    _loadSessionFromFile(sessionId) {
        try {
            const filePath = this._getSessionFilePath(sessionId);
            if (!fs.existsSync(filePath)) return null;
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }

    _saveSessionToFile(session) {
        try {
            const filePath = this._getSessionFilePath(session.id);
            fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
        } catch (e) {}
    }

    _generateId() {
        return crypto.randomUUID();
    }

    _enforceSessionLimit() {
        try {
            const activeSessions = Array.from(this._sessions.values())
                .filter(s => s.status === 'active')
                .sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at));

            while (activeSessions.length >= MAX_ACTIVE_SESSIONS) {
                const oldest = activeSessions.shift();
                if (oldest) {
                    oldest.status = 'archived';
                    oldest.updated_at = new Date().toISOString();
                    this._sessions.set(oldest.id, oldest);
                    this._saveSessionToFile(oldest);
                }
            }
        } catch (e) {}
    }

    _generateTitle(messages) {
        try {
            if (!messages || messages.length === 0) return '新会话';
            const firstUserMessage = messages.find(m => m.role === 'user');
            if (firstUserMessage && firstUserMessage.content) {
                return firstUserMessage.content.slice(0, 50) + (firstUserMessage.content.length > 50 ? '...' : '');
            }
            return `会话 ${new Date().toLocaleString('zh-CN')}`;
        } catch (e) {
            return '新会话';
        }
    }

    createSession(userId) {
        try {
            this._enforceSessionLimit();

            const id = this._generateId();
            const now = new Date().toISOString();

            const session = {
                id,
                userId: userId || 'default',
                title: '新会话',
                status: 'active',
                created_at: now,
                updated_at: now,
                context: {
                    currentTask: null,
                    workingDirectory: null,
                    activeModel: null,
                    preferences: {}
                },
                messages: [],
                metadata: {
                    messageCount: 0,
                    totalTokens: 0,
                    tools_used: []
                }
            };

            this._sessions.set(id, session);
            this._saveSessionToFile(session);
            this._saveSessionsIndex();

            return { id, session };
        } catch (e) {
            return null;
        }
    }

    loadSession(sessionId) {
        try {
            let session = this._sessions.get(sessionId);
            if (!session) {
                session = this._loadSessionFromFile(sessionId);
                if (session) {
                    this._sessions.set(sessionId, session);
                }
            }
            return session || null;
        } catch (e) {
            return null;
        }
    }

    saveSession(sessionId) {
        try {
            const session = this._sessions.get(sessionId);
            if (!session) return false;
            session.updated_at = new Date().toISOString();
            this._saveSessionToFile(session);
            this._saveSessionsIndex();
            return true;
        } catch (e) {
            return false;
        }
    }

    listSessions(userId) {
        try {
            let sessions = Array.from(this._sessions.values());
            if (userId) {
                sessions = sessions.filter(s => s.userId === userId);
            }
            return sessions
                .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
                .map(s => ({
                    id: s.id,
                    userId: s.userId,
                    title: s.title,
                    status: s.status,
                    created_at: s.created_at,
                    updated_at: s.updated_at,
                    messageCount: s.metadata.messageCount
                }));
        } catch (e) {
            return [];
        }
    }

    deleteSession(sessionId) {
        try {
            const session = this._sessions.get(sessionId);
            if (!session) return false;

            this._sessions.delete(sessionId);

            try {
                const filePath = this._getSessionFilePath(sessionId);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (e) {}

            this._saveSessionsIndex();
            return true;
        } catch (e) {
            return false;
        }
    }

    updateSessionContext(sessionId, context) {
        try {
            const session = this._sessions.get(sessionId);
            if (!session) return false;

            session.context = {
                ...session.context,
                ...context
            };
            session.updated_at = new Date().toISOString();

            this._saveSessionToFile(session);
            this._saveSessionsIndex();
            return true;
        } catch (e) {
            return false;
        }
    }

    getSessionContext(sessionId) {
        try {
            const session = this._sessions.get(sessionId);
            if (!session) return null;
            return session.context || null;
        } catch (e) {
            return null;
        }
    }

    addMessage(sessionId, message) {
        try {
            const session = this._sessions.get(sessionId);
            if (!session) return false;

            const msg = {
                id: this._generateId(),
                role: message.role || 'user',
                content: message.content || '',
                timestamp: new Date().toISOString(),
                metadata: message.metadata || {}
            };

            session.messages.push(msg);
            session.metadata.messageCount = session.messages.length;
            session.updated_at = new Date().toISOString();

            if (session.messages.length === 1 || session.title === '新会话') {
                session.title = this._generateTitle(session.messages);
            }

            this._saveSessionToFile(session);
            this._saveSessionsIndex();
            return msg;
        } catch (e) {
            return null;
        }
    }

    getMessages(sessionId, limit) {
        try {
            const session = this._sessions.get(sessionId);
            if (!session) return [];

            const messages = session.messages || [];
            if (limit && limit > 0) {
                return messages.slice(-limit);
            }
            return messages;
        } catch (e) {
            return [];
        }
    }

    archiveSession(sessionId) {
        try {
            const session = this._sessions.get(sessionId);
            if (!session) return false;

            session.status = 'archived';
            session.updated_at = new Date().toISOString();

            this._saveSessionToFile(session);
            this._saveSessionsIndex();
            return true;
        } catch (e) {
            return false;
        }
    }

    restoreSession(sessionId) {
        try {
            const session = this._sessions.get(sessionId);
            if (!session) return false;

            this._enforceSessionLimit();

            session.status = 'active';
            session.updated_at = new Date().toISOString();

            this._saveSessionToFile(session);
            this._saveSessionsIndex();
            return true;
        } catch (e) {
            return false;
        }
    }
}

const sessionManager = new SessionManager();

module.exports = {
    SessionManager,
    sessionManager
};