/**
 * @file server/dependencies/download.js - 缺失依赖下载
 * @description 从原 dependencies.js 中提取的 downloadMissingDependencies 函数。
 *   负责 download checkDependencies 返回的缺失文件列表，包含前置版本安装、
 *   资源索引补全、并发下载、SHA1 校验、镜像重试等逻辑。
 */

const { fs, path, ctx, utils, http, versions, _modloaders } = require('./_shared');

/**
 * 下载 checkDependencies 返回的缺失文件列表
 * @param {object[]} missingFiles - 缺失文件列表
 * @param {function} [onProgress] - 进度回调
 * @param {object} [versionJson] - 版本 JSON（用于补全资源索引）
 * @param {number} [maxThreads=null] - 最大并发数，null 时读取设置
 * @param {string} [externalVersionDir=null] - 外部版本目录
 * @returns {Promise<object>} 下载结果（completed/failed/total/errors/failedFiles/skipped）
 */
async function downloadMissingDependencies(missingFiles, onProgress, versionJson, maxThreads = null, externalVersionDir = null) {
  // 解析外部资源目录，用于回退查找资源文件
  let dlExternalAssetsDir = null;
  if (externalVersionDir) {
    const exRoot = versions.findExternalRoot(externalVersionDir) || path.dirname(path.dirname(externalVersionDir));
    const exAssets = path.join(exRoot, 'assets');
    if (fs.existsSync(exAssets)) dlExternalAssetsDir = exAssets;
  }

  // 1) 先安装缺失的前置版本（parent_version）
  const parentVersions = missingFiles.filter((f) => f.type === 'parent_version');
  for (const pv of parentVersions) {
    if (onProgress) {
      onProgress({
        stage: 'parent_version',
        message: `正在安装基础版本 ${pv.id}...`,
        progress: 0
      });
    }
    const result = await _modloaders().ensureBaseVersionInstalled(pv.id);
    if (result.error) {
      console.error(`[Download] Failed to install parent version ${pv.id}:`, result.error);
    }
  }

  // 2) 过滤出需要下载的文件（排除 asset_batch 和 parent_version，过滤无 URL 的项）
  let allFiles = missingFiles.filter((f) => f.type !== 'asset_batch' && f.type !== 'parent_version');
  allFiles = allFiles.filter((f) => {
    if (!f.url) {
      console.warn(`[Download] 跳过无URL文件: ${f.name || f.path}`);
      return false;
    }
    return true;
  });

  // 3) 资源索引：缺失或 SHA1 不符时先下载索引，再扫描 objects 补全缺失项
  if (versionJson?.assetIndex) {
    const assetIndexInfo = versionJson.assetIndex;
    let assetIndexPath = path.join(ctx.dirs.ASSETS_DIR, 'indexes', `${assetIndexInfo.id}.json`);
    if (!fs.existsSync(assetIndexPath) && dlExternalAssetsDir) {
      const exIdx = path.join(dlExternalAssetsDir, 'indexes', `${assetIndexInfo.id}.json`);
      if (fs.existsSync(exIdx)) assetIndexPath = exIdx;
    }

    if (!fs.existsSync(assetIndexPath) || (assetIndexInfo.sha1 && !(await utils.verifyFileSha1(assetIndexPath, assetIndexInfo.sha1)))) {
      const targetPath = path.join(ctx.dirs.ASSETS_DIR, 'indexes', `${assetIndexInfo.id}.json`);
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.existsSync(targetPath)) http._tryRemoveFile(targetPath);
        await http.downloadFileWithMirror(assetIndexInfo.url, targetPath);
        assetIndexPath = targetPath;
      } catch (e) {
        console.error(`[Download] 资源索引下载失败: ${e.message}`);
      }
    }

    if (fs.existsSync(assetIndexPath)) {
      try {
        const assetIndexData = JSON.parse(fs.readFileSync(assetIndexPath, 'utf-8'));
        const assetObjects = assetIndexData.objects || {};
        const existingAssetUrls = new Set(allFiles.filter((f) => f.type === 'asset').map((f) => f.url));

        for (const [name, info] of Object.entries(assetObjects)) {
          const hash = info.hash;
          const subDir = hash.substring(0, 2);
          let assetPath = path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash);
          if (!fs.existsSync(assetPath) && dlExternalAssetsDir) {
            const exPath = path.join(dlExternalAssetsDir, 'objects', subDir, hash);
            if (fs.existsSync(exPath)) assetPath = exPath;
          }
          const assetUrl = `https://resources.download.minecraft.net/${subDir}/${hash}`;

          if (!fs.existsSync(assetPath) && !existingAssetUrls.has(assetUrl)) {
            allFiles.push({
              type: 'asset',
              url: assetUrl,
              path: path.join(ctx.dirs.ASSETS_DIR, 'objects', subDir, hash),
              sha1: hash,
              size: info.size,
              name: name
            });
            existingAssetUrls.add(assetUrl);
          }
        }
      } catch (e) {}
    }
  }

  // 4) 读取设置：并发数、限速
  const settings = versions.loadSettingsCached();
  const CONCURRENT_DOWNLOADS = maxThreads || parseInt(settings.maxThreads, 10) || 64;
  const PRELOAD_QUEUE_SIZE = CONCURRENT_DOWNLOADS * 2;

  // 连接池上限：并发数 ×4，但不超过 128
  ctx.DownloadManager.connectionLimit = Math.min(Math.max(CONCURRENT_DOWNLOADS * 4, 64), 128);
  ctx.DownloadManager.reset();
  ctx.DownloadManager.totalFiles = allFiles.length;

  const speedLimit = parseInt(settings.speedLimit, 10) || 0;
  ctx.DownloadManager.setSpeedLimit(speedLimit);

  // 5) 预检：已存在且 SHA1/JAR 完整的文件直接跳过
  const preCheckFiles = [];
  const skipFiles = [];
  for (const file of allFiles) {
    if (fs.existsSync(file.path)) {
      if (file.sha1) {
        try {
          const actualSha1 = await utils.calculateSHA1(file.path);
          if (actualSha1 === file.sha1) {
            skipFiles.push(file);
            ctx.DownloadManager.skippedFiles++;
            continue;
          }
        } catch (e) {}
        http._tryRemoveFile(file.path);
      } else {
        // 无 SHA1：按文件大小和 JAR 完整性判断
        try {
          const stat = fs.statSync(file.path);
          if (stat.size > 0) {
            if (file.path.endsWith('.jar') && !utils.isJarIntact(file.path)) {
              http._tryRemoveFile(file.path);
            } else {
              skipFiles.push(file);
              ctx.DownloadManager.skippedFiles++;
              continue;
            }
          }
        } catch (e) {}
      }
    }
    preCheckFiles.push(file);
  }

  allFiles = preCheckFiles;
  const total = allFiles.length + skipFiles.length;
  ctx.DownloadManager.totalFiles = total;

  // 全部已存在：直接返回
  if (allFiles.length === 0) {
    if (onProgress) {
      onProgress({
        status: 'completed',
        current: skipFiles.length,
        total: total,
        progress: 100,
        completedFiles: skipFiles.length,
        totalFiles: total,
        speed: 0
      });
    }
    return { completed: skipFiles.length, failed: 0, total: skipFiles.length, errors: [], failedFiles: [], skipped: skipFiles.length };
  }

  let completed = skipFiles.length;
  let failed = 0;
  const errors = [];
  const failedFiles = [];
  const activeDownloads = new Map();

  let fileIndex = 0;
  let activeCount = 0;
  let resolveAll = null;

  // 准备目录：确保父目录存在
  const prepareFile = (file) => {
    const dir = path.dirname(file.path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  };

  // 下载单个文件：失败时按镜像列表重试，SHA1 校验失败也重试
  const downloadSingleFile = async (file) => {
    const downloadId = `${file.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    activeDownloads.set(downloadId, { name: file.name, progress: 0, speed: 0, bytesDownloaded: 0, totalBytes: 0 });

    try {
      await http.downloadFileWithMirror(file.url, file.path, (p) => {
        const active = activeDownloads.get(downloadId);
        if (active) {
          active.progress = p.progress || 0;
          active.speed = p.speed || 0;
          active.bytesDownloaded = p.bytesDownloaded || 0;
          active.totalBytes = p.totalBytes || 0;
        }
        if (onProgress) {
          onProgress({
            current: completed + failed + 1,
            total,
            file: file.name,
            progress: Math.round(((completed + failed + (p.progress || 0) / 100) / total) * 100),
            bytesDownloaded: p.bytesDownloaded || 0,
            totalBytes: p.totalBytes || 0,
            speed: ctx.DownloadManager.getSpeed() || p.speed || 0,
            activeDownloads: Array.from(activeDownloads.values()),
            completed,
            failed,
            queued: Math.min(PRELOAD_QUEUE_SIZE, allFiles.length - fileIndex - activeCount),
            concurrentDownloads: CONCURRENT_DOWNLOADS,
            activeConnections: ctx.DownloadManager.activeConnections,
            connectionLimit: ctx.DownloadManager.connectionLimit,
            chunks: p.chunks || 1,
            activeChunks: p.activeChunks || 1
          });
        }
      }, 3);

      // 下载完成：若指定了 SHA1 则校验，失败则按镜像重试
      if (file.sha1) {
        const actualSha1 = await utils.calculateSHA1(file.path);
        if (actualSha1 !== file.sha1) {
          console.warn(`[下载] SHA1校验失败: ${file.name} (期望: ${file.sha1}, 实际: ${actualSha1})`);
          http._tryRemoveFile(file.path);

          const mirrorUrls = http.getMirrorUrls(file.url);
          let retrySuccess = false;
          for (let mi = 0; mi < mirrorUrls.length; mi++) {
            try {
              await http.downloadFile(mirrorUrls[mi], file.path, null, 2);
              const retrySha1 = await utils.calculateSHA1(file.path);
              if (retrySha1 === file.sha1) {
                retrySuccess = true;
                break;
              }
              http._tryRemoveFile(file.path);
            } catch (e2) {
              console.warn(`[下载] 镜像重试失败: ${mirrorUrls[mi]} - ${e2.message}`);
            }
          }

          if (retrySuccess) {
            completed++;
            ctx.DownloadManager.completedFiles++;
          } else {
            const errorMsg = `${file.name}: SHA1校验失败`;
            errors.push(errorMsg);
            failedFiles.push({ name: file.name, url: file.url, path: file.path, error: 'SHA1校验失败' });
            console.error(`[下载] 所有镜像重试后SHA1仍然失败: ${file.name}`);
            failed++;
            ctx.DownloadManager.failedFiles++;
          }
        } else {
          completed++;
          ctx.DownloadManager.completedFiles++;
        }
      } else {
        // 无 SHA1：下载完成即视为成功
        completed++;
        ctx.DownloadManager.completedFiles++;
      }
    } catch (e) {
      const errorMsg = `${file.name}: 下载失败 (${e.message})`;
      errors.push(errorMsg);
      failedFiles.push({ name: file.name, url: file.url, path: file.path, error: e.message });
      console.error(`[下载] 下载失败: ${file.name} - URL: ${file.url} - 错误: ${e.message}`);
      failed++;
      ctx.DownloadManager.failedFiles++;
    } finally {
      activeDownloads.delete(downloadId);
      activeCount--;

      // 调度下一批：保持活跃下载数为 CONCURRENT_DOWNLOADS
      while (activeCount < CONCURRENT_DOWNLOADS && fileIndex < allFiles.length) {
        const nextFile = allFiles[fileIndex++];
        prepareFile(nextFile);
        activeCount++;
        downloadSingleFile(nextFile);
      }

      if (onProgress) {
        onProgress({
          current: completed + failed,
          total,
          file: `已完成 ${completed + failed}/${total} 个文件`,
          progress: Math.round(((completed + failed) / total) * 100),
          bytesDownloaded: 0,
          totalBytes: 0,
          speed: ctx.DownloadManager.getSpeed(),
          activeDownloads: Array.from(activeDownloads.values()),
          completed,
          failed,
          skipped: skipFiles.length,
          queued: Math.max(0, allFiles.length - fileIndex),
          failedFiles,
          stats: ctx.DownloadManager.getStats()
        });
      }

      // 所有文件下载完成：解除 await
      if (activeCount === 0 && fileIndex >= allFiles.length && resolveAll) {
        resolveAll();
      }
    }
  };

  // 预创建初始批次的目录
  const initialBatch = Math.min(CONCURRENT_DOWNLOADS + PRELOAD_QUEUE_SIZE, allFiles.length);
  for (let i = 0; i < initialBatch; i++) {
    prepareFile(allFiles[i]);
  }

  // 启动初始并发下载，await 直至全部完成
  const startPromise = new Promise((resolve) => {
    resolveAll = resolve;

    for (let i = 0; i < Math.min(CONCURRENT_DOWNLOADS, allFiles.length); i++) {
      fileIndex++;
      activeCount++;
      downloadSingleFile(allFiles[i]);
    }

    if (allFiles.length === 0) {
      resolve();
    }
  });

  await startPromise;

  if (onProgress) {
    onProgress({
      status: failed > 0 ? 'completed_with_errors' : 'completed',
      current: completed + failed,
      total,
      progress: 100,
      completedFiles: completed,
      totalFiles: total,
      speed: 0,
      failed,
      failedFiles
    });
  }

  return { completed, failed, total, errors, failedFiles, skipped: skipFiles.length };
}

module.exports = {
  downloadMissingDependencies
};
