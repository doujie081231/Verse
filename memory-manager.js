const fs = require('fs');
const path = require('path');
const os = require('os');

const MEMORY_BASE_DIR = path.join(os.homedir(), '.versepc', 'memory');
const DAILY_DIR = path.join(MEMORY_BASE_DIR, 'daily');
const CORE_DIR = path.join(MEMORY_BASE_DIR, 'core');
const CORE_MEMORIES_FILE = path.join(CORE_DIR, 'memories.json');
const CORE_INDEX_FILE = path.join(CORE_DIR, 'index.json');

const DAILY_DISTILL_THRESHOLD = 10;
const MAX_CONTEXT_LENGTH = 200;
const MAX_DAILY_ENTRIES = 500;
const MAX_CORE_ENTRIES = 1000;

class MemoryManager {
    constructor() {
        this._context = [];
        this._coreMemories = [];
        this._coreIndex = [];
        this._ensureDirs();
        this._loadCoreMemories();
        this._loadCoreIndex();
    }

    _ensureDirs() {
        try {
            fs.mkdirSync(DAILY_DIR, { recursive: true });
        } catch (e) {}
        try {
            fs.mkdirSync(CORE_DIR, { recursive: true });
        } catch (e) {}
    }

    _loadCoreMemories() {
        try {
            if (fs.existsSync(CORE_MEMORIES_FILE)) {
                const data = fs.readFileSync(CORE_MEMORIES_FILE, 'utf-8');
                this._coreMemories = JSON.parse(data);
                if (!Array.isArray(this._coreMemories)) this._coreMemories = [];
            }
        } catch (e) {
            this._coreMemories = [];
        }
    }

    _loadCoreIndex() {
        try {
            if (fs.existsSync(CORE_INDEX_FILE)) {
                const data = fs.readFileSync(CORE_INDEX_FILE, 'utf-8');
                this._coreIndex = JSON.parse(data);
                if (!Array.isArray(this._coreIndex)) this._coreIndex = [];
            }
        } catch (e) {
            this._coreIndex = [];
        }
    }

    _saveCoreMemories() {
        try {
            fs.writeFileSync(CORE_MEMORIES_FILE, JSON.stringify(this._coreMemories, null, 2), 'utf-8');
        } catch (e) {}
    }

    _saveCoreIndex() {
        try {
            fs.writeFileSync(CORE_INDEX_FILE, JSON.stringify(this._coreIndex, null, 2), 'utf-8');
        } catch (e) {}
    }

    _getDailyFilePath(date) {
        const d = date || new Date().toISOString().slice(0, 10);
        return path.join(DAILY_DIR, `${d}.json`);
    }

