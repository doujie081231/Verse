const fs = require('fs');
const path = require('path');
const os = require('os');

const _schemaVer = 3;
const _storePath = path.join(os.homedir(), '.versepc', 'app-store.json');

function _readStore() {
    try {
        const raw = fs.readFileSync(_storePath, 'utf-8');
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function checkTampering() {
    const store = _readStore();
    if (store === null) return 'store_corrupt';
    if (store['activation_type'] && store['activation_schema_ver'] !== _schemaVer) return 'schema_mismatch';
    if (store['activation_type'] && !store['activation_code']) return 'code_missing';
    return 'ok';
}

function clearActivation(store) {
    if (!store) return store;
    delete store['activation_type'];
    delete store['activation_code'];
    delete store['activation_time'];
    delete store['activation_version'];
    delete store['activation_schema_ver'];
    return store;
}

function autoRecover() {
    const store = _readStore();
    if (store === null) return;
    const result = checkTampering();
    if (result !== 'ok') {
        clearActivation(store);
        try {
            fs.writeFileSync(_storePath, JSON.stringify(store, null, 2), 'utf8');
        } catch (_) {}
    }
}

module.exports = { checkTampering, autoRecover, _schemaVer };
