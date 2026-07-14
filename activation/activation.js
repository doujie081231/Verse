const crypto = require('crypto');
const SECRET = 'VersePC$ecureK3y#2026@Activation!Gen';
const HASH_LEN = 12;

function hmacSha256(message) {
    return crypto.createHmac('sha256', SECRET).update(message, 'utf8').digest('hex');
}

function validateActivationCode(code, machineId, appVersion) {
    if (!code || !machineId) return { activated: false };

    const c = code.trim().toUpperCase();

    let prefix = '';
    let hash = '';
    let ver = '';

    if (c.startsWith('VP-') || c.startsWith('VS-')) {
        prefix = c.substring(0, 2);
        const rest = c.substring(3);
        const parts = rest.split('-').filter(p => p.length > 0);
        if (parts.length === 1) {
            hash = parts[0];
        } else if (parts.length === 2) {
            if (/^\d+\.\d+/.test(parts[1])) {
                hash = parts[0];
                ver = parts[1];
            } else {
                hash = parts[0] + parts[1];
            }
        } else if (parts.length >= 3) {
            const lastPart = parts[parts.length - 1];
            if (/^\d+\.\d+/.test(lastPart)) {
                ver = lastPart;
                hash = parts.slice(0, -1).join('');
            } else {
                hash = parts.join('');
            }
        }
    }

    if (!prefix || !hash) return { activated: false };

    if (prefix === 'VP') {
        const expected = hmacSha256(machineId + '|PERM').toUpperCase().substring(0, HASH_LEN);
        if (hash === expected) return { activated: true, type: 'permanent' };
    }

    if (prefix === 'VS') {
        const versions = ver ? [ver, ...['1.3.0', '1.3.1', '1.3.2', '1.3.3', '1.3.4', '1.3.41', '1.0.0', '1.0.1']] : ['1.3.0', '1.3.1', '1.3.2', '1.3.3', '1.3.4', '1.3.41', '1.0.0', '1.0.1'];
        for (const v of versions) {
            const expected = hmacSha256(machineId + '|SINGLE|' + v).toUpperCase().substring(0, HASH_LEN);
            if (hash === expected) {
                const currentMajor = parseInt(appVersion.split('.')[0], 10);
                const codeMajor = parseInt(v.split('.')[0], 10);
                if (currentMajor === codeMajor) return { activated: true, type: 'single', matchVersion: v };
            }
        }
        for (const v of versions) {
            const expected = hmacSha256(machineId + '|SINGLE|' + v).toUpperCase().substring(0, hash.length);
            if (hash === expected) {
                const currentMajor = parseInt(appVersion.split('.')[0], 10);
                const codeMajor = parseInt(v.split('.')[0], 10);
                if (currentMajor === codeMajor) return { activated: true, type: 'single', matchVersion: v };
            }
        }
    }

    return { activated: false };
}

module.exports = { validateActivationCode };

//debug
