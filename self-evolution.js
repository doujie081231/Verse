const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EVOLUTION_BASE_DIR = path.join(os.homedir(), '.versepc', 'evolution');
const LESSONS_FILE = path.join(EVOLUTION_BASE_DIR, 'lessons.json');
const TASKS_FILE = path.join(EVOLUTION_BASE_DIR, 'tasks.json');
const STATS_FILE = path.join(EVOLUTION_BASE_DIR, 'stats.json');

const MAX_LESSONS = 500;
const MAX_TASKS = 200;
const CONFIDENCE_DECAY = 0.02;
const CONFIDENCE_BOOST = 0.1;

const SUCCESS_KEYWORDS = [
    '成功', '完成', '解决了', '修复', '搞定', '好了', '可以了',
    'success', 'fixed', 'done', 'resolved', 'working', 'completed'
];

const FAILURE_KEYWORDS = [
    '失败', '报错', '不行', '出错', '问题', '异常', '崩了',
    'error', 'failed', 'broken', 'crash', 'issue', 'bug', 'wrong'
];

const TOPIC_PATTERNS = {
    mod_installation: ['模组', 'mod', 'forge', 'fabric', 'neoforge', '安装模组', 'install mod'],
    mod_conflict: ['模组冲突', 'mod conflict', '不兼容', 'incompatible'],
    java_config: ['java', 'jdk', 'jvm', 'java版本', 'java version'],
    game_crash: ['崩溃', 'crash', '闪退', '游戏崩溃', 'game crash'],
    performance: ['性能', 'fps', '卡顿', 'lag', 'performance', '优化'],
    download: ['下载', 'download', '网络', 'network'],
    version: ['版本', 'version', '更新', 'update'],
    skin: ['皮肤', 'skin', '材质', 'texture'],
    world: ['世界', 'world', '存档', '地图', 'map'],
    server: ['服务器', 'server', '联机', '多人'],
    config: ['配置', 'config', '设置', 'settings'],
    shader: ['光影', 'shader', 'optifine']
};

class SelfEvolution {
    constructor() {
        this._lessons = [];
        this._tasks = [];
        this._stats = {
            totalReviews: 0,
            totalLessons: 0,
            totalTasks: 0,
            completedTasks: 0,
            failedTasks: 0,
            evolutionRuns: 0,
            lastEvolution: null,
            createdAt: new Date().toISOString()
        };
        this._ensureDir();
        this._loadLessons();
        this._loadTasks();
        this._loadStats();
    }

    _ensureDir() {
        try {
            fs.mkdirSync(EVOLUTION_BASE_DIR, { recursive: true });
        } catch (e) {}
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
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {}
    }

    _loadLessons() {
        try {
            const data = this._readJsonFile(LESSONS_FILE);
            if (Array.isArray(data)) {
                this._lessons = data;
            }
        } catch (e) {
            this._lessons = [];
        }
    }

    _saveLessons() {
        try {
            if (this._lessons.length > MAX_LESSONS) {
                this._lessons = this._lessons
                    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
                    .slice(0, MAX_LESSONS);
            }
            this._writeJsonFile(LESSONS_FILE, this._lessons);
        } catch (e) {}
    }

    _loadTasks() {
        try {
            const data = this._readJsonFile(TASKS_FILE);
            if (Array.isArray(data)) {
                this._tasks = data;
            }
        } catch (e) {
            this._tasks = [];
        }
    }

