const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const WORKFLOWS_DIR = path.join(os.homedir(), '.versepc', 'workflows');

const NodeStatus = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    SKIPPED: 'skipped'
};

const RunStatus = {
    PENDING: 'pending',
    RUNNING: 'running',
    PAUSED: 'paused',
    COMPLETED: 'completed',
    FAILED: 'failed',
    ABORTED: 'aborted'
};

const NodeType = {
    AI: 'ai',
    BASH: 'bash',
    APPROVAL: 'approval',
    CONDITION: 'condition'
};

function parseYamlSimple(yamlStr) {
    const lines = yamlStr.split('\n');
    const result = {};
    let currentObj = result;
    let currentKey = null;
    let currentArray = null;
    let currentItem = null;
    let indent = 0;
    let inBlock = false;
    let blockContent = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();

        if (!trimmed || trimmed.startsWith('#')) continue;

        const currentIndent = line.length - trimmed.length;

        if (trimmed.startsWith('- ')) {
            const content = trimmed.slice(2);

            if (content.includes(':')) {
                const colonIdx = content.indexOf(':');
                const key = content.slice(0, colonIdx).trim();
                const value = content.slice(colonIdx + 1).trim();

                if (!currentArray) {
                    currentArray = [];
                    if (currentKey) {
                        currentObj[currentKey] = currentArray;
                    }
                }

                currentItem = {};
                currentItem[key] = parseValue(value);
                currentArray.push(currentItem);
            } else {
                if (!currentArray) {
                    currentArray = [];
                    if (currentKey) {
                        currentObj[currentKey] = currentArray;
                    }
                }
                currentArray.push(parseValue(content));
            }
        } else if (trimmed.includes(':')) {
            const colonIdx = trimmed.indexOf(':');
            const key = trimmed.slice(0, colonIdx).trim();
            const value = trimmed.slice(colonIdx + 1).trim();

            if (currentIndent <= indent && currentArray && currentItem) {
                currentArray = null;
                currentItem = null;
            }

            if (value) {
                if (currentItem && currentIndent > indent) {
                    currentItem[key] = parseValue(value);
                } else if (currentArray && currentArray.length > 0) {
                    const lastItem = currentArray[currentArray.length - 1];
                    if (typeof lastItem === 'object') {
                        lastItem[key] = parseValue(value);
                    }
                } else {
                    currentObj[key] = parseValue(value);
                    currentKey = key;
                }
            } else {
                if (currentArray && currentItem) {
                    currentItem[key] = null;
                } else {
                    currentObj[key] = null;
                    currentKey = key;
                    currentArray = null;
                }
            }

            indent = currentIndent;
        }
    }

    return result;
}

function parseValue(value) {
    if (!value || value === 'null' || value === '~') return null;
    if (value === 'true') return true;
    if (value === 'false') return false;

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }

    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);

    if (value.startsWith('[') && value.endsWith(']')) {
        const content = value.slice(1, -1);
        if (!content.trim()) return [];
        return content.split(',').map(item => parseValue(item.trim()));
    }

    return value;
}

function ensureWorkflowsDir() {
    if (!fs.existsSync(WORKFLOWS_DIR)) {
        fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
    }
}

function topologicalSort(nodes) {
    const nodeMap = new Map();
    const inDegree = new Map();
    const adjList = new Map();

    for (const node of nodes) {
        nodeMap.set(node.id, node);
        inDegree.set(node.id, 0);
        adjList.set(node.id, []);
    }

    for (const node of nodes) {
        if (node.depends_on) {
            for (const dep of node.depends_on) {
                if (adjList.has(dep)) {
                    adjList.get(dep).push(node.id);
                    inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
                }
            }
        }
    }

    const queue = [];
    for (const [nodeId, degree] of inDegree) {
        if (degree === 0) queue.push(nodeId);
    }

    const sorted = [];
    const levels = new Map();

    while (queue.length > 0) {
        const currentLevel = [...queue];
        queue.length = 0;

        for (const nodeId of currentLevel) {
            sorted.push(nodeMap.get(nodeId));

            const maxDepLevel = nodeMap.get(nodeId).depends_on
                ? Math.max(...nodeMap.get(nodeId).depends_on.map(d => levels.get(d) || 0), -1)
                : -1;
            levels.set(nodeId, maxDepLevel + 1);

            for (const neighbor of adjList.get(nodeId)) {
                inDegree.set(neighbor, inDegree.get(neighbor) - 1);
                if (inDegree.get(neighbor) === 0) {
                    queue.push(neighbor);
                }
            }
        }
    }

    if (sorted.length !== nodes.length) {
        throw new Error('检测到循环依赖，无法确定执行顺序');
    }

    return { sorted, levels };
}

