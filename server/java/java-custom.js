/**
 * @file server/java/java-custom.js - 用户手动添加/导入的 Java 管理
 * @description 持久化用户手动添加的 Java 路径（原位引用）和导入的 Java（解压到 JAVA_DIR），
 *   在 detectSystemJava / detectBundledJava 之外作为第三类 Java 来源合并到已安装列表。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ctx = require('../context');
const { getJavaVersionInfo } = require('./java-version');

const LIST_FILE = () => path.join(ctx.dirs.DATA_DIR, 'custom-java-list.json');

/**
 * 读取自定义 Java 列表
 * @returns {Array<{path: string, javaHome: string, source: 'manual'|'imported', addedAt: number, majorVersion: number, version: string, isJdk: boolean, is64Bit: boolean}>}
 */
function loadCustomJavaList() {
  try {
    const file = LIST_FILE();
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.entries)) return [];
    return data.entries;
  } catch (e) {
    console.warn('[Java-Custom] 读取列表失败:', e.message);
    return [];
  }
}

/**
 * 保存自定义 Java 列表
 * @param {Array} entries
 */
function saveCustomJavaList(entries) {
  try {
    const file = LIST_FILE();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ entries }, null, 2));
  } catch (e) {
    console.error('[Java-Custom] 保存列表失败:', e.message);
  }
}

/**
 * 检测指定 java 可执行文件的信息
 * @param {string} javaExePath - java 可执行文件完整路径
 * @returns {{path: string, javaHome: string, version: string, majorVersion: number, minorVersion: number, isJdk: boolean, is64Bit: boolean} | null}
 */
