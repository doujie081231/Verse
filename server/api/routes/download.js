/**
 * @file server/api/routes/download.js
 * @description 自定义下载路由 - 从 server.js handleAPI switch 语句抽取的自定义文件下载端点
 */

const fs = require('fs');
const path = require('path');

module.exports = {
  /**
   * 注册自定义下载相关路由
   * @param {Function} registerRoute - 路由注册函数
   * @param {Object} deps - 依赖对象（ctx/sendJSON/sendError/readBody/http 等）
   * @returns {void}
   */
  register(registerRoute, deps) {
    const { ctx, sendJSON, sendError, readBody } = deps;
    const { http } = deps;

    const customDownloadSessions = ctx.sessions.customDownloadSessions;

    /* /api/download-custom - 创建自定义下载会话并异步执行下载 */
    registerRoute('POST', '/api/download-custom', async (req, res, parsedUrl) => {
      const dcBody = await readBody(req);
      const dcUrl = dcBody.url || '';
      const dcSavePath = dcBody.savePath || '';
      const dcFileName = dcBody.fileName || '';
      if (!dcUrl) { sendError(res, '请输入下载地址', 400); return; }
      if (!dcSavePath) { sendError(res, '请选择保存位置', 400); return; }

      const dcFinalName = dcFileName || path.basename(new URL(dcUrl).pathname) || 'download';
      const dcDestDir = dcSavePath;
      if (!fs.existsSync(dcDestDir)) fs.mkdirSync(dcDestDir, { recursive: true });
      const dcDestPath = path.join(dcDestDir, dcFinalName);

      // 创建下载会话，用于后续状态查询与取消
      const dcSessionId = `custom-${Date.now()}`;
      const dcAbort = new AbortController();
      customDownloadSessions.set(dcSessionId, {
        status: 'downloading', progress: 0, message: '准备下载...',
        fileName: dcFinalName, totalSize: 0, downloaded: 0, abortController: dcAbort
      });

      sendJSON(res, { success: true, sessionId: dcSessionId, destPath: dcDestPath });

      // 异步执行下载，通过会话状态反馈进度
      (async () => {
        try {
          await http.downloadFile(dcUrl, dcDestPath, (p) => {
            const s = customDownloadSessions.get(dcSessionId);
            if (s) {
              s.progress = Math.round(p.progress);
              s.downloaded = p.bytesDownloaded || 0;
              s.totalSize = p.totalBytes || 0;
              s.message = `下载中 ${p.progress.toFixed(0)}%`;
            }
          }, 3, dcAbort.signal);

          const s = customDownloadSessions.get(dcSessionId);
          if (s) {
            s.status = 'completed';
            s.progress = 100;
            s.message = `${dcFinalName} 下载完成！`;
            // 60 秒后清理已完成会话
            setTimeout(() => { try { customDownloadSessions.delete(dcSessionId); } catch (_) {} }, 60000);
          }
        } catch (e) {
          const s = customDownloadSessions.get(dcSessionId);
          if (s) {
            s.status = e.name === 'AbortError' ? 'cancelled' : 'failed';
            s.message = e.name === 'AbortError' ? '下载已取消' : `下载失败: ${e.message}`;
            setTimeout(() => { try { customDownloadSessions.delete(dcSessionId); } catch (_) {} }, 60000);
          }
        }
      })();
    });

    /* /api/download-custom/status - 查询下载会话状态 */
    registerRoute('GET', '/api/download-custom/status', async (req, res, parsedUrl) => {
      const dcsId = parsedUrl.query.sessionId;
      if (!dcsId || !customDownloadSessions.has(dcsId)) { sendJSON(res, { status: 'not_found' }); return; }
      const dcs = customDownloadSessions.get(dcsId);
      sendJSON(res, { status: dcs.status, progress: dcs.progress, message: dcs.message, fileName: dcs.fileName, totalSize: dcs.totalSize, downloaded: dcs.downloaded });
    });

    /* /api/download-custom/cancel - 取消指定下载会话 */
    registerRoute('POST', '/api/download-custom/cancel', async (req, res, parsedUrl) => {
      const dccBody = await readBody(req);
      const dccId = dccBody.sessionId;
      if (dccId && customDownloadSessions.has(dccId)) {
        const dcc = customDownloadSessions.get(dccId);
        if (dcc.abortController) dcc.abortController.abort();
        dcc.status = 'cancelled';
        dcc.message = '下载已取消';
        setTimeout(() => { try { customDownloadSessions.delete(dccId); } catch (_) {} }, 60000);
        sendJSON(res, { success: true });
      } else {
        sendError(res, 'Invalid session', 404);
      }
    });
  }
};
