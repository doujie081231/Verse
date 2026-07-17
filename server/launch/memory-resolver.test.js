const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveMaxMemory } = require('./memory-resolver');

describe('resolveMaxMemory - mod 数量多时自动提高内存下限', () => {
  test('312 个 mod + 8GB 系统 + 可用内存充足应给至少 6144MB', () => {
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'auto',
      memoryValue: null,
      totalMB: 8192,
      freeMB: 7168,
      modCount: 312
    });
    assert.ok(maxMemMB >= 6144, `312 个 mod 应给至少 6144MB，实际 ${maxMemMB}MB`);
  });

  test('312 个 mod + 16GB 系统 + 可用内存充足应给至少 8192MB', () => {
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'auto',
      memoryValue: null,
      totalMB: 16278,
      freeMB: 12288,
      modCount: 312
    });
    assert.ok(maxMemMB >= 8192, `16GB 系统 312 个 mod 应给至少 8192MB，实际 ${maxMemMB}MB`);
  });

  test('0 个 mod + 16GB 系统 + 可用内存充足应保持现有行为', () => {
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'auto',
      memoryValue: null,
      totalMB: 16384,
      freeMB: 16384,
      modCount: 0
    });
    // 现有 auto 计算：floor(16384*0.6)=9830 → floor(9830/256)*256=9728
    assert.strictEqual(maxMemMB, 9728, `无 mod 时应保持 9728MB，实际 ${maxMemMB}MB`);
  });

  test('custom 模式应直接使用用户指定值', () => {
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'custom',
      memoryValue: 8192,
      totalMB: 16384,
      freeMB: 8192,
      modCount: 312
    });
    assert.strictEqual(maxMemMB, 8192);
  });

  test('小内存机器 mod 多时不应超分配（受 totalMB-1536 约束）', () => {
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'auto',
      memoryValue: null,
      totalMB: 4096,
      freeMB: 2048,
      modCount: 312
    });
    assert.ok(maxMemMB <= 4096 - 1536, `4GB 机器不应超分配，实际 ${maxMemMB}MB`);
  });
});

describe('resolveMaxMemory - 可用内存约束（OOM 修复）', () => {
  test('16GB 系统 + 仅 7.49GB 可用 + 348 mod：分配不应超过可用内存', () => {
    // 复现 Aged (Fabric) 整合包 OOM 退出场景
    // 旧逻辑会分配 9728MB 超过可用 7674MB，导致游戏静默退出
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'auto',
      memoryValue: null,
      totalMB: 16278,
      freeMB: 7674,
      modCount: 348
    });
    // 必须不超过 freeMB - 1024（保留 1GB 给系统/启动器）
    assert.ok(maxMemMB <= 7674 - 1024, `分配 ${maxMemMB}MB 超过安全可用内存 ${7674 - 1024}MB，会导致 OOM`);
    assert.ok(maxMemMB >= 2048, `分配过低 ${maxMemMB}MB，游戏可能无法启动`);
  });

  test('mod 下限不能超过当前可用内存（宁可降低下限也不能 OOM）', () => {
    // 200+ mod 要求 8192MB 下限，但可用内存只有 4GB
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'auto',
      memoryValue: null,
      totalMB: 16278,
      freeMB: 4096,
      modCount: 348
    });
    // safeFreeMB = 4096 - 1024 = 3072，分配不应超过此值
    assert.ok(maxMemMB <= 3072, `可用内存不足时仍分配 ${maxMemMB}MB，会 OOM`);
  });

  test('可用内存极低时（<1GB）仍能给出最低可运行内存', () => {
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'auto',
      memoryValue: null,
      totalMB: 8192,
      freeMB: 800,
      modCount: 10
    });
    assert.ok(maxMemMB >= 512, `可用内存极低时应至少给 512MB，实际 ${maxMemMB}MB`);
  });
});
