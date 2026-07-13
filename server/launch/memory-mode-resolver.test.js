/**
 * @file server/launch/memory-mode-resolver.test.js - 内存模式解析纯函数测试
 * @description TDD 任务3：证明 settings.maxMemory 默认 4096 会绕过 auto 逻辑的 bug。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMemoryMode } = require('./memory-mode-resolver');

test('默认 settings.maxMemory=4096 + 无 launch_settings 时走 auto 模式', () => {
  // 这是"剑与王国 (11)"整合包崩溃场景：
  // settings.maxMemory 是 version-settings.js 的默认值 4096，并非用户显式设置
  // 期望走 auto，让 mod 多时自动提高下限到 8192
  const result = resolveMemoryMode({
    settingsMaxMemory: 4096,
    hasLaunchSettings: false,
    launchMemoryMode: null,
    launchMemoryValue: null
  });
  assert.equal(result.memoryMode, 'auto');
  assert.equal(result.memoryValue, null);
});

test('用户在旧版全局设置改过 maxMemory=6144 + 无 launch_settings 时走 custom', () => {
  // 用户在旧版 UI 显式设置了 maxMemory=6144，应保留此值（按 custom 走）
  const result = resolveMemoryMode({
    settingsMaxMemory: 6144,
    hasLaunchSettings: false,
    launchMemoryMode: null,
    launchMemoryValue: null
  });
  assert.equal(result.memoryMode, 'custom');
  assert.equal(result.memoryValue, 6144);
});

test('有 launch_settings 且 memoryMode=custom 时按 launch_settings 走', () => {
  const result = resolveMemoryMode({
    settingsMaxMemory: 4096,
    hasLaunchSettings: true,
    launchMemoryMode: 'custom',
    launchMemoryValue: 8192
  });
  assert.equal(result.memoryMode, 'custom');
  assert.equal(result.memoryValue, 8192);
});

test('有 launch_settings 且 memoryMode=auto 时按 launch_settings 走 auto', () => {
  const result = resolveMemoryMode({
    settingsMaxMemory: 6144, // 即使旧版设置改过，前端显式 auto 也优先
    hasLaunchSettings: true,
    launchMemoryMode: 'auto',
    launchMemoryValue: null
  });
  assert.equal(result.memoryMode, 'auto');
  assert.equal(result.memoryValue, null);
});
