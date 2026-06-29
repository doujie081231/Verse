/**
 * server/modpack/importer.js - 整合包导入入口与 HMCL/RawZip 导入
 * ============================================================================
 * importModpackFromPath 识别整合包格式并分发给对应导入器；
 * _importHmcl 处理 HMCL (modpack.json) 格式；_importRawZip 处理普通 ZIP。
 */

const fs = require('fs');
const path = require('path');

const ctx = require('../context');
const utils = require('../utils');
const versions = require('../versions');
const modloaders = require('../modloaders');

const { _dedupeVersionId } = require('./shared');
const { _importMrpack } = require('./modrinth');
const { _importCurseForge } = require('./curseforge');

/**
 * 从本地文件路径导入整合包（.mrpack / CurseForge .zip）
 * @param {string} filePath  - 本地文件的绝对路径
 * @param {function} onProgress - 进度回调 ({ stage, message, progress: 0-100 })
 * @param {string} targetVersion - 目标版本ID（版本隔离）
 */
async function importModpackFromPath(filePath, onProgress, targetVersion = '', abortSignal = null) {
    const stageHistory = [];
    const progress = (stage, message, pct, files, currentFile) => {
        const existingIdx = stageHistory.findIndex(s => s.stage === stage);
        if (existingIdx >= 0) {
            stageHistory[existingIdx].progress = pct;
            stageHistory[existingIdx].message = message;
        } else {
            stageHistory.push({ stage, message, progress: pct });
        }
        utils._writeImportLog(`[进度] ${stage} ${Math.round(pct)}% - ${message || ''} ${currentFile ? '(' + currentFile + ')' : ''}`);
        const filesSnapshot = files ? files.slice(0, Math.min(files.length, 200)).map(f => ({ n: f.name, s: f.status, p: f.progress || 0, e: f.error || '', sp: f.speed || 0 })) : [];
        const stagesSnapshot = stageHistory.map(s => ({ stage: s.stage, message: s.message, progress: s.progress }));
        if (typeof onProgress === 'function') onProgress({ stage, message, progress: pct, files: filesSnapshot, currentFile: currentFile || '', stageHistory: stagesSnapshot });
    };

    utils._clearImportLog();
    utils._writeImportLog(`========== 开始导入整合包 ==========`);
    utils._writeImportLog(`文件路径: ${filePath}`);
    utils._writeImportLog(`目标版本: ${targetVersion || '(自动)'}`);
    console.log(`[Modpack] ========== 开始导入整合包 ==========`);
    console.log(`[Modpack] 文件路径: ${filePath}`);
    console.log(`[Modpack] 目标版本: ${targetVersion || '(自动)'}`);

    if (!filePath || !fs.existsSync(filePath)) {
        console.error(`[Modpack] 文件不存在: ${filePath}`);
        return { success: false, error: '文件不存在: ' + filePath };
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.mrpack' && ext !== '.zip') {
        console.error(`[Modpack] 不支持的文件格式: ${ext}`);
        return { success: false, error: '不支持的文件格式，请拖入 .mrpack 或 .zip 整合包' };
    }

    progress('read', '正在读取整合包...', 5);

    let AdmZip;
    try { AdmZip = utils.getAdmZip(); } catch (e) {
        console.error(`[Modpack] 加载 AdmZip 失败:`, e.message);
        return { success: false, error: e.message };
    }

    const fileStat = fs.statSync(filePath);
    console.log(`[Modpack] 文件大小: ${(fileStat.size / 1024 / 1024).toFixed(1)} MB`);
    if (fileStat.size < 1024) {
        console.error(`[Modpack] 文件太小: ${fileStat.size} 字节`);
        return { success: false, error: '文件太小（' + fileStat.size + ' 字节），可能下载不完整' };
    }
    const fd = fs.openSync(filePath, 'r');
    const magicBuf = Buffer.alloc(4);
    fs.readSync(fd, magicBuf, 0, 4, 0);
    fs.closeSync(fd);
    if (magicBuf[0] !== 0x50 || magicBuf[1] !== 0x4B || magicBuf[2] !== 0x03 || magicBuf[3] !== 0x04) {
        console.error(`[Modpack] ZIP magic bytes 无效: ${magicBuf.toString('hex')}`);
        return { success: false, error: '文件格式无效（不是有效的 ZIP 文件），可能下载损坏' };
    }

    let zip;
    try { zip = new AdmZip(filePath); } catch (e) {
        console.error(`[Modpack] 无法读取 ZIP:`, e.message);
        if (ext === '.rar') {
            return { success: false, error: '不支持 rar 格式的压缩包，请解压后重新压缩为 zip 格式再试' };
        }
        if (e.message && (e.message.includes('END header') || e.message.includes('Invalid') || e.message.includes('corrupt'))) {
            return { success: false, error: '整合包文件损坏或下载不完整，请删除后重新下载' };
        }
        return { success: false, error: '打开整合包文件失败，文件可能损坏或为不支持的压缩包格式' };
    }

    // 检测加密ZIP
    try {
        const entries = zip.getEntries();
        const encrypted = entries.some(e => e.header && (e.header.flags & 1) === 1);
        if (encrypted) {
            return { success: false, error: '不支持加密的压缩包，请解压后重新压缩为不加密的 zip 格式再试' };
        }
    } catch (e) {
        console.warn(`[Modpack] 检测加密状态失败:`, e.message);
    }

    const modrinthEntry = zip.getEntry('modrinth.index.json');
    const curseEntry    = zip.getEntry('manifest.json');
    const hmclEntry     = zip.getEntry('modpack.json');
    const mmcEntry      = zip.getEntry('mmc-pack.json');
    utils._writeImportLog(`ZIP分析: Modrinth=${!!modrinthEntry}, CurseForge=${!!curseEntry}, HMCL=${!!hmclEntry}, MMC=${!!mmcEntry}`);

    let result;
    const tempFiles = [];
    try {
        if (modrinthEntry) {
            utils._writeImportLog(`检测到 Modrinth 整合包`);
            console.log(`[Modpack] 检测到 Modrinth 整合包 (.mrpack)`);
            result = await _importMrpack(zip, modrinthEntry, filePath, progress, targetVersion, abortSignal);
        } else if (curseEntry) {
            utils._writeImportLog(`检测到 CurseForge 整合包`);
            console.log(`[Modpack] 检测到 CurseForge 整合包`);
            result = await _importCurseForge(zip, curseEntry, filePath, progress, targetVersion, abortSignal);
        } else if (hmclEntry) {
            utils._writeImportLog(`检测到 HMCL 整合包`);
            console.log(`[Modpack] 检测到 HMCL 整合包 (modpack.json)`);
            result = await _importHmcl(zip, hmclEntry, filePath, progress, targetVersion, abortSignal);
        } else {
            utils._writeImportLog(`未检测到已知格式，尝试普通ZIP导入`);
            console.log(`[Modpack] 未检测到已知整合包格式，尝试作为普通 ZIP 导入`);
            result = await _importRawZip(zip, filePath, progress, targetVersion, abortSignal);
        }
    } catch (e) {
        utils._writeImportLog(`[错误] 异常: ${e.stack || e.message}`);
        console.error(`[Modpack] Import exception:`, e.stack || e.message);
        if (result && result.versionId) {
            versions.cleanupVersionChain(result.versionId);
            console.log(`[Modpack] Cleaned up failed version chain: ${result.versionId}`);
        }
        if (result && result.loaderVersionId) {
            try {
                const loaderDir = path.join(ctx.dirs.VERSIONS_DIR, result.loaderVersionId);
                if (fs.existsSync(loaderDir)) {
                    fs.rmSync(loaderDir, { recursive: true, force: true });
                    console.log(`[Modpack] 清理加载器目录: ${result.loaderVersionId}`);
                }
            } catch (ce) {
                console.error(`[Modpack] 清理加载器目录失败: ${ce.message}`);
            }
        }
        for (const tmp of tempFiles) {
            try {
                if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
            } catch (te) {}
        }
        return { success: false, error: '整合包导入失败: ' + e.message, stageHistory };
    }

    if (result && !result.success && result.versionId) {
        console.error(`[Modpack] 导入失败，清理版本链: ${result.versionId}`);
        versions.cleanupVersionChain(result.versionId);
        if (result.loaderVersionId) {
            try {
                const loaderDir = path.join(ctx.dirs.VERSIONS_DIR, result.loaderVersionId);
                if (fs.existsSync(loaderDir)) {
                    fs.rmSync(loaderDir, { recursive: true, force: true });
                    console.log(`[Modpack] 清理加载器目录: ${result.loaderVersionId}`);
                }
            } catch (ce) {
                console.error(`[Modpack] 清理加载器目录失败: ${ce.message}`);
            }
        }
    }

    if (result?.success) {
        ctx.caches._versionsCache = null;
        ctx.caches._versionsCacheTime = 0;
        utils._writeImportLog(`========== 导入成功 ==========`);
        utils._writeImportLog(`版本ID: ${result.versionId}, 整合包名: ${result.name}`);
        console.log(`[Modpack] ========== 导入成功 ==========`);
        console.log(`[Modpack] 版本ID: ${result.versionId}`);
        console.log(`[Modpack] 整合包名: ${result.name}`);
    } else {
        ctx.caches._versionsCache = null;
        ctx.caches._versionsCacheTime = 0;
        utils._writeImportLog(`========== 导入失败 ==========`);
        utils._writeImportLog(`错误: ${result?.error}`);
        console.error(`[Modpack] ========== 导入失败 ==========`);
        console.error(`[Modpack] 错误: ${result?.error}`);
    }

    return result;
}

