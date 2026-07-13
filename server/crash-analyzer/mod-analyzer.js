/**
 * @file server/crash-analyzer/mod-analyzer.js - Mod 名分析与关键字提取
 *   包含 analyzeStackKeyword / analyzeModName / tryAnalyzeModName 方法，
 *   通过 Object.assign 挂载到 CrashAnalyzer.prototype 上。
 */

module.exports = {
  /**
   * 从错误堆栈中提取可能的 Mod ID 关键字
   * @param {string} errorStack - 错误堆栈文本
   * @returns {string[]} Mod ID 关键字数组（超过 10 个时返回空数组）
   */
  analyzeStackKeyword(errorStack) {
    errorStack = '\n' + (errorStack || '') + '\n';

    const stackSearchResults = [];
    // 正则 1：匹配顶层类名
    try {
      const regex1 = new RegExp('(?<=\\n[^{]+)[a-zA-Z_]\\w+\\.[a-zA-Z_]+[\\w\\.]+(?=\\.[\\w\\.\\$]+\\()', 'g');
      let match;
      while ((match = regex1.exec(errorStack)) !== null) {
        stackSearchResults.push(match[0]);
      }
    } catch (e) {}
    // 正则 2：匹配内部类名（$ 分隔）
    try {
      const regex2 = new RegExp('(?<=at [^(]+?\\.\\w+\\$\\w+\\$\\w+)[\\w\\$]+(?=\\$\\w+\\()', 'g');
      let match;
      while ((match = regex2.exec(errorStack)) !== null) {
        stackSearchResults.push(match[0].replace(/\$/g, '.'));
      }
    } catch (e) {}

    // 过滤掉 Java 标准库和已知框架的堆栈
    const possibleStacks = [];
    for (const stack of stackSearchResults) {
      if (!stack.includes('.')) continue;

      const ignoreStacks = [
        'java', 'sun', 'javax', 'jdk', 'oolloo',
        'org.lwjgl', 'com.sun', 'net.minecraftforge', 'paulscode.sound', 'com.mojang', 'net.minecraft', 'cpw.mods',
        'com.google', 'org.apache', 'org.spongepowered', 'net.fabricmc', 'com.mumfrey', 'com.electronwill.nightconfig', 'it.unimi.dsi',
        'MojangTricksIntelDriversForPerformance_java'
      ];

      if (ignoreStacks.some((ignore) => stack.startsWith(ignore))) continue;

      possibleStacks.push(stack.trim());
    }

    // 从包名前 3 段提取候选 Mod ID
    const possibleWords = [];
    for (const stack of possibleStacks) {
      const splitted = stack.split('.');
      for (let i = 0; i < Math.min(3, splitted.length - 1); i++) {
        const word = splitted[i];
        if (word.length <= 2 || word.startsWith('func_')) continue;
        if (['com', 'org', 'net', 'asm', 'fml', 'mod', 'jar', 'sun', 'lib', 'map', 'gui', 'dev', 'nio', 'api', 'dsi', 'top', 'mcp',
          'core', 'init', 'mods', 'main', 'file', 'game', 'load', 'read', 'done', 'util', 'tile', 'item', 'base', 'fake', 'oshi', 'impl',
          'forge', 'setup', 'block', 'model', 'mixin', 'event', 'unimi', 'lwjgl', 'fakes', 'fabric', 'gitlab', 'recipe', 'render', 'packet', 'events',
          'preinit', 'preload', 'machine', 'reflect', 'general', 'handler', 'content', 'systems', 'modules', 'service', 'scripts', 'network',
          'fastutil', 'optifine', 'internal', 'platform', 'override', 'fabricmc', 'neoforge', 'external', 'injection', 'listeners', 'scheduler',
          'minecraft', 'universal', 'multipart', 'neoforged', 'micros oft', 'transformer', 'transformers', 'minecraftforge', 'blockentity', 'spongepowered', 'electr onwill', 'concurrent'
        ].includes(word.toLowerCase())) continue;

        possibleWords.push(word.trim());
      }
    }

    const distinctWords = [...new Set(possibleWords)];

    // 关键字过多时认为分析不可靠
    if (distinctWords.length > 10) {
      return [];
    } else {
      return distinctWords;
    }
  },

  /**
   * 根据关键字从崩溃报告和 Debug 日志中匹配可能的崩溃 Mod 文件名
   * @param {string[]} keywords - analyzeStackKeyword 提取的关键字
   * @returns {string[]|null} Mod 文件名数组，无结果时返回 null
   */
  analyzeModName(keywords) {
    let modFileNames = [];

    // 从崩溃报告的 "A detailed walkthrough" 段落提取
    if (this.logCrash && this.logCrash.includes('A detailed walkthrough of the error')) {
      let details = this.logCrash.replace('A detailed walkthrough of the error', '\u00A7');
      const isFabricDetail = details.includes('Fabric Mods');
      if (isFabricDetail) {
        details = details.replace('Fabric Mods', '\u00A7');
      }
      const lastSection = details.lastIndexOf('\u00A7');
      details = lastSection >= 0 ? details.substring(lastSection + 1) : details;

      // 筛选包含 .jar 的行（或 Fabric 的 fabric 行）
      const modNameLines = [];
      for (const line of details.split('\n')) {
        if ((line.toLowerCase().includes('.jar') && line.length - line.replace(/\.jar/gi, '').length === 4) ||
          (isFabricDetail && line.startsWith('\t\tfabric') && !this.regexCheck(line, '\t\tfabric[\\w-]*: Fabric'))) {
          modNameLines.push(line);
        }
      }

      // 用关键字过滤出可能的崩溃 Mod
      const hintLines = [];
      for (const keyword of keywords) {
        for (const modString of modNameLines) {
          if (modString.toLowerCase().includes(keyword.toLowerCase())) {
            hintLines.push(modString);
          }
        }
      }
      const uniqueHintLines = [...new Set(hintLines)];

      // 从行中提取 .jar 文件名
      for (const line of uniqueHintLines) {
        let name;
        if (isFabricDetail) {
          name = this.regexSeek(line, '(?<=: )[^\\n]+(?= [^\\n]+)');
        } else {
          name = this.regexSeek(line, '(?<=\\()[^\\t]+\\.jar(?=\\))|(?<=(\\t\\t)|(\\| ))[^\\t\\|]+\\.jar', 'gi');
        }
        if (name) modFileNames.push(name);
      }
    }

    // 从 Debug 日志的 "valid mod file" 行提取
    if (this.logMcDebug) {
      const modNameLines = this.regexSeek(this.logMcDebug, '(?<=valid mod file ).*', 'gm');
      if (modNameLines) {
        const modNameArr = modNameLines.split('\n');

        const hintLines = [];
        for (const keyword of keywords) {
          for (const modString of modNameArr) {
            if (modString.toLowerCase().includes(keyword.toLowerCase())) {
              hintLines.push(modString);
            }
          }
        }
        const uniqueHintLines = [...new Set(hintLines)];

        for (const line of uniqueHintLines) {
          const name = this.regexSeek(line, '.*(?= with)');
          if (name) modFileNames.push(name);
        }
      }
    }

    modFileNames = [...new Set(modFileNames)];
    if (modFileNames.length > 0) {
      return modFileNames;
    } else {
      return null;
    }
  },

  /**
   * 尝试用单个关键字匹配 Mod 名，匹配失败时返回原始关键字
   * @param {string} keyword - 关键字
   * @returns {string[]} Mod 文件名数组
   */
  tryAnalyzeModName(keyword) {
    const rawList = [keyword || ''];
    if (!keyword) return rawList;
    return this.analyzeModName(rawList) || rawList;
  }
};
