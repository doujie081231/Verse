const { test } = require('node:test');
const assert = require('node:assert');

const { shouldSkipSystemScan } = require('./java-scan-resolver');

/* =================== 候选为空 =================== */

test('候选列表为空 → 继续系统扫描', () => {
  const r = shouldSkipSystemScan([], 17, 999);
  assert.strictEqual(r, false);
});

/* =================== 精确匹配（关键修复点） =================== */

test('候选有精确匹配（majorVersion == requiredVersion）→ 跳过系统扫描', () => {
  // 场景：Forge 1.20.1 要 Java 17，candidates 里有 jdk-17
  const candidates = [
    { majorVersion: 17 },
    { majorVersion: 21 }
  ];
  const r = shouldSkipSystemScan(candidates, 17, 999);
  assert.strictEqual(r, true);
});

test('候选有精确匹配但超过 maxVersion → 不跳过', () => {
  // 场景：要求 Java 8-8（如旧版 Forge），但候选只有 17 → 不算精确匹配
  const candidates = [
    { majorVersion: 17 }
  ];
  const r = shouldSkipSystemScan(candidates, 8, 8);
  assert.strictEqual(r, false);
});

/* =================== 无精确匹配（旧逻辑会跳过，新逻辑继续扫描） =================== */

test('候选只有更高版本（非精确匹配）→ 继续系统扫描（关键修复点）', () => {
  // 场景：Forge 1.20.1 要 Java 17，candidates 里有 jdk-21（满足但不精确）
  // 系统里可能有更优的 jdk-17，需要继续扫描找到它
  const candidates = [
    { majorVersion: 21 },
    { majorVersion: 25 }
  ];
  const r = shouldSkipSystemScan(candidates, 17, 999);
  assert.strictEqual(r, false, '非精确匹配时应继续扫描系统 Java，找到最优版本');
});

test('候选只有更低版本 → 继续系统扫描', () => {
  // 场景：要求 Java 17，候选只有 Java 8（不满足）
  const candidates = [
    { majorVersion: 8 }
  ];
  const r = shouldSkipSystemScan(candidates, 17, 999);
  assert.strictEqual(r, false);
});

/* =================== 多候选混合 =================== */

test('多候选中有精确匹配 → 跳过系统扫描', () => {
  const candidates = [
    { majorVersion: 8 },
    { majorVersion: 17 }, // 精确匹配
    { majorVersion: 21 },
    { majorVersion: 25 }
  ];
  const r = shouldSkipSystemScan(candidates, 17, 999);
  assert.strictEqual(r, true);
});

test('多候选都非精确匹配 → 继续系统扫描', () => {
  const candidates = [
    { majorVersion: 8 },
    { majorVersion: 11 },
    { majorVersion: 21 },
    { majorVersion: 25 }
  ];
  const r = shouldSkipSystemScan(candidates, 17, 999);
  assert.strictEqual(r, false);
});

/* =================== 边界情况 =================== */

test('requiredVersion=8 时候选有 Java 8 → 跳过', () => {
  const candidates = [{ majorVersion: 8 }];
  const r = shouldSkipSystemScan(candidates, 8, 8);
  assert.strictEqual(r, true);
});

test('requiredVersion=21 时候选有 Java 21 → 跳过', () => {
  const candidates = [{ majorVersion: 21 }];
  const r = shouldSkipSystemScan(candidates, 21, 999);
  assert.strictEqual(r, true);
});

test('requiredVersion=17 但候选只有 Java 16（差一版）→ 继续扫描', () => {
  // 1.17 需要 Java 16，但 1.18 需要 Java 17
  // 候选有 16 但要求 17，应该继续扫描找 17
  const candidates = [{ majorVersion: 16 }];
  const r = shouldSkipSystemScan(candidates, 17, 999);
  assert.strictEqual(r, false);
});

test('maxVersion 限制：候选精确匹配但超过 maxVersion → 不跳过', () => {
  // 场景：旧版 Forge 1.12.2 要求 Java 8（min=8, max=8）
  // 但候选里有 Java 17（majorVersion 不等于 requiredVersion 8）
  const candidates = [{ majorVersion: 17 }];
  const r = shouldSkipSystemScan(candidates, 8, 8);
  assert.strictEqual(r, false);
});
