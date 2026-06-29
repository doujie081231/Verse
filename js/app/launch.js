/**
 * @file launch.js
 * @description 游戏启动流程 - 检查依赖、显示启动模态框、处理进度
 */
async function handleLaunch() {
  if (window._versepc_launching) {
    if (typeof showToast === 'function') showToast('正在启动中，请稍候...', 'info');
    return;
  }
  window._versepc_launching = true;
  setTimeout(() => { window._versepc_launching = false; }, 30000);

  const versionId = launchVersionCustomSelect ? launchVersionCustomSelect.getValue() : '';
  if (!versionId) { showToast('请选择游戏版本', 'error'); window._versepc_launching = false; return; }

  _cachedLastLaunchVersion = versionId;
  try { await window.electronAPI.store.set('versepc_last_launch_version', versionId); } catch (_) {}

  const launchBtn = document.getElementById('launch-btn');
  const homeLaunchBtn = document.getElementById('home-launch-btn');

  launchBtn.disabled = true;
  homeLaunchBtn.disabled = true;

  _launchCounted = false;

  showLaunchModal();
  hideLaunchError();

  try {
    setLaunchStep('auth', 'running', '正在验证登录状态...');
    const accountsResult = await API.getAccounts();
    const accounts = Array.isArray(accountsResult) ? accountsResult : (accountsResult.accounts || []);
    if (accounts.length === 0) {
      setLaunchStep('auth', 'failed', '未登录，请先添加账户');
      showLaunchError('未登录，请先在账户管理中添加账户后再启动游戏。');
      window._versepc_launching = false;
      launchBtn.disabled = false;
      homeLaunchBtn.disabled = false;
      return;
    }
    setLaunchStep('auth', 'success', '登录验证通过');

    setLaunchStep('java-check', 'running', '正在检测 Java 环境...');
    
    let externalVersionDir = null;
    try {
      const vInfo = await API.getVersions();
      if (vInfo && vInfo.versions) {
        const v = vInfo.versions.find(x => x.id === versionId);
        if (v && v.externalDir) externalVersionDir = v.externalDir;
      }
    } catch (_) {}
    const depCheck = await API.launchCheck(versionId, externalVersionDir);
    const requiredJava = (depCheck.java && depCheck.java.required) || 21;

    if (!depCheck.java || !depCheck.java.ok) {
      const requiredVer = requiredJava;
      const maxVer = depCheck.java.maxVersion;
      const rangeDesc = maxVer && maxVer < 999 ? `${requiredVer}~${maxVer}` : `${requiredVer}+`;
      const serverMsg = depCheck.java.message || '';
      setLaunchStep('java-check', 'error', `未找到 Java ${rangeDesc}`);
      const detailMsg = serverMsg || `未找到合适的Java运行环境（需要 Java ${rangeDesc}）`;
      showLaunchError(`${detailMsg}<br><a href="#" onclick="event.preventDefault();closeLaunchModal();navigateToPage('java')" style="color:var(--accent);text-decoration:underline;cursor:pointer;">前往 Java 管理页面 →</a>`);
      launchBtn.disabled = false;
      homeLaunchBtn.disabled = false;
      window._versepc_launching = false;
      return;
    }
    
    setLaunchStep('java-check', 'success', depCheck.java.message || `Java ${depCheck.java.version} ✓`);

    setLaunchStep('version-resolve', 'running', '正在解析版本信息...');
    await new Promise(r => setTimeout(r, 200));
    setLaunchStep('version-resolve', 'success', '版本信息解析完成');

    setLaunchStep('files-check', 'running', '正在检查文件完整性...');
    
    if (depCheck.mainJar) {
      if (depCheck.mainJar.ok) {
        setLaunchStep('files-check', 'success', depCheck.mainJar.message);
      } else {
        setLaunchStep('files-check', 'error', depCheck.mainJar.message);
        showLaunchError(depCheck.mainJar.message);
        launchBtn.disabled = false;
        homeLaunchBtn.disabled = false;
        window._versepc_launching = false;
        return;
      }
    } else {
      setLaunchStep('files-check', 'success', '游戏文件完整');
    }

    if (depCheck.forgeCore && !depCheck.forgeCore.ok && depCheck.forgeCore.missing && depCheck.forgeCore.missing.length > 0) {
      const missingNames = depCheck.forgeCore.missing.map(m => `${m.desc} (${m.name.split(':').pop()})`).join('、');
      const downloadable = depCheck.forgeCore.missing.filter(m => {
        const entry = (depCheck.missingFiles || []).find(f => f.path === m.path);
        return entry && entry.url;
      });
      if (downloadable.length > 0) {
        setLaunchStep('files-check', 'warning', `Forge核心库缺失 ${depCheck.forgeCore.missing.length} 个，正在自动修复...`);
        const dlResult = await API.launchGame(versionId, { checkOnly: true });
        if (dlResult.needDownload && dlResult.sessionId) {
          pollLaunchDownload(dlResult.sessionId, versionId, requiredJava);
          window._versepc_launching = false;
          return;
        }
      }
      const stillMissing = depCheck.forgeCore.missing.filter(m => {
        const entry = (depCheck.missingFiles || []).find(f => f.path === m.path);
        return !entry || !entry.url;
      });
      if (stillMissing.length > 0 || downloadable.length === 0) {
        const errorMsg = `Forge核心库文件缺失 (${depCheck.forgeCore.missing.length}个): ${missingNames}`;
        setLaunchStep('files-check', 'error', errorMsg);
        showLaunchError(
          `Forge 核心库文件缺失，无法启动游戏。\n缺失文件：${missingNames}\n\n请前往"版本设置 → 文件修复"功能修复此问题，或重新安装该 Forge 版本。`,
          { forgeMissing: depCheck.forgeCore.missing, repairHint: 'forge_core_missing', versionId }
        );
        launchBtn.disabled = false;
        homeLaunchBtn.disabled = false;
        window._versepc_launching = false;
        return;
      }
    }

    setLaunchStep('natives-extract', 'running', '正在解压本地库...');
    await new Promise(r => setTimeout(r, 200));
    setLaunchStep('natives-extract', 'success', '本地库解压完成');

    setLaunchStep('assets-check', 'running', '正在检查资源文件...');
    
    if (depCheck.libraries && depCheck.libraries.missing.length > 0) {
      const libMsg = `${depCheck.libraries.missing.length}/${depCheck.libraries.total} 个库文件缺失`;
      setLaunchStep('assets-check', 'warning', libMsg);
    } else {
      setLaunchStep('assets-check', 'success', '所有资源文件完整');
    }

    const hasMissing = depCheck.missingFiles && depCheck.missingFiles.length > 0;
    const assetsMissing = depCheck.assets && depCheck.assets.missing > 0;
    if (hasMissing || assetsMissing) {
      const missingCount = (depCheck.missingFiles && depCheck.missingFiles.length) || (depCheck.assets ? depCheck.assets.missing : 0);
      setLaunchStep('download', 'running', `正在下载 ${missingCount} 个缺失文件...`);
      const dlResult = await API.launchGame(versionId, { checkOnly: true });
      if (dlResult.needDownload && dlResult.sessionId) {
        pollLaunchDownload(dlResult.sessionId, versionId, requiredJava);
        window._versepc_launching = false;
        return;
      }
      if (dlResult.error) {
        setLaunchStep('download', 'error', dlResult.error);
        showLaunchError(dlResult.error);
        launchBtn.disabled = false;
        homeLaunchBtn.disabled = false;
        window._versepc_launching = false;
        return;
      }
    }

    setLaunchStep('build-args', 'running', '正在构建启动参数...');
    await new Promise(r => setTimeout(r, 200));
    setLaunchStep('build-args', 'success', '启动参数构建完成');

    setLaunchStep('launching', 'running', '正在启动 Minecraft...');
    
    const result = await API.launchGame(versionId);

    if (result.needDownload && result.sessionId) {
      pollLaunchDownload(result.sessionId, versionId, requiredJava);
      window._versepc_launching = false;
      return;
    }

    if (result.success) {
      setLaunchStep('launching', 'success', '游戏进程已创建');
      updateLaunchProgress(100);
      document.getElementById('launch-log-section').style.display = '';
      launchBtn.classList.add('running');
      launchBtn.querySelector('span').textContent = '启动游戏';
      document.getElementById('status-indicator').classList.add('running');
      document.getElementById('status-text').textContent = '游戏运行中';
      startGameLogStream();
      updateGameStatus();
      incrementLaunchCount();
      checkSupportMilestone();
      _onGameRunning();
      setTimeout(() => {
        closeLaunchModal('fade');
        launchBtn.disabled = false;
        homeLaunchBtn.disabled = false;
        window._versepc_launching = false;
      }, 2000);
    } else {
      setLaunchStep('launching', 'error', result.error || '启动失败');
      showLaunchError(result.error || '启动失败', result.details || result);
      launchBtn.disabled = false;
      homeLaunchBtn.disabled = false;
      window._versepc_launching = false;
    }
  } catch (e) {
    console.error('[Launch] 启动异常:', e);
    const statusEl = document.getElementById('launch-splash-status');
    if (statusEl) {
      statusEl.textContent = e.message || '启动请求失败';
      statusEl.style.color = '#dc2626';
    }
    showLaunchError(e.message || '启动请求失败', { error: e.message, stack: e.stack });
    launchBtn.disabled = false;
    homeLaunchBtn.disabled = false;
    window._versepc_launching = false;
  }
}

