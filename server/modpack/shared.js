/**
 * server/modpack/shared.js - 整合包导入共享工具函数
 * ============================================================================
 * 版本名去重、JAR 修复、路径安全校验、overrides 解压校验等共用工具。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ctx = require('../context');
const utils = require('../utils');
const http = require('../http-client');
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
            // 扫描阶段用轻量 isJarIntact（只读 PK 头 + EOCD 尾 + 中央目录头）
            // isJarIntactDeep 会 AdmZip 解压所有条目，340 个 jar 耗时 100s+，是 repair 主要瓶颈
            // 下载阶段已通过 SHA1 严格校验，结构级损坏由 isJarIntact 即可检测
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
            // [P0 FIX - 2026-07-21] 不预先创建 tempDir
            // PowerShell 5.1 的 Expand-Archive 遇到已存在的目标目录会报 "DirectoryExist" 错误
            // 即使加 -Force 也无效（PS 5.1 的 bug），让 Expand-Archive 自己创建目录
            const tempDirParent = path.dirname(tempDir);
            if (!fs.existsSync(tempDirParent)) fs.mkdirSync(tempDirParent, { recursive: true });

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
                        if (utils.isJarIntactDeep(jar.path)) { fixed = true; }
                    }
                } catch (e) {
                    logger.warn(`PowerShell修复失败 ${path.basename(jar.path)}: ${e.message}`);
                }
            }

            if (!fixed) {
                const { execSync } = require('child_process');
                const tempDir2 = jar.path + '_unzip_tmp';
                if (fs.existsSync(tempDir2)) fs.rmSync(tempDir2, { recursive: true, force: true });
                // 同上：不预先创建目录，让 unzip 自己创建
                const tempDir2Parent = path.dirname(tempDir2);
                if (!fs.existsSync(tempDir2Parent)) fs.mkdirSync(tempDir2Parent, { recursive: true });
                try {
                    execSync(`unzip -o "${jar.path}" -d "${tempDir2}"`, { stdio: 'pipe', timeout: 30000 });
                    const AdmZip = require('adm-zip');
                    const newZip = new AdmZip();
                    function addDirToZip(zip, dir, base) { for (const i of fs.readdirSync(dir)) { const p = path.join(dir, i); if (fs.statSync(p).isDirectory()) addDirToZip(zip, p, base); else zip.addLocalFile(p, path.relative(base, path.dirname(p)).replace(/\\/g, '/')); } }
                    addDirToZip(newZip, tempDir2, tempDir2);
                    newZip.writeZip(jar.path);
                    if (utils.isJarIntactDeep(jar.path)) { fixed = true; }
                } catch (e) {}
                if (fs.existsSync(tempDir2)) fs.rmSync(tempDir2, { recursive: true, force: true });
            }

            if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {
            console.warn(`[Modpack] 修复失败 ${path.basename(jar.path)}: ${e.message}`);
        }
        if (fixed) { repaired++; }
        else {
            // [P0 FIX - 2026-07-21] 修复失败时保留原文件，不删除
            // 下载阶段已通过 SHA1 严格校验，文件内容正确
            // isJarIntact 的 EOCD 位置检查可能误判带数字签名或有尾部数据的 JAR
            // 保留文件让游戏自己决定能否加载，好过直接删除导致 mod 缺失
            logger.warn(`[Modpack] JAR 文件结构异常但保留: ${path.basename(jar.path)} (已通过 SHA1 校验)`);
            failed++;
        }
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
            if (!jarStat || jarStat.size < 100 || !utils.isJarIntactDeep(destPath)) {
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

// ============================================================================
// Modrinth 整合包缺失 mod 补全（处理 missing_mods_checker.json）
// ============================================================================
// 部分在 Modrinth 发布的整合包（如 Better MC）会带一个 missing_mods_checker.json，
// 列出整合包需要但 Modrinth 平台无法打包的 CurseForge 独占文件。
// 若不下载这些文件，启动游戏时 MissingModsChecker mod 会弹窗并阻止游戏启动。
// 本函数在 Modrinth 整合包正常 mod 下载完成后，读取该清单并从 CurseForge 补全文件。

const _MISSING_MODS_CHECKER_PATHS = [
    'config/missing_mods_checker.json',
    'overrides/config/missing_mods_checker.json'
];

// 从 CurseForge 下载链接中提取 fileID
// 形如 https://www.curseforge.com/minecraft/mc-mods/falling-tree/download/5010620
function _extractCurseForgeFileId(url) {
    if (!url || typeof url !== 'string') return null;
    const m = url.match(/\/download\/(\d+)(?:[/?#]|$)/);
    return m ? parseInt(m[1], 10) : null;
}

/**
 * 在版本目录中查找是否已存在匹配 pattern 的文件，避免重复下载。
 * @param {string} destDir - 目标目录（如 mods/resourcepacks）
 * @param {string} pattern - 预期文件名（如 "FallingTree-1.20.1-4.3.4.jar"）
 * @returns {boolean}
 */
