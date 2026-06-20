const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class MCPClient extends EventEmitter {
    constructor() {
        super();
        this._connected = false;
        this._serverInfo = null;
        this._transport = null;
        this._process = null;
        this._sseConnection = null;
        this._requestId = 0;
        this._pendingRequests = new Map();
        this._tools = [];
        this._resources = [];
        this._config = null;
    }

    async connect(config) {
        this._config = config;
        try {
            if (this._connected) {
                await this.disconnect();
            }
            const transport = config.transport || 'stdio';
            if (transport === 'stdio') {
                await this._connectStdio(config);
            } else if (transport === 'sse') {
                await this._connectSSE(config);
            } else {
                throw new Error(`Unsupported transport: ${transport}`);
            }
            this._transport = transport;
            const initResult = await this._sendRequest('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {
                    roots: { listChanged: true }
                },
                clientInfo: {
                    name: 'VersePC',
                    version: '1.0.0'
                }
            });
            this._serverInfo = initResult.serverInfo || initResult;
            this._connected = true;
            await this._sendNotification('notifications/initialized', {});
            this.emit('connected', this._serverInfo);
            return initResult;
        } catch (error) {
            this._connected = false;
            this.emit('error', error);
            throw error;
        }
    }

    async disconnect() {
        try {
            if (this._transport === 'stdio' && this._process) {
                this._process.kill();
                this._process = null;
            }
            if (this._transport === 'sse' && this._sseConnection) {
                this._sseConnection.destroy();
                this._sseConnection = null;
            }
            for (const [id, pending] of this._pendingRequests) {
                if (pending.timeout) {
                    clearTimeout(pending.timeout);
                }
                pending.reject(new Error('Connection closed'));
            }
            this._pendingRequests.clear();
            this._connected = false;
            this._serverInfo = null;
            this._tools = [];
            this._resources = [];
            this.emit('disconnected');
        } catch (error) {
            this.emit('error', error);
        }
    }

    isConnected() {
        return this._connected;
    }

    getServerInfo() {
        return this._serverInfo;
    }

    async listTools() {
        if (!this._connected) {
            throw new Error('Not connected to MCP server');
        }
        try {
            const result = await this._sendRequest('tools/list', {});
            this._tools = result.tools || [];
            return this._tools;
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    async callTool(name, args) {
        if (!this._connected) {
            throw new Error('Not connected to MCP server');
        }
        try {
            const result = await this._sendRequest('tools/call', {
                name,
                arguments: args || {}
            });
            return result;
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    async listResources() {
        if (!this._connected) {
            throw new Error('Not connected to MCP server');
        }
        try {
            const result = await this._sendRequest('resources/list', {});
            this._resources = result.resources || [];
            return this._resources;
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    async readResource(uri) {
        if (!this._connected) {
            throw new Error('Not connected to MCP server');
        }
        try {
            const result = await this._sendRequest('resources/read', { uri });
            return result;
        } catch (error) {
            this.emit('error', error);
            throw error;
        }
    }

    getToolsAsVersePCFormat() {
        return this._tools.map(tool => ({
            type: 'function',
            function: {
                name: `mcp_${tool.name}`,
                description: tool.description || '',
                parameters: tool.inputSchema || { type: 'object', properties: {} }
            },
            source: 'mcp',
            serverInfo: this._serverInfo
        }));
    }

    getToolRisks() {
        const risks = {};
        for (const tool of this._tools) {
            const name = `mcp_${tool.name}`;
            if (tool.name.includes('delete') || tool.name.includes('remove')) {
                risks[name] = 'dangerous';
            } else if (tool.name.includes('write') || tool.name.includes('create')) {
                risks[name] = 'moderate';
            } else if (tool.name.includes('read') || tool.name.includes('list') || tool.name.includes('get')) {
                risks[name] = 'safe';
            } else {
                risks[name] = 'moderate';
            }
        }
        return risks;
    }

    async _connectStdio(config) {
        return new Promise((resolve, reject) => {
            try {
                const command = config.command;
                const args = config.args || [];
                const env = { ...process.env, ...(config.env || {}) };
                this._process = spawn(command, args, {
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env,
                    shell: process.platform === 'win32'
                });
                let buffer = '';
                this._process.stdout.on('data', (data) => {
                    buffer += data.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        if (line.trim()) {
                            this._handleMessage(line.trim());
                        }
                    }
                });
                this._process.stderr.on('data', (data) => {
                    this.emit('stderr', data.toString());
                });
                this._process.on('error', (error) => {
                    this._connected = false;
                    reject(error);
                });
                this._process.on('exit', (code) => {
                    this._connected = false;
                    this.emit('exit', code);
                });
                setTimeout(() => resolve(), 100);
            } catch (error) {
                reject(error);
            }
        });
    }

    async _connectSSE(config) {
        return new Promise((resolve, reject) => {
            try {
                const url = new URL(config.url);
                const transport = url.protocol === 'https:' ? https : http;
                const req = transport.get(config.url, (res) => {
                    if (res.statusCode !== 200) {
                        reject(new Error(`SSE connection failed with status ${res.statusCode}`));
                        return;
                    }
                    let eventBuffer = '';
                    let dataBuffer = '';
                    let eventType = '';
                    res.on('data', (chunk) => {
                        eventBuffer += chunk.toString();
                        const events = eventBuffer.split('\n\n');
                        eventBuffer = events.pop();
                        for (const event of events) {
                            const lines = event.split('\n');
                            for (const line of lines) {
                                if (line.startsWith('event:')) {
                                    eventType = line.slice(6).trim();
                                } else if (line.startsWith('data:')) {
                                    dataBuffer += line.slice(5).trim();
                                }
                            }
                            if (dataBuffer) {
                                this._handleSSEEvent(eventType, dataBuffer);
                                dataBuffer = '';
                                eventType = '';
                            }
                        }
                    });
                    res.on('error', (error) => {
                        this._connected = false;
                        this.emit('error', error);
                    });
                    this._sseConnection = res;
                    resolve();
                });
                req.on('error', (error) => {
                    reject(error);
                });
                req.setTimeout(30000, () => {
                    req.destroy();
                    reject(new Error('SSE connection timeout'));
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    _handleSSEEvent(eventType, data) {
        try {
            const message = JSON.parse(data);
            if (eventType === 'message' || !eventType) {
                this._handleMessage(message);
            }
        } catch (error) {
            this.emit('error', error);
        }
    }

    _handleMessage(data) {
        try {
            let message;
            if (typeof data === 'string') {
                message = JSON.parse(data);
            } else {
                message = data;
            }
            if (message.id !== undefined) {
                const pending = this._pendingRequests.get(message.id);
                if (pending) {
                    if (pending.timeout) {
                        clearTimeout(pending.timeout);
                    }
                    this._pendingRequests.delete(message.id);
                    if (message.error) {
                        pending.reject(new Error(message.error.message || 'Unknown error'));
                    } else {
                        pending.resolve(message.result);
                    }
                }
            }
            if (message.method) {
                this.emit('notification', message);
            }
        } catch (error) {
            this.emit('error', error);
        }
    }

    async _sendRequest(method, params) {
        return new Promise((resolve, reject) => {
            try {
                const id = ++this._requestId;
                const request = {
                    jsonrpc: '2.0',
                    id,
                    method,
                    params
                };
                const timeout = setTimeout(() => {
                    this._pendingRequests.delete(id);
                    reject(new Error(`Request timeout: ${method}`));
                }, 60000);
                this._pendingRequests.set(id, { resolve, reject, timeout });
                const message = JSON.stringify(request);
                if (this._transport === 'stdio') {
                    if (!this._process || !this._process.stdin) {
                        reject(new Error('Process not available'));
                        return;
                    }
                    this._process.stdin.write(message + '\n');
                } else if (this._transport === 'sse') {
                    const url = new URL(this._config.url);
                    const transport = url.protocol === 'https:' ? https : http;
                    const postData = JSON.stringify(request);
                    const options = {
                        hostname: url.hostname,
                        port: url.port,
                        path: url.pathname,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(postData)
                        }
                    };
                    const req = transport.request(options, (res) => {
                        let body = '';
                        res.on('data', (chunk) => { body += chunk; });
                        res.on('end', () => {
                            try {
                                const response = JSON.parse(body);
                                if (response.error) {
                                    reject(new Error(response.error.message));
                                } else {
                                    resolve(response.result);
                                }
                            } catch (e) {
                                reject(e);
                            }
                        });
                    });
                    req.on('error', reject);
                    req.write(postData);
                    req.end();
                }
            } catch (error) {
                reject(error);
            }
        });
    }

    async _sendNotification(method, params) {
        try {
            const notification = {
                jsonrpc: '2.0',
                method,
                params
            };
            const message = JSON.stringify(notification);
            if (this._transport === 'stdio' && this._process && this._process.stdin) {
                this._process.stdin.write(message + '\n');
            }
        } catch (error) {
            this.emit('error', error);
        }
    }
}

class MCPManager extends EventEmitter {
    constructor() {
        super();
        this._clients = new Map();
        this._configPath = null;
        this._watcher = null;
    }

    async loadConfig(configPath) {
        this._configPath = configPath || this._getDefaultConfigPath();
        try {
            if (!fs.existsSync(this._configPath)) {
                return this;
            }
            const raw = fs.readFileSync(this._configPath, 'utf-8');
            const config = JSON.parse(raw);
            return config;
        } catch (error) {
            this.emit('error', error);
            return { servers: {} };
        }
    }

    async connectAll(config) {
        const servers = config.servers || {};
        const results = {};
        for (const [name, serverConfig] of Object.entries(servers)) {
            try {
                results[name] = await this.connectServer(name, serverConfig);
            } catch (error) {
                results[name] = { error: error.message };
            }
        }
        return results;
    }

    async connectServer(name, config) {
        if (this._clients.has(name)) {
            await this.disconnectServer(name);
        }
        const client = new MCPClient();
        client.on('error', (error) => {
            this.emit('serverError', { name, error });
        });
        client.on('disconnected', () => {
            this.emit('serverDisconnected', { name });
        });
        await client.connect(config);
        this._clients.set(name, client);
        this.emit('serverConnected', { name, serverInfo: client.getServerInfo() });
        return client;
    }

    async disconnectServer(name) {
        const client = this._clients.get(name);
        if (client) {
            await client.disconnect();
            this._clients.delete(name);
        }
    }

    async disconnectAll() {
        for (const [name] of this._clients) {
            await this.disconnectServer(name);
        }
    }

    getClient(name) {
        return this._clients.get(name);
    }

    getAllClients() {
        return new Map(this._clients);
    }

    isConnected(name) {
        const client = this._clients.get(name);
        return client ? client.isConnected() : false;
    }

    getServerInfo(name) {
        const client = this._clients.get(name);
        return client ? client.getServerInfo() : null;
    }

    async listAllTools() {
        const allTools = [];
        for (const [name, client] of this._clients) {
            if (!client.isConnected()) continue;
            try {
                const tools = await client.listTools();
                for (const tool of tools) {
                    allTools.push({
                        ...tool,
                        serverName: name,
                        fullName: `mcp_${name}_${tool.name}`
                    });
                }
            } catch (error) {
                this.emit('error', { server: name, error });
            }
        }
        return allTools;
    }

    async callTool(serverName, toolName, args) {
        const client = this._clients.get(serverName);
        if (!client) {
            throw new Error(`Server not found: ${serverName}`);
        }
        if (!client.isConnected()) {
            throw new Error(`Server not connected: ${serverName}`);
        }
        return await client.callTool(toolName, args);
    }

    getAllToolsAsVersePCFormat() {
        const tools = [];
        for (const [name, client] of this._clients) {
            if (!client.isConnected()) continue;
            const clientTools = client.getToolsAsVersePCFormat();
            for (const tool of clientTools) {
                tool.function.name = `mcp_${name}_${tool.function.name.replace('mcp_', '')}`;
                tools.push(tool);
            }
        }
        return tools;
    }

    getAllToolRisks() {
        const risks = {};
        for (const [name, client] of this._clients) {
            if (!client.isConnected()) continue;
            const clientRisks = client.getToolRisks();
            for (const [toolName, risk] of Object.entries(clientRisks)) {
                risks[`mcp_${name}_${toolName.replace('mcp_', '')}`] = risk;
            }
        }
        return risks;
    }

    enableAutoReload() {
        if (!this._configPath) return;
        try {
            if (this._watcher) {
                this._watcher.close();
            }
            this._watcher = fs.watch(this._configPath, async (eventType) => {
                if (eventType === 'change') {
                    await this._reloadConfig();
                }
            });
        } catch (error) {
            this.emit('error', error);
        }
    }

    disableAutoReload() {
        if (this._watcher) {
            this._watcher.close();
            this._watcher = null;
        }
    }

    async _reloadConfig() {
        try {
            const config = await this.loadConfig();
            const newServers = Object.keys(config.servers || {});
            const currentServers = Array.from(this._clients.keys());
            for (const name of currentServers) {
                if (!newServers.includes(name)) {
                    await this.disconnectServer(name);
                }
            }
            for (const name of newServers) {
                const serverConfig = config.servers[name];
                const existing = this._clients.get(name);
                if (!existing || !existing.isConnected()) {
                    await this.connectServer(name, serverConfig);
                }
            }
            this.emit('configReloaded', config);
        } catch (error) {
            this.emit('error', error);
        }
    }

    _getDefaultConfigPath() {
        const homeDir = require('os').homedir();
        return path.join(homeDir, '.versepc', 'mcp.json');
    }

    async shutdown() {
        this.disableAutoReload();
        await this.disconnectAll();
    }
}

module.exports = { MCPClient, MCPManager };