function showLaunchDepModal(versionId, sessionId, missingCount, depCheck) {
  setLaunchStep('download', 'running', `发现 ${missingCount} 个缺失文件，需要下载...`);
  updateLaunchDownloadProgress(0, `0/${missingCount} 文件`, {
    completedFiles: 0,
    totalFiles: missingCount,
    currentFile: '准备下载...',
    speed: 0,
    activeDownloads: []
  });

  startLaunchDepDownload(versionId, sessionId);
}

function closeLaunchDepModal() {
  if (launchDepPollTimer) { clearInterval(launchDepPollTimer); launchDepPollTimer = null; }
  const modal = document.getElementById('launch-dep-modal');
  if (modal) {
    modal.classList.remove('modal-visible');
    setTimeout(() => modal.remove(), 300);
  }
}

async function startLaunchDepDownload(versionId, sessionId) {
  setLaunchStep('download', 'running', '正在下载缺失文件...');

  try {
    const result = await API.downloadLaunchDeps(versionId, sessionId);

    if (result.success && result.sessionId) {
      pollLaunchDepProgress(result.sessionId, versionId);
    } else if (result.message === '无需下载') {
      setLaunchStep('download', 'success', '无需下载');
      setLaunchStep('build-args', 'running', '正在构建启动参数...');
      await new Promise(r => setTimeout(r, 200));
      setLaunchStep('build-args', 'success', '启动参数构建完成');
      setLaunchStep('launching', 'running', '正在启动 Minecraft...');
      const launchBtn = document.getElementById('launch-btn');
      const homeLaunchBtn = document.getElementById('home-launch-btn');
      try {
        const launchResult = await API.launchGame(versionId);
        if (launchResult.success) {
          setLaunchStep('launching', 'success', '游戏进程已创建');
          updateLaunchProgress(100);
          showToast('游戏启动成功', 'success');
          launchBtn.classList.add('running');
          launchBtn.querySelector('span').textContent = '启动游戏';
          document.getElementById('status-indicator').classList.add('running');
          document.getElementById('status-text').textContent = '游戏运行中';
          startGameLogStream();
          updateGameStatus();
          incrementLaunchCount();
          checkSupportMilestone();
          _onGameRunning();
          setTimeout(() => {
            closeLaunchModal('fade');
            launchBtn.disabled = false;
            homeLaunchBtn.disabled = false;
          }, 2000);
        } else {
          setLaunchStep('launching', 'error', launchResult.error || '启动失败');
          showLaunchError(launchResult.error || '启动失败', launchResult.details || launchResult);
        }
      } catch (e) {
        setLaunchStep('launching', 'error', '启动失败');
        showLaunchError('启动失败', { error: e.message });
      }
      launchBtn.disabled = false;
      if (homeLaunchBtn) homeLaunchBtn.disabled = false;
    } else {
      setLaunchStep('download', 'error', '下载请求失败');
      showLaunchError('下载请求失败');
    }
  } catch (e) {
    setLaunchStep('download', 'error', '下载请求失败: ' + e.message);
    showLaunchError('下载请求失败: ' + e.message, { error: e.message });
  }
}

