const { test } = require('node:test');
const assert = require('node:assert');

const { shouldRunMemoryOptimize } = require('./memory-optimize-resolver');

const GB = 1024;

/* =================== 优先级 1：版本独立设置 =================== */

test('版本独立设置 on → 强制开启，忽略其他条件', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: false,
    versionMemOptimize: 'on',
    totalMemMB: 32 * GB, // 大内存
    modCount: 200,        // 大整合包
    freeMB: 16 * GB       // 充足可用
  });
  assert.strictEqual(r, true);
});

test('版本独立设置 off → 强制关闭，忽略其他条件', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'off',
    totalMemMB: 4 * GB,  // 小内存
    modCount: 0,          // 无 mod
    freeMB: 512           // 可用紧张
  });
  assert.strictEqual(r, false);
});

test('版本独立设置 global → 走全局规则', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 10,
    freeMB: 2048 // 不充足的可用内存
  });
  assert.strictEqual(r, true);
});

/* =================== 优先级 2：全局设置默认关闭 =================== */

test('全局开关未显式开启（undefined）→ 不执行（关键修复点）', () => {
  // 旧逻辑：if (autoMemoryOptimize !== false) → 默认开启
  // 新逻辑：只有 === true 才执行
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: undefined,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 10,
    freeMB: 2048
  });
  assert.strictEqual(r, false, '未显式开启时应关闭，避免系统卡顿 15-30 秒');
});

test('全局开关为 false → 不执行', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: false,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 10,
    freeMB: 2048
  });
  assert.strictEqual(r, false);
});

test('全局开关为 true → 继续判断其他条件', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 10,
    freeMB: 2048
  });
  assert.strictEqual(r, true);
});

/* =================== 优先级 3：大内存机器跳过 =================== */

test('物理内存 ≥12GB → 跳过优化（清空缓存弊大于利）', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 12 * GB,
    modCount: 10,
    freeMB: 2048
  });
  assert.strictEqual(r, false);
});

test('物理内存 ≥16GB → 跳过优化', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 16 * GB,
    modCount: 10,
    freeMB: 2048
  });
  assert.strictEqual(r, false);
});

test('物理内存 <12GB → 继续判断', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 10,
    freeMB: 2048
  });
  assert.strictEqual(r, true);
});

/* =================== 优先级 4：大型整合包跳过 =================== */

test('modCount ≥100 → 跳过优化（清空缓存会让 jar 重新读取更慢）', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 100,
    freeMB: 2048
  });
  assert.strictEqual(r, false);
});

test('modCount 200 → 跳过优化', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 200,
    freeMB: 2048
  });
  assert.strictEqual(r, false);
});

test('modCount <100 → 继续判断', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 99,
    freeMB: 2048
  });
  assert.strictEqual(r, true);
});

/* =================== 优先级 5：可用内存充足跳过 =================== */

test('可用内存 >4GB → 不需要优化', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 10,
    freeMB: 4097 // 刚好超过 4GB
  });
  assert.strictEqual(r, false);
});

test('可用内存 =4GB → 仍可优化（边界）', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 10,
    freeMB: 4096
  });
  assert.strictEqual(r, true);
});

test('可用内存 <4GB → 执行优化', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 10,
    freeMB: 2048
  });
  assert.strictEqual(r, true);
});

/* =================== 综合场景 =================== */

test('典型场景：8GB 物理/50 mod/2GB 可用 → 执行优化', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 50,
    freeMB: 2048
  });
  assert.strictEqual(r, true);
});

test('大内存场景：16GB 物理/20 mod/2GB 可用 → 跳过（大内存）', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 16 * GB,
    modCount: 20,
    freeMB: 2048
  });
  assert.strictEqual(r, false);
});

test('大整合包场景：8GB 物理/200 mod/2GB 可用 → 跳过（整合包大）', () => {
  const r = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8 * GB,
    modCount: 200,
    freeMB: 2048
  });
  assert.strictEqual(r, false);
});
