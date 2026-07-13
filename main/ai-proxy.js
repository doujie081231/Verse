/**
 * main/ai-proxy.js - AI 对话代理 IPC 模块
 * 在主进程发起 AI API 请求，绕过渲染进程的 CORS 限制
 * 支持 openai/anthropic/google 三种接口格式
 */

const { ipcMain, net } = require('electron');

function _buildBody(format, model, messages, maxTokens) {
    var tokens = maxTokens || 1024;
    if (format === 'anthropic') {
        var sysMsg = '';
        var userMsgs = [];
        for (var i = 0; i < messages.length; i++) {
            if (messages[i].role === 'system') sysMsg += messages[i].content + '\n';
            else userMsgs.push({ role: messages[i].role, content: messages[i].content });
        }
        return {
            model: model,
            max_tokens: tokens,
            system: sysMsg.trim(),
            messages: userMsgs
        };
    } else if (format === 'google') {
        var contents = [];
        for (var i = 0; i < messages.length; i++) {
            var role = messages[i].role === 'assistant' ? 'model' : 'user';
            if (messages[i].role === 'system') {
                contents.push({ role: 'user', parts: [{ text: messages[i].content }] });
            } else {
                contents.push({ role: role, parts: [{ text: messages[i].content }] });
            }
        }
        return { contents: contents, generationConfig: { maxOutputTokens: tokens } };
    } else {
        // openai 格式
        return { model: model, messages: messages, max_tokens: tokens };
    }
}

function _extractReply(format, data) {
    try {
        if (format === 'anthropic') {
            if (data.content && data.content.length > 0) return data.content[0].text || '(空回复)';
            return '(空回复)';
        } else if (format === 'google') {
            if (data.candidates && data.candidates.length > 0) {
                var parts = data.candidates[0].content && data.candidates[0].content.parts;
                if (parts && parts.length > 0) return parts[0].text || '(空回复)';
            }
            return '(空回复)';
        } else {
            // openai 格式
            if (data.choices && data.choices.length > 0) {
                return data.choices[0].message && data.choices[0].message.content || '(空回复)';
            }
            return '(空回复)';
        }
    } catch (e) {
        return '(解析回复失败: ' + e.message + ')';
    }
}

// 在主进程发起 HTTP 请求，不受 CORS 限制
function _doRequest(options) {
    return new Promise((resolve, reject) => {
        var req = net.request({
            method: 'POST',
            url: options.url,
            redirect: 'follow'
        });
        // 设置请求头
        var headers = options.headers || {};
        var keys = Object.keys(headers);
        for (var i = 0; i < keys.length; i++) {
            req.setHeader(keys[i], headers[keys[i]]);
        }
        var chunks = [];
        req.on('response', (response) => {
            response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                var body = Buffer.concat(chunks).toString('utf8');
                var status = response.statusCode;
                resolve({ status: status, body: body });
            });
        });
        req.on('error', (e) => reject(e));
        // 超时时间：默认 60 秒，可通过 options.timeout 自定义
        var timeoutMs = options.timeout || 60000;
        setTimeout(() => { try { req.abort(); } catch (_) {} reject(new Error('AI 请求超时')); }, timeoutMs);
        var bodyStr = JSON.stringify(options.body);
        req.write(bodyStr, 'utf8');
        req.end();
    });
}

