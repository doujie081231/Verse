/**
 * server/modloaders/shared.js - 模组加载器通用工具函数
 * ============================================================================
 * 从 server/modloaders.js 拆分而来。
 * 提供 _curlDownload、ensureBaseVersionInstalled、verifyLoaderLibs、版本比较、
 * 模组需求扫描、加载器兼容性、导入库验证、库校验、NeoForge 镜像 URL 等通用能力。
 * 通过 ctx (../context) 访问共享状态，通过 utils (../utils) 访问工具函数，
 * 通过 http (../http-client) 访问 HTTP 请求，通过 versions (../versions) 访问版本管理，
 * 通过 dependencies (../dependencies) 访问依赖下载。
 */
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ctx = require('../context');
const utils = require('../utils');
const http = require('../http-client');
const versions = require('../versions');
const dependencies = require('../dependencies');

// 项目根目录（server.js 所在目录，用于查找 forge-installer.js 等资源文件）
// 原 modloaders.js 位于 server/，故 path.join(__dirname, '..')；
// 本文件位于 server/modloaders/，需上溯两级到达项目根目录。
const SERVER_DIR = path.join(__dirname, '..', '..');

// ============================================================================
// Async curl download helper - non-blocking alternative to execSync(curl)
// ============================================================================
function _curlDownload(url, destPath) {
    return new Promise((resolve, reject) => {
        const cmd = `curl --silent --location --connect-timeout 10 --max-time 60 --output "${destPath}" "${url}"`;
        exec(cmd, { timeout: 90000, windowsHide: true, stdio: 'ignore' }, (err) => {
            if (err) { reject(err); return; }
            resolve();
        });
    });
}

// ============================================================================
// 基础版本安装
// ============================================================================

