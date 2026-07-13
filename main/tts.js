/**
 * main/tts.js - TTS 语音合成 IPC 模块
 * 基于 msedge-tts 调用微软 Edge Read Aloud API
 * 渲染进程通过 IPC 调用，主进程合成音频后返回 ArrayBuffer
 */

const { ipcMain } = require('electron');

let _mod = null;

// 动态加载 ESM 模块（msedge-tts 仅支持 ESM）
async function _loadModule() {
    if (_mod) return _mod;
    try {
        _mod = await import('msedge-tts');
        console.log('[TTS] msedge-tts 模块加载成功');
        return _mod;
    } catch (e) {
        console.error('[TTS] msedge-tts 加载失败:', e.message);
        return null;
    }
}

// 合成音频，返回 Buffer
async function _synthesize(text, voice) {
    const mod = await _loadModule();
    if (!mod) throw new Error('msedge-tts 未加载');
    const { MsEdgeTTS, OUTPUT_FORMAT } = mod;
    const tts = new MsEdgeTTS();
    await tts.setMetadata(
        voice || 'zh-CN-XiaoxiaoNeural',
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
    );
    return new Promise((resolve, reject) => {
        const { audioStream } = tts.toStream(text);
        const chunks = [];
        let done = false;
        const finish = (err, buf) => {
            if (done) return;
            done = true;
            if (err) reject(err);
            else resolve(buf);
        };
        audioStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        audioStream.on('close', () => finish(null, Buffer.concat(chunks)));
        audioStream.on('error', (e) => finish(e));
        // 15 秒超时保护，防止卡死
        setTimeout(() => finish(new Error('TTS 合成超时')), 15000);
    });
}

function registerTTSIPC() {
    // 朗读文本，返回 MP3 音频 Buffer
    ipcMain.handle('tts:speak', async (event, text, voice) => {
        try {
            if (!text || !String(text).trim()) return { ok: false, error: '空文本' };
            const buf = await _synthesize(text, voice);
            if (!buf || buf.length === 0) return { ok: false, error: '合成结果为空' };
            return { ok: true, data: buf };
        } catch (e) {
            console.error('[TTS] 合成失败:', e.message);
            return { ok: false, error: e.message };
        }
    });

    // 停止（保留接口，实际停止在渲染进程控制）
    ipcMain.handle('tts:stop', async () => {
        return { ok: true };
    });
}

module.exports = { registerTTSIPC };
