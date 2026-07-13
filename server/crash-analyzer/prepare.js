/**
 * @file server/crash-analyzer/prepare.js - 日志预处理与分类
 *   包含 prepare / getHeadTailLines 方法，
 *   通过 Object.assign 挂载到 CrashAnalyzer.prototype 上。
 */

const path = require('path');

module.exports = {
  /**
   * 步骤 2：预处理日志文件，按文件名分类（HsErr/CrashReport/MinecraftLog/ExtraLog），
   *   提取日志头尾用于后续分析
   * @returns {boolean} 是否找到有效日志
   */
  prepare() {
    const allFiles = new Map();

    // 按文件名分类
    for (const logFile of this.analyzeRawFiles) {
      const fileName = path.basename(logFile.path).toLowerCase();
      let targetType;

      if (fileName.startsWith('hs_err')) {
        targetType = 'HsErr';
        this.directFile = logFile;
      } else if (fileName.startsWith('crash-')) {
        targetType = 'CrashReport';
        this.directFile = logFile;
      } else if (['latest.log', 'latest log.txt', 'debug.log', 'debug log.txt'].includes(fileName) ||
                 fileName.includes('启动器输出日志') || fileName === 'rawoutput.log' ||
                 fileName === 'log1.txt' || fileName.includes('pc l2启动器输出日志') ||
                 fileName.includes('pcl启动器输出日志')) {
        targetType = 'MinecraftLog';
        if (!this.directFile) {
          this.directFile = logFile;
        }
      } else if (fileName.endsWith('.log')) {
        targetType = 'ExtraLogFile';
      } else if (fileName.endsWith('.txt')) {
        targetType = 'ExtraReportFile';
      } else {
        continue;
      }

      if (logFile.lines && logFile.lines.length > 0) {
        allFiles.set(targetType, logFile);
      }
    }

    // 没有 Minecraft 日志时，用 ExtraLogFile 顶替
    if (!allFiles.has('MinecraftLog') && allFiles.has('ExtraLogFile')) {
      const extraLog = allFiles.get('ExtraLogFile');
      allFiles.set('MinecraftLog', extraLog);
      allFiles.delete('ExtraLogFile');
    }

    for (const [fileType, file] of allFiles) {
      this.outputFiles.push(file.path);

      if (fileType === 'HsErr') {
        // JVM 崩溃日志：取头 200 行 + 尾 100 行
        this.logHs = this.getHeadTailLines(file.lines, 200, 100);
      } else if (fileType === 'CrashReport') {
        // 崩溃报告：取头 300 行 + 尾 700 行
        this.logCrash = this.getHeadTailLines(file.lines, 300, 700);
      } else if (fileType === 'MinecraftLog') {
        this.logMc = '';
        this.logMcDebug = '';

        // 建立文件名 → 文件对象的映射，便于按文件名查找
        const fileNameDict = new Map();
        for (const [fType, fData] of allFiles) {
          fileNameDict.set(path.basename(fData.path).toLowerCase(), fData);
        }

        // 优先使用启动器输出日志（从标记行开始截取）
        for (const fileName of ['rawoutput.log', '启动器输出日志.txt', 'log1.txt', 'pcl2启动器输出日志.txt', 'pcl启动器输出日志.txt']) {
          if (fileNameDict.has(fileName)) {
            const currentLog = fileNameDict.get(fileName);
            let hasLauncherMark = false;

            for (const line of currentLog.lines) {
              if (hasLauncherMark) {
                this.logMc += line + '\n';
              } else if (line.includes('启动器输出日志')) {
                hasLauncherMark = true;
              }
            }

            if (!hasLauncherMark) {
              this.logMc += this.getHeadTailLines(currentLog.lines, 0, 500);
            }

            break;
          }
        }

        // 其次使用 latest.log / debug.log（取头 1500 行 + 尾 500 行）
        for (const fileName of ['latest.log', 'latest log.txt', 'debug.log', 'debug log.txt']) {
          if (fileNameDict.has(fileName)) {
            const currentLog = fileNameDict.get(fileName);
            this.logMc += this.getHeadTailLines(currentLog.lines, 1500, 500);
            break;
          }
        }

        // 单独提取 debug.log 作为 Debug 日志（取头 1000 行）
        for (const fileName of ['debug.log', 'debug log.txt']) {
          if (fileNameDict.has(fileName)) {
            const currentLog = fileNameDict.get(fileName);
            this.logMcDebug += this.getHeadTailLines(currentLog.lines, 1000, 0);
            break;
          }
        }

        // 兜底：logMc 仍为空时，用 Debug 日志或第一个可用文件
        if (this.logMc === '') {
          if (this.logMcDebug !== '') {
            this.logMc = this.logMcDebug;
          } else if (fileNameDict.size > 0) {
            const currentLog = fileNameDict.values().next().value;
            this.logMc += this.getHeadTailLines(currentLog.lines, 1500, 500);
          } else {
            this.logMc = null;
            throw new Error('未找到可用的 Minecraft 日志');
          }
        }

        if (this.logMcDebug === '') {
          this.logMcDebug = null;
        }
      }
    }

    const prepared = this.logMc !== null || this.logHs !== null || this.logCrash !== null;
    return prepared;
  },

  /**
   * 提取日志头部 headLines 行 + 尾部 tailLines 行（去重）
   * @param {string[]} lines - 日志行数组
   * @param {number} headLines - 头部行数
   * @param {number} tailLines - 尾部行数
   * @returns {string} 拼接后的日志文本
   */
  getHeadTailLines(lines, headLines, tailLines) {
    if (lines.length <= headLines + tailLines) {
      return [...new Set(lines)].join('\n');
    }

    const result = [];
    let realHeadLines = 0;

    // 从头部取 headLines 行（去重）
    for (let i = 0; i < lines.length; i++) {
      if (result.includes(lines[i])) continue;
      realHeadLines++;
      result.push(lines[i]);
      if (realHeadLines >= headLines) break;
    }

    // 从尾部取 tailLines 行（去重），插入到头部行之后
    let realTailLines = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (result.includes(lines[i])) continue;
      realTailLines++;
      result.splice(realHeadLines, 0, lines[i]);
      if (realTailLines >= tailLines) break;
    }

    return result.join('\n');
  }
};