async function ensureBaseVersionInstalled(gameVersion, onProgress = null) {
    const baseLog = (msg) => { console.log(`[BaseVersion-DEBUG] ${msg}`); utils._writeImportLog(`[基础版本] ${msg}`); };
    baseLog(`ensureBaseVersionInstalled: ${gameVersion}`);
    const baseJsonPath = path.join(ctx.dirs.VERSIONS_DIR, gameVersion, `${gameVersion}.json`);
    const baseJarPath = path.join(ctx.dirs.VERSIONS_DIR, gameVersion, `${gameVersion}.jar`);
    baseLog(`baseJsonPath: ${baseJsonPath}, exists: ${fs.existsSync(baseJsonPath)}`);
    baseLog(`baseJarPath: ${baseJarPath}, exists: ${fs.existsSync(baseJarPath)}`);
    const report = onProgress || (() => {});

    if (fs.existsSync(baseJsonPath) && fs.existsSync(baseJarPath)) {
        baseLog(`Both files exist, verifying...`);
        try {
            const existingJson = JSON.parse(fs.readFileSync(baseJsonPath, 'utf-8'));
            if (existingJson.downloads?.client?.sha1) {
                baseLog(`Verifying JAR SHA1: ${existingJson.downloads.client.sha1}`);
                const sha1Ok = await utils.verifyFileSha1(baseJarPath, existingJson.downloads.client.sha1);
                if (!sha1Ok) {
                    baseLog(`JAR SHA1 verify failed, re-download`);
                    fs.unlinkSync(baseJarPath);
                } else {
                    let libsOk = true;
                    const libs = existingJson.libraries || [];
                    let checkedCount = 0;
                    for (const lib of libs) {
                        if (checkedCount >= 5) break;
                        if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
                        const artifactPath = lib.downloads?.artifact?.path;
                        if (artifactPath) {
                            checkedCount++;
                            const libFile = path.join(ctx.dirs.LIBRARIES_DIR, artifactPath);
                            if (!fs.existsSync(libFile)) {
                                baseLog(`Lib missing: ${artifactPath}`);
                                libsOk = false;
                                break;
                            }
                        }
                    }
                    if (libsOk) {
                        baseLog(`${gameVersion} already installed (verified)`);
                        return { alreadyInstalled: true };
                    }
                    baseLog(`${gameVersion} libs incomplete, need re-download`);
                }
            } else {
                baseLog(`No sha1 to verify, checking libs...`);
                let libsOk = true;
                const libs = existingJson.libraries || [];
                for (const lib of libs.slice(0, 5)) {
                    const artifactPath = lib.downloads?.artifact?.path;
                    if (artifactPath && !fs.existsSync(path.join(ctx.dirs.LIBRARIES_DIR, artifactPath))) {
                        libsOk = false;
                        break;
                    }
                }
                if (libsOk) {
                    baseLog(`${gameVersion} already installed (no sha1 check)`);
                    return { alreadyInstalled: true };
                }
            }
        } catch (e) {
            baseLog(`Verify error: ${e.message}`);
        }
    }

    baseLog(`${gameVersion} not found or corrupted, installing...`);

    try {
        report('正在获取版本信息...', 15);
        const manifest = await versions.getVersionManifest();
        const versionInfo = manifest.versions.find(v => v.id === gameVersion);

        if (!versionInfo) {
            return { alreadyInstalled: false, error: `找不到版本 ${gameVersion}` };
        }

        report('正在下载版本 JSON...', 20);
        const versionDetails = await versions.getVersionDetails(versionInfo.url);
        const versionDir = path.join(ctx.dirs.VERSIONS_DIR, gameVersion);
        if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

        const jsonPath = path.join(versionDir, `${gameVersion}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(versionDetails, null, 2));

        if (versionDetails.downloads?.client) {
            const clientInfo = versionDetails.downloads.client;
            const clientJarPath = path.join(versionDir, `${gameVersion}.jar`);

            if (!fs.existsSync(clientJarPath) || (clientInfo.sha1 && !(await utils.verifyFileSha1(clientJarPath, clientInfo.sha1)))) {
                report('正在下载客户端...', 25);
                console.log(`[BaseVersion] Downloading client JAR for ${gameVersion}...`);
                await http.downloadFileSyncAsync(clientInfo.url, clientJarPath);
                if (clientInfo.sha1 && !(await utils.verifyFileSha1(clientJarPath, clientInfo.sha1))) {
                    console.warn(`[BaseVersion] Client JAR SHA1 mismatch after download!`);
                }
            }
        }

        const libraries = versionDetails.libraries || [];
        const needDownloadLibs = [];
        for (const lib of libraries) {
            if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
            if (lib.downloads?.artifact) {
                const libPath = utils.safeLibPath(lib.downloads.artifact.path);
                if (!libPath) continue;
                if (!fs.existsSync(libPath) || (lib.downloads.artifact.sha1 && !(await utils.verifyFileSha1(libPath, lib.downloads.artifact.sha1)))) {
                    needDownloadLibs.push(lib);
                }
            }
        }
        const totalLibs = needDownloadLibs.length;
        let downloadedLibs = 0;

        const _collectLibTasks = () => {
            const tasks = [];
            for (const lib of libraries) {
                if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
                if (lib.downloads?.artifact) {
                    const libPath = utils.safeLibPath(lib.downloads.artifact.path);
                    if (!libPath) continue;
                    const needDownload = !fs.existsSync(libPath) ||
                        (lib.downloads.artifact.sha1 && !utils.verifyFileSha1Sync(libPath, lib.downloads.artifact.sha1));
                    if (needDownload && lib.downloads.artifact.url) {
                        tasks.push({ type: 'artifact', lib, libPath });
                    }
                } else if (lib.name) {
                    const parts = lib.name.split(':');
                    if (parts.length >= 3) {
                        const groupPath = parts[0].replace(/\./g, '/');
                        const lname = parts[1];
                        const lversion = parts[2];
                        const classifier = parts.length >= 4 ? parts[3] : '';
                        const jarName = classifier ? `${lname}-${lversion}-${classifier}.jar` : `${lname}-${lversion}.jar`;
                        const libFile = path.join(ctx.dirs.LIBRARIES_DIR, parts[0].replace(/\./g, path.sep), lname, lversion, jarName);
                        if (!fs.existsSync(libFile)) {
                            tasks.push({ type: 'name', lib, libFile, groupPath, lname, lversion, jarName });
                        }
                    }
                }
                if (lib.natives) {
                    const nativeKey = lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
                    if (nativeKey) {
                        const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
                        const nativeDownload = lib.downloads?.classifiers?.[classifier];
                        if (nativeDownload) {
                            const nativeFile = path.join(ctx.dirs.LIBRARIES_DIR, nativeDownload.path);
                            if (!fs.existsSync(nativeFile)) {
                                tasks.push({ type: 'native', lib, nativeDownload, nativeFile });
                            }
                        }
                    }
                }
            }
            return tasks;
        };

        const _allLibTasks = _collectLibTasks();
        const _libParallel = 32;
        if (_allLibTasks.length > 0) {
            let _libDone = 0;
            let _libActive = 0;
            let _libIdx = 0;
            let _libFinish = null;
            const _scheduleLib = () => {
                while (_libActive < _libParallel && _libIdx < _allLibTasks.length) {
                    const task = _allLibTasks[_libIdx++];
                    _libActive++;
                    (async () => {
                        if (task.type === 'artifact') {
                            try {
                                if (fs.existsSync(task.libPath)) fs.unlinkSync(task.libPath);
                                await http.downloadFileWithMirror(task.lib.downloads.artifact.url, task.libPath, null, 3, null, 60000);
                            } catch (e) {
                                console.log(`[BaseVersion] 下载库失败 ${task.lib.name}: ${e.message}, 尝试curl...`);
                                const _bmcl = task.lib.downloads.artifact.url.replace('https://libraries.minecraft.net/', 'https://bmclapi2.bangbang93.com/maven/');
                                const _fm = task.lib.downloads.artifact.url.replace('https://libraries.minecraft.net/', 'https://maven.minecraftforge.net/');
                                try { utils.ensureDirForFile(task.libPath); await _curlDownload(_bmcl, task.libPath); } catch (_) {}
                                if (!fs.existsSync(task.libPath) || fs.statSync(task.libPath).size < 100) {
                                    try { await _curlDownload(_fm, task.libPath); } catch (_) {}
                                }
                                if (!fs.existsSync(task.libPath) || fs.statSync(task.libPath).size < 100) {
                                    try { await _curlDownload(task.lib.downloads.artifact.url, task.libPath); } catch (_) {}
                                }
                            }
                        } else if (task.type === 'name') {
                            const baseUrl = task.lib.url || 'https://libraries.minecraft.net/';
                            const downloadUrl = `${baseUrl}${task.groupPath}/${task.lname}/${task.lversion}/${task.jarName}`;
                            try {
                                await http.downloadFileWithMirror(downloadUrl, task.libFile);
                            } catch (e) {
                                console.log(`[BaseVersion] 下载库失败 ${task.lib.name}: ${e.message}, 尝试curl...`);
                                const _bmcl2 = downloadUrl.replace('https://libraries.minecraft.net/', 'https://bmclapi2.bangbang93.com/maven/');
                                const _fm2 = downloadUrl.replace('https://libraries.minecraft.net/', 'https://maven.minecraftforge.net/');
                                try { utils.ensureDirForFile(task.libFile); await _curlDownload(_bmcl2, task.libFile); } catch (_) {}
                                if (!fs.existsSync(task.libFile) || fs.statSync(task.libFile).size < 100) {
                                    try { await _curlDownload(_fm2, task.libFile); } catch (_) {}
                                }
                                if (!fs.existsSync(task.libFile) || fs.statSync(task.libFile).size < 100) {
                                    try { await _curlDownload(downloadUrl, task.libFile); } catch (_) {}
                                }
                            }
                        } else if (task.type === 'native') {
                            try {
                                await http.downloadFileWithMirror(task.nativeDownload.url, task.nativeFile);
                            } catch (e) {
                                console.log(`[BaseVersion] Failed to download native ${path.basename(task.nativeDownload.path)}: ${e.message}`);
                            }
                        }
                    })().finally(() => {
                        _libActive--;
                        _libDone++;
                        downloadedLibs = _libDone;
                        if (totalLibs > 0) {
                            report(`正在下载库文件 (${downloadedLibs}/${totalLibs})...`, 30 + Math.round(downloadedLibs / totalLibs * 35));
                        }
                        if (_libActive === 0 && _libDone >= _allLibTasks.length && _libFinish) _libFinish();
                        else if (_libActive < _libParallel && _libIdx < _allLibTasks.length) _scheduleLib();
                    });
                }
            };
            await new Promise(resolve => { _libFinish = resolve; _scheduleLib(); });
        } else {
            for (const lib of libraries) {
                if (lib.natives) {
                    const nativeKey = lib.natives[process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'];
                    if (nativeKey) {
                        const classifier = nativeKey.replace('${arch}', process.arch === 'x64' ? '64' : '32');
                        const nativeDownload = lib.downloads?.classifiers?.[classifier];
                        if (nativeDownload) {
                            const nativeFile = path.join(ctx.dirs.LIBRARIES_DIR, nativeDownload.path);
                            if (!fs.existsSync(nativeFile)) {
                                try {
                                    await http.downloadFileWithMirror(nativeDownload.url, nativeFile);
                                } catch (e) {
                                    console.log(`[BaseVersion] Failed to download native ${path.basename(nativeDownload.path)}: ${e.message}`);
                                }
                            }
                        }
                    }
                }
            }
        }

        report('正在下载资源索引...', 68);
        if (versionDetails.assetIndex) {
            const assetIndexDir = path.join(ctx.dirs.ASSETS_DIR, 'indexes');
            if (!fs.existsSync(assetIndexDir)) fs.mkdirSync(assetIndexDir, { recursive: true });
            const assetIndexPath = path.join(assetIndexDir, `${versionDetails.assetIndex.id}.json`);
            if (!fs.existsSync(assetIndexPath) || (versionDetails.assetIndex.sha1 && !(await utils.verifyFileSha1(assetIndexPath, versionDetails.assetIndex.sha1)))) {
                if (fs.existsSync(assetIndexPath)) fs.unlinkSync(assetIndexPath);
                await http.downloadFileWithMirror(versionDetails.assetIndex.url, assetIndexPath);
            }
        }

        report('正在校验库文件...', 72);
        const missingLibs = [];
        const libsToVerify = (versionDetails.libraries || []).filter(l =>
            l.downloads?.artifact?.path && !(l.rules && !versions.evaluateRules(l.rules))
        );
        for (let i = 0; i < Math.min(5, libsToVerify.length); i++) {
            const lib = libsToVerify[i];
            const libFile = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
            if (!fs.existsSync(libFile)) {
                missingLibs.push(lib.downloads.artifact.path);
            }
        }
        if (missingLibs.length > 0) {
            const msg = `基础版本 ${gameVersion} 库文件下载后仍缺失 (${missingLibs.length}个): ${missingLibs[0]}`;
            console.error(`[BaseVersion] ${msg}`);
            return { error: msg };
        }

        console.log(`[BaseVersion] ${gameVersion} installed successfully`);
        return { alreadyInstalled: false, success: true };
    } catch (e) {
        console.error(`[BaseVersion] Failed to install ${gameVersion}:`, e.message);
        try {
            const versionDir = path.join(ctx.dirs.VERSIONS_DIR, gameVersion);
            if (fs.existsSync(versionDir)) {
                fs.rmSync(versionDir, { recursive: true, force: true });
                console.log(`[BaseVersion] Cleaned up failed version directory: ${versionDir}`);
            }
        } catch (cleanupErr) {
            console.error(`[BaseVersion] Failed to cleanup version directory:`, cleanupErr.message);
        }
        return { alreadyInstalled: false, error: `基础版本 ${gameVersion} 安装失败: ${e.message}` };
    }
}

// ============================================================================
// 加载器库验证
// ============================================================================

function verifyLoaderLibs(versionId) {
    try {
        const mergedJson = versions.resolveVersionJson(versionId);
        if (!mergedJson) {
            const jsonPath = path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.json`);
            if (!fs.existsSync(jsonPath)) return false;
            const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            if (!data.libraries || data.libraries.length === 0) return false;
        }
        const libs = mergedJson ? (mergedJson.libraries || []) : [];
        let checked = 0, missing = 0;
        const missingPaths = [];
        for (const lib of libs) {
            if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
            let libPath = null;
            if (lib.downloads?.artifact?.path) {
                libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
            } else if (lib.name) {
                const parts = lib.name.split(':');
                if (parts.length >= 3) {
                    const gp = parts[0].replace(/\./g, path.sep);
                    const nm = parts[1];
                    const vr = parts[2];
                    const cls = parts.length >= 4 ? parts[3] : '';
                    const jn = cls ? `${nm}-${vr}-${cls}.jar` : `${nm}-${vr}.jar`;
                    libPath = path.join(ctx.dirs.LIBRARIES_DIR, gp, nm, vr, jn);
                }
            }
            if (libPath) {
                checked++;
                if (!fs.existsSync(libPath)) {
                    missing++;
                    if (missingPaths.length < 3) missingPaths.push(lib.name || path.basename(libPath));
                }
            }
        }
        if (missing > 0) {
            console.log(`[verifyLoaderLibs] ${versionId}: ${checked}个库, ${missing}个缺失 (${missingPaths.join(', ')}...)`);
            return false;
        }

        const _vlLower = versionId.toLowerCase();
        const _isNeo = _vlLower.includes('neoforge') || _vlLower.includes('neoforged');
        const isForge = _vlLower.includes('forge') && !_isNeo;
        if (isForge && checked > 0) {
            const forgeCoreFiles = [];
            for (const lib of libs) {
                if (!lib.name) continue;
                if (lib.name.startsWith('net.minecraftforge:forge:') && lib.name.split(':').length >= 4) {
                    forgeCoreFiles.push(lib);
                }
                if (lib.name === 'net.minecraftforge:forge' || lib.name.startsWith('net.minecraftforge:forge:')) {
                    forgeCoreFiles.push(lib);
                }
                if (lib.name.startsWith('net.minecraft:client:') && (lib.name.endsWith(':srg') || lib.name.endsWith(':extra'))) {
                    forgeCoreFiles.push(lib);
                }
            }
            let forgeCoreMissing = 0;
            const missingForgeCores = [];
            for (const lib of forgeCoreFiles) {
                const parts = lib.name.split(':');
                const gp = parts[0].replace(/\./g, path.sep);
                const nm = parts[1];
                const vr = parts[2];
                const cl = parts.length >= 4 ? parts[3] : '';
                const jn = cl ? `${nm}-${vr}-${cl}.jar` : `${nm}-${vr}.jar`;
                const fp = path.join(ctx.dirs.LIBRARIES_DIR, gp, nm, vr, jn);
                if (!fs.existsSync(fp)) {
                    forgeCoreMissing++;
                    missingForgeCores.push(path.basename(fp));
                }
            }

            const mainJsonPath = path.join(ctx.dirs.VERSIONS_DIR, versionId, `${versionId}.json`);
            try {
                const mainJson = JSON.parse(fs.readFileSync(mainJsonPath, 'utf-8'));
                if (mainJson.mainClass && mainJson.mainClass.includes('bootstraplauncher')) {
                    const mcMatch = versionId.match(/^(\d+\.\d+(?:\.\d+)?)-forge-(.+)$/);
                    if (mcMatch) {
                        const mcV = mcMatch[1];
                        const fV = mcMatch[2];
                        const forgeVerStr = `${mcV}-${fV}`;
                        const forgeClientPath = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', forgeVerStr, `forge-${forgeVerStr}-client.jar`);
                        const forgeUniversalPath = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraftforge', 'forge', forgeVerStr, `forge-${forgeVerStr}-universal.jar`);
                        const hasForgeJar = (fs.existsSync(forgeClientPath) && utils.isJarIntact(forgeClientPath)) ||
                            (fs.existsSync(forgeUniversalPath) && utils.isJarIntact(forgeUniversalPath));
                        if (!hasForgeJar) {
                            forgeCoreMissing++;
                            missingForgeCores.push(`forge-${forgeVerStr}-client.jar`);
                        }

                        const args = mainJson.arguments?.game || [];
                        const mcpIdx = args.findIndex(a => a === '--fml.mcpVersion');
                        if (mcpIdx >= 0 && mcpIdx + 1 < args.length) {
                            const mcpV = args[mcpIdx + 1];
                            const clientVerStr = `${mcV}-${mcpV}`;
                            for (const suffix of ['srg', 'extra']) {
                                const cp = path.join(ctx.dirs.LIBRARIES_DIR, 'net', 'minecraft', 'client', clientVerStr, `client-${clientVerStr}-${suffix}.jar`);
                                if (!fs.existsSync(cp) || !utils.isJarIntact(cp)) {
                                    forgeCoreMissing++;
                                    missingForgeCores.push(`client-${clientVerStr}-${suffix}.jar`);
                                }
                            }
                        }
                    }
                }
            } catch (_) {}

            if (forgeCoreMissing > 0) {
                console.log(`[verifyLoaderLibs] ${versionId}: 基础库存在但Forge核心文件缺失(${forgeCoreMissing}): ${missingForgeCores.join(', ')}`);
                return false;
            }
            console.log(`[verifyLoaderLibs] ${versionId}: 包含Forge核心文件(${forgeCoreFiles.length}个)全部存在`);
        }

        console.log(`[verifyLoaderLibs] ${versionId}: ${checked}个库全部存在`);
        return checked > 0;
    } catch (e) {
        console.log(`[verifyLoaderLibs] ${versionId}: error ${e.message}`);
        return false;
    }
}