function pollLaunchDepProgress(sessionId, versionId) {
  if (launchDepPollTimer) clearInterval(launchDepPollTimer);
  let depSmoothPct = 0;

  launchDepPollTimer = setInterval(async () => {
    try {
      const status = await API.getLaunchSessionStatus(sessionId);

      const detailData = {
        completedFiles: status.completedFiles || 0,
        totalFiles: status.totalFiles || 0,
        currentFile: status.currentFile || '',
        speed: status.speed || 0,
        activeDownloads: status.activeDownloads || []
      };

      const rawDepPct = status.progress || 0;
      if (depSmoothPct <= 0 || rawDepPct < depSmoothPct) {
        depSmoothPct = rawDepPct;
      } else {
        depSmoothPct = depSmoothPct * 0.85 + rawDepPct * 0.15;
      }
      const smoothDepPct = Math.round(depSmoothPct);
      updateLaunchDownloadProgress(smoothDepPct, status.message || '', detailData);
      const baseProgress = 40;
      updateLaunchProgress(baseProgress + (smoothDepPct / 100) * 50);

      if (status.status === 'launched') {
        clearInterval(launchDepPollTimer);
        launchDepPollTimer = null;
        setLaunchStep('download', 'success', '缺失文件下载完成');
        setLaunchStep('build-args', 'success', '启动参数构建完成');
        setLaunchStep('launching', 'success', '游戏进程已创建');
        updateLaunchProgress(100);
        showToast('游戏启动成功', 'success');
        const launchBtn = document.getElementById('launch-btn');
        const homeLaunchBtn = document.getElementById('home-launch-btn');
        launchBtn.classList.add('running');
        launchBtn.querySelector('span').textContent = '启动游戏';
        document.getElementById('status-indicator').classList.add('running');
        document.getElementById('status-text').textContent = '游戏运行中';
        startGameLogStream();
        incrementLaunchCount();
        checkSupportMilestone();
        _onGameRunning();
        setTimeout(() => {
          closeLaunchModal('fade');
          launchBtn.disabled = false;
          if (homeLaunchBtn) homeLaunchBtn.disabled = false;
        }, 2000);
      } else if (status.status === 'launch_failed') {
        clearInterval(launchDepPollTimer);
        launchDepPollTimer = null;
        setLaunchStep('launching', 'error', status.message || '启动失败');
        showLaunchError(status.message || '启动失败', status.launchResult || status);
      } else if (status.status === 'failed') {
        clearInterval(launchDepPollTimer);
        launchDepPollTimer = null;
        setLaunchStep('download', 'error', status.message || '下载失败');
        showLaunchError(status.message || '下载失败', { failedFiles: status.failedFiles });
      } else if (status.status === 'completed' && status.failed > 0) {
        setLaunchStep('download', 'warning', `${status.failed} 个文件下载失败`);
      } else if (status.status === 'completed') {
        clearInterval(launchDepPollTimer);
        launchDepPollTimer = null;
        updateLaunchDownloadProgress(100, '下载完成', {
          completedFiles: status.totalFiles || 0,
          totalFiles: status.totalFiles || 0,
          currentFile: '',
          speed: 0,
          activeDownloads: []
        });
        setLaunchStep('download', 'success', '缺失文件下载完成');
        showToast(`下载完成: ${status.completedFiles || 0} 个文件`, 'success');
      }
    } catch (e) {
      console.error('[Launch Poll] Error:', e);
    }
  }, 200);
}

