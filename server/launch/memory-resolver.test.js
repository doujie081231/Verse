const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveMaxMemory } = require('./memory-resolver');

describe('resolveMaxMemory - mod 数量多时自动提高内存下限', () => {
  test('312 个 mod + 8GB 系统 auto 模式应给至少 6144MB（而非 4352MB）', () => {
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'auto',
      memoryValue: null,
      totalMB: 8192,
      freeMB: 4096,
      modCount: 312
    });
    assert.ok(maxMemMB >= 6144, `312 个 mod 应给至少 6144MB，实际 ${maxMemMB}MB`);
  });

  test('312 个 mod + 16GB 系统（当前崩溃场景）应给至少 8192MB', () => {
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'auto',
      memoryValue: null,
      totalMB: 16278,
      freeMB: 8192,
      modCount: 312
    });
    assert.ok(maxMemMB >= 8192, `16GB 系统 312 个 mod 应给至少 8192MB，实际 ${maxMemMB}MB`);
  });

  test('0 个 mod + 16GB 系统 auto 模式应保持现有行为（不误提高）', () => {
    const maxMemMB = resolveMaxMemory({
      memoryMode: 'auto',
      memoryValue: null,
      totalMB: 16384,
      freeMB: 8192,
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