function registerAIProxyIPC() {
    ipcMain.handle('ai:chat', async (event, params) => {
        try {
            var cfg = params || {};
            if (!cfg.provider && !cfg.endpoint) return { ok: false, error: '未配置供应商' };
            if (!cfg.apiKey) return { ok: false, error: '未配置 API Key' };
            if (!cfg.model) return { ok: false, error: '未选择模型' };

            var format = cfg.apiFormat || 'openai';
            var url;
            var headers = { 'Content-Type': 'application/json' };

            // 自定义供应商
            if (cfg.provider === 'custom' || cfg.endpoint) {
                url = cfg.endpoint;
                if (format === 'anthropic') {
                    headers['x-api-key'] = cfg.apiKey;
                    headers['anthropic-version'] = '2023-06-01';
                } else if (format === 'google') {
                    var sep = url.indexOf('?') !== -1 ? '&' : '?';
                    url = url + sep + 'key=' + cfg.apiKey;
                } else {
                    // OpenAI 格式：自动补全 /chat/completions 路径
                    headers['Authorization'] = 'Bearer ' + cfg.apiKey;
                    if (!url.endsWith('/chat/completions') && !url.endsWith('/completions')) {
                        url = url.replace(/\/+$/, '') + '/chat/completions';
                    }
                }
            } else if (cfg.provider === 'google' || format === 'google') {
                url = 'https://generativelanguage.googleapis.com/v1beta/models/' + cfg.model + ':generateContent?key=' + cfg.apiKey;
            } else if (cfg.provider === 'anthropic' || format === 'anthropic') {
                url = cfg.endpoint || 'https://api.anthropic.com/v1/messages';
                headers['x-api-key'] = cfg.apiKey;
                headers['anthropic-version'] = '2023-06-01';
            } else {
                // 预设供应商（openai 格式）
                url = cfg.endpoint;
                headers['Authorization'] = 'Bearer ' + cfg.apiKey;
                if (!url) return { ok: false, error: '供应商缺少接口地址' };
            }

            var body = _buildBody(format, cfg.model, cfg.messages || [], cfg.maxTokens);
            var resp = await _doRequest({ url: url, headers: headers, body: body, timeout: cfg.timeout || 60000 });

            if (resp.status >= 400) {
                return { ok: false, error: 'AI 请求失败（' + resp.status + '）：' + resp.body.substring(0, 300) };
            }

            var data;
            try { data = JSON.parse(resp.body); }
            catch (e) { return { ok: false, error: 'AI 返回非 JSON：' + resp.body.substring(0, 200) }; }

            var reply = _extractReply(format, data);
            return { ok: true, reply: reply };
        } catch (e) {
            console.error('[AI Proxy] 请求失败:', e.message);
            return { ok: false, error: e.message || String(e) };
        }
    });

    // 快速翻译：使用 MyMemory 免费翻译 API（国内唯一可用的免Key接口）
    // 其他接口（有道/百度/必应/谷歌/Lingva/LibreTranslate）均已失效或被墙
    // params: { texts: [string], source?: 'en', target?: 'zh-CN' }
    function _doGetRequest(url, timeoutMs) {
        return new Promise((resolve, reject) => {
            var req = net.request({ method: 'GET', url: url, redirect: 'follow' });
            req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
            var chunks = [];
            req.on('response', (response) => {
                response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                response.on('end', () => {
                    resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') });
                });
            });
            req.on('error', (e) => reject(e));
            setTimeout(() => { try { req.abort(); } catch (_) {} reject(new Error('翻译请求超时')); }, timeoutMs || 10000);
            req.end();
        });
    }

    ipcMain.handle('translate:batch', async (event, params) => {
        try {
            var texts = (params && params.texts) || [];
            if (texts.length === 0) return { ok: true, results: [] };
            var source = (params && params.source) || 'en';
            var target = (params && params.target) || 'zh-CN';
            var langPair = source + '|' + target;
            var results = new Array(texts.length);
            var translatedCount = 0;
            var failedCount = 0;

            // 4 路并行，平衡速度和限流
            var PARALLEL = 4;

            async function translateOne(text, idx) {
                if (!text || !text.trim()) { results[idx] = text; return; }
                var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + encodeURIComponent(langPair);
                for (var retry = 0; retry < 5; retry++) {
                    try {
                        var resp = await _doGetRequest(url, 10000);
                        if (resp.status === 429) {
                            // 限流，等待后重试，逐次加长
                            await new Promise(r => setTimeout(r, 3000 + retry * 2000));
                            continue;
                        }
                        if (resp.status >= 400) { await new Promise(r => setTimeout(r, 1000)); continue; }
                        var data;
                        try { data = JSON.parse(resp.body); }
                        catch (e) { await new Promise(r => setTimeout(r, 1000)); continue; }
                        if (data && data.responseData && data.responseData.translatedText) {
                            results[idx] = data.responseData.translatedText;
                            translatedCount++;
                            return;
                        } else {
                            results[idx] = text;
                            failedCount++;
                            return;
                        }
                    } catch (e) {
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }
                // 重试用完，用原文代替
                results[idx] = text;
                failedCount++;
            }

            for (var i = 0; i < texts.length; i += PARALLEL) {
                var batch = texts.slice(i, i + PARALLEL);
                var promises = [];
                for (var j = 0; j < batch.length; j++) {
                    promises.push(translateOne(batch[j], i + j));
                }
                await Promise.all(promises);
                // 每批间隔 300ms，降低限流概率
                await new Promise(r => setTimeout(r, 300));
            }

            console.log('[Translate] 完成：成功 ' + translatedCount + ' 条，失败 ' + failedCount + ' 条（用原文代替）');
            return { ok: true, results: results, translated: translatedCount, failed: failedCount };
        } catch (e) {
            console.error('[Translate] 请求失败:', e.message);
            return { ok: false, error: e.message || String(e) };
        }
    });
}

module.exports = { registerAIProxyIPC };
