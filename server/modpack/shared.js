/**
 * server/modpack/shared.js - 整合包导入共享工具函数
 * ============================================================================
 * 版本名去重、JAR 修复、路径安全校验、overrides 解压校验等共用工具。
 */

const fs = require('fs');
const path = require('path');

const ctx = require('../context');
const utils = require('../utils');

// 重复版本名自动去重，避免覆盖已有版本
function _dedupeVersionId(baseName) {
    let candidate = baseName;
    let counter = 2;
    while (fs.existsSync(path.join(ctx.dirs.VERSIONS_DIR, candidate))) {
        candidate = `${baseName} (${counter})`;
        counter++;
        if (counter > 999) break;
    }
    return candidate;
}

// 整合包导入后修复损坏的JAR文件
// AdmZip解压大型JAR或特殊压缩格式时可能产生损坏文件
async function _repairCorruptedModJars(versionDir) {
    const modsDir = path.join(versionDir, 'mods');
    if (!fs.existsSync(modsDir)) return { repaired: 0, failed: 0 };

    const corruptedJars = [];
    function scanDir(dir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) { scanDir(fullPath); continue; }
            if (!item.toLowerCase().endsWith('.jar')) continue;
            if (stat.size < 100) { corruptedJars.push({ path: fullPath, reason: 'too_small' }); continue; }
            if (!utils.isJarIntact(fullPath)) { corruptedJars.push({ path: fullPath, reason: 'corrupted' }); }
        }
    }
    scanDir(modsDir);

    if (corruptedJars.length === 0) return { repaired: 0, failed: 0 };

    let repaired = 0, failed = 0;

    for (const jar of corruptedJars) {
        let fixed = false;
        try {
            const tempDir = jar.path + '_repair_tmp';
            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
            fs.mkdirSync(tempDir, { recursive: true });

            if (process.platform === 'win32') {
                try {
                    const { execSync } = require('child_process');
                    execSync(`powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path '${jar.path.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force"`, { stdio: 'pipe', timeout: 30000, windowsHide: true });
                    const files = [];
                    function collectPowershell(d) { for (const i of fs.readdirSync(d)) { const p = path.join(d, i); if (fs.statSync(p).isDirectory()) collectPowershell(p); else files.push(p); } }
                    collectPowershell(tempDir);
                    if (files.length > 0) {
                        const AdmZip = require('adm-zip');
                        const newZip = new AdmZip();
                        for (const f of files) {
                            const rel = path.relative(tempDir, f).replace(/\\/g, '/');
                            newZip.addLocalFile(f, path.dirname(rel));
                        }
                        newZip.writeZip(jar.path);
                        if (utils.isJarIntact(jar.path)) { fixed = true; }
                    }
                } catch (e) {
                    console.warn(`[Modpack] PowerShell修复失败 ${path.basename(jar.path)}: ${e.message}`);
                }
            }

            if (!fixed) {
                const { execSync } = require('child_process');
                const tempDir2 = jar.path + '_unzip_tmp';
                if (fs.existsSync(tempDir2)) fs.rmSync(tempDir2, { recursive: true, force: true });
                fs.mkdirSync(tempDir2, { recursive: true });
                try {
                    execSync(`unzip -o "${jar.path}" -d "${tempDir2}"`, { stdio: 'pipe', timeout: 30000 });
                    const AdmZip = require('adm-zip');
                    const newZip = new AdmZip();
                    function addDirToZip(zip, dir, base) { for (const i of fs.readdirSync(dir)) { const p = path.join(dir, i); if (fs.statSync(p).isDirectory()) addDirToZip(zip, p, base); else zip.addLocalFile(p, path.relative(base, path.dirname(p)).replace(/\\/g, '/')); } }
                    addDirToZip(newZip, tempDir2, tempDir2);
                    newZip.writeZip(jar.path);
                    if (utils.isJarIntact(jar.path)) { fixed = true; }
                } catch (e) {}
                if (fs.existsSync(tempDir2)) fs.rmSync(tempDir2, { recursive: true, force: true });
            }

            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
            console.warn(`[Modpack] 修复失败 ${path.basename(jar.path)}: ${e.message}`);
        }
        if (fixed) repaired++; else failed++;
    }

    return { repaired, failed };
}

const _WIN_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
function isModpackPathSafe(entryPath) {
    if (!entryPath) return false;
    if (entryPath.replace(/\\/g, '/').toLowerCase().startsWith('__macosx/')) return false;
    const segments = entryPath.replace(/\\/g, '/').split('/');
    for (const seg of segments) {
        if (seg && _WIN_RESERVED_NAMES.test(seg)) return false;
    }
    return true;
}

// overrides解压JAR文件后的完整性校验
async function _extractOverridesWithVerification(zip, versionDir, entries) {
    let extracted = 0;
    let corrupted = 0;
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName;
        if (!isModpackPathSafe(entryName)) continue;
        let relPath = null;
        if (entryName.startsWith('overrides/')) relPath = entryName.slice('overrides/'.length);
        else if (entryName.startsWith('client-overrides/')) relPath = entryName.slice('client-overrides/'.length);
        if (!relPath) continue;

        const destPath = path.resolve(versionDir, relPath);
        const resolvedBase = path.resolve(versionDir);
        if (!destPath.startsWith(resolvedBase + path.sep) && destPath !== resolvedBase) continue;

        const isModJar = relPath.toLowerCase().startsWith('mods/') && relPath.toLowerCase().endsWith('.jar');
        await utils.asyncEnsureDir(destPath);

        for (let attempt = 1; attempt <= 5; attempt++) {
            try { await fs.promises.writeFile(destPath, entry.getData()); break; } catch (e) {
                if (attempt < 5) await new Promise(r => setTimeout(r, (attempt - 1) * 2000));
            }
        }

        if (isModJar) {
            const jarStat = fs.existsSync(destPath) ? fs.statSync(destPath) : null;
            if (!jarStat || jarStat.size < 100 || !utils.isJarIntact(destPath)) {
                corrupted++;
                console.warn(`[Modpack] 解压后JAR损坏: ${relPath} (${jarStat?.size || 0} bytes)，标记待修复`);
            }
        }

        if (++extracted % 50 === 0) utils.yieldToEventLoop();
    }
    return { extracted, corrupted };
}

module.exports = {
    _dedupeVersionId,
    _repairCorruptedModJars,
    isModpackPathSafe,
    _extractOverridesWithVerification,
};