function _findExistingFile(destDir, pattern) {
    if (!fs.existsSync(destDir) || !pattern) return false;
    try {
        const lowerPattern = pattern.toLowerCase();
        const entries = fs.readdirSync(destDir);
        // 优先精确匹配
        if (entries.some((f) => f.toLowerCase() === lowerPattern)) return true;
        // [P0 FIX - 2026-07-21] 前缀匹配必须至少包含 pattern 中 '-' 之前的全部单词
        // 原 startsWith(baseName) 太宽松："Mandala's GUI - Dark Mode Compat 0.3.2.zip"
        // 的 baseName 会被 "Mandala Utopia.zip" 误判为已存在。
        // 新规则：候选文件名必须包含 baseName 作为前缀（整段），而不是只有第一个词。
        const baseName = lowerPattern.replace(/\.(jar|zip|disable)$/, '');
        return entries.some((f) => f.toLowerCase().startsWith(baseName));
    } catch (_) {
        return false;
    }
}

/**
 * 解析 missing_mods_checker.json 中的条目，规范化为统一格式。
 * @param {Array} items - 原始数组
 * @returns {Array<{fileId: number, destination: string, pattern: string, displayName: string, url: string}>}
 */
function _normalizeMissingModsItems(items) {
    const result = [];
    if (!Array.isArray(items)) return result;
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const url = item.url || item.link || '';
        const fileId = _extractCurseForgeFileId(url);
        if (!fileId) {
            logger.warn(`[MissingMods] 无法识别 fileID，跳过: ${item.displayName || url}`);
            continue;
        }
        const destination = (item.destination || 'mods').replace(/[\\]+/g, '/').replace(/^\/+|\/+$/g, '');
        // 只允许已知目录，防止路径遍历
        if (!['mods', 'resourcepacks', 'datapacks', 'shaderpacks'].includes(destination)) {
            logger.warn(`[MissingMods] 非法 destination "${destination}"，跳过: ${item.displayName || url}`);
            continue;
        }
        result.push({
            fileId,
            destination,
            pattern: item.pattern || '',
            displayName: item.displayName || item.name || `file-${fileId}`,
            url
        });
    }
    return result;
}

/**
 * 读取 zip 中的 missing_mods_checker.json，返回规范化条目数组。
 * 找不到返回空数组（不报错，因为不是所有整合包都有这个文件）。
 * @param {object} zip - AdmZip 实例
 * @returns {Array}
 */
function _readMissingModsCheckerFromZip(zip) {
    if (!zip) return [];
    for (const candidate of _MISSING_MODS_CHECKER_PATHS) {
        try {
            const entry = zip.getEntry(candidate);
            if (entry && !entry.isDirectory) {
                const raw = JSON.parse(entry.getData().toString('utf8'));
                const items = _normalizeMissingModsItems(raw);
                if (items.length > 0) {
                    logger.log(`[MissingMods] 从 ${candidate} 读取到 ${items.length} 个待补全文件`);
                    return items;
                }
            }
        } catch (e) {
            logger.warn(`[MissingMods] 读取 ${candidate} 失败: ${e.message}`);
        }
    }
    return [];
}

