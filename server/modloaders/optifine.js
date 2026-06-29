/**
 * server/modloaders/optifine.js - OptiFine 合并
 * ============================================================================
 * 从 server/modloaders.js 拆分而来。
 * 将 OptiFine 合并到版本 JSON。
 */
const fs = require('fs');
const path = require('path');

const ctx = require('../context');
const http = require('../http-client');
const versions = require('../versions');

async function mergeOptiFineToVersion(versionId, gameVersion, optiFineVersion, onProgress = null) {
    const versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
    const jsonPath = path.join(versionDir, `${versionId}.json`);

    try {
        if (onProgress) onProgress(0, '下载OptiFine...');
        const optiFineApiUrl = `https://optifine.net/downloadx?f=OptiFine_${gameVersion}_${optiFineVersion}.jar&x=${Date.now()}`;
        const optiFinePath = path.join(ctx.dirs.DATA_DIR, 'temp', `OptiFine-${gameVersion}-${optiFineVersion}.jar`);
        if (!fs.existsSync(path.dirname(optiFinePath))) fs.mkdirSync(path.dirname(optiFinePath), { recursive: true });

        await http.downloadFileWithMirror(optiFineApiUrl, optiFinePath);
        if (onProgress) onProgress(1, 'OptiFine下载完成');

        const versionJson = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        versionJson.libraries = versionJson.libraries || [];
        const optiFineLib = {
            name: `optifine:OptiFine:${gameVersion}_${optiFineVersion}`,
            downloads: {
                artifact: {
                    path: `optifine/OptiFine/${gameVersion}_${optiFineVersion}/OptiFine-${gameVersion}_${optiFineVersion}.jar`,
                    sha1: '',
                    size: 0,
                    url: ''
                }
            }
        };

        const targetLibPath = path.join(ctx.dirs.LIBRARIES_DIR, optiFineLib.downloads.artifact.path);
        if (!fs.existsSync(path.dirname(targetLibPath))) {
            // [CRITICAL] ENOTDIR 修复 — 同 ensureDir，清理路径中的文件冲突。
            {
                const _d = path.dirname(targetLibPath);
                for (const _p of _d.split(path.sep).map((_, _i, _a) => _a.slice(0, _i + 1).join(path.sep))) {
                    if (_p) { try { const _s = fs.statSync(_p); if (!_s.isDirectory()) fs.unlinkSync(_p); } catch (_) {} }
                }
            }
            fs.mkdirSync(path.dirname(targetLibPath), { recursive: true });
        }
        fs.copyFileSync(optiFinePath, targetLibPath);
        try { fs.unlinkSync(optiFinePath); } catch (e) {}

        if (!versionJson.libraries.some(l => l.name === optiFineLib.name)) {
            versionJson.libraries.unshift(optiFineLib);
        }

        fs.writeFileSync(jsonPath, JSON.stringify(versionJson, null, 2));
        versions._invalidateResolvedJsonCache(versionId);
        console.log(`[OptiFine] Installed into version: ${versionId}`);
    } catch (e) {
        console.log(`[OptiFine] Install failed: ${e.message}`);
    }
}

module.exports = {
    mergeOptiFineToVersion,
};
