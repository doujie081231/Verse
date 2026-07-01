/**
 * @file memory-optimize-resolver.test.js - 启动前内存优化决策测试
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldRunMemoryOptimize } = require('./memory-optimize-resolver');

test('用户未显式开启（undefined）时不执行内存优化（修复默认开启的 bug）', () => {
  // 旧逻辑：autoMemoryOptimize !== false → true（默认开启）
  // 新逻辑：autoMemoryOptimize !== true → false（默认关闭）
  const result = shouldRunMemoryOptimize({
    autoMemoryOptimize: undefined,
    versionMemOptimize: 'global',
    totalMemMB: 16384,
    modCount: 312,
    freeMB: 2048
  });
  assert.equal(result, false, '用户未显式开启时不应执行内存优化');
});

test('用户显式开启 + 小内存机器 + 少量 mod + 内存紧张时执行', () => {
  const result = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8192,
    modCount: 10,
    freeMB: 1024
  });
  assert.equal(result, true, '用户显式开启 + 资源紧张时应执行');
});

test('用户显式开启但大内存机器（≥12GB）时跳过', () => {
  const result = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 16384,
    modCount: 10,
    freeMB: 1024
  });
  assert.equal(result, false, '大内存机器清空缓存弊大于利');
});

test('用户显式开启但大型整合包（modCount ≥ 100）时跳过', () => {
  const result = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8192,
    modCount: 312,
    freeMB: 1024
  });
  assert.equal(result, false, '大型整合包启动需要文件缓存，清空会更慢');
});

test('版本独立设置 off 覆盖全局开启', () => {
  const result = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'off',
    totalMemMB: 8192,
    modCount: 10,
    freeMB: 1024
  });
  assert.equal(result, false, '版本级 off 应覆盖全局设置');
});

test('版本独立设置 on 覆盖全局关闭', () => {
  const result = shouldRunMemoryOptimize({
    autoMemoryOptimize: false,
    versionMemOptimize: 'on',
    totalMemMB: 16384,
    modCount: 312,
    freeMB: 8192
  });
  assert.equal(result, true, '版本级 on 应强制执行');
});

test('用户显式开启但可用内存充足（>4GB）时跳过', () => {
  const result = shouldRunMemoryOptimize({
    autoMemoryOptimize: true,
    versionMemOptimize: 'global',
    totalMemMB: 8192,
    modCount: 10,
    freeMB: 5120
  });
  assert.equal(result, false, '可用内存充足时无需优化');
});