class WorkflowRun {
    constructor(workflowId, workflow, context = {}) {
        this.runId = crypto.randomUUID();
        this.workflowId = workflowId;
        this.workflow = workflow;
        this.context = context;
        this.status = RunStatus.PENDING;
        this.nodeStates = new Map();
        this.nodeOutputs = new Map();
        this.nodeInputs = new Map();
        this.history = [];
        this.startTime = null;
        this.endTime = null;
        this.pausedAt = null;
        this.abortRequested = false;

        for (const node of workflow.nodes) {
            this.nodeStates.set(node.id, NodeStatus.PENDING);
            this.nodeOutputs.set(node.id, null);
            this.nodeInputs.set(node.id, null);
        }
    }

    addHistory(event) {
        this.history.push({
            ...event,
            timestamp: Date.now()
        });
    }

    toJSON() {
        const nodeStates = {};
        const nodeOutputs = {};
        const nodeInputs = {};

        for (const [nodeId, state] of this.nodeStates) {
            nodeStates[nodeId] = state;
        }
        for (const [nodeId, output] of this.nodeOutputs) {
            nodeOutputs[nodeId] = output;
        }
        for (const [nodeId, input] of this.nodeInputs) {
            nodeInputs[nodeId] = input;
        }

        return {
            runId: this.runId,
            workflowId: this.workflowId,
            workflowName: this.workflow.name,
            status: this.status,
            context: this.context,
            nodeStates,
            nodeOutputs,
            nodeInputs,
            history: this.history,
            startTime: this.startTime,
            endTime: this.endTime,
            duration: this.endTime ? this.endTime - this.startTime : null
        };
    }
}

class WorkflowEngine {
    constructor() {
        this.workflows = new Map();
        this.runs = new Map();
        this.nodeHandlers = new Map();
        this.approvalCallbacks = new Map();

        this.registerDefaultHandlers();
        ensureWorkflowsDir();
    }

    registerDefaultHandlers() {
        this.registerNodeHandler(NodeType.AI, async (node, context, run) => {
            return {
                type: 'ai_response',
                prompt: node.prompt,
                result: `AI 处理完成: ${node.prompt}`,
                context
            };
        });

        this.registerNodeHandler(NodeType.BASH, async (node, context, run) => {
            return new Promise((resolve, reject) => {
                exec(node.command, { timeout: node.timeout || 30000 }, (error, stdout, stderr) => {
                    if (error) {
                        reject(new Error(`命令执行失败: ${error.message}\n${stderr}`));
                    } else {
                        resolve({
                            type: 'bash_output',
                            command: node.command,
                            stdout,
                            stderr
                        });
                    }
                });
            });
        });

        this.registerNodeHandler(NodeType.APPROVAL, async (node, context, run) => {
            return new Promise((resolve) => {
                const callback = (approved) => {
                    resolve({
                        type: 'approval_result',
                        approved,
                        prompt: node.prompt
                    });
                };
                this.approvalCallbacks.set(run.runId, { nodeId: node.id, callback });
            });
        });

        this.registerNodeHandler(NodeType.CONDITION, async (node, context, run) => {
            const conditionResult = evaluateCondition(node.condition, context);
            return {
                type: 'condition_result',
                condition: node.condition,
                result: conditionResult,
                branch: conditionResult ? 'true' : 'false'
            };
        });
    }

    registerNodeHandler(type, handler) {
        this.nodeHandlers.set(type, handler);
    }

    loadWorkflow(yamlPath) {
        try {
            const resolvedPath = path.resolve(yamlPath);
            const content = fs.readFileSync(resolvedPath, 'utf-8');
            return this.loadWorkflowFromString(content, resolvedPath);
        } catch (error) {
            throw new Error(`加载工作流文件失败: ${error.message}`);
        }
    }

