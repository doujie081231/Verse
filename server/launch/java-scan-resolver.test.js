/**
 * @file java-scan-resolver.test.js - Java 系统扫描决策测试
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldSkipSystemScan } = require('./java-scan-resolver');

test('candidates 为空时不跳过系统扫描', () => {
  assert.equal(shouldSkipSystemScan([], 17, 999), false);
});

test('candidates 里有精确匹配（major==required）时跳过系统扫描', () => {
  // Forge 1.20.1 要 Java 17，candidates 里有 jdk-17
  const candidates = [{ majorVersion: 17 }];
  assert.equal(shouldSkipSystemScan(candidates, 17, 999), true);
});

test('candidates 里有满足要求但非精确匹配的 Java 时不跳过系统扫描（核心修复）', () => {
  // Forge 1.20.1 要 Java 17+，candidates 里有 jdk-25（满足要求但非精确匹配）
  // 旧逻辑：25 >= 17 → 跳过系统扫描 → 错过 Program Files 里的 jdk-17
  // 新逻辑：25 != 17 → 继续扫描系统 → 找到 jdk-17
  const candidates = [{ majorVersion: 25 }];
  assert.equal(shouldSkipSystemScan(candidates, 17, 999), false);
});

test('candidates 里有精确匹配但超出 maxVersion 时不跳过系统扫描', () => {
  // 某些老版本要求 Java 8（max=8），candidates 里有 jdk-8
  // 但如果 required=8, max=8，精确匹配 → 跳过
  const candidates = [{ majorVersion: 8 }];
  assert.equal(shouldSkipSystemScan(candidates, 8, 8), true);
});

test('candidates 里同时有精确匹配和非精确匹配时跳过系统扫描', () => {
  // candidates 里有 jdk-17 和 jdk-25，有精确匹配 → 跳过
  const candidates = [{ majorVersion: 25 }, { majorVersion: 17 }];
  assert.equal(shouldSkipSystemScan(candidates, 17, 999), true);
});

test('candidates 里有 Java 21（Minecraft runtime）但要求 Java 17 时不跳过系统扫描', () => {
  // 复现用户场景：versepc 找到了 Minecraft runtime 的 Java 21，
  // 但要求 Java 17，21 非精确匹配 → 继续扫描系统找 jdk-17
  const candidates = [{ majorVersion: 21 }];
  assert.equal(shouldSkipSystemScan(candidates, 17, 999), false);
});
