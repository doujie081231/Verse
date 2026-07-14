const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');

const { relocateMisplacedResourcePacks } = require('../server/modpack/shared');

// 构造一个资源包 zip（有 pack.mcmeta + assets/，无 mods.toml）
function makeResourcePackZip(filePath) {
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 15, description: 'test' } })));
  zip.addFile('assets/minecraft/textures/block/test.png', Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  zip.writeZip(filePath);
}

// 构造一个 zip 格式的 mod（有 mods.toml）
function makeZipMod(filePath) {
  const zip = new AdmZip();
  zip.addFile('META-INF/mods.toml', Buffer.from('modLoader="javafml"'));
  zip.addFile('com/example/test.class', Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]));
  zip.writeZip(filePath);
}

// 构造一个普通 jar mod
function makeJarMod(filePath) {
  const zip = new AdmZip();
  zip.addFile('META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n'));
  zip.addFile('META-INF/mods.toml', Buffer.from('modLoader="javafml"'));
  zip.writeZip(filePath);
}

test('relocateMisplacedResourcePacks: mods 下的资源包 zip 移到 resourcepacks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'resourcepacks'), { recursive: true });
    makeResourcePackZip(path.join(tmpDir, 'mods', 'Ashen_16x.zip'));

    const result = relocateMisplacedResourcePacks(tmpDir);

    assert.strictEqual(result.relocated.length, 1);
    assert.strictEqual(result.relocated[0], 'Ashen_16x.zip');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'mods', 'Ashen_16x.zip')), 'mods 下不应再有该 zip');
    assert.ok(fs.existsSync(path.join(tmpDir, 'resourcepacks', 'Ashen_16x.zip')), 'resourcepacks 下应有该 zip');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('relocateMisplacedResourcePacks: mods 下的 zip mod（有 mods.toml）不移动', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'resourcepacks'), { recursive: true });
    makeZipMod(path.join(tmpDir, 'mods', 'old-style-mod.zip'));

    const result = relocateMisplacedResourcePacks(tmpDir);

    assert.strictEqual(result.relocated.length, 0);
    assert.ok(fs.existsSync(path.join(tmpDir, 'mods', 'old-style-mod.zip')), '合法 zip mod 不应被移动');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('relocateMisplacedResourcePacks: mods 下的 jar 不移动', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'mods'), { recursive: true });
    makeJarMod(path.join(tmpDir, 'mods', 'real-mod.jar'));

    const result = relocateMisplacedResourcePacks(tmpDir);

    assert.strictEqual(result.relocated.length, 0);
    assert.ok(fs.existsSync(path.join(tmpDir, 'mods', 'real-mod.jar')), 'jar mod 不应被移动');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('relocateMisplacedResourcePacks: resourcepacks 下的 zip 不移动', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'resourcepacks'), { recursive: true });
    makeResourcePackZip(path.join(tmpDir, 'resourcepacks', 'already-correct.zip'));

    const result = relocateMisplacedResourcePacks(tmpDir);

    assert.strictEqual(result.relocated.length, 0);
    assert.ok(fs.existsSync(path.join(tmpDir, 'resourcepacks', 'already-correct.zip')), '已在 resourcepacks 的不应被移动');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('relocateMisplacedResourcePacks: 无 mods 目录时不报错', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-test-'));
  try {
    const result = relocateMisplacedResourcePacks(tmpDir);
    assert.strictEqual(result.relocated.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('relocateMisplacedResourcePacks: 多个资源包 zip 全部移动', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versepc-test-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'mods'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'resourcepacks'), { recursive: true });
    makeResourcePackZip(path.join(tmpDir, 'mods', 'pack1.zip'));
    makeResourcePackZip(path.join(tmpDir, 'mods', 'pack2.zip'));
    makeZipMod(path.join(tmpDir, 'mods', 'real-mod.zip'));
    makeJarMod(path.join(tmpDir, 'mods', 'jar-mod.jar'));

    const result = relocateMisplacedResourcePacks(tmpDir);

    assert.strictEqual(result.relocated.length, 2);
    assert.ok(result.relocated.includes('pack1.zip'));
    assert.ok(result.relocated.includes('pack2.zip'));
    assert.ok(fs.existsSync(path.join(tmpDir, 'resourcepacks', 'pack1.zip')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'resourcepacks', 'pack2.zip')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'mods', 'real-mod.zip')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'mods', 'jar-mod.jar')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