// HMCL整合包格式 (modpack.json)
async function _importHmcl(zip, hmclEntry, filePath, progress, targetVersion = '', abortSignal = null) {
    console.log(`[HMCL] ========== 开始解析 HMCL 整合包 ==========`);
    let hmclMeta;
    try {
        hmclMeta = JSON.parse(hmclEntry.getData().toString('utf8'));
    } catch (e) {
        return { success: false, error: '解析 modpack.json 失败: ' + e.message };
    }

    const packName  = (hmclMeta.name || path.basename(filePath, path.extname(filePath))).replace(/[<>:"/\\|?*]/g, '_');
    const mcVersion = hmclMeta.gameVersion || '';
    const author    = hmclMeta.author || '';

    console.log(`[HMCL] 整合包: ${packName}, MC: ${mcVersion}, 作者: ${author}`);
    progress('prepare', `整合包: ${packName}  MC: ${mcVersion}`, 8);

    let versionId = targetVersion ? targetVersion.replace(/ \[外部\d*\]/, '') : _dedupeVersionId(packName);
    let versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);

    if (targetVersion) {
        const existingDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        if (fs.existsSync(existingDir)) {
            // 使用已有版本
        } else {
            const extFolders = versions.loadExternalFolders();
            for (const folder of extFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = versions.scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === versionId);
                if (extV) { versionDir = extV.externalVersionDir; break; }
            }
        }
        if (!fs.existsSync(versionDir)) {
            versionId = _dedupeVersionId(packName);
            versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        }
    }

    const isNewVersion = !fs.existsSync(path.join(versionDir, `${versionId}.json`));
    if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

    let loaderVersionId = null;

    if (isNewVersion && mcVersion) {
        progress('base', '正在准备基础版本...', 5);
        const baseResult = await modloaders.ensureBaseVersionInstalled(mcVersion);
        if (baseResult.error) {
            try { if (fs.existsSync(versionDir)) fs.rmSync(versionDir, { recursive: true, force: true }); } catch (e) {}
            return { success: false, versionId, error: baseResult.error };
        }

        const addons = hmclMeta.addons || [];
        for (const addon of addons) {
            const uid = (addon.uid || '').toLowerCase();
            const ver = addon.version || '';
            if (uid === 'net.minecraftforge' && ver) {
                progress('loader-install', '正在安装Forge...', 20);
                loaderVersionId = `${mcVersion}-forge-${ver}`;
                const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                if (!fs.existsSync(lvJson)) {
                    const ir = await modloaders.installForge(mcVersion, ver, (p, msg) => progress('loader-install', msg || '正在安装Forge...', 20 + p * 15));
                    if (!ir.success) { versions.cleanupVersionChain(versionId); return { success: false, versionId, error: ir.error }; }
                }
                break;
            } else if (uid === 'net.neoforged' && ver) {
                progress('loader-install', '正在安装NeoForge...', 20);
                loaderVersionId = `${mcVersion}-neoforge-${ver}`;
                const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                if (!fs.existsSync(lvJson)) {
                    const ir = await modloaders.installNeoForge(mcVersion, ver, (p, msg) => progress('loader-install', msg || '正在安装NeoForge...', 20 + p * 15));
                    if (!ir.success) { versions.cleanupVersionChain(versionId); return { success: false, versionId, error: ir.error }; }
                }
                break;
            } else if (uid === 'net.fabricmc.fabric-loader' && ver) {
                progress('loader-install', '正在安装Fabric...', 20);
                loaderVersionId = `fabric-loader-${ver}-${mcVersion}`;
                const lvJson = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                let hmclFabricNeedInstall = !fs.existsSync(lvJson);
                if (!hmclFabricNeedInstall) {
                    try {
                        const existingJson = JSON.parse(fs.readFileSync(lvJson, 'utf-8'));
                        if (!(existingJson.libraries || []).some(l => l.name && l.name.startsWith('net.fabricmc:fabric-loader'))) {
                            hmclFabricNeedInstall = true;
                        }
                    } catch (_) { hmclFabricNeedInstall = true; }
                }
                if (hmclFabricNeedInstall) {
                    if (fs.existsSync(lvJson)) {
                        try { fs.rmSync(path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId), { recursive: true, force: true }); } catch (e) {}
                    }
                    const ir = await modloaders.installFabric(mcVersion, ver, (p, msg) => progress('loader-install', msg || '正在安装Fabric...', 20 + p * 15));
                    if (!ir.success) { versions.cleanupVersionChain(versionId); return { success: false, versionId, error: ir.error }; }
                }
                break;
            }
        }

        const versionJson = { id: versionId, inheritsFrom: loaderVersionId || mcVersion, type: 'release', time: new Date().toISOString(), releaseTime: new Date().toISOString() };
        if (loaderVersionId) {
            try {
                const lvJsonPath = path.join(ctx.dirs.VERSIONS_DIR, loaderVersionId, `${loaderVersionId}.json`);
                if (fs.existsSync(lvJsonPath)) { const lvJson = JSON.parse(fs.readFileSync(lvJsonPath, 'utf-8')); if (lvJson.mainClass) versionJson.mainClass = lvJson.mainClass; }
            } catch (e) {}
        }
        fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
        versions._invalidateResolvedJsonCache(versionId);
    }

    progress('extract', '解压覆盖文件...', 20);
    const entries = zip.getEntries();
    let extractCounter = 0;
    for (const entry of entries) {
        if (entry.isDirectory) continue;
        const entryName = entry.entryName;
        if (entryName === 'modpack.json') continue;
        const destPath = path.resolve(versionDir, entryName);
        if (!destPath.startsWith(path.resolve(versionDir) + path.sep)) continue;
        await utils.asyncEnsureDir(destPath);
        for (let attempt = 1; attempt <= 5; attempt++) {
            try { await fs.promises.writeFile(destPath, entry.getData()); break; } catch (e) {
                if (attempt < 5) await new Promise(r => setTimeout(r, (attempt - 1) * 2000));
            }
        }
        if (++extractCounter % 50 === 0) await utils.yieldToEventLoop();
    }

    const packInfo = { name: packName, versionId, packFormat: 'hmcl', importedAt: new Date().toISOString(), sourceFile: filePath, author };
    fs.writeFileSync(path.join(versionDir, 'pack-info.json'), JSON.stringify(packInfo, null, 2));

    if (loaderVersionId) {
        progress('verify', '正在验证依赖完整性...', 90);
        await modloaders.verifyImportLibs(versionId, progress, abortSignal);
    }

    progress('done', `"${packName}" 导入完成！`, 100);
    return { success: true, name: packName, versionId, targetVersion: targetVersion || '', loaderVersionId };
}

