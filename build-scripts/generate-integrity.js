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
    const projectRoot = path.join(__dirname, '..');
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