    _loadDailyMemories(date) {
        const filePath = this._getDailyFilePath(date);
        try {
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf-8');
                const parsed = JSON.parse(data);
                return Array.isArray(parsed) ? parsed : [];
            }
        } catch (e) {}
        return [];
    }

    _saveDailyMemories(memories, date) {
        const filePath = this._getDailyFilePath(date);
        try {
            fs.writeFileSync(filePath, JSON.stringify(memories, null, 2), 'utf-8');
        } catch (e) {}
    }

    _tokenize(text) {
        if (!text || typeof text !== 'string') return [];
        return text
            .toLowerCase()
            .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 0);
    }

    _computeTF(tokens) {
        const tf = {};
        for (const token of tokens) {
            tf[token] = (tf[token] || 0) + 1;
        }
        const len = tokens.length || 1;
        for (const key in tf) {
            tf[key] = tf[key] / len;
        }
        return tf;
    }

    _computeIDF(documents) {
        const idf = {};
        const N = documents.length || 1;
        const docFreq = {};
        for (const doc of documents) {
            const tokens = new Set(this._tokenize(doc));
            for (const token of tokens) {
                docFreq[token] = (docFreq[token] || 0) + 1;
            }
        }
        for (const term in docFreq) {
            idf[term] = Math.log((N + 1) / (docFreq[term] + 1)) + 1;
        }
        return idf;
    }

    _cosineSimilarity(vecA, vecB) {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        const allKeys = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
        for (const key of allKeys) {
            const a = vecA[key] || 0;
            const b = vecB[key] || 0;
            dot += a * b;
            normA += a * a;
            normB += b * b;
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    _buildTFIDFVector(text, idf) {
        const tokens = this._tokenize(text);
        const tf = this._computeTF(tokens);
        const vector = {};
        for (const term in tf) {
            vector[term] = tf[term] * (idf[term] || 1);
        }
        return vector;
    }

    _extractKeywords(text) {
        if (!text || typeof text !== 'string') return [];
        const stopWords = new Set([
            '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一',
            '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有',
            '看', '好', '自己', '这', '他', '她', '它', '们', '那', '些', '什么', '怎么',
            'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
            'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
            'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
            'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
            'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'each',
            'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
            'than', 'too', 'very', 'just', 'about', 'also', 'then', 'there', 'here',
            'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom', 'this',
            'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
            'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their'
        ]);
        const tokens = this._tokenize(text);
        const freq = {};
        for (const token of tokens) {
            if (stopWords.has(token) || token.length < 2) continue;
            freq[token] = (freq[token] || 0) + 1;
        }
        return Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([word]) => word);
    }

    _buildIndexEntry(memory) {
        const content = memory.content || memory.summary || '';
        const keywords = this._extractKeywords(content);
        return {
            id: memory.id,
            category: memory.category || 'general',
            keywords,
            timestamp: memory.timestamp || Date.now(),
            preview: content.slice(0, 100)
        };
    }

    addToContext(role, content) {
        const entry = {
            role,
            content,
            timestamp: Date.now()
        };
        this._context.push(entry);
        if (this._context.length > MAX_CONTEXT_LENGTH) {
            this._context = this._context.slice(-MAX_CONTEXT_LENGTH);
        }
        return entry;
    }

    getContext() {
        return [...this._context];
    }

    clearContext() {
        const snapshot = [...this._context];
        this._context = [];
        return snapshot;
    }

    summarizeDaily(date) {
        const targetDate = date || new Date().toISOString().slice(0, 10);
        if (this._context.length === 0) return null;

        const existing = this._loadDailyMemories(targetDate);

        const userMessages = this._context.filter(e => e.role === 'user');
        const assistantMessages = this._context.filter(e => e.role === 'assistant');

        const allContent = this._context.map(e => `[${e.role}] ${e.content}`).join('\n');
        const keywords = this._extractKeywords(allContent);

        const summary = {
            id: `daily-${targetDate}-${Date.now()}`,
            date: targetDate,
            timestamp: Date.now(),
            messageCount: this._context.length,
            userMessageCount: userMessages.length,
            assistantMessageCount: assistantMessages.length,
            keywords,
            content: allContent.slice(0, 2000),
            summary: this._generateBriefSummary(this._context)
        };

        existing.push(summary);
        if (existing.length > MAX_DAILY_ENTRIES) {
            const trimmed = existing.slice(-MAX_DAILY_ENTRIES);
            this._saveDailyMemories(trimmed, targetDate);
        } else {
            this._saveDailyMemories(existing, targetDate);
        }

        this._autoDistillCheck(targetDate);

        return summary;
    }

    _generateBriefSummary(context) {
        const topics = [];
        for (const entry of context) {
            if (entry.role === 'user' && entry.content.length > 10) {
                topics.push(entry.content.slice(0, 80));
            }
        }
        if (topics.length === 0) return 'Empty conversation';
        return topics.slice(0, 5).join(' | ');
    }

    _autoDistillCheck(date) {
        const dailyMemories = this._loadDailyMemories(date);
        if (dailyMemories.length >= DAILY_DISTILL_THRESHOLD) {
            this.distillCore(date);
        }
    }

    distillCore(date) {
        const targetDate = date || new Date().toISOString().slice(0, 10);
        const dailyMemories = this._loadDailyMemories(targetDate);

        if (dailyMemories.length === 0) return [];

        const allKeywords = {};
        for (const mem of dailyMemories) {
            const kws = mem.keywords || [];
            for (const kw of kws) {
                allKeywords[kw] = (allKeywords[kw] || 0) + 1;
            }
        }

        const importantKeywords = Object.entries(allKeywords)
            .filter(([, count]) => count >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([word]) => word);

        const allContent = dailyMemories.map(m => m.summary || m.content || '').join('\n');
        const uniqueKeywords = [...new Set([...importantKeywords, ...this._extractKeywords(allContent).slice(0, 5)])];

        const distilled = {
            id: `core-${targetDate}-${Date.now()}`,
            date: targetDate,
            timestamp: Date.now(),
            category: 'daily-distill',
            sourceEntryCount: dailyMemories.length,
            keywords: uniqueKeywords,
            content: allContent.slice(0, 3000),
            summary: this._generateBriefSummary(dailyMemories.map(m => ({
                role: 'user',
                content: m.summary || ''
            })))
        };

        this._coreMemories.push(distilled);
        if (this._coreMemories.length > MAX_CORE_ENTRIES) {
            this._coreMemories = this._coreMemories.slice(-MAX_CORE_ENTRIES);
        }
        this._saveCoreMemories();

        const indexEntry = this._buildIndexEntry(distilled);
        this._coreIndex.push(indexEntry);
        if (this._coreIndex.length > MAX_CORE_ENTRIES) {
            this._coreIndex = this._coreIndex.slice(-MAX_CORE_ENTRIES);
        }
        this._saveCoreIndex();

        return [distilled];
    }

    searchMemory(query) {
        if (!query || typeof query !== 'string') return [];

        const queryKeywords = this._extractKeywords(query);
        const queryTokens = this._tokenize(query);

        const allDocuments = [];

        for (const mem of this._coreMemories) {
            const content = mem.content || mem.summary || '';
            allDocuments.push({
                source: 'core',
                id: mem.id,
                memory: mem,
                content,
                keywords: mem.keywords || []
            });
        }

        for (const mem of this._context) {
            allDocuments.push({
                source: 'context',
                id: `ctx-${mem.timestamp}`,
                memory: mem,
                content: mem.content || '',
                keywords: this._extractKeywords(mem.content || '')
            });
        }

        const today = new Date().toISOString().slice(0, 10);
        const dailyMemories = this._loadDailyMemories(today);
        for (const mem of dailyMemories) {
            const content = mem.content || mem.summary || '';
            allDocuments.push({
                source: 'daily',
                id: mem.id,
                memory: mem,
                content,
                keywords: mem.keywords || []
            });
        }

        if (allDocuments.length === 0) return [];

        const docTexts = allDocuments.map(d => d.content);
        const idf = this._computeIDF(docTexts);
        const queryVector = this._buildTFIDFVector(query, idf);

        const scored = allDocuments.map(doc => {
            let keywordScore = 0;
            for (const qk of queryKeywords) {
                for (const dk of doc.keywords) {
                    if (dk.includes(qk) || qk.includes(dk)) {
                        keywordScore += 1;
                    }
                }
            }
            keywordScore = queryKeywords.length > 0 ? keywordScore / queryKeywords.length : 0;

            const docVector = this._buildTFIDFVector(doc.content, idf);
            const tfidfScore = this._cosineSimilarity(queryVector, docVector);

            const combinedScore = keywordScore * 0.4 + tfidfScore * 0.6;

            return {
                source: doc.source,
                id: doc.id,
                score: combinedScore,
                keywordScore,
                tfidfScore,
                content: doc.content.slice(0, 500),
                memory: doc.memory
            };
        });

        return scored
            .filter(r => r.score > 0.01)
            .sort((a, b) => b.score - a.score)
            .slice(0, 20);
    }

    getCoreMemories() {
        return [...this._coreMemories];
    }

    getDailyMemories(date) {
        const targetDate = date || new Date().toISOString().slice(0, 10);
        return this._loadDailyMemories(targetDate);
    }

    addCoreMemory(content, category) {
        if (!content || typeof content !== 'string') return null;
        const entry = {
            id: `core-manual-${Date.now()}`,
            category: category || 'knowledge',
            timestamp: Date.now(),
            content,
            keywords: this._extractKeywords(content),
            summary: content.slice(0, 200)
        };
        this._coreMemories.push(entry);
        if (this._coreMemories.length > MAX_CORE_ENTRIES) {
            this._coreMemories = this._coreMemories.slice(-MAX_CORE_ENTRIES);
        }
        this._saveCoreMemories();

        const indexEntry = this._buildIndexEntry(entry);
        this._coreIndex.push(indexEntry);
        if (this._coreIndex.length > MAX_CORE_ENTRIES) {
            this._coreIndex = this._coreIndex.slice(-MAX_CORE_ENTRIES);
        }
        this._saveCoreIndex();

        return entry;
    }

    updateCoreMemory(id, content, category) {
        const idx = this._coreMemories.findIndex(m => m.id === id);
        if (idx < 0) return null;
        this._coreMemories[idx] = {
            ...this._coreMemories[idx],
            content,
            category: category || this._coreMemories[idx].category,
            keywords: this._extractKeywords(content),
            timestamp: Date.now()
        };
        this._saveCoreMemories();

        const indexIdx = this._coreIndex.findIndex(e => e.id === id);
        if (indexIdx >= 0) {
            this._coreIndex[indexIdx] = this._buildIndexEntry(this._coreMemories[idx]);
            this._saveCoreIndex();
        }

        return this._coreMemories[idx];
    }

    deleteCoreMemory(id) {
        const idx = this._coreMemories.findIndex(m => m.id === id);
        if (idx < 0) return false;
        this._coreMemories.splice(idx, 1);
        this._saveCoreMemories();

        const indexIdx = this._coreIndex.findIndex(e => e.id === id);
        if (indexIdx >= 0) {
            this._coreIndex.splice(indexIdx, 1);
            this._saveCoreIndex();
        }

        return true;
    }

    getStats() {
        const today = new Date().toISOString().slice(0, 10);
        const dailyCount = this._loadDailyMemories(today).length;
        return {
            contextCount: this._context.length,
            dailyCount,
            coreCount: this._coreMemories.length,
            indexCount: this._coreIndex.length
        };
    }
}

const instance = new MemoryManager();

module.exports = { MemoryManager, instance };
