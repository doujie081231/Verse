const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const KNOWLEDGE_BASE_DIR = path.join(os.homedir(), '.versepc', 'knowledge');
const GRAPH_FILE = path.join(KNOWLEDGE_BASE_DIR, 'graph.json');

const NODE_TYPES = ['concept', 'entity', 'fact', 'preference', 'skill'];
const EDGE_TYPES = ['related_to', 'is_a', 'has_property', 'depends_on', 'learned_from'];

const MC_TERMS = [
    'minecraft', '我的世界', 'mod', '模组', 'forge', 'fabric', 'neoforge',
    'optifine', '光影', '材质包', 'resource pack', '整合包', 'modpack',
    '服务器', 'server', '多人游戏', 'multiplayer', '红石', 'redstone',
    '命令方块', 'command block', '附魔', 'enchant', '合成', 'craft',
    '挖矿', 'mine', '生存', 'survival', '创造', 'creative', '冒险', 'adventure',
    '末地', 'end', '下界', 'nether', '地狱', '主世界', 'overworld',
    '苦力怕', 'creeper', '僵尸', 'zombie', '骷髅', 'skeleton', '末影人', 'enderman',
    '村民', 'villager', '凋灵', 'wither', '末影龙', 'ender dragon',
    '钻石', 'diamond', '铁', 'iron', '金', 'gold', '绿宝石', 'emerald',
    '下界合金', 'netherite', '烈焰棒', 'blaze rod', '末影珍珠', 'ender pearl',
    'java', 'bedrock', '基岩版', 'java版'
];

class KnowledgeGraph {
    constructor() {
        this._nodes = new Map();
        this._edges = [];
        this._nameIndex = new Map();
        this._typeIndex = new Map();
        this._ensureDirs();
        this._loadGraph();
    }

    _ensureDirs() {
        try {
            fs.mkdirSync(KNOWLEDGE_BASE_DIR, { recursive: true });
        } catch (e) {}
    }

    _loadGraph() {
        try {
            if (fs.existsSync(GRAPH_FILE)) {
                const data = fs.readFileSync(GRAPH_FILE, 'utf-8');
                const parsed = JSON.parse(data);
                if (parsed.nodes && Array.isArray(parsed.nodes)) {
                    for (const node of parsed.nodes) {
                        this._nodes.set(node.id, node);
                    }
                }
                if (parsed.edges && Array.isArray(parsed.edges)) {
                    this._edges = parsed.edges;
                }
                this._rebuildIndexes();
            }
        } catch (e) {
            this._nodes = new Map();
            this._edges = [];
        }
    }

    _saveGraph() {
        try {
            const data = {
                nodes: Array.from(this._nodes.values()),
                edges: this._edges,
                updatedAt: Date.now()
            };
            fs.writeFileSync(GRAPH_FILE, JSON.stringify(data, null, 2), 'utf-8');
        } catch (e) {}
    }

    _rebuildIndexes() {
        this._nameIndex.clear();
        this._typeIndex.clear();
        for (const node of this._nodes.values()) {
            const normalizedName = node.name.toLowerCase().trim();
            if (!this._nameIndex.has(normalizedName)) {
                this._nameIndex.set(normalizedName, []);
            }
            this._nameIndex.get(normalizedName).push(node.id);
            if (!this._typeIndex.has(node.type)) {
                this._typeIndex.set(node.type, []);
            }
            this._typeIndex.get(node.type).push(node.id);
        }
    }

    _addToIndexes(node) {
        const normalizedName = node.name.toLowerCase().trim();
        if (!this._nameIndex.has(normalizedName)) {
            this._nameIndex.set(normalizedName, []);
        }
        this._nameIndex.get(normalizedName).push(node.id);
        if (!this._typeIndex.has(node.type)) {
            this._typeIndex.set(node.type, []);
        }
        this._typeIndex.get(node.type).push(node.id);
    }

    _removeFromIndexes(node) {
        const normalizedName = node.name.toLowerCase().trim();
        if (this._nameIndex.has(normalizedName)) {
            const ids = this._nameIndex.get(normalizedName).filter(id => id !== node.id);
            if (ids.length === 0) {
                this._nameIndex.delete(normalizedName);
            } else {
                this._nameIndex.set(normalizedName, ids);
            }
        }
        if (this._typeIndex.has(node.type)) {
            const ids = this._typeIndex.get(node.type).filter(id => id !== node.id);
            if (ids.length === 0) {
                this._typeIndex.delete(node.type);
            } else {
                this._typeIndex.set(node.type, ids);
            }
        }
    }

