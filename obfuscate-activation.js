const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'activation.js');
const dst = path.join(__dirname, 'activation.obfuscated.js');

if (!fs.existsSync(src)) {
    console.log('activation.js not found, skipping obfuscation');
    process.exit(0);
}

try {
    execSync(
        `npx javascript-obfuscator "${src}" --output "${dst}" --target node --string-array-encoding rc4 --string-array-threshold 1 --rename-globals false --self-defending false`,
        { stdio: 'pipe', cwd: __dirname }
    );
    console.log('OK: activation.js -> activation.obfuscated.js');
} catch (e) {
    console.error('Obfuscation failed:', e.message);
    process.exit(1);
}
