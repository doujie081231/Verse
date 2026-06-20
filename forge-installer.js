const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const params = {};
for (let i = 0; i < args.length; i += 2) {
    params[args[i].replace('--', '')] = args[i + 1];
}

const ROOT = params.root;
const LIBS = params.libs;
const VER_DIR = params.verdir;
const FORGE_VER = params.forgever;
const CONFIG = params.config;
const LOG_FILE = path.join(ROOT, 'temp', 'forge-installer.log');

const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
};

const send = (obj) => {
    process.stdout.write(JSON.stringify(obj) + '\n');
};

try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch (_) {}
fs.writeFileSync(LOG_FILE, '');

log(`ROOT=${ROOT}`);
log(`LIBS=${LIBS}`);
log(`VER_DIR=${VER_DIR}`);
log(`FORGE_VER=${FORGE_VER}`);
log(`CONFIG=${CONFIG}`);

if (!CONFIG || !fs.existsSync(CONFIG)) {
    log('ERROR: Config file not found');
    send({ type: 'done', success: false, error: 'Config file not found' });
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const ip = config.installProfile;
const vj = config.versionJson;
const processorsInfo = config.processors;

log(`\n=== Step 1: Verify files ===`);
log(`Processors: ${processorsInfo.length}`);

const versionDir = VER_DIR;
if (!fs.existsSync(versionDir)) fs.mkdirSync(versionDir, { recursive: true });

const vjId = path.basename(versionDir);
vj.id = vjId;
if (!vj.inheritsFrom) vj.inheritsFrom = FORGE_VER;

const vjPath = path.join(versionDir, `${vjId}.json`);
fs.writeFileSync(vjPath, JSON.stringify(vj, null, 2));
log(`Written version.json: ${vjPath}`);

const ipPath = path.join(versionDir, 'install_profile.json');
fs.writeFileSync(ipPath, JSON.stringify(ip, null, 2));
log(`Written install_profile.json: ${ipPath}`);

send({ type: 'progress', percent: 0.3, message: 'Files verified, running processors...' });

log(`\n=== Step 2: Run processors ===`);

let javaPath = 'java';
try {
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
        const candidate = path.join(javaHome, 'bin', 'java.exe');
        if (fs.existsSync(candidate)) javaPath = candidate;
    }
} catch (_) {}
log(`Java: ${javaPath} exists=${fs.existsSync(javaPath)}`);

function resolveMavenPath(name) {
    const parts = name.split(':');
    if (parts.length < 3) return null;
    const groupPath = parts[0].replace(/\./g, '/');
    const artifact = parts[1];
    let version = parts[2];
    let classifier = '';
    let ext = 'jar';
    let atIdx = version.indexOf('@');
    if (atIdx >= 0) {
        ext = version.substring(atIdx + 1);
        version = version.substring(0, atIdx);
    }
    if (parts[3]) {
        const atIdx3 = parts[3].indexOf('@');
        if (atIdx3 >= 0) {
            classifier = parts[3].substring(0, atIdx3);
            ext = parts[3].substring(atIdx3 + 1);
        } else {
            classifier = parts[3];
        }
    }
    if (parts[4]) {
        const atIdx4 = parts[4].indexOf('@');
        ext = atIdx4 >= 0 ? parts[4].substring(atIdx4 + 1) : parts[4];
    }
    const fileName = classifier ? `${artifact}-${version}-${classifier}.${ext}` : `${artifact}-${version}.${ext}`;
    return path.join(LIBS, groupPath, artifact, version, fileName);
}

function normalizePath(val) {
    if (val && val.match(/^\[.+\]$/g)) {
        const name = val.substring(1, val.length - 1);
        return resolveMavenPath(name);
    }
    return val;
}

function normalizeVariable(val, variables, side) {
    if (!val) return val;
    let result = val.replace(/{([A-Za-z0-9_-]+)}/g, (_, key) => {
        if (key === 'SIDE') return side;
        if (variables[key]) return normalizePath(variables[key][side] || '');
        return '';
    });
    if (result.match(/^\[.+\]$/g)) {
        result = resolveMavenPath(result.substring(1, result.length - 1)) || result;
    }
    return result;
}

