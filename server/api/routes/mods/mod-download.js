/**
 * @file server/api/routes/mods/mod-download.js
 * @description 模组下载（含递归依赖）与下载状态查询相关路由
 */

const fs = require('fs');
const path = require('path');
const { extractDeps } = require('./shared');

module.exports = {
  /**
   * 注册模组下载相关路由
   * @param {Function} registerRoute - 路由注册函数
   * @param {Object} deps - 依赖对象
   * @returns {void}
   */
  register(registerRoute, deps) {
    const {
      sendJSON, sendError, readBody, http, versions,
      MODRINTH_API, CURSEFORGE_API, modDownloadSessions
    } = extractDeps(deps);

    /* /api/mods/download - 下载模组（自动匹配版本，后台异步下载） */
    registerRoute('POST', '/api/mods/download', async (req, res, parsedUrl) => {
      const data = await readBody(req);
      const projectId = data.projectId;
      const source = data.source || 'modrinth';
      const loader = data.loader || '';
      const mcVersion = data.mcVersion || '';
      const versionId = data.versionId || '';
      if (!projectId) { sendError(res, 'Missing projectId', 400); return; }

      // 确定模组下载目标目录：优先指定版本，其次匹配已安装版本，最后取选中版本
      let modsDestDir = null;
      if (versionId) {
        modsDestDir = versions.getVersionModsDir(versionId);
      }
      if (!modsDestDir && mcVersion) {
        const installedVersions = versions.getInstalledVersions();
        const matched = installedVersions.find((v) =>
          v.id === mcVersion || v.baseVersion === mcVersion ||
          v.inheritsFrom === mcVersion || v.id.startsWith(mcVersion)
        );
        if (matched) {
          modsDestDir = versions.getVersionModsDir(matched.id);
        }
      }
      if (!modsDestDir) {
        const settings = versions.loadSettingsCached();
        modsDestDir = versions.getVersionModsDir(settings.selectedVersion);
      }
      if (!modsDestDir) {
        const installedVersions = versions.getInstalledVersions();
        if (installedVersions.length > 0) {
          modsDestDir = versions.getVersionModsDir(installedVersions[0].id);
        }
        if (!modsDestDir) {
          sendError(res, '请先安装一个游戏版本');
          return;
        }
      }
      if (!fs.existsSync(modsDestDir)) fs.mkdirSync(modsDestDir, { recursive: true });

      let downloadUrl = null;
      let fileName = null;

      try {
        if (source === 'modrinth') {
          // Modrinth：三级查询策略（精确 loader+MC → 仅 MC → 全量）
          const versionUrl = `${MODRINTH_API}/project/${projectId}/version`;
          let versions = null;

          if (loader && mcVersion) {
            try {
              versions = await http.fetchJSON(versionUrl + '?' + `loaders=["${loader}"]&game_versions=["${mcVersion}"]`);
            } catch (e) {
              console.warn(`[mods/download] Modrinth 精确查询失败: ${projectId} - ${e.message}`);
            }
          }
          if (!versions || !versions.length) {
            if (mcVersion) {
              try {
                versions = await http.fetchJSON(versionUrl + '?' + `game_versions=["${mcVersion}"]`);
              } catch (e) {
                console.warn(`[mods/download] Modrinth MC版本查询失败: ${projectId} - ${e.message}`);
              }
            }
          }
          if (!versions || !versions.length) {
            try {
              versions = await http.fetchJSON(versionUrl + '?limit=10');
            } catch (e) {
              console.warn(`[mods/download] Modrinth 全量查询失败: ${projectId} - ${e.message}`);
            }
          }

          if (versions && versions.length) {
            const primaryFile = versions[0].files?.find((f) => f.primary === true);
            const file = primaryFile || versions[0].files?.[0];
            if (file) {
              downloadUrl = file.url;
              fileName = file.filename;
            }
          }
        } else if (source === 'curseforge') {
          // CurseForge：按 gameVersion + modLoaderType 查询文件列表
          const settings = versions.loadSettingsCached();
          const cfApiKey = settings.curseforgeApiKey || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';
          let loaderType = 4;
          if (loader === 'forge') loaderType = 1;
          else if (loader === 'neoforge') loaderType = 5;
          else if (loader === 'fabric') loaderType = 4;
          else if (loader === 'quilt') loaderType = 5;

          const cfVersionUrl = `${CURSEFORGE_API}/mods/${projectId}/files?gameVersion=${mcVersion}${loader ? '&modLoaderType=' + loaderType : ''}`;
          const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};
          const cfResult = await http.fetchJSON(cfVersionUrl, cfHeaders);
          if (cfResult.data && cfResult.data.length > 0) {
            const file = cfResult.data[0];
            downloadUrl = file.downloadUrl;
            fileName = file.fileName;
          } else if (mcVersion) {
            // 无精确匹配时回退到全量文件列表，客户端过滤
            const cfFallbackUrl = `${CURSEFORGE_API}/mods/${projectId}/files`;
            const cfFallbackResult = await http.fetchJSON(cfFallbackUrl, cfHeaders);
            if (cfFallbackResult.data && cfFallbackResult.data.length > 0) {
              const matching = cfFallbackResult.data.filter((f) =>
                f.gameVersions && f.gameVersions.includes(mcVersion)
              );
              const file = matching.length > 0 ? matching[0] : cfFallbackResult.data[0];
              downloadUrl = file.downloadUrl;
              fileName = file.fileName;
            }
          }
        }
      } catch (e) {
        console.error(`[mods/download] 获取下载链接失败: ${source}/${projectId} - ${e.message}`);
      }

      if (!downloadUrl) { sendError(res, `未找到可下载的文件 (${source}/${projectId}, loader=${loader}, mc=${mcVersion})`); return; }

      const safeName = (fileName || `${projectId}.jar`).replace(/[^a-zA-Z0-9._\-]/g, '_');
      const destPath = path.join(modsDestDir, safeName);

      const sessionId = `mod-${Date.now()}`;
      modDownloadSessions.set(sessionId, {
        status: 'downloading', progress: 0, message: '下载中..',
        fileName: safeName, totalSize: 0, downloaded: 0,
        dependencies: 0, currentDep: 0
      });

      sendJSON(res, { success: true, sessionId, fileName: safeName, path: destPath });

      // 后台异步下载，通过 session 推送进度
      (async () => {
        try {
          await http.downloadFile(downloadUrl, destPath, (p) => {
            const session = modDownloadSessions.get(sessionId);
            if (session) {
              session.progress = Math.round(p.progress);
              session.downloaded = p.bytesDownloaded || 0;
              session.message = `下载 ${safeName} ${p.progress.toFixed(0)}%`;
            }
          }, 2);

          const session = modDownloadSessions.get(sessionId);
          if (session) {
            session.status = 'completed';
            session.progress = 100;
            session.message = `${safeName} 下载完成！`;
          }
        } catch (e) {
          const session = modDownloadSessions.get(sessionId);
          if (session) {
            session.status = 'failed';
            session.message = `下载失败: ${e.message}`;
          }
        }
      })();
    });

    /* /api/mods/download-version - 下载指定版本的模组（含前置依赖自动下载） */
    registerRoute('POST', '/api/mods/download-version', async (req, res, parsedUrl) => {
      // 检查模组是否已安装（按文件名/项目 slug 匹配）
      function isModAlreadyInstalled(modsDir, depFileName, depProjectId) {
        if (!modsDir || !fs.existsSync(modsDir)) return false;
        const exactPath = path.join(modsDir, depFileName);
        if (fs.existsSync(exactPath)) return true;
        const disabledPath = exactPath + '.disabled';
        if (fs.existsSync(disabledPath)) return true;
        try {
          const existingFiles = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled'));
          // 去除版本号后比较基础名
          const baseName = depFileName.replace(/\.jar$/i, '').replace(/[-_](v?\d[\w.\-]*)$/i, '').toLowerCase();
          for (const f of existingFiles) {
            const fLower = f.toLowerCase();
            const fBase = fLower.replace(/\.jar\.disabled$/i, '').replace(/\.jar$/i, '').replace(/[-_](v?\d[\w.\-]*)$/i, '');
            if (baseName.length >= 3 && fBase.length >= 3) {
              if (fBase === baseName || fBase.includes(baseName) || baseName.includes(fBase)) return true;
            }
          }
          // 按项目 slug 匹配
          if (depProjectId) {
            const slug = depProjectId.toLowerCase();
            for (const f of existingFiles) {
              if (f.toLowerCase().includes(slug)) return true;
            }
          }
        } catch (e) {}
        return false;
      }

      const dvData = await readBody(req);
      const dvVersionId = dvData.versionId;
      const dvSource = dvData.source || 'modrinth';
      const dvProjectId = dvData.projectId;
      const dvGameVersion = dvData.gameVersion || '';
      const dvLoader = dvData.loader || '';
      const dvSavePath = dvData.savePath || '';
      const dvIncludeDeps = dvData.includeDeps !== false;

      if (!dvVersionId && !dvProjectId) { sendError(res, 'Missing versionId or projectId', 400); return; }

      // 确定下载目标目录
      let destDir = dvSavePath;
      if (!destDir) {
        const settings = versions.loadSettingsCached();
        destDir = versions.getVersionModsDir(settings.selectedVersion);
      }

      if (!destDir) {
        const installedVersions = versions.getInstalledVersions();
        if (installedVersions.length > 0) {
          destDir = versions.getVersionModsDir(installedVersions[0].id);
        }
        if (!destDir) {
          sendError(res, '请先安装一个游戏版本');
          return;
        }
      }

      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

      try {
        let downloadUrl = null;
        let fileName = null;
        let fileSize = 0;

        if (dvSource === 'modrinth') {
          // 获取版本信息：优先按 versionId，否则按 projectId + 过滤条件
          let versionData;
          if (dvVersionId) {
            versionData = await http.fetchJSON(`${MODRINTH_API}/version/${dvVersionId}`);
          } else {
            let versionApiUrl = `${MODRINTH_API}/project/${dvProjectId}/version`;
            const params = [];
            if (dvGameVersion) params.push(`game_versions=["${dvGameVersion}"]`);
            if (dvLoader) params.push(`loaders=["${dvLoader}"]`);
            if (params.length > 0) {
              versionApiUrl += '?' + params.join('&');
            } else {
              versionApiUrl += '?limit=1';
            }
            const versions = await http.fetchJSON(versionApiUrl);

            // 客户端二次过滤：确保 MC 版本和 loader 都匹配
            if (dvGameVersion || dvLoader) {
              const filtered = (versions || []).filter((v) => {
                const gv = v.game_versions || [];
                const loaders = (v.loaders || []).map((l) => l.toLowerCase());
                let match = true;
                if (dvGameVersion && !gv.includes(dvGameVersion)) match = false;
                if (dvLoader && !loaders.includes(dvLoader.toLowerCase())) match = false;
                return match;
              });
              versionData = filtered[0] || versions?.[0];
            } else {
              versionData = versions?.[0];
            }
          }

          if (!versionData) { sendError(res, '未找到匹配的版本信息'); return; }

          const primaryFile = versionData.files?.find((f) => f.primary) || versionData.files?.[0];
          if (!primaryFile) { sendError(res, '未找到下载文件'); return; }

          downloadUrl = primaryFile.url;
          fileName = primaryFile.filename;
          fileSize = primaryFile.size || 0;

          // 收集前置依赖下载任务
          const depDownloads = [];
          if (dvIncludeDeps) {
            for (const dep of (versionData.dependencies || [])) {
              if (dep.dependency_type === 'required' && dep.project_id) {
                try {
                  let depVersionApiUrl = `${MODRINTH_API}/project/${dep.project_id}/version`;
                  const depParams = [];
                  if (dvGameVersion) depParams.push(`game_versions=["${dvGameVersion}"]`);
                  if (dvLoader) depParams.push(`loaders=["${dvLoader}"]`);
                  if (depParams.length > 0) {
                    depVersionApiUrl += '?' + depParams.join('&');
                  } else {
                    depVersionApiUrl += '?limit=1';
                  }
                  const depVersions = await http.fetchJSON(depVersionApiUrl);
                  let depVersionData = null;
                  if (dvGameVersion || dvLoader) {
                    const depFiltered = (depVersions || []).filter((v) => {
                      const gv = v.game_versions || [];
                      const loaders = (v.loaders || []).map((l) => l.toLowerCase());
                      let match = true;
                      if (dvGameVersion && !gv.includes(dvGameVersion)) match = false;
                      if (dvLoader && !loaders.includes(dvLoader.toLowerCase())) match = false;
                      return match;
                    });
                    depVersionData = depFiltered[0] || depVersions?.[0];
                  } else {
                    depVersionData = depVersions?.[0];
                  }
                  if (depVersionData?.files?.[0]) {
                    const depFile = depVersionData.files.find((f) => f.primary) || depVersionData.files[0];
                    const depName = depFile.filename;
                    const depDest = path.join(destDir, depName);
                    // 已安装的依赖跳过下载
                    if (isModAlreadyInstalled(destDir, depName, dep.project_id)) {
                    } else {
                      depDownloads.push({ url: depFile.url, fileName: depName, dest: depDest, size: depFile.size || 0 });
                    }
                  }
                } catch (e) {}
              }
            }
          }

          const safeName = (fileName || `${dvProjectId}.jar`).replace(/[^a-zA-Z0-9._\-]/g, '_');
          const destPath = path.join(destDir, safeName);

          const sessionId = `mod-${Date.now()}`;
          const totalSteps = depDownloads.length + 1;
          modDownloadSessions.set(sessionId, {
            status: 'downloading', progress: 0, message: '下载中..',
            fileName: safeName, totalSize: fileSize, downloaded: 0,
            dependencies: depDownloads.length, currentDep: 0
          });

          sendJSON(res, { success: true, sessionId, fileName: safeName });

          // 后台异步下载：先下载所有依赖，再下载本体
          (async () => {
            try {
              for (let di = 0; di < depDownloads.length; di++) {
                const dep = depDownloads[di];
                const session = modDownloadSessions.get(sessionId);
                if (session) {
                  session.currentDep = di + 1;
                  session.message = `下载前置依赖 (${di + 1}/${depDownloads.length}): ${dep.fileName}`;
                }
                await http.downloadFile(dep.url, dep.dest, (depProgress) => {
                  const s = modDownloadSessions.get(sessionId);
                  if (s) {
                    // 按步骤权重计算总进度
                    const depBase = Math.round((di / totalSteps) * 100);
                    const depWeight = 100 / totalSteps;
                    s.progress = Math.min(99, depBase + Math.round(depProgress.progress * depWeight / 100));
                    s.message = `下载前置依赖 (${di + 1}/${depDownloads.length}): ${dep.fileName} ${depProgress.progress.toFixed(0)}%`;
                  }
                }, 2);
              }

              // 下载本体
              const session = modDownloadSessions.get(sessionId);
              if (session) {
                session.message = `下载本体: ${safeName}`;
              }
              await http.downloadFile(downloadUrl, destPath, (p) => {
                const s = modDownloadSessions.get(sessionId);
                if (s) {
                  const mainBase = Math.round((depDownloads.length / totalSteps) * 100);
                  const mainWeight = 100 / totalSteps;
                  s.progress = Math.min(99, mainBase + Math.round(p.progress * mainWeight / 100));
                  s.downloaded = p.bytesDownloaded || 0;
                  s.message = `下载本体: ${safeName} ${p.progress.toFixed(0)}%`;
                }
              }, 2);

              const finalSession = modDownloadSessions.get(sessionId);
              if (finalSession) {
                finalSession.status = 'completed';
                finalSession.progress = 100;
                finalSession.message = `${safeName} 下载完成！`;
              }
            } catch (e) {
              const session = modDownloadSessions.get(sessionId);
              if (session) {
                session.status = 'failed';
                session.message = `下载失败: ${e.message}`;
              }
            }
          })();
        } else if (dvSource === 'curseforge') {
          const settings = versions.loadSettingsCached();
          const cfApiKey = settings.curseforgeApiKey || '$2a$10$bL4bIL5pUWqfcO7KQtnMReakwtfHbNKh6v1uTpKlzhwoueEJQnPnm';
          const cfHeaders = cfApiKey ? { 'x-api-key': cfApiKey } : {};

          // 获取 CurseForge 文件信息
          let cfFileData = null;
          if (dvVersionId) {
            try {
              const fileInfo = await http.fetchJSON(`${CURSEFORGE_API}/mods/${dvProjectId}/files/${dvVersionId}`, cfHeaders);
              cfFileData = fileInfo?.data;
            } catch (e) {}
          }
          if (!cfFileData && dvProjectId) {
            // 按 gameVersion + modLoaderType 查询文件列表
            let loaderType = 0;
            if (dvLoader === 'forge') loaderType = 1;
            else if (dvLoader === 'fabric') loaderType = 4;
            else if (dvLoader === 'neoforge') loaderType = 6;
            else if (dvLoader === 'quilt') loaderType = 5;
            let cfVerUrl = `${CURSEFORGE_API}/mods/${dvProjectId}/files?pageSize=20`;
            if (dvGameVersion) cfVerUrl += `&gameVersion=${encodeURIComponent(dvGameVersion)}`;
            if (loaderType) cfVerUrl += `&modLoaderType=${loaderType}`;
            try {
              const cfRes = await http.fetchJSON(cfVerUrl, cfHeaders);
              cfFileData = cfRes?.data?.[0];
            } catch (e) {}
          }

          if (!cfFileData) { sendError(res, '未找到匹配的 CurseForge 文件'); return; }

          downloadUrl = cfFileData.downloadUrl;
          fileName = cfFileData.fileName;
          fileSize = cfFileData.fileLength || 0;

          if (!downloadUrl) { sendError(res, 'CurseForge 未提供下载链接（可能需要浏览器下载）'); return; }

          // 收集 CurseForge 前置依赖
          const depDownloads = [];
          if (dvIncludeDeps) {
            const cfDeps = cfFileData.dependencies || [];
            const requiredDeps = cfDeps.filter((d) => (d.relationType === 3 || d.relationType === 5) && d.modId);
            for (const dep of requiredDeps) {
              try {
                const depModInfo = await http.fetchJSON(`${CURSEFORGE_API}/mods/${dep.modId}`, cfHeaders);
                let depFileUrl = `${CURSEFORGE_API}/mods/${dep.modId}/files?pageSize=5`;
                if (dvGameVersion) depFileUrl += `&gameVersion=${encodeURIComponent(dvGameVersion)}`;
                const depFiles = await http.fetchJSON(depFileUrl, cfHeaders);
                const depFile = depFiles?.data?.[0];
                if (depFile && depFile.downloadUrl) {
                  const depName = depFile.fileName;
                  const depDest = path.join(destDir, depName);
                  if (isModAlreadyInstalled(destDir, depName, String(dep.modId))) {
                  } else {
                    depDownloads.push({ url: depFile.downloadUrl, fileName: depName, dest: depDest, size: depFile.fileLength || 0 });
                  }
                }
              } catch (e) {
                console.warn(`[ModDownload] CurseForge依赖查询失败: modId=${dep.modId} - ${e.message}`);
              }
            }
          }

          const safeName = (fileName || `${dvProjectId}.jar`).replace(/[^a-zA-Z0-9._\-]/g, '_');
          const destPath = path.join(destDir, safeName);

          const sessionId = `mod-${Date.now()}`;
          const totalSteps = depDownloads.length + 1;
          modDownloadSessions.set(sessionId, {
            status: 'downloading', progress: 0, message: '下载中..',
            fileName: safeName, totalSize: fileSize, downloaded: 0,
            dependencies: depDownloads.length, currentDep: 0
          });

          sendJSON(res, { success: true, sessionId, fileName: safeName });

          // 后台异步下载：先依赖后本体
          (async () => {
            try {
              for (let di = 0; di < depDownloads.length; di++) {
                const dep = depDownloads[di];
                const session = modDownloadSessions.get(sessionId);
                if (session) {
                  session.currentDep = di + 1;
                  session.message = `下载前置依赖 (${di + 1}/${depDownloads.length}): ${dep.fileName}`;
                }
                await http.downloadFile(dep.url, dep.dest, (depProgress) => {
                  const s = modDownloadSessions.get(sessionId);
                  if (s) {
                    const depBase = Math.round((di / totalSteps) * 100);
                    const depWeight = 100 / totalSteps;
                    s.progress = Math.min(99, depBase + Math.round(depProgress.progress * depWeight / 100));
                    s.message = `下载前置依赖 (${di + 1}/${depDownloads.length}): ${dep.fileName} ${depProgress.progress.toFixed(0)}%`;
                  }
                }, 2);
              }

              const session = modDownloadSessions.get(sessionId);
              if (session) {
                session.message = `下载本体: ${safeName}`;
              }
              await http.downloadFile(downloadUrl, destPath, (p) => {
                const s = modDownloadSessions.get(sessionId);
                if (s) {
                  const mainBase = Math.round((depDownloads.length / totalSteps) * 100);
                  const mainWeight = 100 / totalSteps;
                  s.progress = Math.min(99, mainBase + Math.round(p.progress * mainWeight / 100));
                  s.downloaded = p.bytesDownloaded || 0;
                  s.message = `下载本体: ${safeName} ${p.progress.toFixed(0)}%`;
                }
              }, 2);

              const finalSession = modDownloadSessions.get(sessionId);
              if (finalSession) {
                finalSession.status = 'completed';
                finalSession.progress = 100;
                finalSession.message = `${safeName} 下载完成！`;
              }
            } catch (e) {
              const session = modDownloadSessions.get(sessionId);
              if (session) {
                session.status = 'failed';
                session.message = `下载失败: ${e.message}`;
              }
            }
          })();
        } else {
          sendError(res, 'Unsupported source', 400);
        }
      } catch (e) {
        sendError(res, '下载失败: ' + e.message);
      }
    });

    /* /api/mods/download-status - 查询模组下载状态（完成后延迟清理会话） */
    registerRoute('GET', '/api/mods/download-status', async (req, res, parsedUrl) => {
      const dsSessionId = parsedUrl.query.sessionId;
      if (!dsSessionId || !modDownloadSessions.has(dsSessionId)) {
        sendJSON(res, { status: 'unknown', progress: 0, message: '' });
        return;
      }
      const dsSession = modDownloadSessions.get(dsSessionId);
      sendJSON(res, { ...dsSession });
      if (dsSession.status === 'completed' || dsSession.status === 'failed') {
        setTimeout(() => modDownloadSessions.delete(dsSessionId), 120000);
      }
    });
  }
};
