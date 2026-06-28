// ============================================================================
// JSON 自动修复 - 检测并修复损坏的配置/数据文件
// ============================================================================
const path = require('path');
const fs = require('fs');
const os = require('os');

// 与 main.js 中的 CONFIG_PATH / STORE_PATH 保持一致
const CONFIG_PATH = path.join(os.homedir(), '.versepc', 'window-config.json');
const STORE_PATH = path.join(os.homedir(), '.versepc', 'app-store.json');

async function autoRepairJsonFileAsync(filePath, backupSuffix) {
    try {
        await fs.promises.access(filePath);
        const content = await fs.promises.readFile(filePath, 'utf8');
        JSON.parse(content);
        return true;
    } catch (e) {
        console.error(`[AutoRepair] Detected corrupted file: ${filePath}`);
        try {
            const backupPath = filePath + backupSuffix;
            await fs.promises.copyFile(filePath, backupPath);
            console.log(`[AutoRepair] Backup created: ${backupPath}`);
        } catch (backupErr) {
            console.error(`[AutoRepair] Backup failed:`, backupErr.message);
        }
        const bakPath = filePath + '.bak';
        try {
            await fs.promises.access(bakPath);
            const bakContent = await fs.promises.readFile(bakPath, 'utf8');
            JSON.parse(bakContent);
            await fs.promises.writeFile(filePath, bakContent);
            console.log(`[AutoRepair] Recovered from .bak: ${bakPath}`);
            return true;
        } catch (bakErr) {
            console.error(`[AutoRepair] .bak recovery failed:`, bakErr.message);
        }
        try {
            const dir = path.dirname(filePath);
            await fs.promises.mkdir(dir, { recursive: true });
            const defaultContent = filePath.includes('window-config')
                ? JSON.stringify({ fullscreen: false, windowMode: true, windowWidth: 1200, windowHeight: 800 }, null, 2)
                : '{}';
            await fs.promises.writeFile(filePath, defaultContent);
            console.log(`[AutoRepair] File reset to defaults: ${filePath}`);
        } catch (resetErr) {
            console.error(`[AutoRepair] Reset failed:`, resetErr.message);
        }
        return false;
    }
}

async function repairVersePCDataAsync() {
    const dataDir = path.join(os.homedir(), '.versepc');
    try { await fs.promises.access(dataDir); } catch { return; }
    await autoRepairJsonFileAsync(CONFIG_PATH, '.corrupted.json');
    await autoRepairJsonFileAsync(STORE_PATH, '.corrupted.json');
    try {
        const settingsFile = path.join(dataDir, 'settings.json');
        await autoRepairJsonFileAsync(settingsFile, '.corrupted.json');
    } catch (e) {}
    try {
        const accountsFile = path.join(dataDir, 'accounts.json');
        await autoRepairJsonFileAsync(accountsFile, '.corrupted.json');
    } catch (e) {}
    try {
        const versionsDir = path.join(dataDir, 'versions');
        await fs.promises.access(versionsDir);
        const versions = await fs.promises.readdir(versionsDir);
        for (const ver of versions) {
            const verPath = path.join(versionsDir, ver);
            const stat = await fs.promises.stat(verPath);
            if (stat.isDirectory()) {
                const versionJson = path.join(verPath, 'version.json');
                await autoRepairJsonFileAsync(versionJson, '.corrupted.json');
            }
        }
    } catch (e) {
        console.error('[AutoRepair] Version scan error:', e.message);
    }
    console.log('[AutoRepair] Data integrity check completed');
}

function _deferredRepairData() {
    setImmediate(() => {
        repairVersePCDataAsync().catch(() => {});
    });
}

module.exports = { autoRepairJsonFileAsync, repairVersePCDataAsync, _deferredRepairData };