    _saveTasks() {
        try {
            if (this._tasks.length > MAX_TASKS) {
                this._tasks = this._tasks
                    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))
                    .slice(0, MAX_TASKS);
            }
            this._writeJsonFile(TASKS_FILE, this._tasks);
        } catch (e) {}
    }

    _loadStats() {
        try {
            const data = this._readJsonFile(STATS_FILE);
            if (data && typeof data === 'object') {
                this._stats = { ...this._stats, ...data };
            }
        } catch (e) {}
    }

    _saveStats() {
        try {
            this._writeJsonFile(STATS_FILE, this._stats);
        } catch (e) {}
    }

    _generateId() {
        return crypto.randomUUID();
    }

    _detectTopic(text) {
        if (!text || typeof text !== 'string') return 'general';
        const lower = text.toLowerCase();
        for (const [topic, keywords] of Object.entries(TOPIC_PATTERNS)) {
            for (const kw of keywords) {
                if (lower.includes(kw)) return topic;
            }
        }
        return 'general';
    }

    _isSuccessMessage(text) {
        if (!text || typeof text !== 'string') return false;
        const lower = text.toLowerCase();
        return SUCCESS_KEYWORDS.some(kw => lower.includes(kw));
    }

    _isFailureMessage(text) {
        if (!text || typeof text !== 'string') return false;
        const lower = text.toLowerCase();
        return FAILURE_KEYWORDS.some(kw => lower.includes(kw));
    }

    _extractKeyPhrase(text) {
        if (!text || typeof text !== 'string') return '';
        const cleaned = text.replace(/\s+/g, ' ').trim();
        if (cleaned.length <= 100) return cleaned;
        return cleaned.slice(0, 100) + '...';
    }

    _findDuplicateLesson(topic, lessonText) {
        return this._lessons.findIndex(l => {
            if (l.topic !== topic) return false;
            const a = (l.lesson || '').toLowerCase();
            const b = (lessonText || '').toLowerCase();
            if (a === b) return true;
            if (a.includes(b) || b.includes(a)) return true;
            return false;
        });
    }

    _updateConfidence(lessonId, boost) {
        const idx = this._lessons.findIndex(l => l.id === lessonId);
        if (idx < 0) return;
        const lesson = this._lessons[idx];
        lesson.confidence = Math.min(1, Math.max(0, (lesson.confidence || 0.5) + boost));
        lesson.times_applied = (lesson.times_applied || 0) + 1;
        this._lessons[idx] = lesson;
    }

    _decayConfidence() {
        for (let i = 0; i < this._lessons.length; i++) {
            const lesson = this._lessons[i];
            const lastUsed = lesson.last_used || lesson.created_at;
            const daysSinceUse = (Date.now() - new Date(lastUsed).getTime()) / (1000 * 60 * 60 * 24);
            if (daysSinceUse > 7) {
                lesson.confidence = Math.max(0.1, (lesson.confidence || 0.5) - CONFIDENCE_DECAY);
            }
        }
    }

    _analyzeConversation(messages) {
        const results = {
            successes: [],
            failures: [],
            topics: new Set(),
            lessons: []
        };

        if (!Array.isArray(messages) || messages.length === 0) return results;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (!msg || !msg.content) continue;

            const topic = this._detectTopic(msg.content);
            results.topics.add(topic);

            if (msg.role === 'user' && this._isFailureMessage(msg.content)) {
                const context = i > 0 ? messages[i - 1]?.content || '' : '';
                results.failures.push({
                    topic,
                    content: this._extractKeyPhrase(msg.content),
                    context: this._extractKeyPhrase(context)
                });
            }

            if (msg.role === 'assistant' && this._isSuccessMessage(msg.content)) {
                const userContext = i > 0 ? messages[i - 1]?.content || '' : '';
                results.successes.push({
                    topic,
                    content: this._extractKeyPhrase(msg.content),
                    userQuestion: this._extractKeyPhrase(userContext)
                });
            }
        }

        for (const failure of results.failures) {
            results.lessons.push({
                topic: failure.topic,
                lesson: `遇到问题: ${failure.content}`,
                context: failure.context || undefined,
                confidence: 0.6
            });
        }

        for (const success of results.successes) {
            if (success.userQuestion) {
                results.lessons.push({
                    topic: success.topic,
                    lesson: `成功解决: ${success.userQuestion}`,
                    context: success.content || undefined,
                    confidence: 0.7
                });
            }
        }

        return results;
    }

    reviewConversation(messages) {
        try {
            if (!Array.isArray(messages) || messages.length === 0) {
                return { reviewed: false, reason: 'empty_messages' };
            }

            const analysis = this._analyzeConversation(messages);
            const added = [];

            for (const lessonData of analysis.lessons) {
                const existing = this._findDuplicateLesson(lessonData.topic, lessonData.lesson);
                if (existing >= 0) {
                    this._updateConfidence(this._lessons[existing].id, CONFIDENCE_BOOST);
                    this._lessons[existing].last_used = new Date().toISOString();
                    added.push({ id: this._lessons[existing].id, action: 'updated' });
                } else {
                    const newLesson = {
                        id: this._generateId(),
                        topic: lessonData.topic,
                        lesson: lessonData.lesson,
                        context: lessonData.context || null,
                        confidence: lessonData.confidence || 0.5,
                        times_applied: 1,
                        last_used: new Date().toISOString(),
                        created_at: new Date().toISOString()
                    };
                    this._lessons.push(newLesson);
                    added.push({ id: newLesson.id, action: 'created' });
                }
            }

            this._stats.totalReviews = (this._stats.totalReviews || 0) + 1;
            this._saveLessons();
            this._saveStats();

            return {
                reviewed: true,
                messageCount: messages.length,
                topics: Array.from(analysis.topics),
                successCount: analysis.successes.length,
                failureCount: analysis.failures.length,
                lessonsAdded: added
            };
        } catch (e) {
            return { reviewed: false, error: e.message };
        }
    }

    addLesson(topic, lesson, context) {
        try {
            if (!topic || !lesson) return null;

            const existing = this._findDuplicateLesson(topic, lesson);
            if (existing >= 0) {
                this._updateConfidence(this._lessons[existing].id, CONFIDENCE_BOOST);
                this._lessons[existing].last_used = new Date().toISOString();
                this._saveLessons();
                return this._lessons[existing];
            }

            const entry = {
                id: this._generateId(),
                topic,
                lesson,
                context: context || null,
                confidence: 0.5,
                times_applied: 1,
                last_used: new Date().toISOString(),
                created_at: new Date().toISOString()
            };

            this._lessons.push(entry);
            this._stats.totalLessons = (this._stats.totalLessons || 0) + 1;
            this._saveLessons();
            this._saveStats();

            return entry;
        } catch (e) {
            return null;
        }
    }

    getLessons(topic) {
        try {
            if (topic) {
                return this._lessons
                    .filter(l => l.topic === topic)
                    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
            }
            return [...this._lessons].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
        } catch (e) {
            return [];
        }
    }

    suggestImprovement(taskType) {
        try {
            if (!taskType) return { suggestions: [], taskType: null };

            const relatedLessons = this._lessons
                .filter(l => l.topic === taskType || l.topic === 'general')
                .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
                .slice(0, 10);

            const failedTasks = this._tasks
                .filter(t => t.status === 'failed' && this._detectTopic(t.description || '') === taskType)
                .slice(0, 5);

            const suggestions = [];

            for (const lesson of relatedLessons) {
                suggestions.push({
                    type: 'lesson',
                    lesson: lesson.lesson,
                    confidence: lesson.confidence,
                    topic: lesson.topic,
                    context: lesson.context
                });
            }

            for (const task of failedTasks) {
                suggestions.push({
                    type: 'past_failure',
                    description: task.description,
                    details: task.details,
                    failedAt: task.updated_at
                });
            }

            return {
                taskType,
                suggestionCount: suggestions.length,
                suggestions
            };
        } catch (e) {
            return { suggestions: [], error: e.message };
        }
    }

    trackTask(taskId, status, details) {
        try {
            if (!taskId || !status) return null;

            const validStatuses = ['pending', 'in_progress', 'completed', 'failed'];
            if (!validStatuses.includes(status)) return null;

            const existingIdx = this._tasks.findIndex(t => t.id === taskId);

            if (existingIdx >= 0) {
                const task = this._tasks[existingIdx];
                task.status = status;
                task.updated_at = new Date().toISOString();
                if (details) {
                    task.details = { ...(task.details || {}), ...details };
                }
                this._tasks[existingIdx] = task;

                if (status === 'completed') {
                    this._stats.completedTasks = (this._stats.completedTasks || 0) + 1;
                } else if (status === 'failed') {
                    this._stats.failedTasks = (this._stats.failedTasks || 0) + 1;
                }

                this._saveTasks();
                this._saveStats();
                return task;
            }

            const task = {
                id: taskId,
                description: details?.description || taskId,
                status,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                details: details || {}
            };

            this._tasks.push(task);
            this._stats.totalTasks = (this._stats.totalTasks || 0) + 1;

            if (status === 'completed') {
                this._stats.completedTasks = (this._stats.completedTasks || 0) + 1;
            } else if (status === 'failed') {
                this._stats.failedTasks = (this._stats.failedTasks || 0) + 1;
            }

            this._saveTasks();
            this._saveStats();

            return task;
        } catch (e) {
            return null;
        }
    }

    getPendingTasks() {
        try {
            return this._tasks
                .filter(t => t.status === 'pending' || t.status === 'in_progress')
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        } catch (e) {
            return [];
        }
    }

    evolve() {
        try {
            this._decayConfidence();

            const topicStats = {};
            for (const lesson of this._lessons) {
                const topic = lesson.topic || 'general';
                if (!topicStats[topic]) {
                    topicStats[topic] = { count: 0, avgConfidence: 0, totalConfidence: 0 };
                }
                topicStats[topic].count++;
                topicStats[topic].totalConfidence += lesson.confidence || 0;
            }
            for (const topic of Object.keys(topicStats)) {
                const stat = topicStats[topic];
                stat.avgConfidence = stat.count > 0 ? stat.totalConfidence / stat.count : 0;
            }

            const lowConfidenceLessons = this._lessons
                .filter(l => (l.confidence || 0) < 0.3)
                .map(l => l.id);

            const removed = [];
            for (const id of lowConfidenceLessons) {
                const idx = this._lessons.findIndex(l => l.id === id);
                if (idx >= 0) {
                    const lesson = this._lessons[idx];
                    const created = new Date(lesson.created_at).getTime();
                    const daysSinceCreation = (Date.now() - created) / (1000 * 60 * 60 * 24);
                    if (daysSinceCreation > 30 && (lesson.times_applied || 0) <= 1) {
                        this._lessons.splice(idx, 1);
                        removed.push(id);
                    }
                }
            }

            this._stats.evolutionRuns = (this._stats.evolutionRuns || 0) + 1;
            this._stats.lastEvolution = new Date().toISOString();
            this._stats.totalLessons = this._lessons.length;
            this._saveLessons();
            this._saveStats();

            return {
                success: true,
                run: this._stats.evolutionRuns,
                topicStats,
                removedLowConfidence: removed.length,
                totalLessons: this._lessons.length,
                totalTasks: this._tasks.length,
                timestamp: this._stats.lastEvolution
            };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    getStats() {
        try {
            const topicDistribution = {};
            for (const lesson of this._lessons) {
                const topic = lesson.topic || 'general';
                topicDistribution[topic] = (topicDistribution[topic] || 0) + 1;
            }

            const pendingTasks = this._tasks.filter(t => t.status === 'pending' || t.status === 'in_progress').length;
            const completedTasks = this._tasks.filter(t => t.status === 'completed').length;
            const failedTasks = this._tasks.filter(t => t.status === 'failed').length;

            const avgConfidence = this._lessons.length > 0
                ? this._lessons.reduce((sum, l) => sum + (l.confidence || 0), 0) / this._lessons.length
                : 0;

            return {
                lessons: {
                    total: this._lessons.length,
                    avgConfidence: Math.round(avgConfidence * 100) / 100,
                    topicDistribution
                },
                tasks: {
                    total: this._tasks.length,
                    pending: pendingTasks,
                    completed: completedTasks,
                    failed: failedTasks
                },
                evolution: {
                    runs: this._stats.evolutionRuns || 0,
                    totalReviews: this._stats.totalReviews || 0,
                    lastEvolution: this._stats.lastEvolution,
                    createdAt: this._stats.createdAt
                }
            };
        } catch (e) {
            return { error: e.message };
        }
    }
}

const instance = new SelfEvolution();

module.exports = { SelfEvolution, instance };