async function _importRawZip(zip, filePath, progress, targetVersion = '', abortSignal = null) {
    const settings = versions.loadSettingsCached();
    const packName   = path.basename(filePath, path.extname(filePath)).replace(/[<>:"/\\|?*]/g, '_');
    let versionId;
    let versionDir;

    if (targetVersion) {
        const cleanTargetId = targetVersion.replace(/ \[外部\d*\]/, '');
        const existingDir = path.join(ctx.dirs.VERSIONS_DIR, cleanTargetId);
        if (fs.existsSync(existingDir)) {
            versionId = cleanTargetId;
            versionDir = existingDir;
            console.log(`[RawZip] 安装到现有版本: ${versionId}`);
        } else {
            const extFolders = versions.loadExternalFolders();
            for (const folder of extFolders) {
                if (!fs.existsSync(folder.path)) continue;
                const extVers = versions.scanExternalFolder(folder.path);
                const extV = extVers.find(v => v.id === cleanTargetId);
                if (extV) {
                    versionId = cleanTargetId;
                    versionDir = extV.externalVersionDir;
                    console.log(`[RawZip] 安装到外部版本: ${versionId}`);
                    break;
                }
            }
        }
        if (!versionDir) {
            versionId = _dedupeVersionId(packName);
            versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
            console.log(`[RawZip] 目标版本不存在，创建新版本: ${versionId}`);
        }
    } else {
        versionId = _dedupeVersionId(packName);
        versionDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
        console.log(`[RawZip] 未指定目标版本，创建新版本: ${versionId}`);
    }

    const isNewVersionDirRZ = !fs.existsSync(path.join(versionDir, `${versionId}.json`));
    let baseMcVersion = '';
    try {
        utils.ensureDir(path.join(versionDir, 'dummy.txt'));

    progress('extract', `解压 ${packName}...`, 10);
    try {
        const entries = zip.getEntries();
        let rzExtractYieldCounter = 0;
        for (const entry of entries) {
            const entryName = entry.entryName;
            const destPath = path.resolve(versionDir, entryName);
            if (!destPath.startsWith(path.resolve(versionDir) + path.sep) && destPath !== path.resolve(versionDir)) {
                console.warn(`[Security] Blocked Zip Slip entry: ${entryName}`);
                continue;
            }
            if (entry.isDirectory) {
                await utils.asyncEnsureDir(path.join(versionDir, entryName, 'dummy.txt'));
            } else {
                await utils.asyncEnsureDir(path.join(versionDir, entryName));
                for (let attempt = 1; attempt <= 5; attempt++) {
                    try {
                        await fs.promises.writeFile(destPath, entry.getData());
                        break;
                    } catch (e) {
                        console.warn(`[Modpack] RawZip解压 ${entryName} 第 ${attempt} 次失败: ${e.message}`);
                        if (attempt < 5) await new Promise(r => setTimeout(r, (attempt - 1) * 2000));
                    }
                }
                if (++rzExtractYieldCounter % 50 === 0) await utils.yieldToEventLoop();
            }
        }
    } catch (e) {
        return { success: false, versionId, error: '解压失败: ' + e.message };
    }

    const packInfo = {
        name: packName, versionId: versionId, packFormat: 'raw',
        importedAt: new Date().toISOString(), sourceFile: filePath,
        targetVersion: targetVersion || ''
    };
    fs.writeFileSync(path.join(versionDir, 'pack-info.json'), JSON.stringify(packInfo, null, 2));

    if (isNewVersionDirRZ) {
        try {
            const allInstalled = versions.getInstalledVersions();
            const mcDirs = fs.readdirSync(ctx.dirs.VERSIONS_DIR).filter(d => {
                const dd = path.join(ctx.dirs.VERSIONS_DIR, d);
                if (!fs.statSync(dd).isDirectory()) return false;
                return /^\d+\.\d+(\.\d+)?$/.test(d);
            });
            if (mcDirs.length > 0) {
                baseMcVersion = mcDirs.sort((a, b) => {
                    const pa = a.split('.').map(Number);
                    const pb = b.split('.').map(Number);
                    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
                    return 0;
                })[0];
            }
        } catch (e) {}

        const versionJson = {
            id: versionId,
            inheritsFrom: baseMcVersion || undefined,
            type: 'release',
            time: new Date().toISOString(),
            releaseTime: new Date().toISOString()
        };
        if (baseMcVersion) {
            try {
                const baseResult = await modloaders.ensureBaseVersionInstalled(baseMcVersion);
                if (baseResult.error) console.log(`[RawZip] 基础版本安装失败: ${baseResult.error}`);
            } catch (e) {
                console.log(`[RawZip] 基础版本安装异常: ${e.message}`);
            }
        }
        fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));
        versions._invalidateResolvedJsonCache(versionId);
        console.log(`[RawZip] 创建版本JSON: ${versionId}.json (inheritsFrom: ${baseMcVersion || '无'})`);
    }

    if (baseMcVersion) {
        progress('verify', '正在验证依赖完整性...', 90, [], '');
        await modloaders.verifyImportLibs(versionId, progress, abortSignal);
    }

    progress('done', `"${packName}" 解压完成！`, 100);
    return { success: true, name: packName, versionId, targetVersion: targetVersion || '' };
    } catch (e) {
        console.error('[RawZip] 导入失败:', e);
        try { if (fs.existsSync(versionDir)) { fs.rmSync(versionDir, { recursive: true, force: true }); console.log(`[RawZip] 清理失败目录: ${versionDir}`); } } catch (ce) {}
        return { success: false, versionId, error: e.message || '导入失败' };
    }
}

module.exports = {
    importModpackFromPath,
    _importHmcl,
    _importRawZip,
};