// ============================================================================
// 版本比较与模组需求扫描
// ============================================================================

function compareSemver(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

function parseVersionRequirement(req) {
    if (!req || typeof req !== 'string') return null;
    const m = req.match(/^([><=]+)\s*(.+)/);
    if (!m) return { op: '>=', version: req.trim() };
    return { op: m[1], version: m[2].trim() };
}

function scanModsForLoaderReqs(modsDir) {
    const result = { fabric: null, forge: null };
    if (!fs.existsSync(modsDir)) return result;
    let AdmZip;
    try { AdmZip = require('adm-zip'); } catch (_) { return result; }
    const files = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
    for (const f of files) {
        try {
            const zip = new AdmZip(path.join(modsDir, f));
            let metaEntry = zip.getEntry('fabric.mod.json');
            let isQuilt = false;
            if (!metaEntry) { metaEntry = zip.getEntry('quilt.mod.json'); isQuilt = true; }
            if (!metaEntry) continue;
            const meta = JSON.parse(metaEntry.getData().toString('utf8'));
            const deps = isQuilt ? (meta.quilt_loader?.dependencies || {}) : (meta.depends || {});
            const fabricReq = deps.fabricloader || deps['fabric-loader'];
            if (fabricReq && typeof fabricReq === 'string') {
                const parsed = parseVersionRequirement(fabricReq);
                if (parsed && (parsed.op === '>=' || parsed.op === '=' || parsed.op === '==')) {
                    if (!result.fabric || compareSemver(parsed.version, result.fabric) > 0) {
                        result.fabric = parsed.version;
                    }
                }
            }
            const forgeReq = deps.forge;
            if (forgeReq && typeof forgeReq === 'string') {
                const parsed = parseVersionRequirement(forgeReq);
                if (parsed && (parsed.op === '>=' || parsed.op === '=' || parsed.op === '==')) {
                    if (!result.forge || compareSemver(parsed.version, result.forge) > 0) {
                        result.forge = parsed.version;
                    }
                }
            }
        } catch (_) {}
    }
    return result;
}

async function ensureLoaderCompat(versionId, versionDir, mcVersion, currentLoaderVer, loaderType, progress, abortSignal) {
    const { installFabric } = require('./fabric');
    const { installForge } = require('./forge');
    const modsDir = path.join(versionDir, 'mods');
    const reqs = scanModsForLoaderReqs(modsDir);
    const needed = loaderType === 'fabric' ? reqs.fabric : (loaderType === 'forge' ? reqs.forge : null);
    if (!needed || !currentLoaderVer) return { upgraded: false };
    if (compareSemver(needed, currentLoaderVer) <= 0) return { upgraded: false };
    console.log(`[Modpack] 模组需要 ${loaderType} ≥ ${needed}，当前安装 ${currentLoaderVer}，正在升级...`);
    progress('loader-upgrade', `正在升级 ${loaderType === 'fabric' ? 'Fabric' : 'Forge'} 加载器到 ${needed}...`, 88, [], '');
    let newLoaderVersionId;
    try {
        if (loaderType === 'fabric') {
            newLoaderVersionId = `fabric-loader-${needed}-${mcVersion}`;
            const ir = await installFabric(mcVersion, needed, (p, msg) => {
                progress('loader-upgrade', msg || `安装 Fabric ${needed}...`, 88 + Math.round(p * 2), [], '');
            });
            if (!ir.success) throw new Error(ir.error);
        } else {
            newLoaderVersionId = `${mcVersion}-forge-${needed}`;
            const ir = await installForge(mcVersion, needed, (p, msg) => {
                progress('loader-upgrade', msg || `安装 Forge ${needed}...`, 88 + Math.round(p * 2), [], '');
            });
            if (!ir.success) throw new Error(ir.error);
        }
        const oldJsonPath = path.join(versionDir, `${versionId}.json`);
        if (fs.existsSync(oldJsonPath)) {
            const oldJson = JSON.parse(fs.readFileSync(oldJsonPath, 'utf-8'));
            oldJson.inheritsFrom = newLoaderVersionId;
            let newMainClass = '';
            try {
                const lvJsonPath = path.join(ctx.dirs.VERSIONS_DIR, newLoaderVersionId, `${newLoaderVersionId}.json`);
                if (fs.existsSync(lvJsonPath)) {
                    const lvJson = JSON.parse(fs.readFileSync(lvJsonPath, 'utf-8'));
                    newMainClass = lvJson.mainClass || '';
                }
            } catch (_) {}
            if (newMainClass) oldJson.mainClass = newMainClass;
            fs.writeFileSync(oldJsonPath, JSON.stringify(oldJson, null, 2));
            console.log(`[Modpack] 版本JSON已更新: inheritsFrom → ${newLoaderVersionId}, mainClass → ${newMainClass || '未变更'}`);
        }
        progress('loader-upgrade', `${loaderType === 'fabric' ? 'Fabric' : 'Forge'} 已升级到 ${needed}`, 90, [], '');
        return { upgraded: true, newVersion: needed };
    } catch (e) {
        console.error(`[Modpack] ${loaderType} 升级失败: ${e.message}`);
        progress('loader-upgrade', `${loaderType} 升级失败: ${e.message}（使用原版本继续）`, 90, [], '');
        return { upgraded: false, error: e.message };
    }
}

// ============================================================================
// 导入库验证
// ============================================================================

async function verifyImportLibs(versionId, progress, abortSignal) {
    const mergedJson = versions.resolveVersionJson(versionId);
    const allLibs = mergedJson ? (mergedJson.libraries || []) : [];
    const currentPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    let libChecked = 0, coreLibMissing = 0, nonCoreLibMissing = 0;
    const coreMissingLibFiles = [];
    const nonCoreMissingLibFiles = [];
    const CORE_PREFIXES = ['net.minecraftforge', 'net.neoforged', 'cpw.mods', 'net.minecraft'];

    function isCoreLibrary(libName) {
        if (!libName) return false;
        const pkg = libName.split(':')[0];
        return CORE_PREFIXES.some(p => pkg.startsWith(p));
    }

    for (const lib of allLibs) {
        if (lib.rules && !versions.evaluateRules(lib.rules)) continue;
        if (lib.natives) continue;
        const nameSuffix = lib.name ? lib.name.split(':').pop() : '';
        if (nameSuffix.startsWith('natives-')) {
            let isValid = false;
            if (process.arch === 'x64') {
                const plat = nameSuffix.replace('natives-', '');
                isValid = plat === currentPlatform || plat === currentPlatform + '-x64';
            }
            if (!isValid) continue;
        }
        libChecked++;
        let libPath = null;
        if (lib.downloads?.artifact?.path) {
            libPath = path.join(ctx.dirs.LIBRARIES_DIR, lib.downloads.artifact.path);
        } else if (lib.name) {
            const p = lib.name.split(':');
            if (p.length >= 3) {
                const gp = p[0].replace(/\./g, path.sep);
                const cl = p.length >= 4 ? `-${p[3]}` : '';
                const jn = `${p[1]}-${p[2]}${cl}.jar`;
                libPath = path.join(ctx.dirs.LIBRARIES_DIR, gp, p[1], p[2], jn);
            }
        }
        if (libPath && (!libPath.endsWith('.jar') ? !fs.existsSync(libPath) : !utils.isJarIntact(libPath))) {
            let dlUrl = lib.downloads?.artifact?.url || '';
            if (!dlUrl && lib.name) {
                const p = lib.name.split(':');
                if (p.length >= 3) {
                    const mg = p[0].replace(/\./g, '/');
                    const cl = p.length >= 4 ? `-${p[3]}` : '';
                    const jn = `${p[1]}-${p[2]}${cl}.jar`;
                    const base = lib.url || (p[0].includes('neoforged') ? 'https://maven.neoforged.net/'
                        : (p[0].includes('forge') || p[0].includes('minecraftforge') || p[0].includes('minecraft')
                        ? 'https://maven.minecraftforge.net/' : 'https://libraries.minecraft.net/'));
                    dlUrl = `${base}${mg}/${p[1]}/${p[2]}/${jn}`;
                }
            }
            const libEntry = {
                type: 'library', url: dlUrl || '', path: libPath,
                sha1: lib.downloads?.artifact?.sha1 || '',
                size: lib.downloads?.artifact?.size || 0,
                name: lib.name || path.basename(libPath)
            };
            if (isCoreLibrary(lib.name)) {
                coreLibMissing++;
                coreMissingLibFiles.push(libEntry);
            } else {
                nonCoreLibMissing++;
                nonCoreMissingLibFiles.push(libEntry);
            }
        }
    }
    console.log(`[verifyImport] ${versionId}: 检查${libChecked}个库, 核心缺失${coreLibMissing}个, 非核心缺失${nonCoreLibMissing}个`);

    if (coreLibMissing > 0) {
        if (progress) progress('verify', `正在补全 ${coreLibMissing} 个核心缺失库文件...`, 91, [], '');
        const dlResult = await dependencies.downloadMissingDependencies(coreMissingLibFiles, (p) => {
            if (progress && p.progress !== undefined) {
                const pct = 91 + Math.round((p.progress / 100) * 6);
                progress('verify', `补全核心依赖 (${(p.completed || 0) + (p.failed || 0)}/${coreLibMissing})`, Math.min(pct, 97), [], '');
            }
        }, mergedJson);
        console.log(`[verifyImport] 核心库补全结果: ${dlResult.completed}成功 ${dlResult.failed}失败`);
        if (dlResult.failed > 0) {
            return { ok: false, checked: libChecked, missing: dlResult.failed };
        }
    }

    if (nonCoreLibMissing > 0) {
        if (progress) progress('verify', `正在补全 ${nonCoreLibMissing} 个非核心缺失库文件...`, 91, [], '');
        const dlResult = await dependencies.downloadMissingDependencies(nonCoreMissingLibFiles, (p) => {
            if (progress && p.progress !== undefined) {
                const pct = 91 + Math.round((p.progress / 100) * 6);
                progress('verify', `补全非核心依赖 (${(p.completed || 0) + (p.failed || 0)}/${nonCoreLibMissing})`, Math.min(pct, 97), [], '');
            }
        }, mergedJson);
        console.log(`[verifyImport] 非核心库补全结果: ${dlResult.completed}成功 ${dlResult.failed}失败`);
        if (dlResult.failed > 0) {
            if (progress) progress('verify', `警告: ${dlResult.failed} 个非核心库补全失败，将继续导入`, 93, [], '');
            return { ok: true, checked: libChecked, missing: dlResult.failed, warning: `${dlResult.failed} 个非核心库文件缺失（如 org.apache、com.google 等），导入将继续但可能影响部分功能` };
        }
    }

    if (progress) progress('verify', '完整性检查通过', 93, [], '');
    return { ok: true, checked: libChecked, missing: 0 };
}

function isLibValid(libPath, expectedSize, expectedSha1) {
    if (!fs.existsSync(libPath)) return false;
    try {
        const stat = fs.statSync(libPath);
        if (stat.size === 0) return false;
        if (expectedSize > 0 && stat.size !== expectedSize) return false;
        if (expectedSha1 && typeof expectedSha1 === 'string' && expectedSha1.length === 40) {
            const crypto = require('crypto');
            const content = fs.readFileSync(libPath);
            const hash = crypto.createHash('sha1').update(content).digest('hex');
            return hash === expectedSha1;
        }
        return stat.size > 1024;
    } catch (e) {
        return false;
    }
}

function getNeoLibMirrorUrl(originalUrl) {
    if (!originalUrl) return originalUrl;
    return originalUrl
        .replace('https://maven.neoforged.net/releases/', 'https://bmclapi2.bangbang93.com/maven/')
        .replace('https://maven.neoforged.net/', 'https://bmclapi2.bangbang93.com/maven/')
        .replace('https://maven.minecraftforge.net/', 'https://bmclapi2.bangbang93.com/maven/')
        .replace('https://libraries.minecraft.net/', 'https://bmclapi2.bangbang93.com/libraries/');
}

module.exports = {
    SERVER_DIR,
    ensureBaseVersionInstalled,
    verifyLoaderLibs,
    compareSemver,
    parseVersionRequirement,
    scanModsForLoaderReqs,
    ensureLoaderCompat,
    verifyImportLibs,
    isLibValid,
    getNeoLibMirrorUrl,
};
