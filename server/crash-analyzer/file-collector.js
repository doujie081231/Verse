/**
 * @file server/crash-analyzer/file-collector.js - 日志文件收集与导入
 *   包含 collect / importFile / extractCompressedFile 方法，
 *   通过 Object.assign 挂载到 CrashAnalyzer.prototype 上。
 */

const fs = require('fs');
const path = require('path');

module.exports = {
  /**
   * 步骤 1：收集可能存在的日志文件（crash-reports / 版本目录 / latest.log / hs_err_pid）
   * @param {string} versionPathIndex - 版本目录名
   * @param {string[]} [latestLog=null] - 启动器输出的最新日志行数组
   */
  async collect(versionPathIndex, latestLog = null) {
    const possibleLogs = [];
    const mcDir = this.minecraftDir;

    // 1. 搜索 crash-reports 目录
    const crashReportsDir = path.join(mcDir, 'crash-reports');
    try {
      if (fs.existsSync(crashReportsDir)) {
        const files = fs.readdirSync(crashReportsDir);
        files.forEach((file) => {
          if (file.startsWith('crash-') && file.endsWith('.txt')) {
            possibleLogs.push(path.join(crashReportsDir, file));
          }
        });
      }
    } catch (ex) {
      console.error('[Crash] 无法读取 crash-reports 文件夹', ex.message);
    }

    // 2. 搜索版本目录下的日志
    try {
      const versionDir = path.join(mcDir, 'versions', versionPathIndex || '');
      if (versionPathIndex && fs.existsSync(versionDir)) {
        const files = fs.readdirSync(versionDir);
        files.forEach((file) => {
          if (file.endsWith('.log')) {
            possibleLogs.push(path.join(versionDir, file));
          }
        });
      }
    } catch (ex) {
      console.error('[Crash] 无法读取版本文件夹', ex.message);
    }

    // 3. 添加 latest.log 和 debug.log
    possibleLogs.push(path.join(mcDir, 'logs', 'latest.log'));
    possibleLogs.push(path.join(mcDir, 'logs', 'debug.log'));

    // 4. 搜索 hs_err_pid*.log 文件（JVM 崩溃日志）
    try {
      const mcFiles = fs.readdirSync(mcDir);
      mcFiles.forEach((file) => {
        if (file.startsWith('hs_err_pid') && file.endsWith('.log')) {
          possibleLogs.push(path.join(mcDir, file));
        }
      });
    } catch (ex) {
      // ignore
    }

    // 5. 去重
    const uniqueLogs = [...new Set(possibleLogs)];

    // 6. 筛选最近 30 分钟内修改的文件
    const rightLogs = [];
    for (const logFile of uniqueLogs) {
      try {
        if (fs.existsSync(logFile)) {
          const stat = fs.statSync(logFile);
          const time = Math.abs((stat.mtime - new Date()) / 60000);
          if (time < 30 && stat.size > 0) {
            rightLogs.push(logFile);
          }
        }
      } catch (ex) {
        console.error(`[Crash] 检查日志文件失败：${logFile}`, ex.message);
      }
    }

    // 7. 如果没有找到最近修改的日志，放宽时间限制，使用所有存在的日志
    if (rightLogs.length === 0) {
      for (const logFile of uniqueLogs) {
        try {
          if (fs.existsSync(logFile)) {
            const stat = fs.statSync(logFile);
            if (stat.size > 0) {
              rightLogs.push(logFile);
            }
          }
        } catch (ex) {
          // ignore
        }
      }
    }

    // 8. 如果仍然没有日志，使用启动器输出的最新日志
    if (rightLogs.length === 0 && latestLog && latestLog.length > 0) {
      const rawOutput = latestLog.join('\n');
      const rawOutputPath = path.join(this.tempFolder, 'RawOutput.log');
      fs.writeFileSync(rawOutputPath, rawOutput, 'utf8');
      this.analyzeRawFiles.push({
        path: rawOutputPath,
        lines: latestLog
      });
    }

    // 9. 读取所有找到的日志文件
    for (const filePath of rightLogs) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        this.analyzeRawFiles.push({
          path: filePath,
          lines: content.split(/\r?\n/)
        });
      } catch (ex) {
        console.error(`[Crash] 读取日志文件失败：${filePath}`, ex.message);
      }
    }
  },

  /**
   * 步骤 1（手动导入）：从指定文件路径导入日志，.jar 文件先解压
   * @param {string} filePath - 日志或 jar 文件路径
   */
  async importFile(filePath) {
    try {
      if (fs.existsSync(filePath) && filePath.endsWith('.jar')) {
        await this.extractCompressedFile(filePath);
      } else {
        const content = fs.readFileSync(filePath, 'utf8');
        this.analyzeRawFiles.push({
          path: filePath,
          lines: content.split(/\r?\n/)
        });
      }
    } catch (ex) {
      console.error(`[Crash] 导入日志文件失败：${filePath}`, ex);
    }
  },

  /**
   * 解压 jar/zip 压缩包到临时目录，并导入其中的 .log / .txt 文件
   * @param {string} filePath - 压缩文件路径
   */
  async extractCompressedFile(filePath) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    const extractPath = path.join(this.tempFolder, 'Extracted');

    if (!fs.existsSync(extractPath)) {
      fs.mkdirSync(extractPath, { recursive: true });
    }

    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const entryPath = entry.entryName;
      const destPath = path.join(extractPath, entryPath);
      // 路径穿越防护：确保解压目标在 extractPath 内
      const resolvedDest = path.resolve(destPath);
      const resolvedTarget = path.resolve(extractPath);
      if (!resolvedDest.startsWith(resolvedTarget + path.sep) && resolvedDest !== resolvedTarget) {
        continue;
      }
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(destPath, entry.getData());
    }

    // 导入解压出的 .log / .txt 文件
    const files = fs.readdirSync(extractPath);
    for (const file of files) {
      const fullPath = path.join(extractPath, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        const ext = path.extname(file).toLowerCase();
        if (ext === '.log' || ext === '.txt') {
          const content = fs.readFileSync(fullPath, 'utf8');
          this.analyzeRawFiles.push({
            path: fullPath,
            lines: content.split(/\r?\n/)
          });
        }
      }
    }
  }
};
