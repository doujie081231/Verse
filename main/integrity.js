/**
 * @file main/integrity.js
 * @description 运行时完整性自检 - 读取 integrity.json 校验源文件 SHA256，
 * 延迟到窗口显示后执行，避免阻塞启动。
 */

const path = require('path');
// 模块位于 main/ 子目录，integrity.json 在项目根目录，需要回退一级
const _rootDir = path.join(__dirname, '..');

let _integrityViolated = false;

// 私有函数：异步执行完整性校验，比对各文件 SHA256 与清单是否一致
async function _runIntegrityCheckAsync() {
  try {
    const _crypto = require('crypto');
    const _integrityPath = path.join(_rootDir, 'integrity.json');
    await require('fs').promises.access(_integrityPath);
    const _manifest = JSON.parse(await require('fs').promises.readFile(_integrityPath, 'utf-8'));
    for (const [_file, _expectedHash] of Object.entries(_manifest)) {
      try {
        const _filePath = path.join(_rootDir, _file);
        const _content = await require('fs').promises.readFile(_filePath);
        const _actualHash = _crypto.createHash('sha256').update(_content).digest('hex');
        if (_actualHash !== _expectedHash) {
          _integrityViolated = true;
          console.warn(`[Integrity] File tampered: ${_file}`);
        }
      } catch (e) {}
    }
    if (_integrityViolated) {
      console.warn('[Integrity] Source file modification detected. This may indicate tampering.');
    }
  } catch (e) {}
}

module.exports = {
  _runIntegrityCheckAsync,
  get _integrityViolated() { return _integrityViolated; }
};