/**
 * 从 CurseForge 下载 missing_mods_checker.json 列出的文件。
 * 在 Modrinth 整合包 mod 下载完成后调用，补全 CurseForge 独占文件。
 * 启动前检查时也可调用：第一个参数传入 items 数组（已解析的文件列表）
 *
 * @param {object|Array} zipOrItems - AdmZip 实例 或 已解析的 items 数组
 * @param {string} versionDir - 版本目录绝对路径
 * @param {object} settings - 设置对象（读取 curseforgeApiKey）
 * @param {(stage: string, message: string, percent: number) => void} [progress] - 进度回调
 * @param {AbortSignal} [abortSignal=null] - 取消信号
 * @returns {Promise<{downloaded: number, skipped: number, failed: number, failedItems: Array}>}
 */
async function _downloadMissingModsCheckerFiles(zipOrItems, versionDir, settings, progress, abortSignal = null) {
    // 支持两种调用方式：传入 zip 对象（导入时）或 items 数组（启动前检查时）
    const items = Array.isArray(zipOrItems) ? zipOrItems : _readMissingModsCheckerFromZip(zipOrItems);
    if (items.length === 0) {
        return { downloaded: 0, skipped: 0, failed: 0, failedItems: [] };
    }

    const cfApiKey = (settings && settings.curseforgeApiKey) || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';
    if (!cfApiKey) {
        logger.warn(`[MissingMods] 未配置 CurseForge API Key，跳过 ${items.length} 个文件下载`);
        return { downloaded: 0, skipped: 0, failed: items.length, failedItems: items.map((i) => ({ ...i, error: '未配置 API Key' })) };
    }

    // 过滤掉已存在的文件
    const pending = [];
    let skipped = 0;
    for (const item of items) {
        const destDir = path.join(versionDir, item.destination);
        if (_findExistingFile(destDir, item.pattern)) {
            skipped++;
            logger.log(`[MissingMods] 已存在，跳过: ${item.displayName} (${item.pattern})`);
        } else {
            pending.push(item);
        }
    }

    if (pending.length === 0) {
        logger.log(`[MissingMods] 全部 ${items.length} 个文件已存在，无需下载`);
        return { downloaded: 0, skipped, failed: 0, failedItems: [] };
    }

    logger.log(`[MissingMods] 需下载 ${pending.length} 个文件（已跳过 ${skipped} 个）`);
    if (progress) progress('cf-extra', `正在从 CurseForge 补全 ${pending.length} 个额外文件...`, 86);

    // 批量获取文件信息
    const fileInfoMap = {};
    const BATCH_SIZE = 50;
    for (let bi = 0; bi < pending.length; bi += BATCH_SIZE) {
        if (abortSignal && abortSignal.aborted) break;
        const batch = pending.slice(bi, bi + BATCH_SIZE);
        try {
            const batchRes = await http.fetchJSONWithMethod(
                `${ctx.urls.CURSEFORGE_API}/mods/files`,
                'POST',
                JSON.stringify({ fileIds: batch.map((f) => f.fileId) }),
                { 'x-api-key': cfApiKey, 'Content-Type': 'application/json' }
            );
            if (batchRes && batchRes.data) {
                for (const fi of batchRes.data) fileInfoMap[fi.id] = fi;
            }
        } catch (e) {
            logger.warn(`[MissingMods] 批量获取文件信息失败: ${e.message}`);
        }
    }

    // 并发下载
    const PARALLEL = Math.min(resolveConcurrency(settings), 16);
    const agent = new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: PARALLEL + 4,
        maxFreeSockets: 8,
        timeout: 180000
    });

    let downloaded = 0;
    let failed = 0;
    const failedItems = [];
    let inFlight = 0;
    let taskIdx = 0;

    const downloadOne = async (item) => {
        inFlight++;
        try {
            if (abortSignal && abortSignal.aborted) {
                failedItems.push({ ...item, error: '已取消' });
                failed++;
                return;
            }

            const info = fileInfoMap[item.fileId];
            if (!info || !info.downloadUrl) {
                logger.warn(`[MissingMods] 无法获取下载链接: ${item.displayName} (fileId=${item.fileId})`);
                failedItems.push({ ...item, error: 'CurseForge 未返回下载链接' });
                failed++;
                return;
            }

            const fileName = info.fileName || item.pattern || `${item.displayName}.jar`;
            const destDir = path.join(versionDir, item.destination);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            const destPath = path.join(destDir, fileName);

            // 已存在且完整则跳过
            if (fs.existsSync(destPath) && utils.isJarIntact(destPath)) {
                downloaded++;
                return;
            }

            const timeout = computeModTimeout(info.fileLength || 0);
            const perTryAbort = new AbortController();
            const perTryTimeout = setTimeout(() => { try { perTryAbort.abort(); } catch (_) {} },
                Math.max(120000, timeout + 30000));
            if (abortSignal) {
                abortSignal.addEventListener('abort', () => { try { perTryAbort.abort(); } catch (_) {} }, { once: true });
            }

            try {
                const allUrls = http.getMirrorUrls(info.downloadUrl);
                let ok = false;
                for (const mirrorUrl of allUrls) {
                    if (ok || perTryAbort.signal.aborted) break;
                    try {
                        await http._dlSingle(mirrorUrl, destPath, {
                            onProgress: (p) => {
                                if (progress && p) {
                                    const pct = 86 + Math.round((downloaded / pending.length) * 2);
                                    progress('cf-extra', `补全 CurseForge 文件 (${downloaded + 1}/${pending.length}) ${fileName}`, pct);
                                }
                            },
                            retries: 3,
                            stallTimeout: 45000,
                            abortSignal: perTryAbort.signal,
                            timeout,
                            agent
                        });
                        // [P0 FIX - 2026-07-21] 下载后立即复查文件存在性
                        // 之前的 bug：.zip 文件直接 ok=true 不验证；.jar 通过 isJarIntact 后到
                        // 记日志之间，文件可能被杀毒软件删除，导致日志显示成功但文件实际丢失
                        const isJar = fileName.toLowerCase().endsWith('.jar');
                        const isZip = fileName.toLowerCase().endsWith('.zip');
                        if (!fs.existsSync(destPath)) {
                            // 文件不存在（可能被杀软删除），标记失败继续下一个镜像
                            logger.warn(`[MissingMods] 下载后文件不存在: ${fileName}（可能被杀毒软件删除），尝试下一个镜像`);
                            continue;
                        }
                        const finalStat = fs.statSync(destPath);
                        if (finalStat.size === 0) {
                            try { fs.unlinkSync(destPath); } catch (_) {}
                            logger.warn(`[MissingMods] 下载后文件为 0 字节: ${fileName}，尝试下一个镜像`);
                            continue;
                        }
                        if (isJar && !utils.isJarIntact(destPath)) {
                            try { fs.unlinkSync(destPath); } catch (_) {}
                            logger.warn(`[MissingMods] JAR 结构校验失败: ${fileName}，尝试下一个镜像`);
                            continue;
                        }
                        // zip 和 jar 都通过：再次确认文件还在（防止 race condition）
                        if (fs.existsSync(destPath)) {
                            ok = true;
                        }
                    } catch (e) {
                        if (abortSignal && abortSignal.aborted) break;
                        try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
                    }
                }
                if (ok) {
                    // [P0 FIX] 记日志前最后确认一次文件确实还在
                    if (fs.existsSync(destPath)) {
                        downloaded++;
                        logger.log(`[MissingMods] 下载成功: ${fileName} -> ${item.destination}/`);
                    } else {
                        // 极端情况：刚刚 ok=true 但瞬间文件消失，标记失败
                        failed++;
                        failedItems.push({ ...item, error: '下载成功后文件被外部程序删除' });
                        logger.warn(`[MissingMods] 文件下载后消失: ${item.displayName}`);
                    }
                } else {
                    failed++;
                    failedItems.push({ ...item, error: '下载失败或文件不完整' });
                    logger.warn(`[MissingMods] 下载失败: ${item.displayName}`);
                }
            } finally {
                clearTimeout(perTryTimeout);
            }
        } catch (e) {
            failed++;
            failedItems.push({ ...item, error: e.message });
            logger.warn(`[MissingMods] 下载异常: ${item.displayName} - ${e.message}`);
        } finally {
            inFlight--;
        }
    };

    const runNext = async () => {
        while (taskIdx < pending.length) {
            if (abortSignal && abortSignal.aborted) break;
            const idx = taskIdx++;
            await downloadOne(pending[idx]);
        }
    };
    const pool = [];
    for (let p = 0; p < Math.min(PARALLEL, pending.length); p++) {
        pool.push(runNext());
    }
    await Promise.all(pool);

    // [P0 FIX - 2026-07-21] 二次验证：扫描所有 pending 文件，缺的重下
    // 之前的 bug：下载成功记日志后，文件可能被杀毒软件静默删除，
    // 但流程已经走完，导致最终文件缺失。这里强制做最终扫描+重试
    const MAX_RETRY_ROUNDS = 3;
    for (let round = 1; round <= MAX_RETRY_ROUNDS; round++) {
        if (abortSignal && abortSignal.aborted) break;
        const stillMissing = [];
        for (const item of pending) {
            const info = fileInfoMap[item.fileId];
            if (!info) continue;
            const fileName = info.fileName || item.pattern || `${item.displayName}.jar`;
            const destDir = path.join(versionDir, item.destination);
            const destPath = path.join(destDir, fileName);
            // 文件不存在或大小为 0，加入重试列表
            let needRetry = false;
            if (!fs.existsSync(destPath)) {
                needRetry = true;
            } else {
                try {
                    const stat = fs.statSync(destPath);
                    if (stat.size === 0) needRetry = true;
                    else if (fileName.toLowerCase().endsWith('.jar') && !utils.isJarIntact(destPath)) needRetry = true;
                } catch (_) { needRetry = true; }
            }
            if (needRetry) {
                // 排除已经计入 failedItems 的（避免重复计数）
                const alreadyFailed = failedItems.some(fi => fi.fileId === item.fileId);
                if (!alreadyFailed) stillMissing.push(item);
            }
        }
        if (stillMissing.length === 0) {
            logger.log(`[MissingMods] 第 ${round} 轮验证通过：所有文件齐全`);
            break;
        }
        logger.warn(`[MissingMods] 第 ${round} 轮验证发现 ${stillMissing.length} 个文件缺失，重试下载...`);
        if (progress) progress('cf-extra', `第 ${round} 轮验证：补下 ${stillMissing.length} 个缺失文件...`, 88);
        // 串行重试（避免并发再次触发杀软扫描）
        for (const item of stillMissing) {
            if (abortSignal && abortSignal.aborted) break;
            // 复用 downloadOne 逻辑，但它会计数，所以临时包装
            const info = fileInfoMap[item.fileId];
            if (!info || !info.downloadUrl) continue;
            const fileName = info.fileName || item.pattern || `${item.displayName}.jar`;
            const destDir = path.join(versionDir, item.destination);
            if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
            const destPath = path.join(destDir, fileName);
            const allUrls = http.getMirrorUrls(info.downloadUrl);
            let retryOk = false;
            for (const mirrorUrl of allUrls) {
                if (retryOk) break;
                try {
                    // 串行下载，间隔 500ms 避免触发杀软
                    await new Promise(r => setTimeout(r, 500));
                    await http._dlSingle(mirrorUrl, destPath, {
                        retries: 5,
                        stallTimeout: 60000,
                        timeout: 180000,
                        agent
                    });
                    // 立即复查
                    if (fs.existsSync(destPath)) {
                        const stat = fs.statSync(destPath);
                        if (stat.size > 0) {
                            if (fileName.toLowerCase().endsWith('.jar')) {
                                if (utils.isJarIntact(destPath)) retryOk = true;
                                else { try { fs.unlinkSync(destPath); } catch (_) {} }
                            } else {
                                retryOk = true;
                            }
                        }
                    }
                } catch (e) {
                    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
                }
            }
            if (retryOk) {
                // 从失败列表移除（如果在），加入成功计数
                const failIdx = failedItems.findIndex(fi => fi.fileId === item.fileId);
                if (failIdx >= 0) failedItems.splice(failIdx, 1);
                failed = Math.max(0, failed - 1);
                downloaded++;
                logger.log(`[MissingMods] 第 ${round} 轮重试成功: ${fileName} -> ${item.destination}/`);
            } else {
                logger.warn(`[MissingMods] 第 ${round} 轮重试仍失败: ${item.displayName}`);
            }
        }
    }

    try { agent.destroy(); } catch (_) {}

    logger.log(`[MissingMods] 补全完成: ${downloaded}成功 ${skipped}已存在 ${failed}失败`);
    return { downloaded, skipped, failed, failedItems };
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
    _downloadMissingModsCheckerFiles,
    _normalizeMissingModsItems,
};
