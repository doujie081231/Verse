const { test } = require('node:test');
const assert = require('node:assert');

const { resolveMemoryMode, DEFAULT_LEGACY_MAX_MEMORY } = require('./memory-mode-resolver');

/* =================== 优先级 1：前端 launch_settings =================== */

test('前端有 launch_settings 时优先使用前端配置（auto）', () => {
  const r = resolveMemoryMode({
    settingsMaxMemory: 8192, // 即使全局设置是 8192，前端优先
    hasLaunchSettings: true,
    launchMemoryMode: 'auto',
    launchMemoryValue: null
  });
  assert.strictEqual(r.memoryMode, 'auto');
  assert.strictEqual(r.memoryValue, null);
});

test('前端有 launch_settings 时优先使用前端配置（custom + 具体值）', () => {
  const r = resolveMemoryMode({
    settingsMaxMemory: 4096,
    hasLaunchSettings: true,
    launchMemoryMode: 'custom',
    launchMemoryValue: 6144
  });
  assert.strictEqual(r.memoryMode, 'custom');
  assert.strictEqual(r.memoryValue, 6144);
});

test('前端 launch_settings 模式为空时回退到 auto', () => {
  const r = resolveMemoryMode({
    settingsMaxMemory: 4096,
    hasLaunchSettings: true,
    launchMemoryMode: null,
    launchMemoryValue: null
  });
  assert.strictEqual(r.memoryMode, 'auto');
});

/* =================== 优先级 2：旧版全局设置 maxMemory ≠ 4096 =================== */

test('无前端配置 + 全局 maxMemory=8192（非默认）→ 视为 custom', () => {
  const r = resolveMemoryMode({
    settingsMaxMemory: 8192,
    hasLaunchSettings: false,
    launchMemoryMode: null,
    launchMemoryValue: null
  });
  assert.strictEqual(r.memoryMode, 'custom');
  assert.strictEqual(r.memoryValue, 8192);
});

test('无前端配置 + 全局 maxMemory=2048（非默认）→ 视为 custom', () => {
  const r = resolveMemoryMode({
    settingsMaxMemory: 2048,
    hasLaunchSettings: false,
    launchMemoryMode: null,
    launchMemoryValue: null
  });
  assert.strictEqual(r.memoryMode, 'custom');
  assert.strictEqual(r.memoryValue, 2048);
});

/* =================== 优先级 3：默认走 auto =================== */

test('无前端配置 + 全局 maxMemory=4096（默认值）→ 走 auto', () => {
  // 这是最关键的修复点：旧代码 if(settings.maxMemory) 永远为真，导致 auto 失效
  const r = resolveMemoryMode({
    settingsMaxMemory: DEFAULT_LEGACY_MAX_MEMORY, // 4096
    hasLaunchSettings: false,
    launchMemoryMode: null,
    launchMemoryValue: null
  });
  assert.strictEqual(r.memoryMode, 'auto');
  assert.strictEqual(r.memoryValue, null);
});

/* =================== 边界情况 =================== */

test('settingsMaxMemory 为字符串 4096 时走 auto（typeof 保护，非数字直接走 auto）', () => {
  // 实现里第一层有 typeof === 'number' 保护
  // 非数字类型（字符串 '4096'）不会进入"非默认值"判断，直接走 auto
  // 这是合理的设计：避免字符串和数字类型混用导致误判
  const r = resolveMemoryMode({
    settingsMaxMemory: '4096',
    hasLaunchSettings: false,
    launchMemoryMode: null,
    launchMemoryValue: null
  });
  assert.strictEqual(r.memoryMode, 'auto');
  assert.strictEqual(r.memoryValue, null);
});

test('settingsMaxMemory 为 null 时走 auto', () => {
  const r = resolveMemoryMode({
    settingsMaxMemory: null,
    hasLaunchSettings: false,
    launchMemoryMode: null,
    launchMemoryValue: null
  });
  assert.strictEqual(r.memoryMode, 'auto');
});

test('settingsMaxMemory 为 undefined 时走 auto', () => {
  const r = resolveMemoryMode({
    settingsMaxMemory: undefined,
    hasLaunchSettings: false,
    launchMemoryMode: null,
    launchMemoryValue: null
  });
  assert.strictEqual(r.memoryMode, 'auto');
});

test('DEFAULT_LEGACY_MAX_MEMORY 应为 4096', () => {
  assert.strictEqual(DEFAULT_LEGACY_MAX_MEMORY, 4096);
});

test('前端配置优先于旧版全局设置（优先级回归）', () => {
  // 前端选 auto + 全局 maxMemory=8192 → 应该走前端的 auto
  const r = resolveMemoryMode({
    settingsMaxMemory: 8192,
    hasLaunchSettings: true,
    launchMemoryMode: 'auto',
    launchMemoryValue: null
  });
  assert.strictEqual(r.memoryMode, 'auto');
});
