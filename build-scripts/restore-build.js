const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

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
