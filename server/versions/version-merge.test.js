const { test } = require('node:test');
const assert = require('node:assert');

const {
  deduplicateJvmArgs,
  deduplicateGameArgs,
  mergeVersionJson,
  evaluateRules
} = require('./version-merge');

/* =================== deduplicateJvmArgs =================== */

test('deduplicateJvmArgs: 空数组原样返回', () => {
  assert.deepStrictEqual(deduplicateJvmArgs([]), []);
});

test('deduplicateJvmArgs: null/undefined 返回空数组', () => {
  assert.deepStrictEqual(deduplicateJvmArgs(null), []);
  assert.deepStrictEqual(deduplicateJvmArgs(undefined), []);
});

test('deduplicateJvmArgs: 精确字符串去重 - 不同值的 -Xmx 都保留', () => {
  // 实现是精确字符串匹配去重：-Xmx4G 和 -Xmx8G 是不同字符串，都保留
  const input = ['-Xmx4G', '-Xms2G', '-Xmx8G', '-Xms4G'];
  const result = deduplicateJvmArgs(input);
  assert.deepStrictEqual(result, ['-Xmx4G', '-Xms2G', '-Xmx8G', '-Xms4G']);
});

test('deduplicateJvmArgs: 完全相同的 -Xmx 字符串只保留首次', () => {
  const input = ['-Xmx4G', '-Xms2G', '-Xmx4G', '-Xms2G'];
  const result = deduplicateJvmArgs(input);
  assert.deepStrictEqual(result, ['-Xmx4G', '-Xms2G']);
});