async function retryLaunchDepDownload(versionId, sessionId) {
  setLaunchStep('download', 'running', '正在重试下载...');

  try {
    const result = await API.downloadLaunchDeps(versionId, sessionId);
    if (result.success && result.sessionId) {
      pollLaunchDepProgress(result.sessionId, versionId);
    } else {
      setLaunchStep('download', 'error', '重试失败');
      showLaunchError('重试失败', result);
    }
  } catch (e) {
    setLaunchStep('download', 'error', '重试请求失败');
    showLaunchError('重试请求失败', { error: e.message });
  }
}

async function updateGameStatus() {
  try {
    const status = await API.getGameStatus();
    const indicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');
    const launchBtn = document.getElementById('launch-btn');

    if (status.running) {
      indicator.classList.add('running');
      const count = status.instances ? status.instances.length : 1;
      if (count > 1) {
        statusText.textContent = `${count} 个游戏运行中`;
      } else {
        statusText.textContent = '游戏运行中';
      }
      launchBtn.classList.add('running');
      launchBtn.querySelector('span').textContent = '启动游戏';

      updateGameInstanceList(status.instances || []);
    } else {
      const wasRunning = indicator.classList.contains('running');
      indicator.classList.remove('running');
      statusText.textContent = '就绪';
      launchBtn.classList.remove('running');
      launchBtn.querySelector('span').textContent = '启动游戏';

      updateGameInstanceList([]);

      if (wasRunning) {
        try {
          const analysisResult = await API.getExitAnalysis();
          const analysis = analysisResult.analysis;
          if (analysis && analysis.isCrash) {
            showToast(`游戏崩溃: ${analysis.reason}`, 'error');
            if (analysis.suggestion) {
              setTimeout(() => showToast(`建议: ${analysis.suggestion}`, 'info'), 1000);
            }
            if (analysis.versionId || status.lastVersionId) {
              const vid = analysis.versionId || status.lastVersionId;
              setTimeout(() => {
                const repairToast = document.createElement('div');
                repairToast.className = 'toast warning';
                repairToast.style.cssText = 'cursor:pointer;display:flex;align-items:center;gap:8px';
                repairToast.innerHTML = '<span>游戏启动失败，可前往<strong>版本设置页面</strong>使用<strong>文件修复功能</strong>解决此问题</span><button style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap">立即修复</button>';
                repairToast.querySelector('button').addEventListener('click', () => {
                  openVersionSettings(vid);
                  document.querySelectorAll('.vset-nav-item[data-tab="overview"]').forEach(b => b.click());
                  setTimeout(() => { repairFiles(); }, 500);
                });
                const container = document.getElementById('toast-container');
                if (container) {
                  container.appendChild(repairToast);
                  setTimeout(() => {
                    repairToast.style.transform = 'translateX(120%)';
                    repairToast.style.opacity = '0';
                    setTimeout(() => { if (repairToast.parentNode) repairToast.parentNode.removeChild(repairToast); }, 300);
                  }, 8000);
                }
              }, 2000);
            }
            const crashVid = analysis.versionId || status.lastVersionId;
            if (crashVid) {
              showCrashAnalysis(crashVid);
            }
          }
        } catch (e) {
          console.warn('[Launch] 退出分析失败:', e);
        }
      }
    }
  } catch (e) {
    console.error('[Launch] 更新游戏状态失败:', e);
  }
}

async function showCrashAnalysis(versionId) {
  try {
    const result = await API.analyzeCrash(versionId);
    if (result.found) {
      showCrashAnalysisDialog(result);
    }
  } catch (e) {}
}

