/**
 * @file server/api/routes/mods/mod-dialog.js
 * @description 模组文件/文件夹选择对话框相关路由
 */

const path = require('path');
const { extractDeps } = require('./shared');

module.exports = {
  /**
   * 注册模组对话框相关路由
   * @param {Function} registerRoute - 路由注册函数
   * @param {Object} deps - 依赖对象
   * @returns {void}
   */
  register(registerRoute, deps) {
    const { sendJSON, readBody } = extractDeps(deps);

    /* /api/mods/select-modpack-file - 弹出对话框选择整合包文件 */
    registerRoute('GET', '/api/mods/select-modpack-file', async (req, res, parsedUrl) => {
      try {
        const result = await new Promise((resolve, reject) => {
          const { dialog, BrowserWindow: BW } = require('electron');
          dialog.showOpenDialog(BW.getAllWindows()[0] || null, {
            properties: ['openFile'],
            filters: [
              { name: 'Modpack Files', extensions: ['mrpack', 'zip'] },
              { name: 'All Files', extensions: ['*'] }
            ]
          }).then((r) => resolve(r)).catch(reject);
        });
        if (result.canceled || !result.filePaths.length) {
          sendJSON(res, null);
        } else {
          sendJSON(res, { filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) });
        }
      } catch (e) { sendJSON(res, null); }
    });

    /* /api/mods/select-file - 弹出对话框选择模组文件 */
    registerRoute('GET', '/api/mods/select-file', async (req, res, parsedUrl) => {
      try {
        const result = await new Promise((resolve, reject) => {
          const { dialog, BrowserWindow: BW } = require('electron');
          dialog.showOpenDialog(BW.getAllWindows()[0] || null, {
            properties: ['openFile'],
            filters: [{ name: 'Mod Files', extensions: ['jar', 'zip'] }]
          }).then((r) => resolve(r)).catch(reject);
        });
        if (result.canceled || !result.filePaths.length) {
          sendJSON(res, null);
        } else {
          sendJSON(res, { filePath: result.filePaths[0], fileName: path.basename(result.filePaths[0]) });
        }
      } catch (e) { sendJSON(res, null); }
    });

    /* /api/mods/select-save-folder - 弹出对话框选择模组保存文件夹 */
    registerRoute('POST', '/api/mods/select-save-folder', async (req, res, parsedUrl) => {
      try {
        const ssfData = await readBody(req);
        const ssfDefaultPath = ssfData.defaultPath || '';
        const { ipcMain } = require('electron');
        const allWindows = require('electron').BrowserWindow.getAllWindows();
        const win = allWindows.length > 0 ? allWindows[0] : null;
        let result;
        // 优先调用渲染进程的选目录 API
        if (win && win.webContents) {
          result = await win.webContents.executeJavaScript(`window.electronAPI?.selectSaveFolder?.(${JSON.stringify(ssfDefaultPath)})`).catch(() => null);
        }
        if (!result) {
          const { dialog } = require('electron');
          result = await dialog.showOpenDialog(win, {
            properties: ['openDirectory'],
            title: '选择模组保存文件夹',
            defaultPath: ssfDefaultPath || undefined
          });
          result = { cancelled: result.canceled || !result.filePaths.length, path: result.filePaths?.[0] || '' };
        }
        if (result.cancelled) {
          sendJSON(res, { cancelled: true, error: result.error || '' });
        } else {
          sendJSON(res, { cancelled: false, path: result.path });
        }
      } catch (e) {
        console.error('[select-save-folder] dialog error:', e);
        sendJSON(res, { cancelled: true, error: e.message });
      }
    });
  }
};
