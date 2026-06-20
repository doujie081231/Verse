const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VERSION_ID = 'Zombie Invade 100 Days';
const VERSIONS_DIR = path.join(process.env.USERPROFILE, '.versepc', 'versions');
const LIBRARIES_DIR = path.join(process.env.USERPROFILE, '.versepc', 'libraries');
const GAME_DIR = path.join(process.env.USERPROFILE, '.versepc', 'gameDirectory');
const VERSION_DIR = path.join(VERSIONS_DIR, VERSION_ID);
const VERSION_JSON_PATH = path.join(VERSION_DIR, `${VERSION_ID}.json`);

const versionJson = JSON.parse(fs.readFileSync(VERSION_JSON_PATH, 'utf-8'));

const JAVA_PATH = 'java';

const variables = {
    '${auth_player_name}': 'TestPlayer',
    '${version_name}': VERSION_ID,
    '${library_directory}': LIBRARIES_DIR,
    '${classpath_separator}': ';',
    '${assets_index_name}': versionJson.assetIndex?.id || '1.19',
    '${user_properties}': '{}',
    '${user_type}': 'msa',
    '${natives_directory}': VERSION_DIR,
    '${launcher_name}': 'VersePC',
    '${launcher_version}': '1.0',
    '${version_type}': '1.0',
    '${game_directory}': GAME_DIR,
    '${assets_root}': path.join(process.env.USERPROFILE, '.versepc', 'assets'),
    '${auth_session}': 'test',
    '${auth_access_token}': 'test',
    '${client_id}': 'test',
    '${auth_uuid}': 'test',
    '${user_properties}': '{}',
};

function replaceVariables(str) {
    if (typeof str !== 'string') return str;
    let result = str;
    for (const [key, value] of Object.entries(variables)) {
        while (result.includes(key)) {
            result = result.replace(key, value);
        }
    }
    return result;
}

function buildClasspath() {
    const entries = [];
    const seen = new Set();

    const addLib = (lib) => {
        if (lib.name) {
            const parts = lib.name.split(':');
            if (parts.length >= 3) {
                const group = parts[0].replace(/\./g, '/');
                const artifact = parts[1];
                const version = parts[2];
                const classifier = parts[3] || '';
                const jarName = classifier
                    ? `${artifact}-${version}-${classifier}.jar`
                    : `${artifact}-${version}.jar`;
                const jarPath = path.join(LIBRARIES_DIR, group, artifact, version, jarName);
                const normPath = path.normalize(jarPath);
                if (!seen.has(normPath) && fs.existsSync(normPath)) {
                    seen.add(normPath);
                    entries.push(normPath);
                }
            }
        }
    };

    if (versionJson.libraries) {
        for (const lib of versionJson.libraries) {
            if (lib.rules) {
                const allow = lib.rules.some(r => r.action === 'allow');
                const deny = lib.rules.some(r => r.action === 'deny' && (!r.os || r.os.name === 'windows'));
                if (deny) continue;
            }
            addLib(lib);
        }
    }

    const clientJar = path.join(VERSION_DIR, `${VERSION_ID}.jar`);
    if (fs.existsSync(clientJar)) {
        entries.push(clientJar);
    }

    return entries;
}

const MULTI_VALUE_FLAGS = new Set(['--add-opens', '--add-exports', '--add-reads', '--add-modules']);
const SKIP_ARGS = new Set(['-cp']);

const jvmArgs = [];
if (versionJson.arguments?.jvm) {
    const rawJvm = versionJson.arguments.jvm;
    for (let i = 0; i < rawJvm.length; i++) {
        const arg = rawJvm[i];
        if (typeof arg === 'object') continue;
        const replaced = replaceVariables(arg);
        if (SKIP_ARGS.has(replaced)) {
            if (replaced === '-cp') { i++; continue; }
            continue;
        }
        if (MULTI_VALUE_FLAGS.has(replaced)) {
            jvmArgs.push(replaced);
            while (i + 1 < rawJvm.length && typeof rawJvm[i + 1] === 'string' && !rawJvm[i + 1].startsWith('-')) {
                i++;
                jvmArgs.push(replaceVariables(rawJvm[i]));
            }
            continue;
        }
        if (replaced.startsWith('-Xmx') || replaced.startsWith('-Xms')) continue;
        if (replaced.startsWith('-Xss')) continue;
        jvmArgs.push(replaced);
    }
}

