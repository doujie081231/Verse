/**
 * server/modpack/shared.js - 整合包导入共享工具函数
 * ============================================================================
 * 版本名去重、JAR 修复、路径安全校验、overrides 解压校验等共用工具。
 */

const fs = require('fs');
const path = require('path');

const ctx = require('../context');
const utils = require('../utils');
const logger = require('../logger').createLogger('Modpack');

let AdmZip;
try { AdmZip = require('adm-zip'); } catch (_) {}

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
                    logger.warn(`PowerShell修复失败 ${path.basename(jar.path)}: ${e.message}`);
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
                logger.warn(`解压后JAR损坏: ${relPath} (${jarStat?.size || 0} bytes)，标记待修复`);
            }
        }

        if (++extracted % 50 === 0) utils.yieldToEventLoop();
    }
    return { extracted, corrupted };
}

// 检测 zip 是否为资源包（有 pack.mcmeta 且无 mods.toml）
function _isResourcePackZip(zipPath) {
    if (!AdmZip) return false;
    try {
        const zip = new AdmZip(zipPath);
        const hasMcMeta = zip.getEntry('pack.mcmeta') !== null;
        if (!hasMcMeta) return false;
        const hasModsToml = zip.getEntry('META-INF/mods.toml') !== null
            || zip.getEntry('mcmod.info') !== null;
        return !hasModsToml;
    } catch (_) {
        return false;
    }
}

// 将 mods 目录下误放的资源包 zip 移到 resourcepacks 目录
function relocateMisplacedResourcePacks(versionDir) {
    const result = { relocated: [], skipped: [] };
    const modsDir = path.join(versionDir, 'mods');
    if (!fs.existsSync(modsDir) || !fs.statSync(modsDir).isDirectory()) return result;

    const resourcepacksDir = path.join(versionDir, 'resourcepacks');
    let zipFiles = [];
    try {
        zipFiles = fs.readdirSync(modsDir).filter(f => f.toLowerCase().endsWith('.zip'));
    } catch (_) { return result; }

    for (const zipName of zipFiles) {
        const srcPath = path.join(modsDir, zipName);
        try {
            if (!_isResourcePackZip(srcPath)) {
                result.skipped.push(zipName);
                continue;
            }
            if (!fs.existsSync(resourcepacksDir)) fs.mkdirSync(resourcepacksDir, { recursive: true });
            const dstPath = path.join(resourcepacksDir, zipName);
            // 同名文件已存在则跳过移动，避免覆盖
            if (fs.existsSync(dstPath)) {
                result.skipped.push(zipName);
                continue;
            }
            fs.renameSync(srcPath, dstPath);
            result.relocated.push(zipName);
        } catch (e) {
            result.skipped.push(zipName);
        }
    }
    return result;
}

// ============================================================================
// 模组下载共用：并发解析、超时计算、加权进度聚合
// ============================================================================

const DEFAULT_MODPACK_CONCURRENCY = 64;
const MAX_MODPACK_CONCURRENCY = 64;

// 根据 settings.maxThreads 解析模组下载并发数，默认 64，上限 64
function resolveConcurrency(settings) {
    return Math.min(parseInt(settings && settings.maxThreads, 10) || DEFAULT_MODPACK_CONCURRENCY, MAX_MODPACK_CONCURRENCY);
}

// 按文件大小返回单个模组下载超时（毫秒）
function computeModTimeout(sizeBytes) {
    if (sizeBytes > 50 * 1024 * 1024) return 600000;
    if (sizeBytes > 20 * 1024 * 1024) return 300000;
    if (sizeBytes > 5 * 1024 * 1024) return 180000;
    return 120000;
}

// 创建加权进度聚合器
// modFiles 元素的 status/progress 字段由外部下载流程直接修改，update() 读取这些字段计算总百分比
// 含 200ms 节流 + 平滑算法
function createProgressUpdater({ modFiles, overrideFiles, modCount, progress, getDoneCount, getInFlight }) {
    let lastProgUpdate = 0;
    let lastReportedPct = 0;
    let smoothPct = 0;

    const totalModSize = modFiles.reduce((sum, mf) => sum + Math.max(mf.size || 0, 102400), 0);
    const modWeights = modFiles.map((mf) => Math.max(mf.size || 0, 102400) / totalModSize);

    function update() {
        const now = Date.now();
        let weightedPct = 0;
        for (let i = 0; i < modFiles.length; i++) {
            const mf = modFiles[i];
            const w = modWeights[i] || (1 / modFiles.length);
            weightedPct += ((mf.status === 'completed' || mf.status === 'failed') ? 100 : (mf.progress || 0)) * w;
        }
        const pct = 50 + Math.round((weightedPct / 100) * 45);
        const clamped = Math.min(pct, 95);
        if (smoothPct <= 0 || clamped <= smoothPct) {
            smoothPct = clamped;
        } else {
            smoothPct = smoothPct * 0.75 + clamped * 0.25;
        }
        const finalPct = Math.max(lastReportedPct, Math.round(smoothPct));
        if (finalPct <= lastReportedPct && now - lastProgUpdate < 200) return;
        lastReportedPct = finalPct;
        lastProgUpdate = now;
        const doneCount = getDoneCount();
        const inFlight = getInFlight();
        progress('mods', `下载 Mod (${doneCount}/${modCount}, ${inFlight}个进行中)`, lastReportedPct, [...overrideFiles, ...modFiles], '');
    }

    return { update };
}

module.exports = {
    _dedupeVersionId,
    _repairCorruptedModJars,
    isModpackPathSafe,
    _extractOverridesWithVerification,
    relocateMisplacedResourcePacks,
    DEFAULT_MODPACK_CONCURRENCY,
    MAX_MODPACK_CONCURRENCY,
    resolveConcurrency,
    computeModTimeout,
    createProgressUpdater,
};
