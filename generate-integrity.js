const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const INTEGRITY_FILES = [
    'main.js',
    'server.js',
    'preload.cjs',
    'editor-preload.cjs',
    'js/app.js',
    'js/api.js'
];

const OUTPUT_FILE = 'integrity.json';

function computeHash(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

function main() {
    const projectRoot = __dirname;
    const manifest = {};
    const isBeta = process.env.IS_BETA === 'true';

    const mainPath = path.join(projectRoot, 'main.js');
    let mainContent = fs.readFileSync(mainPath, 'utf8');
    mainContent = mainContent.replace(
        /let IS_BETA = \(\(\) => \{ try \{ return [^;]+; \} catch \(_\) \{ return false; \} \}\)\(\);/,
        `let IS_BETA = (() => { try { return ${isBeta ? 'true' : 'false'}; } catch (_) { return false; } })();`
    );
    fs.writeFileSync(mainPath, mainContent);
    console.log(`  main.js: __IS_BETA__ -> ${isBeta}`);

    const avPath = path.join(projectRoot, 'activation', 'activation-verify.js');
    const avBakPath = path.join(projectRoot, 'activation', 'activation-verify.js.bak');
    if (isBeta && fs.existsSync(avPath)) {
        const avContent = fs.readFileSync(avPath, 'utf8');
        const avLines = avContent.split('\n').length;
        if (avLines > 5) {
            fs.copyFileSync(avPath, avBakPath);
            try {
                execSync(
                    `npx javascript-obfuscator "${avPath}" --output "${avPath}" --target node --string-array-encoding rc4 --string-array-threshold 1 --rename-globals false --self-defending false`,
                    { stdio: 'pipe', cwd: projectRoot }
                );
                console.log('  activation-verify.js: obfuscated');
            } catch (e) {
                console.warn('  WARN: activation-verify obfuscation failed:', e.message);
                fs.copyFileSync(avBakPath, avPath);
            }
        } else {
            console.log('  activation-verify.js: already obfuscated, skipping');
        }
    }

    for (const file of INTEGRITY_FILES) {
        const filePath = path.join(projectRoot, file);
        if (!fs.existsSync(filePath)) {
            console.warn(`  WARN: ${file} not found, skipping`);
            continue;
        }
        manifest[file] = computeHash(filePath);
        console.log(`  OK: ${file} -> ${manifest[file].substring(0, 16)}...`);
    }

    const outputPath = path.join(projectRoot, OUTPUT_FILE);
    fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
    console.log(`Integrity manifest written to ${OUTPUT_FILE} (${Object.keys(manifest).length} files)`);
}

main();