const side = 'client';
const variables = {
    SIDE: { client: 'client', server: 'server' },
    MINECRAFT_JAR: {
        client: path.join(ROOT, 'versions', ip.minecraft, `${ip.minecraft}.jar`),
        server: path.join(ROOT, 'versions', ip.minecraft, `${ip.minecraft}-server.jar`),
    },
    ROOT: { client: ROOT, server: ROOT },
    MINECRAFT_VERSION: { client: ip.minecraft, server: ip.minecraft },
    LIBRARY_DIR: { client: LIBS, server: LIBS },
};

if (ip.data) {
    for (const key in ip.data) {
        const val = ip.data[key];
        variables[key] = {
            client: normalizePath(typeof val === 'object' ? (val.client || '') : val),
            server: normalizePath(typeof val === 'object' ? (val.server || '') : val),
        };
    }
}

async function runProcessor(procInfo, index) {
    const { jar, mainClass, classpath: cpNames, args: procArgs } = procInfo;
    log(`\n--- Processor ${index + 1}/${processorsInfo.length}: ${jar} ---`);
    log(`Main-Class: ${mainClass}`);

    const jarPath = resolveMavenPath(jar);
    if (!jarPath || !fs.existsSync(jarPath)) {
        log(`ERROR: Processor jar not found: ${jarPath}`);
        return false;
    }

    const classpath = cpNames
        .map(name => resolveMavenPath(name))
        .filter(p => p && fs.existsSync(p));
    classpath.push(jarPath);
    const cpStr = classpath.join(';');

    const resolvedArgs = procArgs
        .map(a => normalizeVariable(a, variables, side));

    log(`Command: java -cp <${classpath.length} jars> ${mainClass} <${resolvedArgs.length} args>`);

    return new Promise((resolve) => {
        const child = spawn(javaPath, ['-cp', cpStr, mainClass, ...resolvedArgs], {
            timeout: 300000,
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });

        child.on('close', (code) => {
            log(`Exit code: ${code}`);
            if (stdout) log(`stdout: ${stdout.substring(0, 500)}`);
            if (stderr) log(`stderr: ${stderr.substring(0, 500)}`);
            if (code !== 0) {
                log(`Processor FAILED with code ${code}`);
                resolve(false);
            } else {
                log(`Processor completed successfully`);
                resolve(true);
            }
        });

        child.on('error', (err) => {
            log(`ERROR: ${err.message}`);
            resolve(false);
        });
    });
}