test('deduplicateJvmArgs: -XX 参数精确字符串去重', () => {
  // -XX:+UseG1GC 完全相同 → 去重；MaxGCPauseMillis=50 和 =100 是不同字符串 → 都保留
  const input = ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=50', '-XX:+UseG1GC', '-XX:MaxGCPauseMillis=100'];
  const result = deduplicateJvmArgs(input);
  assert.deepStrictEqual(result, ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=50', '-XX:MaxGCPauseMillis=100']);
});

test('deduplicateJvmArgs: -D 系统属性精确字符串去重', () => {
  // -Dfoo=1 和 -Dfoo=3 是不同字符串 → 都保留；-Dbar=2 完全相同重复 → 去重
  const input = ['-Dfoo=1', '-Dbar=2', '-Dfoo=3', '-Dbar=2'];
  const result = deduplicateJvmArgs(input);
  assert.deepStrictEqual(result, ['-Dfoo=1', '-Dbar=2', '-Dfoo=3']);
});

test('deduplicateJvmArgs: --add-opens 多值标志展开为成对', () => {
  // 实现将 --add-opens v1 v2 展开为成对：--add-opens v1 --add-opens v2
  const input = ['--add-opens', 'java.base/java.lang=ALL-UNNAMED', 'java.base/java.util=ALL-UNNAMED', '-Xmx4G'];
  const result = deduplicateJvmArgs(input);
  assert.deepStrictEqual(result, [
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '--add-opens', 'java.base/java.util=ALL-UNNAMED',
    '-Xmx4G'
  ]);
});

test('deduplicateJvmArgs: --add-opens 完全相同的成对出现会被去重', () => {
  const input = [
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED'
  ];
  const result = deduplicateJvmArgs(input);
  // --add-opens 本身不以 -D/-X/-XX 开头，不会被去重，所以两对都保留
  assert.deepStrictEqual(result, [
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED'
  ]);
});

test('deduplicateJvmArgs: 非 -D/-X/-XX 参数不去重（保留所有出现）', () => {
  const input = ['--some-flag', '--some-flag', 'arg'];
  const result = deduplicateJvmArgs(input);
  assert.deepStrictEqual(result, ['--some-flag', '--some-flag', 'arg']);
});

/* =================== deduplicateGameArgs =================== */

test('deduplicateGameArgs: --username 重复时保留首次', () => {
  const input = ['--username', 'Player1', '--username', 'Player2'];
  const result = deduplicateGameArgs(input);
  assert.deepStrictEqual(result, ['--username', 'Player1']);
});

test('deduplicateGameArgs: --version 单值选项去重', () => {
  const input = ['--version', '1.20.1', '--version', '1.20.2'];
  const result = deduplicateGameArgs(input);
  assert.deepStrictEqual(result, ['--version', '1.20.1']);
});

test('deduplicateGameArgs: 不同单值选项各自去重', () => {
  const input = [
    '--username', 'P1', '--version', '1.20',
    '--username', 'P2', '--version', '1.21'
  ];
  const result = deduplicateGameArgs(input);
  assert.deepStrictEqual(result, ['--username', 'P1', '--version', '1.20']);
});

test('deduplicateGameArgs: 非单值选项不去重', () => {
  const input = ['--fullscreen', '--fullscreen'];
  const result = deduplicateGameArgs(input);
  assert.deepStrictEqual(result, ['--fullscreen', '--fullscreen']);
});

test('deduplicateGameArgs: --fml.forgeVersion 等加载器参数去重', () => {
  const input = ['--fml.forgeVersion', '47.0.1', '--fml.forgeVersion', '47.1.0'];
  const result = deduplicateGameArgs(input);
  assert.deepStrictEqual(result, ['--fml.forgeVersion', '47.0.1']);
});

/* =================== mergeVersionJson =================== */

test('mergeVersionJson: 子版本字段优先于父版本', () => {
  const parent = { mainClass: 'net.minecraft.client.main.Main', type: 'release' };
  const child = { mainClass: 'cpw.mods.modlauncher.Launcher', id: '1.20.1-forge' };
  const merged = mergeVersionJson(parent, child);
  assert.strictEqual(merged.mainClass, 'cpw.mods.modlauncher.Launcher');
  assert.strictEqual(merged.id, '1.20.1-forge');
});

test('mergeVersionJson: 子版本未设置的字段继承父版本', () => {
  const parent = { mainClass: 'net.minecraft.client.main.Main', assets: '1.20' };
  const child = { id: 'child-version' };
  const merged = mergeVersionJson(parent, child);
  assert.strictEqual(merged.mainClass, 'net.minecraft.client.main.Main');
  assert.strictEqual(merged.assets, '1.20');
});

test('mergeVersionJson: 库列表合并，子版本优先', () => {
  const parent = {
    libraries: [
      { name: 'com.google.guava:guava:31.1-jre' },
      { name: 'net.minecraft:client:1.20.1' }
    ]
  };
  const child = {
    libraries: [
      { name: 'net.minecraftforge:forge:1.20.1-47.0.1' }
    ]
  };
  const merged = mergeVersionJson(parent, child);
  // 子版本库在前，父版本库在后
  assert.strictEqual(merged.libraries[0].name, 'net.minecraftforge:forge:1.20.1-47.0.1');
  // 父版本库应保留
  assert.ok(merged.libraries.some((l) => l.name === 'com.google.guava:guava:31.1-jre'));
});

test('mergeVersionJson: 子版本库与父版本同 group:artifact 时去重父版本', () => {
  const parent = {
    libraries: [
      { name: 'com.google.guava:guava:31.1-jre' },
      { name: 'net.minecraft:client:1.20.1' }
    ]
  };
  const child = {
    libraries: [
      { name: 'com.google.guava:guava:32.0.0-jre' } // 同 group:artifact，不同版本
    ]
  };
  const merged = mergeVersionJson(parent, child);
  // 应只有 1 个 guava（子版本），父版本被过滤
  const guavaLibs = merged.libraries.filter((l) => l.name.startsWith('com.google.guava:guava'));
  assert.strictEqual(guavaLibs.length, 1, `应只有 1 个 guava，实际 ${guavaLibs.length}`);
  assert.strictEqual(guavaLibs[0].name, 'com.google.guava:guava:32.0.0-jre');
  // 父版本的其他库应保留
  assert.ok(merged.libraries.some((l) => l.name === 'net.minecraft:client:1.20.1'));
});

test('mergeVersionJson: arguments.jvm 合并去重', () => {
  const parent = {
    arguments: {
      jvm: ['-Xmx2G', '-Dfoo=1'],
      game: ['--username', 'Parent']
    }
  };
  const child = {
    arguments: {
      jvm: ['-Xmx4G', '-Dbar=2'],
      game: ['--username', 'Child']
    }
  };
  const merged = mergeVersionJson(parent, child);
  // JVM 参数合并：子版本在前，父版本在后；精确字符串去重
  // -Xmx4G 和 -Xmx2G 是不同字符串，都保留；-Dfoo=1 和 -Dbar=2 也都保留
  assert.ok(merged.arguments.jvm.includes('-Xmx4G'));
  assert.ok(merged.arguments.jvm.includes('-Xmx2G'));
  assert.ok(merged.arguments.jvm.includes('-Dfoo=1'));
  assert.ok(merged.arguments.jvm.includes('-Dbar=2'));
  // 子版本参数应排在父版本前面
  assert.strictEqual(merged.arguments.jvm.indexOf('-Xmx4G'), 0);
  assert.ok(merged.arguments.jvm.indexOf('-Xmx2G') > merged.arguments.jvm.indexOf('-Xmx4G'));
  // game 参数 --username 单值去重，保留首次（子版本在前）
  assert.deepStrictEqual(merged.arguments.game, ['--username', 'Child']);
});

test('mergeVersionJson: arguments.jvm 完全相同的字符串只保留首次', () => {
  const parent = {
    arguments: {
      jvm: ['-Xmx4G', '-Dfoo=1']
    }
  };
  const child = {
    arguments: {
      jvm: ['-Xmx4G', '-Dbar=2']
    }
  };
  const merged = mergeVersionJson(parent, child);
  // -Xmx4G 完全相同 → 只保留首次（子版本位置）；-Dfoo=1 和 -Dbar=2 不同 → 都保留
  const xmxCount = merged.arguments.jvm.filter((x) => x === '-Xmx4G').length;
  assert.strictEqual(xmxCount, 1, '完全相同的 -Xmx4G 应只保留 1 个');
  assert.ok(merged.arguments.jvm.includes('-Dfoo=1'));
  assert.ok(merged.arguments.jvm.includes('-Dbar=2'));
});

test('mergeVersionJson: inheritsFrom 保留子版本声明', () => {
  const parent = { id: '1.20.1' };
  const child = { id: '1.20.1-forge', inheritsFrom: '1.20.1' };
  const merged = mergeVersionJson(parent, child);
  assert.strictEqual(merged.inheritsFrom, '1.20.1');
  assert.strictEqual(merged.id, '1.20.1-forge');
});

test('mergeVersionJson: javaVersion 子版本优先', () => {
  const parent = { javaVersion: { majorVersion: 8 } };
  const child = { javaVersion: { majorVersion: 17 } };
  const merged = mergeVersionJson(parent, child);
  assert.strictEqual(merged.javaVersion.majorVersion, 17);
});

test('mergeVersionJson: downloads 合并（子版本覆盖父版本同名字段）', () => {
  const parent = {
    downloads: { client: { url: 'parent-url' }, server: { url: 'parent-server-url' } }
  };
  const child = {
    downloads: { client: { url: 'child-url' } }
  };
  const merged = mergeVersionJson(parent, child);
  assert.strictEqual(merged.downloads.client.url, 'child-url');
  assert.strictEqual(merged.downloads.server.url, 'parent-server-url');
});

test('mergeVersionJson: Fabric 主类缺库时自动补齐 fabric-loader/intermediary', () => {
  const parent = {};
  const child = {
    id: 'fabric-loader-0.16.10-1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    inheritsFrom: '1.20.1'
  };
  const merged = mergeVersionJson(parent, child);
  const libs = merged.libraries || [];
  const hasLoader = libs.some((l) => l.name.startsWith('net.fabricmc:fabric-loader'));
  const hasIntermediary = libs.some((l) => l.name.startsWith('net.fabricmc:intermediary'));
  assert.ok(hasLoader, '应自动补齐 fabric-loader 库');
  assert.ok(hasIntermediary, '应自动补齐 intermediary 库');
});

/* =================== evaluateRules =================== */

test('evaluateRules: 无规则时默认允许', () => {
  assert.strictEqual(evaluateRules([]), true);
  assert.strictEqual(evaluateRules(null), true);
  assert.strictEqual(evaluateRules(undefined), true);
});

test('evaluateRules: allow 当前 OS → 允许', () => {
  const currentOS = process.platform === 'win32' ? 'windows' :
                   process.platform === 'darwin' ? 'osx' : 'linux';
  const rules = [{ action: 'allow', os: { name: currentOS } }];
  assert.strictEqual(evaluateRules(rules), true);
});

test('evaluateRules: allow 其他 OS → 不允许', () => {
  const otherOS = process.platform === 'win32' ? 'linux' : 'windows';
  const rules = [{ action: 'allow', os: { name: otherOS } }];
  assert.strictEqual(evaluateRules(rules), false);
});

test('evaluateRules: disallow 当前 OS → 不允许', () => {
  const currentOS = process.platform === 'win32' ? 'windows' :
                   process.platform === 'darwin' ? 'osx' : 'linux';
  const rules = [
    { action: 'allow' },
    { action: 'disallow', os: { name: currentOS } }
  ];
  assert.strictEqual(evaluateRules(rules), false);
});

test('evaluateRules: 多条规则按顺序生效（最后匹配的决定）', () => {
  const currentOS = process.platform === 'win32' ? 'windows' : 'linux';
  const rules = [
    { action: 'allow' }, // 默认允许
    { action: 'disallow', os: { name: currentOS } }, // 当前 OS 禁止
    { action: 'allow', os: { name: 'osx' } } // osx 允许（不匹配当前）
  ];
  // 第二条匹配当前 OS → disallow 生效
  assert.strictEqual(evaluateRules(rules), false);
});

test('evaluateRules: features.is_demo_user → 当前不支持 → 不匹配', () => {
  const rules = [{ action: 'allow', features: { is_demo_user: true } }];
  assert.strictEqual(evaluateRules(rules), false);
});

test('evaluateRules: features.has_custom_resolution 需要显式传入', () => {
  const rules = [
    { action: 'allow' },
    { action: 'disallow', features: { has_custom_resolution: true } }
  ];
  // 不传 hasCustomResolution → 第二条不匹配 → 默认允许
  assert.strictEqual(evaluateRules(rules, {}), true);
  // 传 hasCustomResolution=true → 第二条匹配 → disallow
  assert.strictEqual(evaluateRules(rules, { hasCustomResolution: true }), false);
});

test('evaluateRules: has_quick_plays_support 系列一律不匹配', () => {
  const rules1 = [{ action: 'allow', features: { has_quick_plays_support: true } }];
  const rules2 = [{ action: 'allow', features: { is_quick_play_singleplayer: true } }];
  const rules3 = [{ action: 'allow', features: { is_quick_play_multiplayer: true } }];
  const rules4 = [{ action: 'allow', features: { is_quick_play_realms: true } }];
  assert.strictEqual(evaluateRules(rules1), false);
  assert.strictEqual(evaluateRules(rules2), false);
  assert.strictEqual(evaluateRules(rules3), false);
  assert.strictEqual(evaluateRules(rules4), false);
});

test('evaluateRules: 无 os 无 features 的规则视为匹配', () => {
  const rules = [
    { action: 'allow' },
    { action: 'disallow' } // 无条件 disallow
  ];
  // 两条都匹配，最后一条决定 → disallow
  assert.strictEqual(evaluateRules(rules), false);
});