const heapArgs = [];
if (jvmArgs.some(a => a.startsWith('-Xmx'))) {
    heapArgs.push(...jvmArgs.filter(a => !a.startsWith('-Xmx') && !a.startsWith('-Xms')));
} else {
    heapArgs.push('-Xmx4G', '-Xms2G', ...jvmArgs);
}

if (!heapArgs.some(a => a.startsWith('-Djava.library.path'))) {
    heapArgs.push('-Djava.library.path=' + VERSION_DIR);
}
if (!heapArgs.some(a => a.startsWith('-Dminecraft.launcher.brand'))) {
    heapArgs.push('-Dminecraft.launcher.brand=VersePC');
}
if (!heapArgs.some(a => a.startsWith('-Dminecraft.launcher.version'))) {
    heapArgs.push('-Dminecraft.launcher.version=1.0');
}

const classpath = buildClasspath();
heapArgs.push('-cp');
heapArgs.push(classpath.join(';'));

const mainClass = versionJson.mainClass || 'net.minecraft.client.main.Main';
heapArgs.push(mainClass);

const gameArgs = [];
if (versionJson.arguments?.game) {
    for (const arg of versionJson.arguments.game) {
        if (typeof arg === 'object') continue;
        gameArgs.push(replaceVariables(arg));
    }
}
heapArgs.push(...gameArgs);

console.log(`\n=== 测试启动 ${VERSION_ID} ===`);
console.log(`Java: ${JAVA_PATH}`);
console.log(`Classpath entries: ${classpath.length}`);
console.log(`Total JVM args: ${heapArgs.length}`);
console.log(`Main class: ${mainClass}`);

const modulePathIdx = heapArgs.indexOf('-p');
let mpValue = '';
if (modulePathIdx >= 0) {
    mpValue = heapArgs[modulePathIdx + 1];
    const mpEntries = mpValue.split(';');
    console.log(`\nModule path entries: ${mpEntries.length}`);
    mpEntries.forEach((e, i) => console.log(`  [${i}] ${path.basename(e)}`));
}

const cpIdx = heapArgs.indexOf('-cp');
if (cpIdx >= 0) {
    const cpEntries = heapArgs[cpIdx + 1].split(';');
    console.log(`\nClasspath entries: ${cpEntries.length}`);
    
    const fmlloaderInCp = cpEntries.filter(e => e.includes('fmlloader'));
    console.log(`\nfmlloader in classpath: ${fmlloaderInCp.length}`);
    fmlloaderInCp.forEach(e => console.log(`  ${e}`));
    
    const fmlloaderInMp = mpValue.split(';').filter(e => e.includes('fmlloader'));
    console.log(`fmlloader in module path: ${fmlloaderInMp.length}`);
    fmlloaderInMp.forEach(e => console.log(`  ${e}`));
    
    const duplicates = cpEntries.filter(e => {
        const base = path.basename(e);
        return mpValue.split(';').some(m => path.basename(m) === base);
    });
    console.log(`\nJARs in BOTH module path and classpath: ${duplicates.length}`);
    duplicates.forEach(e => console.log(`  ${path.basename(e)}`));
}

console.log(`\n=== 启动游戏 ===`);
const javaExe = 'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe';
const psArgs = heapArgs.map(a => `'${a.replace(/'/g, "''")}'`).join(', ');
const psScript = `$ErrorActionPreference = 'Stop'\ntry {\n    & '${javaExe}' ${heapArgs.map(a => `'${a.replace(/'/g, "''")}'`).join(' ')} 2>&1\n} catch {\n    $_.Exception.Message\n    if ($_.Exception.ErrorRecord) { $_.Exception.ErrorRecord } \n}`;
const psPath = path.join(VERSION_DIR, '_test_launch.ps1');
fs.writeFileSync(psPath, psScript, 'utf8');
console.log(`PowerShell 脚本已写入: ${psPath}`);
try {
    const { execSync } = require('child_process');
    const result = execSync(`powershell -ExecutionPolicy Bypass -File "${psPath}"`, {
        timeout: 30000,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 10,
        cwd: GAME_DIR
    });
    console.log(`\n--- 输出 (前5000字符) ---`);
    console.log(result.substring(0, 5000));
} catch (e) {
    console.log(`\n--- 进程退出 (code: ${e.status}) ---`);
    if (e.stdout) {
        console.log(`\n--- stdout (前8000字符) ---`);
        console.log(e.stdout.toString().substring(0, 8000));
    }
    if (e.stderr) {
        console.log(`\n--- stderr (前8000字符) ---`);
        console.log(e.stderr.toString().substring(0, 8000));
    }
}
