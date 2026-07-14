const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const bytenode = require('bytenode');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.backup-before-protect');

const JS_FILES_TO_OBFUSCATE = [
    'main.js',
    'server.js',
    'preload.cjs',
    'editor-preload.cjs',
];

const JS_DIRS_TO_OBFUSCATE = [
    'main',
    'server',
    'activation',
    'js',
    'plugins',
];

const BYTECODE_FILES = [
    'main.js',
    'server.js',
    'activation/activation.js',
    'activation/activation-verify.js',
];

const SKIP_PATTERNS = [
    'node_modules',
    '.backup-before-protect',
    'dist',
    '.git',
    'scripts',
    'ai-chat.js',
    'skinview3d.bundle.js',
    'three.bundle.js',
    'marked.min.js',
    'monaco',
];

function collectJsFiles(dir, results = []) {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(ROOT, fullPath);
        if (SKIP_PATTERNS.some(p => relPath.includes(p))) continue;
        if (entry.isDirectory()) {
            collectJsFiles(fullPath, results);
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) {
            results.push(fullPath);
        }
    }
    return results;
}

function backupFiles(files) {
    if (fs.existsSync(BACKUP_DIR)) {
        fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (const file of files) {
        const relPath = path.relative(ROOT, file);
        const backupPath = path.join(BACKUP_DIR, relPath);
        const backupDir = path.dirname(backupPath);
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(file, backupPath);
    }
}

function restoreFiles() {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const copyRecursive = (src, dest) => {
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                fs.mkdirSync(destPath, { recursive: true });
                copyRecursive(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
            }
        }
    };
    copyRecursive(BACKUP_DIR, ROOT);
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
}

function obfuscateFile(filePath) {
    const relPath = path.relative(ROOT, filePath);
    try {
        execSync(
            `npx javascript-obfuscator "${filePath}" --output "${filePath}" --target node ` +
            `--string-array-encoding rc4 --string-array-threshold 1 ` +
            `--rename-globals false --self-defending false ` +
            `--dead-code-injection true --dead-code-injection-threshold 0.4 ` +
            `--control-flow-flattening true --control-flow-flattening-threshold 0.75 ` +
            `--identifier-names-generator hexadecimal ` +
            `--numbers-to-expressions true --simplify true ` +
            `--split-strings true --split-strings-chunk-length 10 ` +
            `--transform-object-keys true --unicode-escape-sequence true`,
            { stdio: 'pipe', cwd: ROOT, timeout: 120000 }
        );
        return true;
    } catch (e) {
        console.warn(`  [WARN] Obfuscate failed: ${relPath} - ${e.message.substring(0, 100)}`);
        return false;
    }
}

async function compileToBytecode(filePath) {
    const relPath = path.relative(ROOT, filePath);
    const jscPath = filePath + '.jsc';
    try {
        await bytenode.compileFile({
            filename: filePath,
            output: jscPath,
            electron: true
        });
        if (fs.existsSync(jscPath)) {
            fs.unlinkSync(filePath);
            const loaderContent = `require('bytenode').loadFile('${path.basename(jscPath)}');`;
            fs.writeFileSync(filePath, loaderContent);
            return true;
        }
        return false;
    } catch (e) {
        console.warn(`  [WARN] Bytecode compile failed: ${relPath} - ${e.message.substring(0, 100)}`);
        return false;
    }
}

async function main() {
    const isRestore = process.argv.includes('--restore');

    if (isRestore) {
        console.log('[Protect] Restoring original files...');
        restoreFiles();
        console.log('[Protect] Done. Original files restored.');
        return;
    }

    console.log('[Protect] Collecting JS files...');
    const allFiles = [];
    for (const file of JS_FILES_TO_OBFUSCATE) {
        const fullPath = path.join(ROOT, file);
        if (fs.existsSync(fullPath)) allFiles.push(fullPath);
    }
    for (const dir of JS_DIRS_TO_OBFUSCATE) {
        collectJsFiles(path.join(ROOT, dir), allFiles);
    }

    const uniqueFiles = [...new Set(allFiles)];
    console.log(`[Protect] Found ${uniqueFiles.length} JS files`);

    console.log('[Protect] Backing up original files...');
    backupFiles(uniqueFiles);

    console.log('[Protect] Obfuscating files...');
    let obfOk = 0, obfFail = 0;
    for (const file of uniqueFiles) {
        const relPath = path.relative(ROOT, file);
        process.stdout.write(`  [OBF] ${relPath} ... `);
        if (obfuscateFile(file)) {
            console.log('OK');
            obfOk++;
        } else {
            console.log('SKIP');
            obfFail++;
        }
    }
    console.log(`[Protect] Obfuscation: ${obfOk} OK, ${obfFail} skipped`);

    console.log('[Protect] Compiling critical files to V8 bytecode...');
    let bcOk = 0, bcFail = 0;
    for (const file of BYTECODE_FILES) {
        const fullPath = path.join(ROOT, file);
        if (!fs.existsSync(fullPath)) {
            console.log(`  [BC] ${file} - not found, skip`);
            bcFail++;
            continue;
        }
        process.stdout.write(`  [BC] ${file} ... `);
        if (await compileToBytecode(fullPath)) {
            console.log('OK');
            bcOk++;
        } else {
            console.log('FAIL');
            bcFail++;
        }
    }
    console.log(`[Protect] Bytecode: ${bcOk} OK, ${bcFail} failed`);

    console.log('[Protect] Protection complete. Run build now.');
    console.log('[Protect] After build, run: node scripts/protect-build.js --restore');
}

main();