function inspectJavaExe(javaExePath) {
  if (!javaExePath || !fs.existsSync(javaExePath)) return null;
  const info = getJavaVersionInfo(javaExePath);
  if (info.major <= 0) return null;

  const binDir = path.dirname(javaExePath);
  const javaHome = path.dirname(binDir);
  const javacName = process.platform === 'win32' ? 'javac.exe' : 'javac';
  const isJdk = fs.existsSync(path.join(binDir, javacName));

  let is64Bit = true;
  try {
    const archOutput = execSync(`"${javaExePath}" -XshowSettings:properties -version 2>&1`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
    is64Bit = archOutput.includes('os.arch = x86_64') || archOutput.includes('os.arch = amd64') || archOutput.includes('64-bit');
  } catch (e) {
    try {
      const vOutput = execSync(`"${javaExePath}" -version 2>&1`, { encoding: 'utf8', timeout: 5000, windowsHide: true });
      is64Bit = vOutput.includes('64-Bit') || vOutput.includes('64-bit');
    } catch (e2) {}
  }

  return {
    path: javaExePath,
    javaHome,
    version: info.version,
    majorVersion: info.major,
    minorVersion: info.minor,
    isJdk,
    is64Bit
  };
}

/**
 * 路径规范化用于去重比较
 */
function normalizePath(p) {
  return (p || '').toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
}

/**
 * 添加手动定位的 Java（原位引用，不复制文件）
 * @param {string} javaExePath - 用户选择的 java 可执行文件路径
 * @returns {{success: boolean, message: string, entry?: object}}
 */
function addManualJava(javaExePath) {
  if (!javaExePath) return { success: false, message: '缺少 Java 路径' };
  if (!fs.existsSync(javaExePath)) return { success: false, message: '文件不存在: ' + javaExePath };

  // 必须是 java 可执行文件
  const baseName = path.basename(javaExePath).toLowerCase();
  const isJavaExe = baseName === 'java.exe' || baseName === 'java' || baseName === 'javaw.exe';
  if (!isJavaExe) {
    return { success: false, message: '请选择 java 或 java.exe 可执行文件（一般在 Java 安装目录的 bin 文件夹内）' };
  }

  const info = inspectJavaExe(javaExePath);
  if (!info) {
    return { success: false, message: '无法识别为有效的 Java，请检查文件是否可执行' };
  }

  // 去重：检查是否已在自定义列表中
  const entries = loadCustomJavaList();
  const normalizedNew = normalizePath(javaExePath);
  if (entries.some((e) => normalizePath(e.path) === normalizedNew)) {
    return { success: false, message: '该 Java 已在列表中' };
  }

  const entry = {
    path: info.path,
    javaHome: info.javaHome,
    source: 'manual',
    addedAt: Date.now(),
    majorVersion: info.majorVersion,
    minorVersion: info.minor,
    version: info.version,
    isJdk: info.isJdk,
    is64Bit: info.is64Bit
  };
  entries.push(entry);
  saveCustomJavaList(entries);

  console.log(`[Java-Custom] 手动添加 Java ${info.majorVersion}: ${javaExePath}`);
  return { success: true, message: `已添加 Java ${info.majorVersion}`, entry };
}

/**
 * 导入 Java 压缩包到 JAVA_DIR
 * @param {string} archivePath - 压缩包路径（.zip）
 * @param {function} [onProgress] - 进度回调 ({phase, progress, message})
 * @returns {{success: boolean, message: string, entry?: object}}
 */
async function importJavaArchive(archivePath, onProgress = () => {}) {
  if (!archivePath) return { success: false, message: '缺少压缩包路径' };
  if (!fs.existsSync(archivePath)) return { success: false, message: '压缩包不存在: ' + archivePath };

  const ext = path.extname(archivePath).toLowerCase();
  if (ext !== '.zip') {
    return { success: false, message: '目前仅支持 .zip 格式的 Java 压缩包' };
  }

  const report = (phase, progress, message) => {
    try { onProgress({ phase, progress, message }); } catch (e) {}
  };

  report('preparing', 5, '正在准备导入...');
  const importDir = path.join(ctx.dirs.JAVA_DIR, `_import_${Date.now()}`);
  fs.mkdirSync(importDir, { recursive: true });

  report('extracting', 15, '正在解压压缩包...');
  try {
    // Windows 优先用 PowerShell Expand-Archive（更快、支持大文件）
    if (process.platform === 'win32') {
      try {
        execSync(
          `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${importDir.replace(/'/g, "''")}' -Force"`,
          { encoding: 'utf8', timeout: 300000, windowsHide: true }
        );
      } catch (e) {
        // 回退到 adm-zip
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(archivePath);
        zip.extractAllTo(importDir, true);
      }
    } else {
      execSync(`tar -xf "${archivePath}" -C "${importDir}"`, { encoding: 'utf8', timeout: 300000 });
    }
  } catch (e) {
    // 清理临时目录
    try { fs.rmSync(importDir, { recursive: true, force: true }); } catch (ce) {}
    return { success: false, message: '解压失败: ' + e.message };
  }

  report('searching', 50, '正在查找 Java 可执行文件...');
  // 在解压目录中查找 bin/java 或 bin/java.exe
  const javaExeName = process.platform === 'win32' ? 'java.exe' : 'java';
  let foundJavaExe = null;
  let foundJavaHome = null;

  function searchDir(dir, depth) {
    if (depth <= 0 || !fs.existsSync(dir) || foundJavaExe) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (foundJavaExe) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // 直接检查 bin/java
          const candidateExe = path.join(fullPath, 'bin', javaExeName);
          if (fs.existsSync(candidateExe)) {
            foundJavaExe = candidateExe;
            foundJavaHome = fullPath;
            return;
          }
          searchDir(fullPath, depth - 1);
        }
      }
    } catch (e) {}
  }

  searchDir(importDir, 5);

  if (!foundJavaExe) {
    try { fs.rmSync(importDir, { recursive: true, force: true }); } catch (ce) {}
    return { success: false, message: '压缩包中未找到有效的 Java（缺少 bin/java.exe）' };
  }

  report('verifying', 70, '正在验证 Java...');
  const info = inspectJavaExe(foundJavaExe);
  if (!info) {
    try { fs.rmSync(importDir, { recursive: true, force: true }); } catch (ce) {}
    return { success: false, message: '压缩包中的 Java 无法运行或识别失败' };
  }

  // 重命名目录为有意义的名字
  const finalDirName = `imported-jdk-${info.majorVersion}-${Date.now()}`;
  const finalDir = path.join(ctx.dirs.JAVA_DIR, finalDirName);
  try {
    fs.renameSync(foundJavaHome, finalDir);
  } catch (e) {
    // 跨盘符 rename 失败时用 xcopy
    if (process.platform === 'win32') {
      execSync(`xcopy "${foundJavaHome}\\*" "${finalDir}\\" /E /I /Y /Q /C`, { windowsHide: true });
    } else {
      execSync(`cp -r "${foundJavaHome}/." "${finalDir}/"`);
    }
    try { fs.rmSync(importDir, { recursive: true, force: true }); } catch (ce) {}
  }

  // 如果 importDir 还有其他残留文件，清理掉
  if (path.dirname(finalDir) !== importDir) {
    try { fs.rmSync(importDir, { recursive: true, force: true }); } catch (e) {}
  }

  const finalJavaExe = path.join(finalDir, 'bin', javaExeName);
  const finalJavaHome = finalDir;

  report('saving', 90, '正在保存到列表...');
  const entry = {
    path: finalJavaExe,
    javaHome: finalJavaHome,
    source: 'imported',
    addedAt: Date.now(),
    majorVersion: info.majorVersion,
    minorVersion: info.minor,
    version: info.version,
    isJdk: info.isJdk,
    is64Bit: info.is64Bit
  };

  const entries = loadCustomJavaList();
  // 去重
  const normalizedNew = normalizePath(finalJavaExe);
  if (entries.some((e) => normalizePath(e.path) === normalizedNew)) {
    // 已存在，删除新导入的目录
    try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch (e) {}
    return { success: false, message: '该 Java 已在列表中' };
  }
  entries.push(entry);
  saveCustomJavaList(entries);

  report('done', 100, `导入成功: Java ${info.majorVersion}`);
  console.log(`[Java-Custom] 导入 Java ${info.majorVersion}: ${finalJavaExe}`);
  return { success: true, message: `已导入 Java ${info.majorVersion}`, entry };
}

