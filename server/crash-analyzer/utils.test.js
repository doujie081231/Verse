const { test } = require('node:test');
const assert = require('node:assert');

const { regexSeek, regexCheck, appendReason } = require('./utils');

/* =================== regexSeek =================== */

test('regexSeek: 匹配到返回完整匹配文本', () => {
  assert.strictEqual(regexSeek('hello world', 'world'), 'world');
  assert.strictEqual(regexSeek('Java version: 17.0.1', 'Java version: \\S+'), 'Java version: 17.0.1');
});

test('regexSeek: 无匹配返回 null', () => {
  assert.strictEqual(regexSeek('hello world', 'foo'), null);
});

test('regexSeek: 空文本返回 null', () => {
  assert.strictEqual(regexSeek('', 'foo'), null);
  assert.strictEqual(regexSeek(null, 'foo'), null);
  assert.strictEqual(regexSeek(undefined, 'foo'), null);
});

test('regexSeek: 非法正则返回 null（不抛错）', () => {
  assert.strictEqual(regexSeek('hello', '['), null);
  assert.strictEqual(regexSeek('hello', '(unclosed'), null);
});

test('regexSeek: 使用 flags（如 i 忽略大小写）', () => {
  assert.strictEqual(regexSeek('Hello World', 'world', 'i'), 'World');
  assert.strictEqual(regexSeek('Hello World', 'WORLD'), null);
});

test('regexSeek: 带捕获组的只返回完整匹配（不含捕获组）', () => {
  // match[0] 是完整匹配，不带捕获组
  assert.strictEqual(regexSeek('version=17', 'version=(\\d+)'), 'version=17');
});

test('regexSeek: 多行文本中的匹配（默认不跨行）', () => {
  const text = 'line1\nerror: something\nline3';
  assert.strictEqual(regexSeek(text, 'error: \\w+'), 'error: something');
});

/* =================== regexCheck =================== */

test('regexCheck: 匹配返回 true', () => {
  assert.strictEqual(regexCheck('hello world', 'world'), true);
  assert.strictEqual(regexCheck('Java 17', 'Java \\d+'), true);
});

test('regexCheck: 无匹配返回 false', () => {
  assert.strictEqual(regexCheck('hello world', 'foo'), false);
});

test('regexCheck: 空文本返回 false', () => {
  assert.strictEqual(regexCheck('', 'foo'), false);
  assert.strictEqual(regexCheck(null, 'foo'), false);
  assert.strictEqual(regexCheck(undefined, 'foo'), false);
});

test('regexCheck: 非法正则返回 false（不抛错）', () => {
  assert.strictEqual(regexCheck('hello', '['), false);
  assert.strictEqual(regexCheck('hello', '(unclosed'), false);
});

test('regexCheck: 使用 flags（如 i 忽略大小写）', () => {
  assert.strictEqual(regexCheck('Hello', 'hello', 'i'), true);
  assert.strictEqual(regexCheck('Hello', 'hello'), false);
});

test('regexCheck: 部分匹配也返回 true（与 regexSeek 一致）', () => {
  assert.strictEqual(regexCheck('error: NullPointerException', 'NullPointerException'), true);
});

/* =================== appendReason =================== */

// 辅助函数：创建一个 mock 的 this 上下文
function createMockThis() {
  return { crashReasons: new Map() };
}

test('appendReason: 新原因被添加到 Map', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'MOD_CONFLICT');
  assert.ok(ctx.crashReasons.has('MOD_CONFLICT'));
  assert.deepStrictEqual(ctx.crashReasons.get('MOD_CONFLICT'), []);
});

test('appendReason: additional 字符串被包装为数组', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'MOD_CONFLICT', 'optifine');
  assert.deepStrictEqual(ctx.crashReasons.get('MOD_CONFLICT'), ['optifine']);
});

test('appendReason: additional 数组原样保留', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'MOD_CONFLICT', ['optifine', 'forge']);
  assert.deepStrictEqual(ctx.crashReasons.get('MOD_CONFLICT'), ['optifine', 'forge']);
});

test('appendReason: 相同原因多次调用合并 additional', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'MOD_CONFLICT', 'optifine');
  appendReason.call(ctx, 'MOD_CONFLICT', 'forge');
  assert.deepStrictEqual(ctx.crashReasons.get('MOD_CONFLICT'), ['optifine', 'forge']);
});

test('appendReason: 相同 additional 字符串会去重', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'MOD_CONFLICT', 'optifine');
  appendReason.call(ctx, 'MOD_CONFLICT', 'optifine'); // 重复
  appendReason.call(ctx, 'MOD_CONFLICT', 'forge');
  assert.deepStrictEqual(ctx.crashReasons.get('MOD_CONFLICT'), ['optifine', 'forge']);
});

test('appendReason: additional=null 不影响已有列表', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'MOD_CONFLICT', 'optifine');
  appendReason.call(ctx, 'MOD_CONFLICT', null);
  assert.deepStrictEqual(ctx.crashReasons.get('MOD_CONFLICT'), ['optifine']);
});

test('appendReason: 新原因 + null additional → 空数组', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'JAVA_VERSION', null);
  assert.deepStrictEqual(ctx.crashReasons.get('JAVA_VERSION'), []);
});

test('appendReason: 新原因 + undefined additional → 空数组', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'JAVA_VERSION');
  assert.deepStrictEqual(ctx.crashReasons.get('JAVA_VERSION'), []);
});

test('appendReason: 数组中的重复项会被去重', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'MOD_CONFLICT', ['optifine', 'forge', 'optifine', 'forge']);
  assert.deepStrictEqual(ctx.crashReasons.get('MOD_CONFLICT'), ['optifine', 'forge']);
});

test('appendReason: 多个原因互不影响', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'MOD_CONFLICT', 'optifine');
  appendReason.call(ctx, 'JAVA_VERSION', '17');
  appendReason.call(ctx, 'MEMORY', 'low');
  assert.strictEqual(ctx.crashReasons.size, 3);
  assert.deepStrictEqual(ctx.crashReasons.get('MOD_CONFLICT'), ['optifine']);
  assert.deepStrictEqual(ctx.crashReasons.get('JAVA_VERSION'), ['17']);
  assert.deepStrictEqual(ctx.crashReasons.get('MEMORY'), ['low']);
});

test('appendReason: 已存在原因 + additional=null 保持原列表不变', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'MOD_CONFLICT', ['optifine', 'forge']);
  appendReason.call(ctx, 'MOD_CONFLICT', null);
  assert.deepStrictEqual(ctx.crashReasons.get('MOD_CONFLICT'), ['optifine', 'forge']);
});

test('appendReason: 已存在原因 + undefined 保持原列表不变', () => {
  const ctx = createMockThis();
  appendReason.call(ctx, 'MOD_CONFLICT', ['optifine']);
  appendReason.call(ctx, 'MOD_CONFLICT'); // additional 默认 null
  assert.deepStrictEqual(ctx.crashReasons.get('MOD_CONFLICT'), ['optifine']);
});
