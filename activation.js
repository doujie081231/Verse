const crypto = require('crypto');

const SECRET = 'VersePC$ecureK3y#2026@Activation!Gen';
const HASH_LEN = 12;

function validateActivationCode(code, machineId, appVersion) {
    if (!code || !machineId) return { activated: false };

    const c = code.trim().toUpperCase();
    const parts = c.split('-');

    if (parts.length === 2) {
        const prefix = parts[0];
        const hash = parts[1];

        if (prefix === 'VP') {
            const expected = crypto.createHmac('sha256', SECRET).update(machineId + '|PERM').digest('hex').toUpperCase().substring(0, HASH_LEN);
            if (hash === expected) return { activated: true, type: 'permanent' };
        }

        if (prefix === 'VS') {
            const expected = crypto.createHmac('sha256', SECRET).update(machineId + '|SINGLE|' + (appVersion || '1.2.5')).digest('hex').toUpperCase().substring(0, HASH_LEN);
            if (hash === expected) return { activated: true, type: 'single' };
        }
    }

    if (parts.length === 3) {
        const prefix = parts[0];
        const hash = parts[1];
        const ver = parts[2];

        if (prefix === 'VP') {
            const expected = crypto.createHmac('sha256', SECRET).update(machineId + '|PERM').digest('hex').toUpperCase().substring(0, HASH_LEN);
            if (hash === expected) return { activated: true, type: 'permanent' };
        }

        if (prefix === 'VS') {
            const expectedShort = crypto.createHmac('sha256', SECRET).update(machineId + '|SINGLE|' + ver).digest('hex').toUpperCase().substring(0, hash.length);
            if (hash === expectedShort) return { activated: true, type: 'single' };
            const expectedFull = crypto.createHmac('sha256', SECRET).update(machineId + '|SINGLE|' + (appVersion || '1.2.5')).digest('hex').toUpperCase().substring(0, hash.length);
            if (hash === expectedFull) return { activated: true, type: 'single' };
        }
    }

    return { activated: false };
}

module.exports = { validateActivationCode };