/**
 * 导入 Java 目录（复制到 JAVA_DIR）
 * @param {string} srcDir - 源 Java Home 目录
 * @param {function} [onProgress]
 * @returns {{success: boolean, message: string, entry?: object}}
 */
async function importJavaDirectory(srcDir, onProgress = () => {}) {
  if (!srcDir) return { success: false, message: '缺少目录路径' };
  if (!fs.existsSync(srcDir)) return { success: false, message: '目录不存在: ' + srcDir };

  const report = (phase, progress, message) => {
    try { onProgress({ phase, progress, message }); } catch (e) {}
  };

  // 检查目录中是否有 bin/java
  const javaExeName = process.platform === 'win32' ? 'java.exe' : 'java';
  const candidateExe = path.join(srcDir, 'bin', javaExeName);
  if (!fs.existsSync(candidateExe)) {
    // 如果用户选的是 bin 目录，向上找一级
    const parentExe = path.join(path.dirname(srcDir), 'bin', javaExeName);
    if (fs.existsSync(parentExe)) {
      srcDir = path.dirname(srcDir);
    } else {
      return { success: false, message: '该目录不是有效的 Java 安装目录（缺少 bin/' + javaExeName + '）' };
    }
  }

  report('verifying', 10, '正在验证 Java...');
  const info = inspectJavaExe(candidateExe);
  if (!info) {
    return { success: false, message: '目录中的 Java 无法运行或识别失败' };
  }

  report('copying', 30, '正在复制 Java 到启动器目录...');
  const finalDirName = `imported-jdk-${info.majorVersion}-${Date.now()}`;
  const finalDir = path.join(ctx.dirs.JAVA_DIR, finalDirName);
  fs.mkdirSync(ctx.dirs.JAVA_DIR, { recursive: true });

  try {
    if (process.platform === 'win32') {
      execSync(`xcopy "${srcDir}\\*" "${finalDir}\\" /E /I /Y /Q /C`, { windowsHide: true, timeout: 300000 });
    } else {
      execSync(`cp -r "${srcDir}/." "${finalDir}/"`, { timeout: 300000 });
    }
  } catch (e) {
    try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch (ce) {}
    return { success: false, message: '复制 Java 目录失败: ' + e.message };
  }

  const finalJavaExe = path.join(finalDir, 'bin', javaExeName);

  report('saving', 90, '正在保存到列表...');
  const entry = {
    path: finalJavaExe,
    javaHome: finalDir,
    source: 'imported',
    addedAt: Date.now(),
    majorVersion: info.majorVersion,
    minorVersion: info.minor,
    version: info.version,
    isJdk: info.isJdk,
    is64Bit: info.is64Bit
  };

  const entries = loadCustomJavaList();
  const normalizedNew = normalizePath(finalJavaExe);
  if (entries.some((e) => normalizePath(e.path) === normalizedNew)) {
    try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch (e) {}
    return { success: false, message: '该 Java 已在列表中' };
  }
  entries.push(entry);
  saveCustomJavaList(entries);

  report('done', 100, `导入成功: Java ${info.majorVersion}`);
  console.log(`[Java-Custom] 导入目录 Java ${info.majorVersion}: ${finalJavaExe}`);
  return { success: true, message: `已导入 Java ${info.majorVersion}`, entry };
}

