/**
 * @file server/api/routes/java.js
 * @description Java 管理路由 - 从 server.js handleAPI switch 语句抽取的 Java 相关端点，包含 Java 检测、安装、下载、配置环境变量等功能
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

module.exports = {
  /**
   * 注册 Java 管理相关路由
   * @param {Function} registerRoute - 路由注册函数
   * @param {Object} deps - 依赖对象（ctx/sendJSON/sendError/readBody/java/accounts/utils）
   * @returns {void}
   */
  register(registerRoute, deps) {
    const { ctx, sendJSON, sendError, readBody } = deps;
    const { java, accounts, utils } = deps;

    /* /api/java/detect - 检测系统与内置 Java 列表 */
    registerRoute('GET', '/api/java/detect', async (req, res, parsedUrl) => {
      try {
        const systemJava = java.detectSystemJava();
        const bundledJava = java.detectBundledJava();
        const allJava = [...bundledJava, ...systemJava];
        sendJSON(res, {
          success: true,
          platform: utils.getPlatformKey(),
          javaList: allJava,
          hasJava: allJava.length > 0,
          hasJava17: allJava.some((j) => j.majorVersion >= 17),
          hasJava21: allJava.some((j) => j.majorVersion >= 21)
        });
      } catch (e) {
        sendError(res, 'Java检测失败 ' + e.message);
      }
    });

    /* /api/java/install - 安装 Java 运行时（旧接口，回调式进度） */
    registerRoute('POST', '/api/java/install', async (req, res, parsedUrl) => {
      const data = await readBody(req);
      const component = data.component || 'java-runtime-gamma';
      const sessionId = `java-${Date.now()}`;
      ctx.sessions.javaInstallSessions.set(sessionId, { status: 'pending', progress: 0, message: '准备下载Java运行时..', component, lastActivity: Date.now() });
      sendJSON(res, { success: true, sessionId });
      // 通过回调更新会话进度，完成后更新状态
      java.downloadJavaRuntime(component, (progress) => {
        const session = ctx.sessions.javaInstallSessions.get(sessionId);
        if (session) {
          session.status = 'downloading';
          session.progress = progress.progress;
          session.message = `下载 ${progress.file} (${progress.current}/${progress.total})`;
        }
      }).then((result) => {
        const session = ctx.sessions.javaInstallSessions.get(sessionId);
        if (session) { session.status = 'completed'; session.progress = 100; session.message = 'Java运行时安装完成！'; session.result = result; }
      }).catch((e) => {
        const session = ctx.sessions.javaInstallSessions.get(sessionId);
        if (session) { session.status = 'failed'; session.message = `安装失败: ${e.message}`; session.error = e.message; }
      });
    });

    /* /api/java/install-status - 查询 Java 安装会话状态 */
    registerRoute('GET', '/api/java/install-status', async (req, res, parsedUrl) => {
      const sessionId = parsedUrl.query.sessionId;
      if (!sessionId || !ctx.sessions.javaInstallSessions.has(sessionId)) { sendError(res, '无效的会话ID', 400); return; }
      const session = ctx.sessions.javaInstallSessions.get(sessionId);
      sendJSON(res, { success: true, ...session });
      if (session.status === 'completed' || session.status === 'failed') ctx.sessions.javaInstallSessions.delete(sessionId);
    });

    /* /api/java/auto-install - 自动检测并安装所需 Java 版本 */
    registerRoute('POST', '/api/java/auto-install', async (req, res, parsedUrl) => {
      const aiData = await readBody(req);
      const requiredVersion = aiData.requiredVersion || 17;
      const aiSessionId = `java-auto-${Date.now()}`;
      ctx.sessions.javaInstallSessions.set(aiSessionId, {
        status: 'detecting',
        progress: 0,
        message: '正在检测Java环境...',
        component: '',
        source: '',
        speed: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        lastActivity: Date.now()
      });
      sendJSON(res, { success: true, sessionId: aiSessionId });

      // 异步检测：优先复用已安装的合适 Java，否则提示手动安装
      (async () => {
        try {
          const systemJava = java.detectSystemJava();
          const bundledJava = java.detectBundledJava();
          const allJava = [...bundledJava, ...systemJava];
          const suitable = allJava.find((j) => j.majorVersion >= requiredVersion);

          if (suitable) {
            const s = ctx.sessions.javaInstallSessions.get(aiSessionId);
            if (s) {
              s.status = 'completed';
              s.progress = 100;
              s.message = `已找到Java ${suitable.version}`;
              s.result = { path: suitable.path, version: suitable.version, majorVersion: suitable.majorVersion };
            }
            return;
          }

          const s = ctx.sessions.javaInstallSessions.get(aiSessionId);
          if (s) {
            s.status = 'need_manual';
            s.progress = 0;
            s.message = `未找到合适的Java运行环境（需要 Java ${requiredVersion}），请在设置中手动安装或配置Java路径`;
          }
        } catch (e) {
          const errSession = ctx.sessions.javaInstallSessions.get(aiSessionId);
          if (errSession) {
            errSession.status = 'failed';
            errSession.message = `检测失败: ${e.message}`;
            errSession.error = e.message;
          }
        }
      })();
    });

    /* /api/java/download-sources - 返回可选的 Java 下载源列表 */
    registerRoute('GET', '/api/java/download-sources', async (req, res, parsedUrl) => {
      sendJSON(res, {
        success: true,
        sources: [
          { id: 'bmclapi', name: 'BMCLAPI镜像', description: '国内加速镜像(bangbang93)' },
          { id: 'mojang', name: 'Mojang官方源', description: 'Minecraft官方Java运行时' },
          { id: 'temurin', name: 'Adoptium (Temurin)', description: 'Eclipse开源JDK' }
        ]
      });
    });

    /* /api/java/list - 返回推荐的 Java 大版本列表 */
    registerRoute('GET', '/api/java/list', async (req, res, parsedUrl) => {
      try {
        const requiredVersions = [8, 17, 21, 25];
        const javaVersions = requiredVersions.map((v) => ({
          majorVersion: v,
          version: `Java ${v}`,
          source: 'Adoptium (Temurin)'
        }));
        sendJSON(res, { versions: javaVersions });
      } catch (e) {
        console.error('[Java] 获取Java列表失败:', e.message);
        sendError(res, '获取Java列表失败: ' + e.message);
      }
    });

    /* /api/java/download - 启动 Java 异步下载（写入状态文件供轮询） */
    registerRoute('POST', '/api/java/download', async (req, res, parsedUrl) => {
      try {
        const body = await readBody(req);
        const { majorVersion, mirrorIndex } = body;

        if (!majorVersion) {
          sendError(res, '缺少majorVersion参数', 400);
          return;
        }

        const sessionId = `java-${Date.now()}`;
        const sessionFile = path.join(ctx.dirs.DATA_DIR, `java-download-${sessionId}.json`);
        const abortController = new AbortController();
        ctx.sessions.javaDownloadAbortControllers.set(sessionId, abortController);

        // 初始化下载状态文件
        fs.writeFileSync(sessionFile, JSON.stringify({
          status: 'starting',
          progress: 0,
          majorVersion: majorVersion,
          startTime: Date.now()
        }));

        java.downloadJavaAsync(majorVersion, sessionId, sessionFile, mirrorIndex || 0, abortController.signal);

        sendJSON(res, { sessionId: sessionId });
      } catch (e) {
        sendError(res, '启动Java下载失败: ' + e.message);
      }
    });

    /* /api/java/download-status - 轮询 Java 下载状态（读取状态文件） */
    registerRoute('GET', '/api/java/download-status', async (req, res, parsedUrl) => {
      const sessionId = parsedUrl.query.sessionId;
      if (!sessionId) {
        sendError(res, '缺少sessionId参数', 400);
        return;
      }

      const sessionFile = path.join(ctx.dirs.DATA_DIR, `java-download-${sessionId}.json`);
      if (!fs.existsSync(sessionFile)) {
        sendJSON(res, { status: 'not_found' });
        return;
      }

      try {
        const status = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
        sendJSON(res, status);

        // 终态后延时清理状态文件
        if (status.status === 'completed' || status.status === 'error' || status.status === 'cancelled') {
          setTimeout(() => {
            try { fs.unlinkSync(sessionFile); } catch (e) {}
          }, 60000);
        }
      } catch (e) {
        sendJSON(res, { status: 'error', error: e.message });
      }
    });

    /* /api/java/cancel - 取消 Java 下载（GET/POST 共用） */
    registerRoute('*', '/api/java/cancel', async (req, res, parsedUrl) => {
      const cancelData = parsedUrl.query.sessionId
        ? { sessionId: parsedUrl.query.sessionId }
        : (req.method === 'POST' ? await readBody(req).catch(() => ({})) : {});
      const cancelSid = cancelData.sessionId;
      if (!cancelSid) {
        sendError(res, '缺少sessionId参数', 400);
        return;
      }
      // 触发 AbortController 中止下载
      const controller = ctx.sessions.javaDownloadAbortControllers.get(cancelSid);
      if (controller) {
        controller.abort();
        ctx.sessions.javaDownloadAbortControllers.delete(cancelSid);
      }
      // 同步更新状态文件为已取消
      const cancelFile = path.join(ctx.dirs.DATA_DIR, `java-download-${cancelSid}.json`);
      if (fs.existsSync(cancelFile)) {
        try {
          const st = JSON.parse(fs.readFileSync(cancelFile, 'utf-8'));
          if (st.status !== 'completed' && st.status !== 'error' && st.status !== 'cancelled') {
            st.status = 'cancelled';
            st.message = '下载已取消';
            fs.writeFileSync(cancelFile, JSON.stringify(st));
          }
        } catch (e) {}
      }
      sendJSON(res, { success: true, message: '已取消Java下载' });
    });

    /* /api/java/installed - 返回已安装 Java 列表 */
    registerRoute('GET', '/api/java/installed', async (req, res, parsedUrl) => {
      try {
        const systemJava = java.detectSystemJava();
        const bundledJava = java.detectBundledJava();
        const allJava = [...bundledJava, ...systemJava];

        sendJSON(res, {
          java: allJava,
          total: allJava.length
        });
      } catch (e) {
        sendError(res, '获取已安装Java列表失败: ' + e.message);
      }
    });

    /* /api/java/configure-env - 配置 JAVA_HOME 与 PATH 环境变量 */
    registerRoute('POST', '/api/java/configure-env', async (req, res, parsedUrl) => {
      try {
        const envBody = await readBody(req);
        const { javaHome, majorVersion } = envBody;
        if (!javaHome) {
          sendError(res, '缺少javaHome参数', 400);
          return;
        }
        if (!fs.existsSync(javaHome)) {
          sendError(res, 'Java目录不存在: ' + javaHome, 400);
          return;
        }
        const result = await java.configureJavaEnv(javaHome, majorVersion || 17);
        sendJSON(res, { success: true, ...result });
      } catch (e) {
        sendError(res, '配置环境变量失败: ' + e.message);
      }
    });

    /* /api/java/delete - 删除内置 Java 并清理环境变量引用 */
    registerRoute('POST', '/api/java/delete', async (req, res, parsedUrl) => {
      try {
        const delBody = await readBody(req);
        const { javaHome } = delBody;
        if (!javaHome) {
          sendError(res, '缺少javaHome参数', 400);
          return;
        }

        // 路径规范化用于安全校验
        const normalizedJavaHome = javaHome.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
        const normalizedDataDir = ctx.dirs.DATA_DIR.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
        const normalizedJavaDir = ctx.dirs.JAVA_DIR.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');

        // 仅允许删除启动器内置 Java 目录
        if (!normalizedJavaHome.startsWith(normalizedJavaDir)) {
          sendError(res, '只能删除启动器内置的Java，系统Java请通过系统设置卸载', 403);
          return;
        }

        if (normalizedJavaHome === normalizedJavaDir || normalizedJavaHome === normalizedDataDir) {
          sendError(res, '不能删除Java根目录', 400);
          return;
        }

        if (!fs.existsSync(javaHome)) {
          sendError(res, 'Java目录不存在: ' + javaHome, 404);
          return;
        }

        const javaExe = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        if (!fs.existsSync(javaExe)) {
          sendError(res, '指定目录不是有效的Java安装', 400);
          return;
        }

        // 清除设置中引用的 Java 路径
        const settings = accounts.loadSettingsCached();
        if (settings.javaPath) {
          const normalizedSettingsPath = settings.javaPath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
          if (normalizedSettingsPath.startsWith(normalizedJavaHome)) {
            settings.javaPath = '';
            accounts.saveSettings(settings);
            console.log(`[Java] 已清除设置中引用的Java路径: ${javaHome}`);
          }
        }

        // Windows 下清理系统 PATH 与 JAVA_HOME 环境变量
        if (process.platform === 'win32') {
          try {
            const currentPath = execSync(
              `powershell -Command "[Environment]::GetEnvironmentVariable('Path', 'Machine')"`,
              { encoding: 'utf8', timeout: 10000, windowsHide: true }
            ).trim();
            const javaBinDir = path.join(javaHome, 'bin');
            const normalizedJavaBin = javaBinDir.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
            const pathEntries = currentPath.split(';').filter((p) => {
              const normalized = p.trim().toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
              return normalized !== normalizedJavaBin && p.trim() !== '';
            });
            const newPath = pathEntries.join(';');
            if (newPath !== currentPath) {
              execSync(
                `powershell -Command "[Environment]::SetEnvironmentVariable('Path', '${newPath.replace(/'/g, "''")}', 'Machine')"`,
                { encoding: 'utf8', timeout: 15000, windowsHide: true }
              );
              console.log(`[Java] 已从系统PATH移除: ${javaBinDir}`);
            }
          } catch (envErr) {
            console.warn(`[Java] 从系统PATH移除失败(不影响): ${envErr.message}`);
          }

          try {
            const currentUserPath = execSync(
              `powershell -Command "[Environment]::GetEnvironmentVariable('Path', 'User')"`,
              { encoding: 'utf8', timeout: 10000, windowsHide: true }
            ).trim();
            const javaBinDir = path.join(javaHome, 'bin');
            const normalizedJavaBin = javaBinDir.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
            const userPathEntries = currentUserPath.split(';').filter((p) => {
              const normalized = p.trim().toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
              return normalized !== normalizedJavaBin && p.trim() !== '';
            });
            const newUserPath = userPathEntries.join(';');
            if (newUserPath !== currentUserPath) {
              execSync(
                `powershell -Command "[Environment]::SetEnvironmentVariable('Path', '${newUserPath.replace(/'/g, "''")}', 'User')"`,
                { encoding: 'utf8', timeout: 15000, windowsHide: true }
              );
              console.log(`[Java] 已从用户PATH移除: ${javaBinDir}`);
            }
          } catch (envErr) {
            console.warn(`[Java] 从用户PATH移除失败(不影响): ${envErr.message}`);
          }

          try {
            const currentJavaHome = execSync(
              `powershell -Command "[Environment]::GetEnvironmentVariable('JAVA_HOME', 'Machine')"`,
              { encoding: 'utf8', timeout: 10000, windowsHide: true }
            ).trim();
            const normalizedCurrentJavaHome = currentJavaHome.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
            if (normalizedCurrentJavaHome === normalizedJavaHome) {
              execSync(
                `powershell -Command "[Environment]::SetEnvironmentVariable('JAVA_HOME', $null, 'Machine')"`,
                { encoding: 'utf8', timeout: 15000, windowsHide: true }
              );
              console.log(`[Java] 已清除JAVA_HOME环境变量`);
            }
          } catch (envErr) {
            console.warn(`[Java] 清除JAVA_HOME失败(不影响): ${envErr.message}`);
          }
        }

        fs.rmSync(javaHome, { recursive: true, force: true });
        console.log(`[Java] 已删除Java: ${javaHome}`);

        sendJSON(res, { success: true, message: `已删除Java: ${path.basename(javaHome)}` });
      } catch (e) {
        console.error('[Java] 删除失败:', e.message);
        sendError(res, '删除Java失败: ' + e.message);
      }
    });
  }
};
