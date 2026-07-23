// =============================================================================
// test/paths.test.js
// 数据目录解析（main/paths.js resolveDataDir）防御性测试
//
// 覆盖三个优先级分支 + 一个边界场景：
//   1. data-config.json 有效 → 返回配置的 dataDir
//   2. data-config.json 缺失 + 旧目录存在 → 回退到旧目录 + 写诊断日志
//   3. 两者都不存在 → 回退到 appDir/data + 写诊断日志
//   4. data-config.json 存在但 dataDir 指向不存在的目录 → 降级到分支 2/3
//
// 用 resolveDataDir 的 opts 参数注入临时目录，隔离真实文件系统。
// =============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { resolveDataDir } = require('../main/paths');

function makeTmpAppDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-test-'));
}

test('分支1: data-config.json 有效 → 返回配置的 dataDir，不写回退日志', () => {
  const appDir = makeTmpAppDir();
  const customDataDir = path.join(appDir, 'my-data');
  fs.mkdirSync(customDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'data-config.json'),
    JSON.stringify({ dataDir: customDataDir })
  );
  const oldDataDir = path.join(appDir, 'nonexistent-old'); // 确保不存在

  const result = resolveDataDir({ appDir, oldDataDir });

  assert.strictEqual(result, customDataDir);
  assert.ok(!fs.existsSync(path.join(customDataDir, '.path-resolution.log')),
    '分支1 不应写回退日志');

  fs.rmSync(appDir, { recursive: true, force: true });
});

test('分支2: data-config.json 缺失 + 旧目录存在 → 回退到旧目录 + 写诊断日志', () => {
  const appDir = makeTmpAppDir();
  const oldDataDir = path.join(appDir, 'old-versepc');
  fs.mkdirSync(oldDataDir, { recursive: true });
  // 不写 data-config.json

  const result = resolveDataDir({ appDir, oldDataDir });

  assert.strictEqual(result, oldDataDir);
  const logPath = path.join(oldDataDir, '.path-resolution.log');
  assert.ok(fs.existsSync(logPath), '应生成 .path-resolution.log 记录回退原因');
  const logContent = fs.readFileSync(logPath, 'utf8');
  assert.ok(logContent.includes('data-config.json'), '日志应提及 data-config.json 缺失');

  fs.rmSync(appDir, { recursive: true, force: true });
});

test('分支3: data-config.json 缺失 + 旧目录也不存在 → 回退到 appDir/data + 写诊断日志', () => {
  const appDir = makeTmpAppDir();
  const oldDataDir = path.join(appDir, 'nonexistent-old'); // 不存在
  const expectedFallback = path.join(appDir, 'data');

  const result = resolveDataDir({ appDir, oldDataDir });

  assert.strictEqual(result, expectedFallback);
  const logPath = path.join(expectedFallback, '.path-resolution.log');
  assert.ok(fs.existsSync(logPath), '应生成 .path-resolution.log 记录兜底回退');

  fs.rmSync(appDir, { recursive: true, force: true });
});

test('边界: data-config.json 存在但 dataDir 指向不存在的目录 → 降级到分支3', () => {
  const appDir = makeTmpAppDir();
  const ghostDataDir = path.join(appDir, 'ghost'); // 故意不创建
  fs.writeFileSync(
    path.join(appDir, 'data-config.json'),
    JSON.stringify({ dataDir: ghostDataDir })
  );
  const oldDataDir = path.join(appDir, 'nonexistent-old'); // 不存在

  const result = resolveDataDir({ appDir, oldDataDir });

  // dataDir 无效 → 跳过分支1 → 旧目录不存在 → 走分支3（appDir/data）
  assert.strictEqual(result, path.join(appDir, 'data'));

  fs.rmSync(appDir, { recursive: true, force: true });
});