/**
 * 移除自定义 Java 记录
 * @param {string} javaHome - 要移除的 Java Home
 * @param {boolean} deleteFiles - 是否同时删除文件（仅对 source=imported 有效）
 * @returns {{success: boolean, message: string}}
 */
function removeCustomJava(javaHome, deleteFiles = false) {
  if (!javaHome) return { success: false, message: '缺少 Java Home 参数' };
  const entries = loadCustomJavaList();
  const idx = entries.findIndex((e) => normalizePath(e.javaHome) === normalizePath(javaHome));
  if (idx < 0) return { success: false, message: '未在自定义列表中找到该 Java' };

  const entry = entries[idx];
  entries.splice(idx, 1);
  saveCustomJavaList(entries);

  // 仅导入的 Java 才允许删除文件；manual 是原位引用不删
  if (deleteFiles && entry.source === 'imported') {
    try {
      fs.rmSync(entry.javaHome, { recursive: true, force: true });
      console.log(`[Java-Custom] 已删除导入的 Java 文件: ${entry.javaHome}`);
    } catch (e) {
      console.warn(`[Java-Custom] 删除文件失败: ${e.message}`);
      return { success: true, message: '记录已移除，但文件删除失败: ' + e.message };
    }
  }

  return { success: true, message: deleteFiles && entry.source === 'imported' ? '已移除并删除文件' : '已从列表移除' };
}

/**
 * 获取所有自定义 Java 列表（用于合并到已安装列表）
 * @returns {Array}
 */
function detectCustomJava() {
  const entries = loadCustomJavaList();
  const valid = [];
  let dirty = false;

  for (const entry of entries) {
    // 过滤已不存在的条目
    if (!fs.existsSync(entry.path)) {
      dirty = true;
      continue;
    }
    // 重新检测版本信息（应对 Java 升级但路径不变）
    const info = inspectJavaExe(entry.path);
    if (!info) {
      dirty = true;
      continue;
    }
    valid.push({
      path: entry.path,
      version: info.version,
      majorVersion: info.majorVersion,
      minorVersion: info.minor,
      is64Bit: info.is64Bit,
      isJdk: info.isJdk,
      source: entry.source,  // 'manual' 或 'imported'
      javaHome: entry.javaHome,
      addedAt: entry.addedAt
    });
  }

  if (dirty) saveCustomJavaList(valid.map((v) => ({
    path: v.path,
    javaHome: v.javaHome,
    source: v.source,
    addedAt: v.addedAt,
    majorVersion: v.majorVersion,
    minorVersion: v.minor,
    version: v.version,
    isJdk: v.isJdk,
    is64Bit: v.is64Bit
  })));

  return valid;
}

module.exports = {
  loadCustomJavaList,
  saveCustomJavaList,
  inspectJavaExe,
  addManualJava,
  importJavaArchive,
  importJavaDirectory,
  removeCustomJava,
  detectCustomJava
};
