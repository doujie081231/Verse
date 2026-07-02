const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { _dedupeVersionId, isModpackPathSafe } = require('../server/modpack/shared');
const ctx = require('../server/context');

test('_dedupeVersionId: 无同名版本时返回原名称', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-dedupe-'));
  const saved = ctx.dirs.VERSIONS_DIR;
  try {
    ctx.dirs.VERSIONS_DIR = tmpDir;
    assert.strictEqual(_dedupeVersionId('test'), 'test');
  } finally {
    ctx.dirs.VERSIONS_DIR = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('_dedupeVersionId: 已存在同名版本时返回 "名称 (2)"', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-dedupe-'));
  const saved = ctx.dirs.VERSIONS_DIR;
  try {
    ctx.dirs.VERSIONS_DIR = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

    assert.strictEqual(_dedupeVersionId('test'), 'test (2)');
  } finally {
    ctx.dirs.VERSIONS_DIR = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('_dedupeVersionId: 连续调用递增编号 (2)、(3)、(4)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-dedupe-'));
  const saved = ctx.dirs.VERSIONS_DIR;
  try {
    ctx.dirs.VERSIONS_DIR = tmpDir;

    // 首次：无冲突
    assert.strictEqual(_dedupeVersionId('MyPack'), 'MyPack');
    // 模拟"已保存 MyPack"
    fs.mkdirSync(path.join(tmpDir, 'MyPack'), { recursive: true });
    assert.strictEqual(_dedupeVersionId('MyPack'), 'MyPack (2)');
    // 模拟"已保存 MyPack (2)"
    fs.mkdirSync(path.join(tmpDir, 'MyPack (2)'), { recursive: true });
    assert.strictEqual(_dedupeVersionId('MyPack'), 'MyPack (3)');
    // 模拟"已保存 MyPack (3)"
    fs.mkdirSync(path.join(tmpDir, 'MyPack (3)'), { recursive: true });
    assert.strictEqual(_dedupeVersionId('MyPack'), 'MyPack (4)');
  } finally {
    ctx.dirs.VERSIONS_DIR = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('_dedupeVersionId: 中文名称也能正确去重', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-dedupe-'));
  const saved = ctx.dirs.VERSIONS_DIR;
  try {
    ctx.dirs.VERSIONS_DIR = tmpDir;
    fs.mkdirSync(path.join(tmpDir, '我的整合包'), { recursive: true });

    assert.strictEqual(_dedupeVersionId('我的整合包'), '我的整合包 (2)');
  } finally {
    ctx.dirs.VERSIONS_DIR = saved;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('isModpackPathSafe: 正常路径返回 true', () => {
  assert.strictEqual(isModpackPathSafe('mods/optifine.jar'), true);
  assert.strictEqual(isModpackPathSafe('config/config.ini'), true);
  assert.strictEqual(isModpackPathSafe('overrides/mods/foo.jar'), true);
  assert.strictEqual(isModpackPathSafe('saves/world/level.dat'), true);
});

test('isModpackPathSafe: 反斜杠路径正常返回 true', () => {
  assert.strictEqual(isModpackPathSafe('mods\\optifine.jar'), true);
  assert.strictEqual(isModpackPathSafe('config\\sub\\file.txt'), true);
});

test('isModpackPathSafe: __macosx/ 前缀返回 false', () => {
  assert.strictEqual(isModpackPathSafe('__macosx/._mods'), false);
  assert.strictEqual(isModpackPathSafe('__MACOSX/._foo'), false);
  assert.strictEqual(isModpackPathSafe('__macosx\\bar'), false);
});

test('isModpackPathSafe: Windows 保留名返回 false', () => {
  assert.strictEqual(isModpackPathSafe('CON'), false);
  assert.strictEqual(isModpackPathSafe('PRN'), false);
  assert.strictEqual(isModpackPathSafe('AUX'), false);
  assert.strictEqual(isModpackPathSafe('NUL'), false);
  assert.strictEqual(isModpackPathSafe('COM1'), false);
  assert.strictEqual(isModpackPathSafe('LPT9'), false);
  // 保留名带扩展名也应拦截
  assert.strictEqual(isModpackPathSafe('CON.txt'), false);
  assert.strictEqual(isModpackPathSafe('mods/COM3.dll'), false);
});

test('isModpackPathSafe: 类似保留名但非保留的名称返回 true', () => {
  assert.strictEqual(isModpackPathSafe('COM10'), true);
  assert.strictEqual(isModpackPathSafe('LPT0'), true);
  assert.strictEqual(isModpackPathSafe('console.txt'), true);
  assert.strictEqual(isModpackPathSafe('config/control.ini'), true);
});

test('isModpackPathSafe: 空值返回 false', () => {
  assert.strictEqual(isModpackPathSafe(''), false);
  assert.strictEqual(isModpackPathSafe(null), false);
  assert.strictEqual(isModpackPathSafe(undefined), false);
});
