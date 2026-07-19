const { test } = require('node:test');
const assert = require('node:assert');

const { resolveMaxMemory } = require('./memory-resolver');

const GB = 1024;

// 辅助：把 MB 转 GB 字符串，便于断言阅读
const mbToGb = (mb) => `${(mb / GB).toFixed(2)} GB`;

/* =================== custom 模式 =================== */

test('custom 模式：直接返回用户指定的内存值', () => {
  assert.strictEqual(resolveMaxMemory({
    memoryMode: 'custom', memoryValue: 4096,
    totalMB: 16 * GB, freeMB: 8 * GB, modCount: 0
  }), 4096);
});

test('custom 模式：memoryValue 为字符串也能解析', () => {
  assert.strictEqual(resolveMaxMemory({
    memoryMode: 'custom', memoryValue: '6144',
    totalMB: 16 * GB, freeMB: 8 * GB, modCount: 0
  }), 6144);
});

test('custom 模式：memoryValue 非法时回退到 4096', () => {
  assert.strictEqual(resolveMaxMemory({
    memoryMode: 'custom', memoryValue: 'abc',
    totalMB: 16 * GB, freeMB: 8 * GB, modCount: 0
  }), 4096);
});

test('custom 模式：memoryValue 为空时回退到 4096', () => {
  assert.strictEqual(resolveMaxMemory({
    memoryMode: 'custom', memoryValue: null,
    totalMB: 16 * GB, freeMB: 8 * GB, modCount: 0
  }), 4096);
});

/* =================== auto 模式：基础值 =================== */

test('auto 模式：2GB 物理/0 mod → 至少 512MB 保底', () => {
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 2 * GB, freeMB: 1 * GB, modCount: 0
  });
  assert.ok(r >= 512, `期望 ≥512MB，实际 ${r}MB`);
  assert.ok(r <= 1024, `2GB 物理不应分配超过 1GB，实际 ${mbToGb(r)}`);
});

test('auto 模式：4GB 物理/0 mod → 物理 1/4 减去系统保留 ≈ 2.5GB', () => {
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 4 * GB, freeMB: 2 * GB, modCount: 0
  });
  // 4GB 物理：基础值 1024MB，物理上限 (4096-1536)=2560MB
  // ramGive 计算：0 mod 时 ramTarget1=1.5GB，4GB 物理 * 100% 满足 → 1.5GB=1536MB
  // 取 max(1024, 1536)=1536，再受 cap 2560 限制，最终对齐 256 → 2560
  assert.strictEqual(r, 2560, `期望 2560MB，实际 ${r}MB`);
});

test('auto 模式：8GB 物理/0 mod → 约 4.5GB', () => {
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 8 * GB, freeMB: 4 * GB, modCount: 0
  });
  // 验证：合理范围 4GB ~ 5GB
  assert.ok(r >= 4096 && r <= 5120, `期望 4-5GB，实际 ${mbToGb(r)}`);
});

test('auto 模式：16GB 物理/0 mod → 约 5.5GB', () => {
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 16 * GB, freeMB: 8 * GB, modCount: 0
  });
  assert.ok(r >= 5120 && r <= 6144, `期望 5-6GB，实际 ${mbToGb(r)}`);
});

/* =================== auto 模式：Mod 加成 =================== */

test('auto 模式：16GB 物理/20 mod (Conquest 场景) → 至少 6GB，避免 OOM', () => {
  // 这是关键回归测试：Conquest Reforged 整合包崩溃的根因
  // 旧算法给 3.5GB → OOM，新算法应给 6GB+
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 16 * GB, freeMB: 5 * GB, // 注意：free 只有 5GB，但算法应该看 total
    modCount: 20
  });
  assert.ok(r >= 6144, `20 mod 大整合包应至少 6GB，实际 ${mbToGb(r)}`);
  assert.ok(r <= 8192, `16GB 物理不应给超过 8GB，实际 ${mbToGb(r)}`);
});

test('auto 模式：mod 越多分配越多（单调性检查）', () => {
  const total = 16 * GB;
  const free = 8 * GB;
  const r0 = resolveMaxMemory({ memoryMode: 'auto', memoryValue: null, totalMB: total, freeMB: free, modCount: 0 });
  const r50 = resolveMaxMemory({ memoryMode: 'auto', memoryValue: null, totalMB: total, freeMB: free, modCount: 50 });
  const r100 = resolveMaxMemory({ memoryMode: 'auto', memoryValue: null, totalMB: total, freeMB: free, modCount: 100 });
  const r200 = resolveMaxMemory({ memoryMode: 'auto', memoryValue: null, totalMB: total, freeMB: free, modCount: 200 });
  assert.ok(r0 <= r50, `0 mod (${r0}) 应 ≤ 50 mod (${r50})`);
  assert.ok(r50 <= r100, `50 mod (${r50}) 应 ≤ 100 mod (${r100})`);
  assert.ok(r100 <= r200, `100 mod (${r100}) 应 ≤ 200 mod (${r200})`);
});