    loadWorkflowFromString(yamlString, source = 'string') {
        try {
            const workflow = parseYamlSimple(yamlString);

            if (!workflow.name) {
                throw new Error('工作流必须包含 name 字段');
            }
            if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
                throw new Error('工作流必须包含 nodes 数组');
            }

            for (const node of workflow.nodes) {
                if (!node.id) {
                    throw new Error('每个节点必须包含 id 字段');
                }
                if (!node.type) {
                    throw new Error(`节点 ${node.id} 必须包含 type 字段`);
                }
                if (!Object.values(NodeType).includes(node.type)) {
                    throw new Error(`节点 ${node.id} 的类型无效: ${node.type}`);
                }
            }

            const workflowId = crypto.randomUUID();
            this.workflows.set(workflowId, {
                id: workflowId,
                source,
                ...workflow,
                loadedAt: Date.now()
            });

            return workflowId;
        } catch (error) {
            throw new Error(`解析工作流失败: ${error.message}`);
        }
    }

    async start(workflowId, context = {}) {
        const workflow = this.workflows.get(workflowId);
        if (!workflow) {
            throw new Error(`工作流不存在: ${workflowId}`);
        }

        const run = new WorkflowRun(workflowId, workflow, context);
        this.runs.set(run.runId, run);

        run.status = RunStatus.RUNNING;
        run.startTime = Date.now();
        run.addHistory({
            event: 'workflow_started',
            workflowId,
            workflowName: workflow.name
        });

        this.executeWorkflow(run).catch(error => {
            run.status = RunStatus.FAILED;
            run.endTime = Date.now();
            run.addHistory({
                event: 'workflow_failed',
                error: error.message
            });
        });

        return run.runId;
    }

    async executeWorkflow(run) {
        try {
            const { sorted, levels } = topologicalSort(run.workflow.nodes);

            const levelGroups = new Map();
            for (const node of sorted) {
                const level = levels.get(node.id);
                if (!levelGroups.has(level)) {
                    levelGroups.set(level, []);
                }
                levelGroups.get(level).push(node);
            }

            const sortedLevels = [...levelGroups.keys()].sort((a, b) => a - b);

            for (const level of sortedLevels) {
                if (run.abortRequested) {
                    run.status = RunStatus.ABORTED;
                    run.endTime = Date.now();
                    run.addHistory({ event: 'workflow_aborted' });
                    return;
                }

                while (run.status === RunStatus.PAUSED) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    if (run.abortRequested) {
                        run.status = RunStatus.ABORTED;
                        run.endTime = Date.now();
                        run.addHistory({ event: 'workflow_aborted' });
                        return;
                    }
                }

                const nodesAtLevel = levelGroups.get(level);
                const promises = nodesAtLevel.map(node => this.executeNode(node, run));
                await Promise.all(promises);

                const hasFailure = nodesAtLevel.some(node =>
                    run.nodeStates.get(node.id) === NodeStatus.FAILED
                );

                if (hasFailure) {
                    run.status = RunStatus.FAILED;
                    run.endTime = Date.now();
                    run.addHistory({ event: 'workflow_failed', reason: '节点执行失败' });
                    return;
                }
            }

            run.status = RunStatus.COMPLETED;
            run.endTime = Date.now();
            run.addHistory({ event: 'workflow_completed' });
        } catch (error) {
            run.status = RunStatus.FAILED;
            run.endTime = Date.now();
            run.addHistory({
                event: 'workflow_error',
                error: error.message
            });
        }
    }

    async executeNode(node, run) {
        try {
            const skipNode = this.shouldSkipNode(node, run);
            if (skipNode) {
                run.nodeStates.set(node.id, NodeStatus.SKIPPED);
                run.addHistory({
                    event: 'node_skipped',
                    nodeId: node.id,
                    reason: '条件不满足或依赖失败'
                });
                return;
            }

            run.nodeStates.set(node.id, NodeStatus.RUNNING);
            run.addHistory({ event: 'node_started', nodeId: node.id });

            const handler = this.nodeHandlers.get(node.type);
            if (!handler) {
                throw new Error(`未注册的节点类型处理器: ${node.type}`);
            }

            const input = this.collectNodeInputs(node, run);
            run.nodeInputs.set(node.id, input);

            if (node.loop) {
                await this.executeNodeWithLoop(node, run, handler, input);
            } else {
                const output = await handler(node, run.context, run);
                run.nodeOutputs.set(node.id, output);
                run.nodeStates.set(node.id, NodeStatus.COMPLETED);
                run.addHistory({
                    event: 'node_completed',
                    nodeId: node.id,
                    output
                });
            }
        } catch (error) {
            run.nodeStates.set(node.id, NodeStatus.FAILED);
            run.nodeOutputs.set(node.id, { error: error.message });
            run.addHistory({
                event: 'node_failed',
                nodeId: node.id,
                error: error.message
            });
        }
    }

    async executeNodeWithLoop(node, run, handler, input) {
        const maxIterations = node.loop.max_iterations || 10;
        const untilCondition = node.loop.until;
        let iteration = 0;

        while (iteration < maxIterations) {
            if (run.abortRequested) break;

            const output = await handler(node, run.context, run);
            run.nodeOutputs.set(node.id, output);
            iteration++;

            run.addHistory({
                event: 'loop_iteration',
                nodeId: node.id,
                iteration,
                output
            });

            const shouldContinue = !this.evaluateLoopCondition(untilCondition, output, run.context);
            if (!shouldContinue) {
                run.nodeStates.set(node.id, NodeStatus.COMPLETED);
                run.addHistory({
                    event: 'node_completed',
                    nodeId: node.id,
                    iterations: iteration
                });
                return;
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (iteration >= maxIterations) {
            run.nodeStates.set(node.id, NodeStatus.FAILED);
            run.addHistory({
                event: 'loop_max_iterations',
                nodeId: node.id,
                maxIterations
            });
        }
    }

    evaluateLoopCondition(condition, output, context) {
        if (!condition) return true;

        if (typeof output === 'object' && output !== null) {
            const outputStr = JSON.stringify(output).toLowerCase();
            const conditionLower = condition.toLowerCase();

            if (conditionLower.includes('成功') || conditionLower.includes('success')) {
                return outputStr.includes('成功') || outputStr.includes('success');
            }
            if (conditionLower.includes('失败') || conditionLower.includes('fail')) {
                return outputStr.includes('失败') || outputStr.includes('fail');
            }
        }

        return false;
    }

    shouldSkipNode(node, run) {
        if (node.depends_on) {
            for (const dep of node.depends_on) {
                const depState = run.nodeStates.get(dep);
                if (depState === NodeStatus.FAILED || depState === NodeStatus.SKIPPED) {
                    return true;
                }
            }
        }

        if (node.condition) {
            return !evaluateCondition(node.condition, run.context);
        }

        return false;
    }

    collectNodeInputs(node, run) {
        const inputs = {};

        if (node.depends_on) {
            for (const dep of node.depends_on) {
                const output = run.nodeOutputs.get(dep);
                if (output) {
                    inputs[dep] = output;
                }
            }
        }

        return inputs;
    }

    pause(runId) {
        const run = this.runs.get(runId);
        if (!run) {
            throw new Error(`运行实例不存在: ${runId}`);
        }
        if (run.status !== RunStatus.RUNNING) {
            throw new Error(`运行实例状态不允许暂停: ${run.status}`);
        }

        run.status = RunStatus.PAUSED;
        run.pausedAt = Date.now();
        run.addHistory({ event: 'workflow_paused' });
    }

    resume(runId) {
        const run = this.runs.get(runId);
        if (!run) {
            throw new Error(`运行实例不存在: ${runId}`);
        }
        if (run.status !== RunStatus.PAUSED) {
            throw new Error(`运行实例状态不允许恢复: ${run.status}`);
        }

        run.status = RunStatus.RUNNING;
        run.pausedAt = null;
        run.addHistory({ event: 'workflow_resumed' });
    }

    abort(runId) {
        const run = this.runs.get(runId);
        if (!run) {
            throw new Error(`运行实例不存在: ${runId}`);
        }

        run.abortRequested = true;

        if (run.status === RunStatus.PAUSED) {
            run.status = RunStatus.ABORTED;
            run.endTime = Date.now();
            run.addHistory({ event: 'workflow_aborted' });
        }
    }

    approve(runId, approved = true) {
        const approvalInfo = this.approvalCallbacks.get(runId);
        if (!approvalInfo) {
            throw new Error(`没有待审批的请求: ${runId}`);
        }

        approvalInfo.callback(approved);
        this.approvalCallbacks.delete(runId);
    }

    getStatus(runId) {
        const run = this.runs.get(runId);
        if (!run) {
            throw new Error(`运行实例不存在: ${runId}`);
        }
        return run.toJSON();
    }

    listWorkflows() {
        const list = [];
        for (const [id, workflow] of this.workflows) {
            list.push({
                id,
                name: workflow.name,
                description: workflow.description,
                nodeCount: workflow.nodes.length,
                source: workflow.source,
                loadedAt: workflow.loadedAt
            });
        }
        return list;
    }

    listRuns(workflowId = null) {
        const list = [];
        for (const [runId, run] of this.runs) {
            if (workflowId && run.workflowId !== workflowId) continue;
            list.push({
                runId,
                workflowId: run.workflowId,
                workflowName: run.workflow.name,
                status: run.status,
                startTime: run.startTime,
                endTime: run.endTime,
                nodeStates: Object.fromEntries(run.nodeStates)
            });
        }
        return list;
    }

    saveRunHistory(runId) {
        const run = this.runs.get(runId);
        if (!run) {
            throw new Error(`运行实例不存在: ${runId}`);
        }

        ensureWorkflowsDir();
        const historyDir = path.join(WORKFLOWS_DIR, 'history');
        if (!fs.existsSync(historyDir)) {
            fs.mkdirSync(historyDir, { recursive: true });
        }

        const filename = `run_${runId}_${Date.now()}.json`;
        const filepath = path.join(historyDir, filename);

        fs.writeFileSync(filepath, JSON.stringify(run.toJSON(), null, 2), 'utf-8');

        return filepath;
    }

    loadRunHistory(filepath) {
        try {
            const content = fs.readFileSync(filepath, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            throw new Error(`加载运行历史失败: ${error.message}`);
        }
    }

    listRunHistory() {
        const historyDir = path.join(WORKFLOWS_DIR, 'history');
        if (!fs.existsSync(historyDir)) {
            return [];
        }

        const files = fs.readdirSync(historyDir)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const filepath = path.join(historyDir, f);
                try {
                    const content = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
                    return {
                        file: f,
                        runId: content.runId,
                        workflowName: content.workflowName,
                        status: content.status,
                        startTime: content.startTime,
                        endTime: content.endTime
                    };
                } catch {
                    return null;
                }
            })
            .filter(Boolean);

        return files;
    }

    exportWorkflow(workflowId) {
        const workflow = this.workflows.get(workflowId);
        if (!workflow) {
            throw new Error(`工作流不存在: ${workflowId}`);
        }

        const exportData = {
            name: workflow.name,
            description: workflow.description,
            nodes: workflow.nodes
        };

        return exportData;
    }

    importWorkflow(workflowData) {
        const yamlStr = this.objectToYaml(workflowData);
        return this.loadWorkflowFromString(yamlStr);
    }

    objectToYaml(obj, indent = 0) {
        const lines = [];
        const prefix = '  '.repeat(indent);

        for (const [key, value] of Object.entries(obj)) {
            if (value === null || value === undefined) {
                lines.push(`${prefix}${key}:`);
            } else if (Array.isArray(value)) {
                lines.push(`${prefix}${key}:`);
                for (const item of value) {
                    if (typeof item === 'object') {
                        lines.push(`${prefix}  -`);
                        for (const [itemKey, itemValue] of Object.entries(item)) {
                            if (typeof itemValue === 'object' && itemValue !== null) {
                                lines.push(`${prefix}    ${itemKey}:`);
                                for (const [subKey, subValue] of Object.entries(itemValue)) {
                                    lines.push(`${prefix}      ${subKey}: ${this.formatYamlValue(subValue)}`);
                                }
                            } else {
                                lines.push(`${prefix}    ${itemKey}: ${this.formatYamlValue(itemValue)}`);
                            }
                        }
                    } else {
                        lines.push(`${prefix}  - ${this.formatYamlValue(item)}`);
                    }
                }
            } else if (typeof value === 'object') {
                lines.push(`${prefix}${key}:`);
                lines.push(this.objectToYaml(value, indent + 1));
            } else {
                lines.push(`${prefix}${key}: ${this.formatYamlValue(value)}`);
            }
        }

        return lines.join('\n');
    }

    formatYamlValue(value) {
        if (typeof value === 'string') {
            if (value.includes(':') || value.includes('#') || value.includes("'") || value.includes('"')) {
                return `"${value.replace(/"/g, '\\"')}"`;
            }
            return value;
        }
        return String(value);
    }
}

function evaluateCondition(condition, context) {
    if (!condition) return true;

    try {
        const contextKeys = Object.keys(context);
        const contextValues = Object.values(context);
        const fn = new Function(...contextKeys, `return ${condition};`);
        return fn(...contextValues);
    } catch {
        return false;
    }
}

const workflowEngine = new WorkflowEngine();

module.exports = {
    WorkflowEngine,
    workflowEngine,
    NodeStatus,
    RunStatus,
    NodeType
};