    _tokenize(text) {
        if (!text || typeof text !== 'string') return [];
        return text
            .toLowerCase()
            .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 0);
    }

    addNode(type, name, properties = {}) {
        try {
            if (!NODE_TYPES.includes(type)) {
                return null;
            }
            if (!name || typeof name !== 'string') {
                return null;
            }
            const trimmedName = name.trim();
            if (trimmedName.length === 0) {
                return null;
            }
            const existingNodes = this._nameIndex.get(trimmedName.toLowerCase());
            if (existingNodes && existingNodes.length > 0) {
                const existing = this._nodes.get(existingNodes[0]);
                if (existing && existing.type === type) {
                    existing.properties = { ...existing.properties, ...properties };
                    existing.updatedAt = Date.now();
                    this._saveGraph();
                    return existing;
                }
            }
            const node = {
                id: crypto.randomUUID(),
                type,
                name: trimmedName,
                properties: properties || {},
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            this._nodes.set(node.id, node);
            this._addToIndexes(node);
            this._saveGraph();
            return node;
        } catch (e) {
            return null;
        }
    }

    addEdge(sourceId, targetId, relation, properties = {}) {
        try {
            if (!this._nodes.has(sourceId) || !this._nodes.has(targetId)) {
                return null;
            }
            if (!EDGE_TYPES.includes(relation)) {
                return null;
            }
            const existingEdge = this._edges.find(e =>
                e.sourceId === sourceId &&
                e.targetId === targetId &&
                e.relation === relation
            );
            if (existingEdge) {
                existingEdge.properties = { ...existingEdge.properties, ...properties };
                existingEdge.updatedAt = Date.now();
                this._saveGraph();
                return existingEdge;
            }
            const edge = {
                id: crypto.randomUUID(),
                sourceId,
                targetId,
                relation,
                properties: properties || {},
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            this._edges.push(edge);
            this._saveGraph();
            return edge;
        } catch (e) {
            return null;
        }
    }

    searchNodes(query) {
        try {
            if (!query || typeof query !== 'string') {
                return [];
            }
            const queryLower = query.toLowerCase().trim();
            const queryTokens = this._tokenize(query);
            const results = [];
            for (const node of this._nodes.values()) {
                const nodeNameLower = node.name.toLowerCase();
                let score = 0;
                if (nodeNameLower === queryLower) {
                    score = 100;
                } else if (nodeNameLower.includes(queryLower)) {
                    score = 80;
                } else if (queryLower.includes(nodeNameLower)) {
                    score = 60;
                } else {
                    const nodeTokens = this._tokenize(node.name);
                    let matchCount = 0;
                    for (const qt of queryTokens) {
                        for (const nt of nodeTokens) {
                            if (nt.includes(qt) || qt.includes(nt)) {
                                matchCount++;
                                break;
                            }
                        }
                    }
                    if (matchCount > 0) {
                        score = (matchCount / Math.max(queryTokens.length, nodeTokens.length)) * 50;
                    }
                }
                if (score > 0) {
                    results.push({ node, score });
                }
            }
            return results
                .sort((a, b) => b.score - a.score)
                .slice(0, 50)
                .map(r => r.node);
        } catch (e) {
            return [];
        }
    }

    getNode(nodeId) {
        try {
            return this._nodes.get(nodeId) || null;
        } catch (e) {
            return null;
        }
    }

    getRelated(nodeId, relation = null) {
        try {
            if (!this._nodes.has(nodeId)) {
                return [];
            }
            const relatedEdges = this._edges.filter(e => {
                const isConnected = e.sourceId === nodeId || e.targetId === nodeId;
                if (relation) {
                    return isConnected && e.relation === relation;
                }
                return isConnected;
            });
            const relatedNodes = [];
            for (const edge of relatedEdges) {
                const relatedId = edge.sourceId === nodeId ? edge.targetId : edge.sourceId;
                const relatedNode = this._nodes.get(relatedId);
                if (relatedNode) {
                    relatedNodes.push({
                        node: relatedNode,
                        relation: edge.relation,
                        edgeProperties: edge.properties
                    });
                }
            }
            return relatedNodes;
        } catch (e) {
            return [];
        }
    }

    extractFromText(text) {
        try {
            if (!text || typeof text !== 'string') {
                return [];
            }
            const extracted = [];
            const isPattern = /([^\s,，。.!?！？]+)\s*(?:是|就是|means?|is)\s*([^\s,，。.!?！？]+)/g;
            let match;
            while ((match = isPattern.exec(text)) !== null) {
                const subject = match[1].trim();
                const object = match[2].trim();
                if (subject.length > 0 && object.length > 0 && subject !== object) {
                    extracted.push({
                        type: 'is_a',
                        subject,
                        object,
                        relation: 'is_a'
                    });
                }
            }
            const containsPattern = /([^\s,，。.!?！？]+)\s*(?:包含|含有|有|contains?|includes?|has)\s*([^\s,，。.!?！？]+)/g;
            while ((match = containsPattern.exec(text)) !== null) {
                const subject = match[1].trim();
                const object = match[2].trim();
                if (subject.length > 0 && object.length > 0 && subject !== object) {
                    extracted.push({
                        type: 'has_property',
                        subject,
                        object,
                        relation: 'has_property'
                    });
                }
            }
            const preferencePattern = /(?:我|我)\s*(?:喜欢|偏好|爱好|prefer|like|love|enjoy)\s*([^\s,，。.!?！？]+)/g;
            while ((match = preferencePattern.exec(text)) !== null) {
                const preference = match[1].trim();
                if (preference.length > 0) {
                    extracted.push({
                        type: 'preference',
                        subject: '用户',
                        object: preference,
                        relation: 'related_to'
                    });
                }
            }
            const lowerText = text.toLowerCase();
            for (const term of MC_TERMS) {
                if (lowerText.includes(term)) {
                    const termPattern = new RegExp(`([^\\s,，。.!?！？]*${term}[^\\s,，。.!?！？]*)`, 'i');
                    const termMatch = text.match(termPattern);
                    if (termMatch) {
                        const termNode = termMatch[1].trim();
                        if (termNode.length > 0) {
                            extracted.push({
                                type: 'entity',
                                subject: termNode,
                                object: 'Minecraft',
                                relation: 'related_to'
                            });
                        }
                    }
                }
            }
            const nodes = [];
            const edges = [];
            for (const item of extracted) {
                let subjectType = 'concept';
                let objectType = 'concept';
                if (item.type === 'preference') {
                    subjectType = 'entity';
                    objectType = 'preference';
                } else if (item.type === 'has_property') {
                    objectType = 'fact';
                } else if (item.relation === 'related_to') {
                    subjectType = 'entity';
                    objectType = 'entity';
                }
                const subjectNode = this.addNode(subjectType, item.subject);
                const objectNode = this.addNode(objectType, item.object);
                if (subjectNode && objectNode) {
                    const edge = this.addEdge(subjectNode.id, objectNode.id, item.relation);
                    if (edge) {
                        edges.push(edge);
                    }
                }
                if (subjectNode) nodes.push(subjectNode);
                if (objectNode) nodes.push(objectNode);
            }
            return { nodes, edges };
        } catch (e) {
            return { nodes: [], edges: [] };
        }
    }

    exportGraph() {
        try {
            return {
                nodes: Array.from(this._nodes.values()),
                edges: this._edges,
                exportedAt: Date.now(),
                stats: this.getStats()
            };
        } catch (e) {
            return { nodes: [], edges: [], exportedAt: Date.now() };
        }
    }

    importGraph(data) {
        try {
            if (!data || typeof data !== 'object') {
                return false;
            }
            if (data.nodes && Array.isArray(data.nodes)) {
                for (const node of data.nodes) {
                    if (node.id && node.type && node.name) {
                        this._nodes.set(node.id, node);
                    }
                }
            }
            if (data.edges && Array.isArray(data.edges)) {
                for (const edge of data.edges) {
                    if (edge.id && edge.sourceId && edge.targetId && edge.relation) {
                        const existingIdx = this._edges.findIndex(e => e.id === edge.id);
                        if (existingIdx >= 0) {
                            this._edges[existingIdx] = edge;
                        } else {
                            this._edges.push(edge);
                        }
                    }
                }
            }
            this._rebuildIndexes();
            this._saveGraph();
            return true;
        } catch (e) {
            return false;
        }
    }

    getStats() {
        try {
            const nodeTypeCounts = {};
            for (const type of NODE_TYPES) {
                nodeTypeCounts[type] = this._typeIndex.has(type) ? this._typeIndex.get(type).length : 0;
            }
            const edgeTypeCounts = {};
            for (const type of EDGE_TYPES) {
                edgeTypeCounts[type] = this._edges.filter(e => e.relation === type).length;
            }
            return {
                totalNodes: this._nodes.size,
                totalEdges: this._edges.length,
                nodeTypeCounts,
                edgeTypeCounts,
                updatedAt: Date.now()
            };
        } catch (e) {
            return {
                totalNodes: 0,
                totalEdges: 0,
                nodeTypeCounts: {},
                edgeTypeCounts: {},
                updatedAt: Date.now()
            };
        }
    }

    deleteNode(nodeId) {
        try {
            if (!this._nodes.has(nodeId)) {
                return false;
            }
            const node = this._nodes.get(nodeId);
            this._edges = this._edges.filter(e => e.sourceId !== nodeId && e.targetId !== nodeId);
            this._removeFromIndexes(node);
            this._nodes.delete(nodeId);
            this._saveGraph();
            return true;
        } catch (e) {
            return false;
        }
    }
}

const instance = new KnowledgeGraph();

module.exports = { KnowledgeGraph, instance, NODE_TYPES, EDGE_TYPES };