test('auto 模式：100 mod 大型整合包 → 至少 8GB', () => {
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 16 * GB, freeMB: 8 * GB, modCount: 100
  });
  assert.ok(r >= 8192, `100 mod 应至少 8GB，实际 ${mbToGb(r)}`);
});

/* =================== auto 模式：物理内存约束 =================== */

test('auto 模式：4GB 物理不应给超过 2.5GB（保留 1.5GB 给系统）', () => {
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 4 * GB, freeMB: 3 * GB, // 即使可用 3GB，也不能给太多
    modCount: 50
  });
  assert.ok(r <= 2560, `4GB 物理应 ≤ 2.5GB，实际 ${mbToGb(r)}`);
});

test('auto 模式：8GB 物理不应给超过 6GB（保留 2GB 给系统）', () => {
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 8 * GB, freeMB: 7 * GB,
    modCount: 50
  });
  assert.ok(r <= 6144, `8GB 物理应 ≤ 6GB，实际 ${mbToGb(r)}`);
});

test('auto 模式：当前可用内存低不影响分配（关键修复点）', () => {
  // 这是修复的核心：旧算法用 freeMB 算，新算法用 totalMB
  // 16GB 物理，即使当前可用只有 1GB，也应该给整合包足够内存
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 16 * GB, freeMB: 1 * GB, // 可用内存极低
    modCount: 20
  });
  assert.ok(r >= 4096, `即使可用内存低，也应至少 4GB，实际 ${mbToGb(r)}`);
});

/* =================== auto 模式：封顶与对齐 =================== */

test('auto 模式：64GB 物理/300 mod → 封顶 16GB', () => {
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 64 * GB, freeMB: 32 * GB,
    modCount: 300
  });
  assert.ok(r <= 16384, `应封顶 16GB，实际 ${mbToGb(r)}`);
});

test('auto 模式：所有返回值对齐到 256MB', () => {
  const testCases = [
    { total: 2 * GB, mod: 0 },
    { total: 4 * GB, mod: 10 },
    { total: 8 * GB, mod: 50 },
    { total: 16 * GB, mod: 100 },
    { total: 32 * GB, mod: 200 },
    { total: 64 * GB, mod: 300 }
  ];
  for (const tc of testCases) {
    const r = resolveMaxMemory({
      memoryMode: 'auto', memoryValue: null,
      totalMB: tc.total, freeMB: tc.total / 2,
      modCount: tc.mod
    });
    assert.strictEqual(r % 256, 0, `${tc.total}MB 物理/${tc.mod}mod 返回 ${r}MB 未对齐 256`);
  }
});

test('auto 模式：所有返回值在合理范围 [512MB, 16GB]', () => {
  const testCases = [
    { total: 1 * GB, mod: 0 },
    { total: 2 * GB, mod: 0 },
    { total: 4 * GB, mod: 0 },
    { total: 8 * GB, mod: 0 },
    { total: 16 * GB, mod: 0 },
    { total: 32 * GB, mod: 0 },
    { total: 64 * GB, mod: 0 }
  ];
  for (const tc of testCases) {
    const r = resolveMaxMemory({
      memoryMode: 'auto', memoryValue: null,
      totalMB: tc.total, freeMB: tc.total / 2,
      modCount: tc.mod
    });
    assert.ok(r >= 512, `${tc.total}MB 物理应 ≥ 512MB，实际 ${r}`);
    assert.ok(r <= 16384, `${tc.total}MB 物理应 ≤ 16GB，实际 ${r}`);
  }
});

/* =================== 边界情况 =================== */

test('auto 模式：modCount 为负数时按 0 处理', () => {
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 16 * GB, freeMB: 8 * GB, modCount: -10
  });
  const r0 = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 16 * GB, freeMB: 8 * GB, modCount: 0
  });
  assert.strictEqual(r, r0, `负 mod 应等同于 0 mod`);
});

test('auto 模式：modCount 为字符串数字也能解析', () => {
  const r1 = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 16 * GB, freeMB: 8 * GB, modCount: 50
  });
  const r2 = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 16 * GB, freeMB: 8 * GB, modCount: '50'
  });
  assert.strictEqual(r1, r2, `数字 50 和字符串 '50' 应结果一致`);
});

test('auto 模式：totalMB 异常小时至少返回 512MB', () => {
  const r = resolveMaxMemory({
    memoryMode: 'auto', memoryValue: null,
    totalMB: 256, freeMB: 128, modCount: 0
  });
  assert.ok(r >= 512, `极端小内存也应 ≥ 512MB，实际 ${r}`);
});
