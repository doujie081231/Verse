const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const avBak = path.join(root, 'activation', 'activation-verify.js.bak');
const avOrig = path.join(root, 'activation', 'activation-verify.js');
if (fs.existsSync(avBak)) {
    const bakContent = fs.readFileSync(avBak, 'utf8');
    const bakLines = bakContent.split('\n').length;
    if (bakLines > 5) {
        fs.copyFileSync(avBak, avOrig);
        fs.unlinkSync(avBak);
        console.log('Restored activation-verify.js');
    } else {
        fs.unlinkSync(avBak);
        console.log('Skipped activation-verify.js restore (bak already obfuscated)');
    }
}

const mainPath = path.join(root, 'main.js');
let mainContent = fs.readFileSync(mainPath, 'utf8');
const restored = mainContent.replace(
    /let IS_BETA = \(\(\) => \{ try \{ return (?:true|false); \} catch \(_\) \{ return false; \} \}\)\(\);/,
    'let IS_BETA = (() => { try { return __IS_BETA__; } catch (_) { return false; } })();'
);
if (restored !== mainContent) {
    fs.writeFileSync(mainPath, restored);
    console.log('Restored main.js IS_BETA placeholder');
}

console.log('Build artifacts restored');
