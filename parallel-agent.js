const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const MAX_CONCURRENCY = 3;
const DEFAULT_TIMEOUT = 120000;
const TASK_STATES = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    ABORTED: 'aborted'
};

const AGENT_TYPES = [
    'file_search',
    'code_analysis',
    'resource_download',
    'crash_analysis',
    'code_completion',
    'explore',
    'review',
    'verifier'
];

const PRIORITY_WEIGHT = { high: 3, normal: 2, low: 1 };

class ParallelAgentManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this._tasks = new Map();
        this._queue = [];
        this._running = 0;
        this._maxConcurrency = options.maxConcurrency || MAX_CONCURRENCY;
        this._defaultTimeout = options.defaultTimeout || DEFAULT_TIMEOUT;
        this._workers = new Map();
        this._timers = new Map();
    }

    dispatch(tasks) {
        if (!Array.isArray(tasks) || tasks.length === 0) return [];

        const taskIds = [];
        for (const task of tasks) {
            if (!task.type || !AGENT_TYPES.includes(task.type)) continue;
            const taskId = crypto.randomUUID();
            const priority = task.priority || 'normal';
            const timeout = task.timeout || this._defaultTimeout;
            const entry = {
                id: taskId,
                type: task.type,
                task: task.task,
                priority,
                timeout,
                state: TASK_STATES.PENDING,
                result: null,
                error: null,
                createdAt: Date.now(),
                startedAt: null,
                completedAt: null
            };
            this._tasks.set(taskId, entry);
            this._queue.push(taskId);
            taskIds.push(taskId);
        }

        this._queue.sort((a, b) => {
            const wa = PRIORITY_WEIGHT[this._tasks.get(a).priority] || 2;
            const wb = PRIORITY_WEIGHT[this._tasks.get(b).priority] || 2;
            return wb - wa;
        });

        this._processQueue();
        return taskIds;
    }

    _processQueue() {
        while (this._running < this._maxConcurrency && this._queue.length > 0) {
            const taskId = this._queue.shift();
            const task = this._tasks.get(taskId);
            if (!task || task.state !== TASK_STATES.PENDING) continue;
            this._executeTask(taskId);
        }
    }

    _executeTask(taskId) {
        const task = this._tasks.get(taskId);
        if (!task) return;

        task.state = TASK_STATES.RUNNING;
        task.startedAt = Date.now();
        this._running++;

        const timer = setTimeout(() => {
            this._handleTimeout(taskId);
        }, task.timeout);
        this._timers.set(taskId, timer);

        try {
            const workerPath = path.join(__dirname, 'agent-worker.js');
            const worker = new Worker(workerPath, {
                workerData: {
                    parallelTask: true,
                    type: task.type,
                    task: task.task,
                    taskId
                }
            });
            this._workers.set(taskId, worker);

            let resultData = '';
            let errorData = null;

            worker.on('message', (msg) => {
                if (msg.type === 'chunk' && msg.chunk) {
                    if (msg.chunk.content) resultData += msg.chunk.content;
                    if (msg.chunk.result) resultData += msg.chunk.result;
                }
                if (msg.type === 'error') {
                    errorData = msg.error;
                }
                if (msg.type === 'done') {
                    this._completeTask(taskId, resultData || null, errorData);
                }
            });

            worker.on('error', (err) => {
                this._failTask(taskId, err.message || String(err));
            });

            worker.on('exit', (code) => {
                if (task.state === TASK_STATES.RUNNING) {
                    if (code !== 0 && !errorData) {
                        this._failTask(taskId, `Worker exited with code ${code}`);
                    } else if (task.state === TASK_STATES.RUNNING) {
                        this._completeTask(taskId, resultData || null, errorData);
                    }
                }
            });

            worker.postMessage({
                type: 'start',
                params: {
                    messages: [{ role: 'user', content: task.task }],
                    tools: [],
                    parallelSubTask: true,
                    subTaskType: task.type
                }
            });
        } catch (err) {
            this._failTask(taskId, err.message || String(err));
        }
    }

    _handleTimeout(taskId) {
        const task = this._tasks.get(taskId);
        if (!task || task.state !== TASK_STATES.RUNNING) return;

        const worker = this._workers.get(taskId);
        if (worker) {
            try { worker.terminate(); } catch (e) {}
            this._workers.delete(taskId);
        }

        task.state = TASK_STATES.FAILED;
        task.error = 'Task timed out';
        task.completedAt = Date.now();
        this._running--;
        this._timers.delete(taskId);

        this.emit('task_failed', { taskId, error: task.error });
        this._processQueue();
    }

    _completeTask(taskId, result, error) {
        const task = this._tasks.get(taskId);
        if (!task || task.state !== TASK_STATES.RUNNING) return;

        const timer = this._timers.get(taskId);
        if (timer) {
            clearTimeout(timer);
            this._timers.delete(taskId);
        }

        const worker = this._workers.get(taskId);
        if (worker) {
            try { worker.terminate(); } catch (e) {}
            this._workers.delete(taskId);
        }

        if (error) {
            task.state = TASK_STATES.FAILED;
            task.error = error;
        } else {
            task.state = TASK_STATES.COMPLETED;
            task.result = result;
        }
        task.completedAt = Date.now();
        this._running--;

        this.emit(task.state === TASK_STATES.COMPLETED ? 'task_completed' : 'task_failed', {
            taskId,
            result: task.result,
            error: task.error
        });
        this._processQueue();
    }

    _failTask(taskId, errorMsg) {
        const task = this._tasks.get(taskId);
        if (!task || task.state !== TASK_STATES.RUNNING) return;

        const timer = this._timers.get(taskId);
        if (timer) {
            clearTimeout(timer);
            this._timers.delete(taskId);
        }

        const worker = this._workers.get(taskId);
        if (worker) {
            try { worker.terminate(); } catch (e) {}
            this._workers.delete(taskId);
        }

        task.state = TASK_STATES.FAILED;
        task.error = errorMsg;
        task.completedAt = Date.now();
        this._running--;

        this.emit('task_failed', { taskId, error: errorMsg });
        this._processQueue();
    }

    getStatus(taskId) {
        const task = this._tasks.get(taskId);
        if (!task) return null;
        return {
            id: task.id,
            type: task.type,
            state: task.state,
            priority: task.priority,
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            elapsed: task.completedAt
                ? task.completedAt - (task.startedAt || task.createdAt)
                : task.startedAt
                    ? Date.now() - task.startedAt
                    : 0
        };
    }

    getResult(taskId) {
        const task = this._tasks.get(taskId);
        if (!task) return null;
        return {
            id: task.id,
            type: task.type,
            state: task.state,
            result: task.result,
            error: task.error,
            elapsed: task.completedAt
                ? task.completedAt - (task.startedAt || task.createdAt)
                : null
        };
    }

    abort(taskId) {
        const task = this._tasks.get(taskId);
        if (!task) return false;

        if (task.state === TASK_STATES.PENDING) {
            const idx = this._queue.indexOf(taskId);
            if (idx >= 0) this._queue.splice(idx, 1);
            task.state = TASK_STATES.ABORTED;
            task.completedAt = Date.now();
            this.emit('task_aborted', { taskId });
            return true;
        }

        if (task.state === TASK_STATES.RUNNING) {
            const timer = this._timers.get(taskId);
            if (timer) {
                clearTimeout(timer);
                this._timers.delete(taskId);
            }

            const worker = this._workers.get(taskId);
            if (worker) {
                try { worker.terminate(); } catch (e) {}
                this._workers.delete(taskId);
            }

            task.state = TASK_STATES.ABORTED;
            task.completedAt = Date.now();
            this._running--;
            this.emit('task_aborted', { taskId });
            this._processQueue();
            return true;
        }

        return false;
    }

    abortAll() {
        const aborted = [];
        for (const [taskId, task] of this._tasks) {
            if (task.state === TASK_STATES.PENDING || task.state === TASK_STATES.RUNNING) {
                if (this.abort(taskId)) aborted.push(taskId);
            }
        }
        return aborted;
    }

    listActive() {
        const active = [];
        for (const [taskId, task] of this._tasks) {
            if (task.state === TASK_STATES.PENDING || task.state === TASK_STATES.RUNNING) {
                active.push({
                    id: task.id,
                    type: task.type,
                    state: task.state,
                    priority: task.priority,
                    elapsed: task.startedAt ? Date.now() - task.startedAt : 0
                });
            }
        }
        return active;
    }

    getAggregatedResults() {
        const completed = [];
        const failed = [];
        const aborted = [];
        let totalElapsed = 0;

        for (const [, task] of this._tasks) {
            const elapsed = task.completedAt
                ? task.completedAt - (task.startedAt || task.createdAt)
                : 0;

            if (task.state === TASK_STATES.COMPLETED) {
                completed.push({
                    id: task.id,
                    type: task.type,
                    result: task.result,
                    elapsed
                });
                totalElapsed += elapsed;
            } else if (task.state === TASK_STATES.FAILED) {
                failed.push({
                    id: task.id,
                    type: task.type,
                    error: task.error,
                    elapsed
                });
            } else if (task.state === TASK_STATES.ABORTED) {
                aborted.push({
                    id: task.id,
                    type: task.type
                });
            }
        }

        const totalTasks = this._tasks.size;
        const doneCount = completed.length + failed.length + aborted.length;

        return {
            total: totalTasks,
            completed: completed.length,
            failed: failed.length,
            aborted: aborted.length,
            pending: totalTasks - doneCount,
            totalElapsed,
            results: completed,
            errors: failed,
            abortedTasks: aborted,
            summary: `${completed.length}/${totalTasks} tasks completed successfully`
        };
    }

    destroy() {
        this.abortAll();
        for (const [, timer] of this._timers) {
            clearTimeout(timer);
        }
        this._timers.clear();
        this._workers.clear();
        this._tasks.clear();
        this._queue = [];
        this._running = 0;
        this.removeAllListeners();
    }
}

const instance = new ParallelAgentManager();

module.exports = { ParallelAgentManager, instance };