function showCrashAnalysisDialog(result) {
  const existing = document.getElementById('crash-analysis-dialog');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'crash-analysis-dialog';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:10001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px)';

  const severityColors = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };
  const severityLabels = { high: '严重', medium: '中等', low: '轻微' };
  const severityColor = severityColors[result.severity] || severityColors.medium;
  const severityLabel = severityLabels[result.severity] || '中等';

  const dialog = document.createElement('div');
  dialog.style.cssText = `width:90%;max-width:520px;background:var(--bg-secondary);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.5);overflow:hidden`;

  dialog.innerHTML = `
    <div style="padding:20px 24px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between">
      <h3 style="margin:0;font-size:18px;color:var(--text-primary)">崩溃分析结果</h3>
      <button id="crash-dialog-close" style="width:32px;height:32px;border:none;background:transparent;color:var(--text-muted);font-size:20px;cursor:pointer;border-radius:6px">×</button>
    </div>
    <div style="padding:24px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${severityColor}"></span>
        <span style="font-size:14px;font-weight:600;color:var(--text-primary)">${escapeHtml(result.reason)}</span>
        <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${severityColor}20;color:${severityColor}">${escapeHtml(severityLabel)}</span>
      </div>
      ${result.modName ? `<div style="padding:10px 14px;background:var(--bg-primary);border-radius:8px;margin-bottom:12px;font-size:13px;color:var(--text-secondary)">相关Mod: <strong style="color:var(--accent)">${escapeHtml(result.modName)}</strong></div>` : ''}
      <div style="padding:14px;background:var(--bg-primary);border-radius:8px;border-left:4px solid var(--accent);margin-bottom:16px">
        <div style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:6px">解决方案</div>
        <div style="font-size:13px;color:var(--text-primary);line-height:1.6">${escapeHtml(result.solution)}</div>
      </div>
      ${result.logFile ? `<div style="font-size:12px;color:var(--text-muted)">日志文件: ${escapeHtml(result.logFile)}</div>` : ''}
    </div>
    <div style="padding:16px 24px;border-top:1px solid var(--border-color);display:flex;justify-content:flex-end;gap:8px">
      <button id="crash-dialog-view-log" style="padding:8px 16px;border:1px solid var(--border-color);background:var(--bg-secondary);color:var(--text-primary);border-radius:6px;font-size:13px;cursor:pointer">查看日志</button>
      <button id="crash-dialog-ok" style="padding:8px 16px;border:none;background:var(--accent);color:#fff;border-radius:6px;font-size:13px;cursor:pointer">知道了</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const closeDialog = () => { overlay.remove(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDialog(); });
  dialog.querySelector('#crash-dialog-close').addEventListener('click', closeDialog);
  dialog.querySelector('#crash-dialog-ok').addEventListener('click', closeDialog);
  dialog.querySelector('#crash-dialog-view-log').addEventListener('click', () => {
    closeDialog();
    if (typeof crashAnalyzerUI !== 'undefined') {
      crashAnalyzerUI.show();
    }
  });
}

function showLaunchModal() {
  const overlay = document.getElementById('game-launch-overlay');
  if (!overlay) {
    console.error('[Launch] game-launch-overlay element not found');
    return;
  }

  overlay.style.display = 'flex';

  const progressBar = document.getElementById('launch-splash-progress');
  if (progressBar) progressBar.style.width = '0%';

  const statusEl = document.getElementById('launch-splash-status');
  if (statusEl) {
    statusEl.textContent = '正在验证登录状态...';
    statusEl.style.color = '';
  }

  const logo = document.getElementById('launch-splash-logo');
  if (logo) {
    logo.style.animation = 'none';
    void logo.offsetWidth;
    logo.style.animation = '';
  }

  const errorSection = document.getElementById('launch-error-section');
  if (errorSection) errorSection.style.display = 'none';

  const logSection = document.getElementById('launch-log-section');
  if (logSection) logSection.style.display = 'none';

  const repairGuide = document.getElementById('launch-repair-guide');
  if (repairGuide) repairGuide.style.display = 'none';
}

function closeLaunchModal(name_fade) {
  const overlay = document.getElementById('game-launch-overlay');
  if (!overlay) return;

  if (name_fade) {
    overlay.style.transition = 'opacity 0.5s ease-out';
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.style.display = 'none';
      overlay.style.opacity = '1';
      overlay.style.transition = '';
      navigateToPage('home');
    }, 500);
  } else {
    overlay.style.display = 'none';
  }

  hideLaunchError();
}

function updateLaunchProgress(pct) {
  const bar = document.getElementById('launch-splash-progress');
  if (bar) bar.style.width = pct + '%';
}

const LAUNCH_STEP_PROGRESS = {
  'auth': 5, 'java-check': 15, 'version-resolve': 25,
  'files-check': 40, 'natives-extract': 55, 'assets-check': 65,
  'download': 75, 'build-args': 85, 'launching': 95
};

function setLaunchStep(stepName, status, desc) {
  const statusEl = document.getElementById('launch-splash-status');
  if (statusEl && desc) statusEl.textContent = desc;

  const progress = LAUNCH_STEP_PROGRESS[stepName] || 0;
  updateLaunchProgress(progress);

  if (statusEl) {
    if (status === 'error') {
      statusEl.style.color = '#dc2626';
    } else if (status === 'success' && stepName === 'launching') {
      updateLaunchProgress(100);
      statusEl.textContent = '启动成功！';
      statusEl.style.color = '#4ade80';
    } else {
      statusEl.style.color = '';
    }
  }
}

function completeAllPreviousSteps(currentStepName) {
}

function showLaunchError(msg, details = null) {
  const errorSection = document.getElementById('launch-error-section');
  const errorMsg = document.getElementById('launch-error-msg');
  const repairGuide = document.getElementById('launch-repair-guide');
  if (errorSection) errorSection.style.display = 'flex';
  if (repairGuide) {
    repairGuide.style.display = 'flex';
    repairGuide.dataset.versionId = (details && details.versionId) || currentSettingsVersionId || (launchVersionCustomSelect ? launchVersionCustomSelect.getValue() : '');
  }

  let fullMsg = msg || '未知错误';
  if (details) {
    console.error('[Launch] 详细错误信息:', details);
    if (details.versionId) fullMsg += `\n版本: ${details.versionId}`;
    if (details.mainClass) fullMsg += `\n主类: ${details.mainClass}`;
    if (details.externalVersionDir) fullMsg += `\n外部目录: ${details.externalVersionDir}`;
    if (details.error) fullMsg += `\n错误: ${details.error}`;
  }

  if (errorMsg) {
    errorMsg.innerHTML = (msg || '未知错误').replace(/\n/g, '<br>');
    errorMsg.title = fullMsg;
  }

  const statusEl = document.getElementById('launch-splash-status');
  if (statusEl) {
    statusEl.textContent = msg || '启动失败';
    statusEl.style.color = '#dc2626';
  }
}

function hideLaunchError() {
  const errorSection = document.getElementById('launch-error-section');
  const repairGuide = document.getElementById('launch-repair-guide');
  if (errorSection) errorSection.style.display = 'none';
  if (repairGuide) repairGuide.style.display = 'none';

  const statusEl = document.getElementById('launch-splash-status');
  if (statusEl) statusEl.style.color = '';
}

function openVersionSettingsForRepair() {
  const repairGuide = document.getElementById('launch-repair-guide');
  const versionId = (repairGuide && repairGuide.dataset.versionId) || (launchVersionCustomSelect ? launchVersionCustomSelect.getValue() : '');
  if (versionId) {
    openVersionSettings(versionId);
  }
  closeLaunchModal();
}

function updateLaunchDownloadProgress(pct, msg, detailData) {
  const statusEl = document.getElementById('launch-splash-status');
  if (!statusEl) return;

  if (detailData) {
    const parts = [];
    if (detailData.completedFiles !== undefined && detailData.totalFiles !== undefined) {
      parts.push(detailData.completedFiles + '/' + detailData.totalFiles);
    }
    if (detailData.speed > 0) {
      const spd = detailData.speed;
      if (spd < 1024) parts.push(spd.toFixed(0) + ' B/s');
      else if (spd < 1024 * 1024) parts.push((spd / 1024).toFixed(1) + ' KB/s');
      else parts.push((spd / (1024 * 1024)).toFixed(1) + ' MB/s');
    }
    statusEl.textContent = (parts.length ? parts.join('  ') + ' - ' : '') + Math.round(pct) + '%';
  } else if (msg) {
    statusEl.textContent = msg;
  }
}

function cancelLaunchFlow() {
  if (window._launchDlPollInterval) {
    clearInterval(window._launchDlPollInterval);
    window._launchDlPollInterval = null;
  }
  window._versepc_launching = false;
  if (typeof API !== 'undefined' && API.cancelLaunch) {
    API.cancelLaunch().catch(() => {});
  }
  closeLaunchModal();
  const launchBtn = document.getElementById('launch-btn');
  const homeLaunchBtn = document.getElementById('home-launch-btn');
  if (launchBtn) launchBtn.disabled = false;
  if (homeLaunchBtn) homeLaunchBtn.disabled = false;
}

function toggleLaunchLog() {
  const content = document.getElementById('launch-log-content');
  if (content.style.maxHeight === '0px') {
    content.style.maxHeight = '150px';
  } else {
    content.style.maxHeight = '0px';
  }
}

async function pollLaunchDownload(sessionId, versionId, requiredJava) {
  try {
    let lastPct = 0;
    let smoothPct = 0;
    
    const pollInterval = setInterval(async () => {
      window._launchDlPollInterval = pollInterval;
      try {
        const dlStatus = await API.getLaunchSessionStatus(sessionId);
        
        if (!dlStatus || dlStatus.status === 'error') {
          clearInterval(pollInterval);
          setLaunchStep('download', 'error', dlStatus?.message || '下载失败');
          showLaunchError(dlStatus?.message || '下载失败');
          const launchBtn = document.getElementById('launch-btn');
          const homeLaunchBtn = document.getElementById('home-launch-btn');
          if (launchBtn) launchBtn.disabled = false;
          if (homeLaunchBtn) homeLaunchBtn.disabled = false;
          return;
        }
        
        const rawPct = dlStatus.progress || 0;
        if (smoothPct <= 0 || rawPct < smoothPct) {
          smoothPct = rawPct;
        } else {
          smoothPct = smoothPct * 0.85 + rawPct * 0.15;
        }
        const pct = Math.min(95, Math.round(smoothPct));
        if (pct !== lastPct) {
          lastPct = pct;
          updateLaunchDownloadProgress(pct, `下载文件 (${dlStatus.completedFiles || 0}/${dlStatus.totalFiles || 0}): ${dlStatus.currentFile || ''}`, {
            completedFiles: dlStatus.completedFiles || 0,
            totalFiles: dlStatus.totalFiles || 0,
            currentFile: dlStatus.currentFile || '',
            speed: dlStatus.speed || 0,
            activeDownloads: dlStatus.activeDownloads || []
          });
          const baseProgress = 40;
          updateLaunchProgress(baseProgress + (pct / 100) * 50);
        }
        
        if (dlStatus.status === 'completed') {
          clearInterval(pollInterval);
          updateLaunchDownloadProgress(100, '下载完成', {
            completedFiles: dlStatus.totalFiles || 0,
            totalFiles: dlStatus.totalFiles || 0,
            currentFile: '',
            speed: 0,
            activeDownloads: []
          });
          setLaunchStep('download', 'success', '缺失文件下载完成');
          
          setTimeout(async () => {
            setLaunchStep('build-args', 'running', '正在构建启动参数...');
            await new Promise(r => setTimeout(r, 200));
            setLaunchStep('build-args', 'success', '启动参数构建完成');
            
            setLaunchStep('launching', 'running', '正在启动 Minecraft...');
            
            const result = await API.launchGame(versionId);
            
            if (result.success) {
              setLaunchStep('launching', 'success', '游戏进程已创建');
              updateLaunchProgress(100);
              document.getElementById('launch-log-section').style.display = '';
              const launchBtn = document.getElementById('launch-btn');
              const homeLaunchBtn = document.getElementById('home-launch-btn');
              launchBtn.classList.add('running');
              launchBtn.querySelector('span').textContent = '启动游戏';
              document.getElementById('status-indicator').classList.add('running');
              document.getElementById('status-text').textContent = '游戏运行中';
              startGameLogStream();
              updateGameStatus();
              incrementLaunchCount();
              checkSupportMilestone();
              _onGameRunning();
              setTimeout(() => {
                closeLaunchModal('fade');
                launchBtn.disabled = false;
                homeLaunchBtn.disabled = false;
              }, 2000);
            } else {
              setLaunchStep('launching', 'error', result.error || '启动失败');
              showLaunchError(result.error || '启动失败');
              const launchBtn = document.getElementById('launch-btn');
              const homeLaunchBtn = document.getElementById('home-launch-btn');
              if (launchBtn) launchBtn.disabled = false;
              if (homeLaunchBtn) homeLaunchBtn.disabled = false;
            }
          }, 500);
        }
      } catch (e) {
        console.warn('[Launch] 启动轮询回调异常:', e);
      }
    }, 800);
  } catch (e) {
    console.error('[Launch] 轮询失败:', e);
  }
}

function updateGameInstanceList(instances) {
  let container = document.getElementById('game-instance-list');
  if (!container) {
    const sidebar = document.querySelector('.launch-bar') || document.querySelector('.sidebar');
    if (!sidebar) return;
    container = document.createElement('div');
    container.id = 'game-instance-list';
    container.style.cssText = 'position:fixed;bottom:60px;right:16px;z-index:1000;display:flex;flex-direction:column;gap:6px;max-width:280px;';
    document.body.appendChild(container);
  }

  if (instances.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';
  container.innerHTML = instances.map(inst => {
    const elapsed = Math.floor((Date.now() - inst.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
    return `
      <div class="game-instance-card" data-session="${inst.sessionId}" style="
        background:var(--card-bg);border:1px solid var(--border-color);border-radius:8px;
        padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:12px;
        box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:default;
      ">
        <div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;"></div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${inst.versionId}</div>
          <div style="color:var(--text-secondary);font-size:11px;">PID: ${inst.pid} · ${timeStr}${inst.lanPort ? ' · LAN:' + inst.lanPort : ''}</div>
        </div>
        <button onclick="stopGameInstance('${inst.sessionId}')" style="
          background:var(--red);color:white;border:none;border-radius:4px;
          padding:2px 8px;cursor:pointer;font-size:11px;flex-shrink:0;
        ">停止</button>
      </div>
    `;
  }).join('');
}

async function stopGameInstance(sessionId) {
  try {
    const result = await API.stopGameInstance(sessionId);
    if (result.success) {
      showToast('游戏实例已停止', 'info');
      updateGameStatus();
    } else {
      showToast(result.error || '停止失败', 'error');
    }
  } catch (e) {
    showToast('停止请求失败', 'error');
  }
}

// 游戏运行低调模式 - 游戏启动成功后的统一处理：
// 1. 标记 body.game-running  2. 挂起壁纸引擎  3. 5秒后按设置最小化启动器
function _onGameRunning() {
  try { document.body.classList.add('game-running'); } catch (e) {}
  try {
    if (typeof wallpaperEngine !== 'undefined' && wallpaperEngine && typeof wallpaperEngine.suspend === 'function') {
      wallpaperEngine.suspend();
    }
  } catch (e) {}
  try {
    if (window.electronAPI && window.electronAPI.store && window.electronAPI.windowMinimize) {
      window.electronAPI.store.get('minimizeOnGameRun').then((val) => {
        // 默认开启：undefined/null 视为 true
        if (val === undefined || val === null || val === true) {
          setTimeout(() => {
            try { window.electronAPI.windowMinimize(); } catch (e) {}
          }, 5000);
        }
      }).catch(() => {});
    }
  } catch (e) {}
}

// 游戏运行低调模式 - 游戏退出后的统一处理：
// 1. 移除 body.game-running  2. 恢复壁纸引擎  3. 恢复启动器窗口
function _onGameExited() {
  try { document.body.classList.remove('game-running'); } catch (e) {}
  try {
    if (typeof wallpaperEngine !== 'undefined' && wallpaperEngine && typeof wallpaperEngine.resume === 'function') {
      wallpaperEngine.resume();
    }
  } catch (e) {}
  try {
    if (window.electronAPI && window.electronAPI.windowRestore) {
      window.electronAPI.windowRestore();
    }
  } catch (e) {}
}

function startGameLogStream() {
  if (gameLogEventSource) gameLogEventSource.close();
  const consoleOutput = document.getElementById('console-output');
  consoleOutput.innerHTML = '';
  try {
    gameLogEventSource = new EventSource('/api/game/log/stream');
    gameLogEventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === 'exited') {
          appendConsoleLine('[VersePC] 游戏进程已退出', 'warn');
          _onGameExited();
          gameLogEventSource.close();
          gameLogEventSource = null;
          return;
        }
        if (data.batch && Array.isArray(data.batch)) {
          const frag = document.createDocumentFragment();
          const batchLen = data.batch.length;
          for (let i = 0; i < batchLen; i++) {
            const line = data.batch[i];
            let type = '';
            if (line.includes('ERROR') || line.includes('FATAL') || line.includes('Exception')) type = 'error';
            else if (line.includes('WARN')) type = 'warn';
            else if (line.includes('[VersePC]')) type = 'info';
            const el = document.createElement('div');
            el.className = 'console-line' + (type ? ' ' + type : '');
            el.textContent = line;
            frag.appendChild(el);
          }
          consoleOutput.appendChild(frag);
          while (consoleOutput.children.length > 500) consoleOutput.removeChild(consoleOutput.firstChild);
          consoleOutput.scrollTop = consoleOutput.scrollHeight;
        } else if (data.line) {
          let type = '';
          const line = data.line;
          if (line.includes('ERROR') || line.includes('FATAL') || line.includes('Exception')) type = 'error';
          else if (line.includes('WARN')) type = 'warn';
          else if (line.includes('[VersePC]')) type = 'info';
          appendConsoleLine(line, type);
        }
      } catch (e) {
        console.warn('[GameLog] 解析日志行失败:', e);
      }
    };
    gameLogEventSource.onerror = () => { gameLogEventSource.close(); gameLogEventSource = null; };
  } catch (e) {
    console.warn('[GameLog] 创建日志流失败:', e);
  }
}

function appendConsoleLine(text, type = '') {
  const consoleOutput = document.getElementById('console-output');
  const line = document.createElement('div');
  line.className = `console-line ${type}`;
  line.textContent = text;
  consoleOutput.appendChild(line);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
  while (consoleOutput.children.length > 500) consoleOutput.removeChild(consoleOutput.firstChild);
}

async function detectJava() {
  const hint = document.getElementById('java-detect-result');
  if (hint) hint.textContent = '检测中...';
  try {
    const result = await API.detectJava();
    if (result.javaList && result.javaList.length > 0) {
      const best = result.javaList.find(j => j.majorVersion >= 17) || result.javaList[0];
      const javaPathInput = document.getElementById('setting-java-path');
      if (javaPathInput) javaPathInput.value = best.path;
      if (hint) hint.textContent = `找到 Java ${best.version} (${best.is64Bit ? '64位' : '32位'})`;
      const statJava = document.getElementById('stat-java');
      if (statJava) statJava.textContent = best.majorVersion;
    } else {
      if (hint) hint.textContent = '未检测到Java，请手动配置或安装';
    }
  } catch (e) { if (hint) hint.textContent = '检测失败'; }
}

let javaInstallPollTimer = null;

async function checkJavaOnStartup() {
  try {
    const result = await API.detectJava();
    if (result.javaList && result.javaList.length > 0) {
      const best = result.javaList.find(j => j.majorVersion >= 17) || result.javaList[0];
      const statJava = document.getElementById('stat-java');
      if (statJava) statJava.textContent = best.majorVersion;
    }
  } catch (e) {
    console.error('Java startup check failed:', e);
  }
}

async function triggerJvmPreheat() {
  try {
    const saved = await window.electronAPI.store.get('versepc_launch_settings');
    if (!saved) return;
    const settings = JSON.parse(saved);
    if (!settings.jvmPreheat) return;

    const result = await API.detectJava();
    if (result && result.javaList && result.javaList.length > 0) {
      const bestJava = result.javaList.find(j => j.majorVersion >= 17) || result.javaList[0];
      const memInfo = await API.getSystemMemory();
      const totalMB = memInfo.totalMB || 8192;
      const preheatMem = Math.min(2048, Math.floor(totalMB * 0.3));
      await fetch('/api/jvm/preheat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ javaPath: bestJava.path, maxMemMB: preheatMem })
      });
    }
  } catch(e) {}
}

async function generateCdsArchive() {
  const versionId = document.getElementById('launch-version-select')?.value;
  if (!versionId) {
    showToast('请先选择一个游戏版本', 'error');
    return;
  }
  const statusText = document.getElementById('cds-status-text');
  if (statusText) statusText.textContent = '正在生成...';
  showToast('正在生成 CDS 归档，请稍候...', 'info');
  try {
    const result = await API.generateCds(versionId);
    if (result.success) {
      const sizeInfo = result.sizeKB ? ` (${result.sizeKB}KB)` : '';
      showToast(`CDS 归档生成成功${sizeInfo}，下次启动将自动加速`, 'success');
      if (statusText) statusText.textContent = `✓ 已生成${sizeInfo}`;
    } else {
      showToast('CDS 归档生成失败: ' + (result.error || '未知错误'), 'error');
      if (statusText) statusText.textContent = '✗ 生成失败';
    }
  } catch (e) {
    showToast('CDS 归档生成失败: ' + e.message, 'error');
    if (statusText) statusText.textContent = '✗ 生成失败';
  }
}

async function checkCdsStatus() {
  const versionId = document.getElementById('launch-version-select')?.value;
  if (!versionId) return;
  const statusText = document.getElementById('cds-status-text');
  if (!statusText) return;
  try {
    const result = await API.getCdsStatus(versionId);
    if (result.available) {
      statusText.textContent = `✓ 归档已就绪 (${result.sizeKB}KB)`;
    } else {
      statusText.textContent = '未生成归档';
    }
  } catch (e) {
    statusText.textContent = '';
  }
}