async function main() {
    let allOk = true;
    for (let i = 0; i < processorsInfo.length; i++) {
        send({ type: 'progress', percent: 0.4 + (i / processorsInfo.length) * 0.5, message: `Running processor ${i + 1}/${processorsInfo.length}...` });
        const ok = await runProcessor(processorsInfo[i], i);
        if (!ok) {
            log(`\nProcessor ${i + 1} failed, stopping.`);
            allOk = false;
            break;
        }
    }

    if (allOk) {
        log(`\n=== All processors completed successfully ===`);

        const patchedOutputs = [];
        for (const proc of processorsInfo) {
            if (proc.outputs) {
                for (const [file, checksum] of Object.entries(proc.outputs)) {
                    const normalized = normalizeVariable(file, variables, side);
                    if (normalized && fs.existsSync(normalized)) {
                        patchedOutputs.push(normalized);
                    }
                }
            }
        }
        log(`Patched files: ${patchedOutputs.length}`);

        if (patchedOutputs.length > 0) {
            const versionJar = path.join(versionDir, `${vj.id}.jar`);
            let patchedJar = patchedOutputs.find(f => f.endsWith('-client.jar') || f.endsWith('.jar'));

            if (patchedJar) {
                fs.copyFileSync(patchedJar, versionJar);
                log(`Copied patched jar to: ${versionJar}`);
            }
        }

        const mergedForgeLibs = vj.libraries || [];
        const seenNames = new Set(mergedForgeLibs.map(l => l.name).filter(Boolean));
        if (vj.inheritsFrom) {
            const vanillaJsonPath = path.join(ROOT, 'versions', vj.inheritsFrom, `${vj.inheritsFrom}.json`);
            log(`Vanilla JSON path: ${vanillaJsonPath} exists=${fs.existsSync(vanillaJsonPath)}`);
            if (fs.existsSync(vanillaJsonPath)) {
                try {
                    const vanillaJson = JSON.parse(fs.readFileSync(vanillaJsonPath, 'utf8'));
                    const vanillaLibs = vanillaJson.libraries || [];
                    for (const vl of vanillaLibs) {
                        if (vl.name && !seenNames.has(vl.name)) {
                            mergedForgeLibs.push(vl);
                            seenNames.add(vl.name);
                        }
                    }
                    if (vanillaJson.arguments) {
                        if (!vj.arguments) {
                            vj.arguments = vanillaJson.arguments;
                        } else {
                            const mergedGame = [...(vanillaJson.arguments.game || [])];
                            for (const fg of (vj.arguments.game || [])) {
                                const fgStr = typeof fg === 'string' ? fg : JSON.stringify(fg);
                                if (!mergedGame.some(mg => (typeof mg === 'string' ? mg : JSON.stringify(mg)) === fgStr)) {
                                    mergedGame.push(fg);
                                }
                            }
                            vj.arguments.game = mergedGame;
                            const expandedJvm = [];
                            const fjArr = vj.arguments.jvm || [];
                            for (let fji = 0; fji < fjArr.length; fji++) {
                                const fj = fjArr[fji];
                                if (typeof fj === 'string' && (fj === '--add-opens' || fj === '--add-exports' || fj === '--add-reads' || fj === '--add-modules')) {
                                    const vals = [];
                                    while (fji + 1 < fjArr.length && typeof fjArr[fji + 1] === 'string' && !fjArr[fji + 1].startsWith('-')) {
                                        fji++;
                                        vals.push(fjArr[fji]);
                                    }
                                    if (vals.length === 0) {
                                        expandedJvm.push(fj);
                                    } else {
                                        for (const v of vals) { expandedJvm.push(fj, v); }
                                    }
                                } else {
                                    expandedJvm.push(fj);
                                }
                            }
                            const mergedJvm = [...(vanillaJson.arguments.jvm || [])];
                            for (const fj of expandedJvm) {
                                const fjStr = typeof fj === 'string' ? fj : JSON.stringify(fj);
                                if (!mergedJvm.some(mj => (typeof mj === 'string' ? mj : JSON.stringify(mj)) === fjStr)) {
                                    mergedJvm.push(fj);
                                }
                            }
                            vj.arguments.jvm = mergedJvm;
                        }
                    }
                    log(`Merged ${vanillaLibs.length} vanilla libraries, arguments merged`);
                } catch (e) {
                    log(`Warning: Failed to merge vanilla JSON: ${e.message}`);
                }
            }
        }
        const outputJson = {};
        for (const key of Object.keys(vj)) {
            if (key !== 'inheritsFrom') outputJson[key] = vj[key];
        }
        outputJson.libraries = mergedForgeLibs;
        const vjPath2 = path.join(versionDir, `${vj.id}.json`);
        fs.writeFileSync(vjPath2, JSON.stringify(outputJson, null, 2));
        try { fs.fsyncSync(fs.openSync(vjPath2, 'r')); } catch (_) {}
        log(`Wrote version JSON (inheritsFrom removed): ${vjPath2}`);

        send({ type: 'progress', percent: 1.0, message: 'Forge install complete' });
        send({ type: 'done', success: true, versionId: vj.id });
        log(`\n=== SUCCESS ===`);
        process.exit(0);
    } else {
        send({ type: 'done', success: false, error: 'Processor execution failed' });
        log(`\n=== FAILED ===`);
        process.exit(1);
    }
}

main().catch(err => {
    log(`FATAL: ${err.message}`);
    send({ type: 'done', success: false, error: err.message });
    process.exit(1);
});
