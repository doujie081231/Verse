/**
 * @file versions.js
 * @description 版本列表管理 - 加载、筛选、渲染游戏版本列表
 */
let versionsLoadFailed = false;
let versionsRetryTimer = null;
let _versionsLoadTime = 0;
const _VERSIONS_CACHE_TTL = 300000;

let currentLaunchVersionId = '';

// ============================================================================
// 版本列表管理 - 加载、筛选、渲染游戏版本列表
// ============================================================================
async function loadVersions(forceRefresh = false) {
  if (!forceRefresh && _versionsLoadTime > 0 &&
    (Date.now() - _versionsLoadTime) < _VERSIONS_CACHE_TTL &&
    (allVersions.length > 0 || installedVersions.length > 0)) {
    return;
  }
  try {
    const data = await API.getVersions(forceRefresh);
    allVersions = data.versions || [];
    installedVersions = data.installed || [];
    if (!Array.isArray(allVersions)) allVersions = [];
    if (!Array.isArray(installedVersions)) installedVersions = [];
    versionIconsTimestamp = Date.now();
    versionsLoadFailed = false;
    _versionsLoadTime = Date.now();

    await updateVersionSelects();
    renderVersions();
    updateHomeStats();
    populateModVersionFilter();
  } catch (e) {
    console.error('[Versions] Load failed:', e.message);
    versionsLoadFailed = true;
    
    const container = document.getElementById('versions-list');
    if (container && installedVersions.length > 0) {
      currentVersionTab = 'installed';
      renderVersions();
      const tabs = document.querySelectorAll('.tab-btn[data-tab]');
      tabs.forEach(t => t.classList.remove('active'));
      const installedTab = document.querySelector('.tab-btn[data-tab="installed"]');
      if (installedTab) installedTab.classList.add('active');
    } else if (container) {
      container.innerHTML = `
        <p class="empty-text">加载版本列表失败</p>
        <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="retryLoadVersions()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;vertical-align:middle;margin-right:4px">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
          </svg> 重试
        </button>`;
    }
    populateModVersionFilter();

    if (!forceRefresh && !versionsRetryTimer) {
      versionsRetryTimer = setTimeout(() => {
        versionsRetryTimer = null;
        if (versionsLoadFailed) {
          loadVersions(false);
        }
      }, 30000);
    }
  }
}

function retryLoadVersions() {
  if (versionsRetryTimer) clearTimeout(versionsRetryTimer);
  versionsRetryTimer = null;
  const container = document.getElementById('versions-list');
  if (container) {
    container.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><p>正在重新加载...</p></div>`;
  }
  loadVersions(true);
}

// ============================================================================
// 版本选择器 - 自定义下拉选择框的选项填充
// ============================================================================
let _cachedLastLaunchVersion = null;
async function updateVersionSelects() {
  let currentVal = currentLaunchVersionId;
  if (!currentVal && launchVersionCustomSelect) {
    currentVal = launchVersionCustomSelect.getValue();
  }

  if (!currentVal) {
    try {
      if (_cachedLastLaunchVersion === null) {
        _cachedLastLaunchVersion = await window.electronAPI.store.get('versepc_last_launch_version') || '';
      }
      currentVal = _cachedLastLaunchVersion;
    } catch (_) {}
  }

  const versionOptions = installedVersions.filter(v => !v.error).map(v => {
    const customName = v.customName || '';
    let baseName = v.isExternal ? v.id.replace(/ \[外部\d*\]/, '') : v.id;
    let text = customName || baseName;
    let subtext = customName ? baseName : '';
    if (v.isModpack) { text += ` [${v.modpackLoader || '整合包'}]`; subtext = (subtext ? subtext + ' · ' : '') + (v.modpackLoader || '整合包'); }
    else if (v.isFabric) { text += ' [Fabric]'; subtext = (subtext ? subtext + ' · ' : '') + 'Fabric Loader'; }
    else if (v.isForge) { text += ' [Forge]'; subtext = (subtext ? subtext + ' · ' : '') + 'Forge'; }
    else if (v.isNeoForge) { text += ' [NeoForge]'; subtext = (subtext ? subtext + ' · ' : '') + 'NeoForge'; }
    else { subtext = (subtext ? subtext + ' · ' : '') + 'Vanilla'; }
    if (v.isExternal) { subtext += ' · 外部文件夹'; }
    return { value: v.id, text: text, subtext: subtext };
  });

  // 选中的版本不在列表中（已被删除等）→ 回退到第一个
  if (currentVal && !versionOptions.find(o => o.value === currentVal)) {
    currentVal = versionOptions.length > 0 ? versionOptions[0].value : '';
  } else if (!currentVal && versionOptions.length > 0) {
    currentVal = versionOptions[0].value;
  }

  // 同步 currentLaunchVersionId 状态变量
  currentLaunchVersionId = currentVal;
  _cachedLastLaunchVersion = currentVal;
  try {
    if (currentVal) window.electronAPI.store.set('versepc_last_launch_version', currentVal);
  } catch (_) {}

  // 同步底部启动栏（隐藏）的选择器
  if (launchVersionCustomSelect) {
    launchVersionCustomSelect.setOptions(versionOptions);
    launchVersionCustomSelect.setValue(currentVal);
  }

  // 渲染主页内嵌版本卡片
  renderHomeCurrentVersionCard();
}

function renderHomeCurrentVersionCard() {
  const card = document.getElementById('home-current-version-card');
  if (!card) return;

  const arrow = `<svg class="home-current-version-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

  const placeholder = `<div class="home-current-version-placeholder">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="home-current-version-placeholder-icon">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="16"></line>
      <line x1="8" y1="12" x2="16" y2="12"></line>
    </svg>
    <span>点击选择版本</span>
  </div>`;

  if (!currentLaunchVersionId) {
    card.innerHTML = placeholder + arrow;
    return;
  }

  const v = installedVersions.find(x => x.id === currentLaunchVersionId);
  if (!v) {
    // 选中的版本已被删除，重置
    currentLaunchVersionId = '';
    card.innerHTML = placeholder + arrow;
    return;
  }

  const iconParams = `id=${encodeURIComponent(v.id)}&type=release`;
  const forgeParam = v.isForge ? '&forge=true' : '';
  const fabricParam = v.isFabric ? '&fabric=true' : '';
  const neoforgeParam = v.isNeoForge ? '&neoforge=true' : '';
  const modpackParam = v.isModpack ? '&modpack=true' : '';
  const extDirParam = v.externalVersionDir ? `&extDir=${encodeURIComponent(v.externalVersionDir)}` : '';
  const iconUrl = `/api/version-icon?${iconParams}${forgeParam}${fabricParam}${neoforgeParam}${modpackParam}${extDirParam}&_t=${versionIconsTimestamp}`;

  let badge = '原版', badgeClass = '';
  if (v.isModpack) { badge = v.modpackLoader || '整合包'; badgeClass = 'modpack'; }
  else if (v.isFabric) { badge = 'Fabric'; badgeClass = 'fabric'; }
  else if (v.isForge) { badge = 'Forge'; badgeClass = 'forge'; }
  else if (v.isNeoForge) { badge = 'NeoForge'; badgeClass = 'forge'; }

  const externalBadgeHtml = v.isExternal ? '<span class="v-badge external">外部</span>' : '';
  const displayName = v.isExternal ? (v.customName || v.id.replace(/ \[外部\d*\]/, '')) : (v.customName || v.id);

  card.innerHTML = `
    <div class="version-item-left">
      <div class="version-item-icon"><img src="${iconUrl}" alt="" class="version-icon-img"></div>
      <div class="version-item-info">
        <span class="version-item-name">${escapeHtml(displayName)}</span>
        <span class="version-item-meta"><span class="v-badge ${badgeClass}">${badge}</span>${externalBadgeHtml}</span>
      </div>
    </div>
    ${arrow}
  `;
}

function selectLaunchVersion(versionId) {
  if (!versionId) return;
  currentLaunchVersionId = versionId;
  _cachedLastLaunchVersion = versionId;
  try { window.electronAPI.store.set('versepc_last_launch_version', versionId); } catch (_) {}
  // 同步底部启动栏（隐藏）的选择器
  if (launchVersionCustomSelect) {
    launchVersionCustomSelect.setValue(versionId);
  }
  // 更新"已安装"tab 中卡片的 selected 类
  document.querySelectorAll('.version-item-clickable[data-installed="true"]').forEach(item => {
    item.classList.toggle('selected', item.dataset.versionId === versionId);
  });
  // 更新主页内嵌版本卡片
  renderHomeCurrentVersionCard();
}

async function quickDeleteErrorVersion(versionId) {
  if (!confirm(`确定要删除版本 "${versionId}" 吗？`)) {
    return;
  }
  try {
    const r = await API.deleteVersion(versionId, false);
    if (r.success) {
      showToast(`版本 ${versionId} 已删除`, 'success');
      await loadVersions(true);
    } else {
      showToast(r.error || '删除失败', 'error');
    }
  } catch (e) {
    console.error('[Delete] API异常:', e);
    showToast('删除失败: ' + (e.message || e), 'error');
  }
}

function toggleErrorVersions(id) {
  const list = document.getElementById(id);
  const header = list?.previousElementSibling;
  if (!list) return;
  list.classList.toggle('show');
  header?.classList.toggle('expanded');
}

// ============================================================================
// 版本列表渲染 - 将版本数据渲染为DOM卡片列表
// ============================================================================
function renderVersions() {
  const container = document.getElementById('versions-list');
  if (!container) return;
  let versions;

  if (currentVersionTab === 'installed') {
    versions = installedVersions;
  } else if (currentVersionTab === 'old') {
    versions = allVersions.filter(v => v.type === 'old_beta' || v.type === 'old_alpha');
  } else {
    versions = allVersions.filter(v => v.type === currentVersionTab);
  }

  if (versions.length === 0) {
    container.innerHTML = '<p class="empty-text">暂无版本</p>';
    return;
  }

  if (currentVersionTab === 'installed') {
    const errorVersions = versions.filter(v => v.error);
    const normalVersions = versions.filter(v => !v.error);
    
    const vanillaVersions = normalVersions.filter(v => {
      return !v.isFabric && !v.isForge && !v.isNeoForge && !v.isOptiFine && !v.isLiteLoader && !v.isModpack;
    });
    const moddedVersions = normalVersions.filter(v => {
      return v.isFabric || v.isForge || v.isNeoForge || v.isOptiFine || v.isLiteLoader || v.isModpack;
    });

    const renderVersionItem = (v) => {
      const iconClass = v.type === 'snapshot' ? 'snapshot' : v.type === 'special' ? 'special' : 'installed';
      const iconParams = `id=${encodeURIComponent(v.id)}&type=${v.type || 'release'}`;
      const forgeParam = v.isForge ? '&forge=true' : '';
      const fabricParam = v.isFabric ? '&fabric=true' : '';
      const neoforgeParam = v.isNeoForge ? '&neoforge=true' : '';
      const modpackParam = v.isModpack ? '&modpack=true' : '';
      const extDirParam = v.externalVersionDir ? `&extDir=${encodeURIComponent(v.externalVersionDir)}` : '';
      const iconUrl = `/api/version-icon?${iconParams}${forgeParam}${fabricParam}${neoforgeParam}${modpackParam}${extDirParam}&_t=${versionIconsTimestamp}`;
      const externalBadgeHtml = v.isExternal ? '<span style="display:inline-block;background:rgba(255,165,0,0.15);color:#ffa500;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:6px">外部文件夹</span>' : '';
      const externalPathHtml = v.isExternal && v.externalPath ? `<span style="color:var(--text-muted);font-size:11px;margin-left:4px" title="${escapeHtml(v.externalPath)}">${escapeHtml(v.externalPath)}</span>` : '';
      const displayName = v.isExternal ? (v.customName || v.id.replace(/ \[外部\d*\]/, '')) : (v.customName || v.id);
      const deleteBtnHtml = `<button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteVersion('${escapeOnclick(v.id)}')">${v.isExternal ? '移除' : '删除'}</button>`;
      const settingsBtnHtml = `<button class="version-item-settings-btn" data-version-id="${escapeHtml(v.id)}" data-custom-name="${escapeHtml(v.customName || '')}" title="版本设置" onclick="event.stopPropagation();">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"></path></svg>
      </button>`;
      const selectedClass = currentLaunchVersionId === v.id ? ' selected' : '';
      return `<div class="version-item version-item-clickable${selectedClass}"
        data-version-id="${escapeHtml(v.id)}"
        data-version-url=""
        data-version-type="${v.type || 'release'}"
        data-installed="true"
        data-custom-name="${escapeHtml(v.customName || '')}">
        <div class="version-item-left">
          <div class="version-item-icon ${iconClass}">
            <img src="${iconUrl}" alt="" class="version-icon-img">
          </div>
          <div class="version-item-info">
            <span class="version-item-name">${displayName}${externalBadgeHtml}</span>
            <span class="version-item-meta">${getVersionTypeLabel(v)} \u00B7 ${formatDate(v.releaseTime)}${externalPathHtml}</span>
          </div>
        </div>
        <div class="version-item-actions">
          ${settingsBtnHtml}
          <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openVersionSettings('${escapeOnclick(v.id)}','${escapeOnclick(displayName)}')">设置</button>
          ${deleteBtnHtml}
        </div>
      </div>`;
    };

    let html = '';

    if (moddedVersions.length > 0) {
      html += moddedVersions.map(renderVersionItem).join('');
    }

    if (vanillaVersions.length > 0) {
      html += `<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:0 4px">
          <span style="font-size:12px;color:var(--text-muted);font-weight:600">\u26A0 基础版本 (${vanillaVersions.length})</span>
        </div>
        ${vanillaVersions.map(renderVersionItem).join('')}
      </div>`;
    }

    if (errorVersions.length > 0) {
      const errorId = 'error-versions-' + Date.now();
      const tntIcon = `<img src="assets/tnt.png" alt="TNT" width="40" height="40" style="image-rendering:pixelated;image-rendering:crisp-edges;">`;
      html += `<div class="error-versions-section" style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(239,68,68,0.2)">
        <div class="error-versions-header" onclick="toggleErrorVersions('${errorId}')">
          <span>\u26A0 错误的版本 (<span class="error-count">${errorVersions.length}</span>)</span>
          <span class="error-chevron">▼</span>
        </div>
        <div class="error-versions-list" id="${errorId}">
          ${errorVersions.map(v => {
            const displayName = v.customName || v.id.replace(/ \[外部\d*\]/, '');
            return `<div class="error-version-item">
              <div class="error-version-icon">${tntIcon}</div>
              <div class="error-version-info">
                <span class="error-version-name">${escapeHtml(displayName)}</span>
                <span class="error-version-reason">${escapeHtml(v.errorReason || '无法识别')}</span>
              </div>
              <button class="btn btn-danger btn-sm" style="flex-shrink:0;padding:4px 12px;font-size:12px" onclick="event.stopPropagation();quickDeleteErrorVersion('${escapeOnclick(v.id)}')">删除</button>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }

    container.innerHTML = html;
    return;
  }

  container.innerHTML = versions.map(v => {
    const iconClass = v.type === 'snapshot' ? 'snapshot' : v.type === 'special' ? 'special' : (v.type === 'old_beta' || v.type === 'old_alpha') ? 'old' : 'release';
    const iconParams = `id=${encodeURIComponent(v.id)}&type=${v.type || 'release'}`;
    const forgeParam = v.isForge ? '&forge=true' : '';
    const fabricParam = v.isFabric ? '&fabric=true' : '';
    const neoforgeParam = v.isNeoForge ? '&neoforge=true' : '';
    const modpackParam = v.isModpack ? '&modpack=true' : '';
    const extDirParam = v.externalVersionDir ? `&extDir=${encodeURIComponent(v.externalVersionDir)}` : '';
    const iconUrl = `/api/version-icon?${iconParams}${forgeParam}${fabricParam}${neoforgeParam}${modpackParam}${extDirParam}&_t=${versionIconsTimestamp}`;
    return `<div class="version-item version-item-clickable" 
      data-version-id="${escapeHtml(v.id)}" 
      data-version-url="${escapeHtml(v.url || '')}" 
      data-version-type="${escapeHtml(v.type || 'release')}">
      <div class="version-item-left">
        <div class="version-item-icon ${iconClass}">
          <img src="${iconUrl}" alt="" class="version-icon-img">
        </div>
        <div class="version-item-info">
          <span class="version-item-name">${v.id}</span>
          <span class="version-item-meta">${getVersionTypeLabel(v)} \u00B7 ${formatDate(v.releaseTime)}</span>
        </div>
      </div>
      <div class="version-item-actions">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:20px;height:20px;opacity:0.5"><path d="M9 18l6-6-6-6"/></svg>
      </div>
    </div>`;
  }).join('');
}

let currentVersionDetail = null;
let selectedLoaderType = '';
let selectedLoaderVersion = '';
const AVATAR_CACHE_VERSION = 9;

let _pageTransitionLock = false;
let _pendingPageTransition = null;

async function navigateToPage(pageName) {
  if (_pageTransitionLock) {
    _pendingPageTransition = pageName;
    return;
  }

  const currentPage = document.querySelector('.page.active');
  const target = document.getElementById(`page-${pageName}`);
  if (!target) {
    console.error('[Navigate] Page not found:', pageName);
    return;
  }
  
  if (currentPage && currentPage === target) {
    target.scrollTop = 0;
    return;
  }

  if (pageName === 'explore') {
    if (currentPage) {
      currentPage.classList.remove('active');
      currentPage.style.animation = '';
    }
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.nav-sub-btn').forEach(b => b.classList.remove('active'));
    const navBtn = document.querySelector('.nav-btn[data-page="explore"]');
    if (navBtn) navBtn.classList.add('active');
    target.classList.add('active');
    target.scrollTop = 0;
    return;
  }
  
  const isDetailPage = pageName === 'version-detail' || pageName === 'mod-detail' || pageName === 'version-settings';
  
  if (isDetailPage && currentPage && currentPage.id.startsWith('page-')) {
    const currentPageName = currentPage.id.replace('page-', '');
    const detailPages = ['version-detail', 'mod-detail', 'version-settings'];
    if (!detailPages.includes(currentPageName)) {
      previousPage = currentPageName;
    }
  }

  if (pageName === 'mod-detail' && currentPage && currentPage.id === 'page-mod-detail' && !_isRestoringModDetail) {
    modDetailHistory.push({
      id: currentModDetailId,
      source: currentModDetailSource
    });
  }
  
  if (currentPage && currentPage !== target) {
    if (currentPage.id === 'page-version-settings') {
      document.querySelector('.content-area')?.classList.remove('no-scroll');
    }
    _pageTransitionLock = true;
    currentPage.style.animation = '';
    requestAnimationFrame(() => {
      currentPage.classList.remove('active');
      currentPage.style.animation = '';
      target.classList.add('active');
      target.scrollTop = 0;
      target.style.animation = 'pageIn 0.18s var(--ease-out-expo) backwards';
      setTimeout(() => {
        _pageTransitionLock = false;
        if (_pendingPageTransition && _pendingPageTransition !== pageName) {
          const pending = _pendingPageTransition;
          _pendingPageTransition = null;
          navigateToPage(pending);
        } else {
          _pendingPageTransition = null;
        }
      }, 80);
    });
  } else if (!currentPage) {
    target.classList.add('active');
    target.scrollTop = 0;
    target.style.animation = 'pageIn 0.18s var(--ease-out-expo) backwards';
  }
  
  if (isDetailPage) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const backPage = previousPage || 'mods';
    const navBtn = document.querySelector(`.nav-btn[data-page="${backPage}"]`);
    if (navBtn) {
      navBtn.classList.add('active');
    } else {
      const subBtn = document.querySelector(`.nav-sub-btn[data-page="${backPage}"]`);
      if (subBtn) {
        subBtn.classList.add('active');
      }
    }
  } else {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.nav-sub-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.nav-submenu-group').forEach(g => g.classList.remove('open'));
    document.querySelectorAll('.nav-submenu-toggle').forEach(t => t.classList.remove('active'));
    const navBtn = document.querySelector(`.nav-btn[data-page="${pageName}"]`);
    if (navBtn) {
      navBtn.classList.add('active');
    } else {
      const subBtn = document.querySelector(`.nav-sub-btn[data-page="${pageName}"]`);
      if (subBtn) {
        subBtn.classList.add('active');
        const parentGroup = subBtn.closest('.nav-submenu-group');
        if (parentGroup) {
          parentGroup.classList.add('open');
          const toggle = parentGroup.querySelector('.nav-submenu-toggle');
          if (toggle) toggle.classList.add('active');
        }
      }
    }
  }

  if (pageName === 'modpacks') {
    modDetailHistory = [];
    setTimeout(() => loadResourcePage('modpack'), 100);
  } else if (pageName === 'settings-other') {
    setTimeout(() => refreshMemoryInfo(), 200);
  } else if (pageName === 'datapacks') {
    setTimeout(() => loadResourcePage('datapack'), 100);
  } else if (pageName === 'resourcepacks') {
    setTimeout(() => loadResourcePage('resourcepack'), 100);
  } else if (pageName === 'shaders') {
    setTimeout(() => loadResourcePage('shader'), 100);
  } else if (pageName === 'mods' && modMultiSelectMode) {
    modDetailHistory = [];
    setTimeout(() => {
      document.getElementById('mod-multiselect-bar').style.display = 'flex';
      document.getElementById('mod-multiselect-toggle').classList.add('btn-primary');
      document.getElementById('mod-multiselect-toggle').classList.remove('btn-secondary');
      updateModSelectUI();
      loadMods();
    }, 200);
  } else if (pageName === 'mod-favorites') {
    modDetailHistory = [];
    setupFavSearchListeners();
    setTimeout(function() { renderFavPage(); }, 100);
  } else if (pageName === 'mods') {
    modDetailHistory = [];
  } else if (pageName === 'downloads') {
    dlManager.render();
  }
}

function acceptExperimentalDisclaimer() {
  try { localStorage.setItem('versepc_disclaimer_accepted', '1'); } catch (e) {}
  const disclaimerModal = document.getElementById('experimental-disclaimer-modal');
  if (disclaimerModal) {
    disclaimerModal.classList.remove('modal-visible');
    disclaimerModal.style.display = 'none';
  }
  document.getElementById('page-explore').classList.add('active');
}

function goBackFromDetail() {
  if (modDetailHistory.length > 0) {
    const prev = modDetailHistory.pop();
    _isRestoringModDetail = true;
    openModDetail(prev.id, prev.source);
    _isRestoringModDetail = false;
  } else {
    const backPage = previousPage || 'mods';
    navigateToPage(backPage);
  }
}

function openVersionDetail(versionId, versionUrl, versionType) {
  currentVersionDetail = { id: versionId, url: versionUrl, type: versionType };
  
  navigateToPage('version-detail');
  
  const iconParams = `id=${encodeURIComponent(versionId)}&type=${versionType}`;
  document.getElementById('verdetail-icon').src = `/api/version-icon?${iconParams}&_t=${versionIconsTimestamp}`;
  document.getElementById('verdetail-name').textContent = versionId;
  const typeLabels = { release: '正式版', snapshot: '快照版', special: '愚人节版', old_beta: '旧测试版', old_alpha: '旧内测版' };
  document.getElementById('verdetail-meta').textContent = typeLabels[versionType] || versionType || '正式版';
  
  const selectedSource = document.getElementById('setting-download-source')?.value || 'china-first';
  const selectedRadio = document.querySelector(`input[name="download-source"][value="${selectedSource}"]`);
  if (selectedRadio) selectedRadio.checked = true;
  
  selectedLoaderType = '';
  selectedLoaderVersion = '';
  document.querySelectorAll('.loader-card').forEach(item => item.classList.remove('selected'));
  const emptyLoaderCard = document.querySelector('.loader-card[data-loader=""]');
  if (emptyLoaderCard) emptyLoaderCard.classList.add('selected');
  const loaderVersionSection = document.getElementById('loader-version-section');
  if (loaderVersionSection) loaderVersionSection.style.display = 'none';
  document.getElementById('loader-version-list').innerHTML = '';
  
  loadLoaderVersions(versionId);
}

async function loadLoaderVersions(versionId) {
  const loaders = ['forge', 'neoforge', 'fabric', 'optifine'];
  const mcMajor = parseInt(versionId.split('.')[0], 10);
  const isNewVersioning = mcMajor >= 25;
  for (const loader of loaders) {
    const descEl = document.getElementById(`loader-desc-${loader}`);
    if (!descEl) continue;
    try {
      const versions = await API.getModLoaderVersions(versionId, loader);
      if (versions && versions.length > 0) {
        const latestVer = versions[0].version || versions[0].id || versions[0] || '最新';
        const loaderNames = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', optifine: 'OptiFine' };
        descEl.textContent = `${loaderNames[loader]} ${latestVer} 可用`;
      } else if (isNewVersioning && (loader === 'forge' || loader === 'neoforge')) {
        descEl.textContent = '此版本暂未适配';
      } else if (loader === 'optifine') {
        descEl.textContent = '暂不支持此版本';
      } else {
        descEl.textContent = '暂无可用版本';
      }
    } catch (e) {
      console.error(`[LoaderVersions] ${loader} error:`, e.message);
      if (descEl) descEl.textContent = '加载失败';
    }
  }
}

function selectLoaderCard(loaderType) {
  selectedLoaderType = loaderType;
  
  document.querySelectorAll('.loader-card').forEach(item => item.classList.remove('selected'));
  document.querySelector(`.loader-card[data-loader="${loaderType}"]`).classList.add('selected');
  
  if (loaderType) {
    populateLoaderVersionSelect(loaderType);
  } else {
    document.getElementById('loader-version-section').style.display = 'none';
    selectedLoaderVersion = '';
  }
}

async function populateLoaderVersionSelect(loaderType) {
  const listContainer = document.getElementById('loader-version-list');
  const section = document.getElementById('loader-version-section');

  section.style.display = 'block';
  listContainer.innerHTML = '<p class="empty-text" style="padding:20px 0;text-align:center;color:var(--text-muted)">加载中...</p>';

  const loaderIcons = {
    forge: 'CommandBlock.png',
    neoforge: 'NeoForge.png',
    fabric: 'Fabric.png',
    optifine: 'OptiFabric.png'
  };
  const iconFile = loaderIcons[loaderType] || 'Grass.png';

  try {
    const versions = await API.getModLoaderVersions(currentVersionDetail.id, loaderType);
    
    if (versions && versions.length > 0) {
      const loaderNames = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', optifine: 'OptiFine' };
      const loaderName = loaderNames[loaderType] || loaderType;

      listContainer.innerHTML = versions.map((v, i) => {
        const verStr = v.version || v.id || v;
        const verType = v.type || (i === 0 ? '推荐' : '');
        return `<div class="lver-item ${i === 0 ? 'selected' : ''}" data-version="${escapeHtml(verStr)}" onclick="selectLoaderVersion('${escapeOnclick(verStr)}')">
          <div class="lver-icon"><img src="img/${iconFile}" alt="" style="width:24px;height:24px;image-rendering:pixelated"></div>
          <div class="lver-info">
            <div class="lver-name">${loaderName} ${escapeHtml(verStr)}</div>
            <div class="lver-meta">${verType ? '<span class="lver-badge">' + escapeHtml(verType) + '</span>' : ''}</div>
          </div>
          <div class="lver-check">✓</div>
        </div>`;
      }).join('');

      selectedLoaderVersion = versions[0].version || versions[0].id || versions[0];
    } else {
      listContainer.innerHTML = '<p class="empty-text" style="padding:20px 0;text-align:center;color:var(--text-muted)">暂无可用版本</p>';
      selectedLoaderVersion = '';
    }
  } catch (e) {
    console.error('Loader version load error:', e);
    listContainer.innerHTML = '<p class="empty-text" style="padding:20px 0;text-align:center;color:var(--text-muted)">加载失败</p>';
    selectedLoaderVersion = '';
  }
}

function selectLoaderVersion(version) {
  selectedLoaderVersion = version;
  document.querySelectorAll('.lver-item').forEach(item => item.classList.remove('selected'));
  document.querySelector(`.lver-item[data-version="${version}"]`)?.classList.add('selected');
}

function confirmInstallVersion() {
  if (!currentVersionDetail) return;
  
  const downloadSource = document.querySelector('input[name="download-source"]:checked');
  const source = downloadSource ? downloadSource.value : 'mojang';
  
  let loaderInfo = null;
  if (selectedLoaderType) {
    loaderInfo = {
      type: selectedLoaderType,
      version: selectedLoaderVersion
    };
  }
  
  let defaultName = currentVersionDetail.id;
  if (loaderInfo && loaderInfo.type && loaderInfo.version) {
    const loaderSuffix = loaderInfo.type === 'neoforge' ? 'NeoForge' : 
              loaderInfo.type.charAt(0).toUpperCase() + loaderInfo.type.slice(1);
    defaultName = `${currentVersionDetail.id}-${loaderSuffix}-${loaderInfo.version}`;
  }
  
  showVersionNameModal(defaultName, currentVersionDetail.url, currentVersionDetail.id, loaderInfo, source);
}

async function installVersionWithLoader(versionUrl, versionId, loaderInfo, downloadSource, customName = '') {
  try {
    const result = await API.installVersion(versionUrl, versionId, loaderInfo, downloadSource, customName);
    if (result.success) {
      currentInstallSessionId = result.sessionId;
      showInstallModal(versionId);
      pollInstallProgress(result.sessionId);
    } else if (result.alreadyInstalled) {
      showToast(result.message || `版本 ${versionId} 已安装`, 'info');
    } else {
      showToast(result.error || '安装失败', 'error');
    }
  } catch (e) {
    showToast('安装请求失败', 'error');
  }
}

async function installVersion(versionUrl, versionId) {
  try {
    const result = await API.installVersion(versionUrl, versionId);
    if (result.success) {
      currentInstallSessionId = result.sessionId;
      showInstallModal(versionId);
      pollInstallProgress(result.sessionId);
    } else if (result.alreadyInstalled) {
      showToast(result.message || `版本 ${versionId} 已安装`, 'info');
    } else {
      showToast(result.error || '安装失败', 'error');
    }
  } catch (e) {
    showToast('安装请求失败', 'error');
  }
}

function showVersionNameModal(defaultName, versionUrl, versionId, loaderInfo, downloadSource) {
  const existing = document.getElementById('version-name-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'version-name-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';

  const card = document.createElement('div');
  card.style.cssText = 'max-width:420px;width:90%;background:var(--bg-secondary);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden;';

  card.innerHTML = `
    <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
      <span style="font-size:15px;font-weight:600;color:var(--text-primary);">设置版本名称</span>
      <button id="vnm-close" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:18px;padding:4px;">✕</button>
    </div>
    <div style="padding:20px;">
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:13px;color:var(--text-secondary);margin-bottom:6px;">版本名称</label>
        <input id="vnm-input" type="text" value="${defaultName.replace(/"/g, '&quot;')}" 
          style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-primary);color:var(--text-primary);font-size:14px;outline:none;box-sizing:border-box;" />
        <div id="vnm-hint" style="margin-top:6px;font-size:12px;color:var(--text-muted);"></div>
      </div>
      <div id="vnm-warn" style="display:none;padding:10px 12px;border-radius:8px;background:rgba(255,193,7,0.1);border:1px solid rgba(255,193,7,0.3);margin-bottom:12px;">
        <span style="font-size:13px;color:#e6a817;">⚠ 已有相同名称的版本</span>
      </div>
    </div>
    <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px;">
      <button id="vnm-cancel" style="padding:8px 20px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-primary);cursor:pointer;font-size:13px;">取消</button>
      <button id="vnm-confirm" style="padding:8px 20px;border-radius:8px;border:none;background:var(--accent);color:#fff;cursor:pointer;font-size:13px;font-weight:500;">确认安装</button>
    </div>
  `;

  modal.appendChild(card);
  document.body.appendChild(modal);

  const input = document.getElementById('vnm-input');
  const hint = document.getElementById('vnm-hint');
  const warn = document.getElementById('vnm-warn');
  const confirmBtn = document.getElementById('vnm-confirm');
  let nameExists = false;

  async function checkName() {
    const name = input.value.trim();
    if (!name) {
      hint.textContent = '';
      warn.style.display = 'none';
      confirmBtn.disabled = true;
      return;
    }
    try {
      const result = await API.checkVersionName(name);
      nameExists = result.exists;
      if (nameExists) {
        warn.style.display = 'block';
        hint.textContent = '';
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
        confirmBtn.style.cursor = 'not-allowed';
      } else {
        warn.style.display = 'none';
        hint.textContent = '✓ 名称可用';
        confirmBtn.disabled = false;
        confirmBtn.style.opacity = '1';
        confirmBtn.style.cursor = 'pointer';
      }
    } catch (e) {
      warn.style.display = 'none';
      confirmBtn.disabled = false;
      confirmBtn.style.opacity = '1';
      confirmBtn.style.cursor = 'pointer';
    }
  }

  input.addEventListener('input', checkName);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
  });

  document.getElementById('vnm-close').onclick = () => modal.remove();
  document.getElementById('vnm-cancel').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  confirmBtn.onclick = async () => {
    const name = input.value.trim();
    if (!name || confirmBtn.disabled) return;
    
    modal.remove();
    navigateToPage('versions');
    
    setTimeout(() => {
      installVersionWithLoader(versionUrl, versionId, loaderInfo, downloadSource, name);
    }, 200);
  };

  checkName();
  input.focus();
  input.select();
}

function showInstallModal(versionId) {
  const taskId = 'version-' + currentInstallSessionId;
  dlManager.add(taskId, `安装 ${versionId}`, 'version', currentInstallSessionId,
    versionId ? `/api/version-icon?id=${encodeURIComponent(versionId)}&type=release` : '');
  navigateToPage('downloads');
}

function closeInstallModal() {
  if (currentInstallSessionId) {
    API.cancelInstall(currentInstallSessionId);
    currentInstallSessionId = null;
  }
}

function cancelInstall() {
  closeInstallModal();
  showToast('安装已取消', 'info');
}

async function pollInstallProgress(sessionId) {
  const taskId = 'version-' + sessionId;
  let smoothInstallPct = 0;

  const poll = async () => {
    try {
      if (!dlManager.tasks.has(taskId)) return;
      const data = await API.getInstallProgress(sessionId);
      if (!data || !data.sessionId) return;

      const rawPct = data.progress || 0;
      if (rawPct > smoothInstallPct) {
        smoothInstallPct = smoothInstallPct * 0.85 + rawPct * 0.15;
      }
      const smoothPct = Math.round(smoothInstallPct);

      const downloadStatus = data.status === 'completed' ? 'completed' : data.status === 'failed' ? 'failed' : data.status === 'cancelled' ? 'failed' : 'downloading';
      const statusMessage = getStageText(data.stage) || data.message || '安装中...';

      var files = [];
      if (data.currentFile) {
        var speedText = data.speed ? formatBytes(data.speed) + '/s' : '';
        files.push({
          name: '当前文件: ' + data.currentFile,
          progress: downloadStatus === 'completed' ? 100 : (data.totalFiles ? Math.round(data.completedFiles / data.totalFiles * 100) : smoothPct),
          status: downloadStatus,
          size: speedText
        });
      }
      if (data.totalFiles > 0) {
        files.push({
          name: '文件进度: ' + data.completedFiles + ' / ' + data.totalFiles,
          progress: Math.round(data.completedFiles / data.totalFiles * 100),
          status: downloadStatus
        });
      }
      if (data.bytesDownloaded > 0 || data.totalBytes > 0) {
        var dlText = formatBytes(data.bytesDownloaded || 0);
        if (data.totalBytes) dlText += ' / ' + formatBytes(data.totalBytes);
        files.push({
          name: '下载量: ' + dlText,
          progress: data.totalBytes ? Math.round(data.bytesDownloaded / data.totalBytes * 100) : 0,
          status: downloadStatus
        });
      }
      if (data.stage) {
        files.push({
          name: '当前阶段: ' + (getStageText(data.stage) || data.stage),
          progress: downloadStatus === 'completed' ? 100 : smoothPct,
          status: data.stage === 'completed' ? 'completed' : downloadStatus
        });
      }

      dlManager.update(taskId, {
        progress: smoothPct,
        status: downloadStatus,
        message: statusMessage,
        files: files
      });

      if (data.status === 'completed') {
        showToast(data.versionId + ' 安装完成！', 'success');
        currentInstallSessionId = null;
        await loadVersions(true);
        return;
      }
      if (data.status === 'failed') {
        showToast('安装失败: ' + (data.message || '未知错误'), 'error');
        currentInstallSessionId = null;
        return;
      }
      if (data.status === 'cancelled') { currentInstallSessionId = null; return; }
      setTimeout(poll, 500);
    } catch (e) {
      if (dlManager.tasks.has(taskId)) setTimeout(poll, 1000);
    }
  };
  poll();
}

function getStageText(stage) {
  const map = {
    'preparing': '准备中...',
    'version_json': '下载版本信息...',
    'client_jar': '下载游戏客户端...',
    'libraries': '下载依赖库...',
    'assets': '下载资源文件...',
    'natives': '提取原生库...',
    'finalizing': '完成安装...',
    'loader': '安装模组加载器...',
    'fabric-api': '下载 Fabric API...',
    'completed': '安装完成',
    'failed': '安装失败',
    'cancelled': '已取消'
  };
  return map[stage] || stage || '';
}

let _shiftKeyDown = false;
document.addEventListener('keydown', (e) => { if (e.key === 'Shift') _shiftKeyDown = true; });
document.addEventListener('keyup', (e) => { if (e.key === 'Shift') _shiftKeyDown = false; });

async function deleteVersion(versionId) {
  const isExternal = versionId.includes(' [外部');
  const ver = installedVersions.find(v => v.id === versionId);
  const isPermanent = !isExternal && _shiftKeyDown;
  let warningParts = [];
  if (ver?.hasMods) warningParts.push('模组');
  if (ver?.hasSaves) warningParts.push('存档');
  if (ver?.hasResourcepacks) warningParts.push('资源包');
  let confirmMsg = isExternal
    ? `确定要从列表中移除 ${versionId} 吗？\n（不会删除实际游戏文件）`
    : isPermanent
      ? `确定要永久删除版本 ${versionId} 吗？\n（无法恢复）`
      : `确定要删除版本 ${versionId} 吗？\n（将移入回收站）`;

  if (warningParts.length > 0) {
    confirmMsg += `\n\n⚠ 由于该版本开启了版本隔离，删除版本时该版本对应的${warningParts.join('、')}等文件也将被一并删除！`;
  }

  const confirmed = await showConfirmDialog(isExternal ? '移除外部版本' : isPermanent ? '永久删除' : '版本删除确认', confirmMsg, isExternal ? '移除' : isPermanent ? '永久删除' : '删除', '取消');
  if (!confirmed) return;
  try {
    const r = await API.deleteVersion(versionId, isPermanent);
    if (r.success) {
      showToast(`版本 ${versionId} 已${isPermanent ? '永久删除' : '删除'}`, 'success');
      await loadVersions(true);
    } else {
      showToast(r.error || '删除失败', 'error');
    }
  } catch (e) { showToast('删除失败', 'error'); }
}

let pendingExternalFolderPath = '';

async function addExternalFolder() {
  document.getElementById('external-folder-path').value = '';
  document.getElementById('external-folder-name').value = '';
  document.getElementById('external-folder-preview').style.display = 'none';
  document.getElementById('external-folder-error').style.display = 'none';
  document.getElementById('external-folder-confirm-btn').disabled = true;
  pendingExternalFolderPath = '';
  showModal('external-folder-modal');
}

function closeExternalFolderModal() {
  hideModal('external-folder-modal');
  pendingExternalFolderPath = '';
}

async function selectExternalFolderPath() {
  try {
    const result = await API.selectExternalFolder();
    if (result.success && result.path) {
      document.getElementById('external-folder-path').value = result.path;
      pendingExternalFolderPath = result.path;
      document.getElementById('external-folder-error').style.display = 'none';
      document.getElementById('external-folder-confirm-btn').disabled = false;
    }
  } catch (e) {
    console.error('Select external folder error:', e);
  }
}

async function confirmAddExternalFolder() {
  const folderPath = document.getElementById('external-folder-path').value || pendingExternalFolderPath;
  const folderName = document.getElementById('external-folder-name').value.trim();
  if (!folderPath) {
    showToast('请先选择文件夹', 'error');
    return;
  }
  const confirmBtn = document.getElementById('external-folder-confirm-btn');
  confirmBtn.disabled = true;
  confirmBtn.textContent = '添加中...';
  try {
    const result = await API.addExternalFolder(folderPath, folderName);
    if (result.success) {
      showToast(`已添加文件夹，发现 ${result.versions.length} 个版本`, 'success');
      if (result.versions && result.versions.length > 0) {
        const listHtml = result.versions.map(v => {
          let typeLabel = '原版';
          if (v.isFabric) typeLabel = 'Fabric';
          else if (v.isForge) typeLabel = 'Forge';
          else if (v.isNeoForge) typeLabel = 'NeoForge';
          return `<div style="padding:4px 0;display:flex;align-items:center;gap:8px"><span style="color:var(--text-primary)">${v.id}</span><span style="color:var(--text-muted);font-size:12px;padding:2px 6px;border-radius:4px;background:var(--bg-tertiary)">${typeLabel}</span></div>`;
        }).join('');
        document.getElementById('external-folder-versions-list').innerHTML = listHtml;
        document.getElementById('external-folder-preview').style.display = 'block';
      }
      setTimeout(() => {
        closeExternalFolderModal();
        loadVersions(true);
      }, 1500);
    } else {
      document.getElementById('external-folder-error').textContent = result.error || '添加失败';
      document.getElementById('external-folder-error').style.display = 'block';
    }
  } catch (e) {
    document.getElementById('external-folder-error').textContent = '添加失败: ' + e.message;
    document.getElementById('external-folder-error').style.display = 'block';
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = '添加';
  }
}

function openModLoaderModal(gameVersion) {
  showModal('modloader-modal');

  if (!modloaderGameVersionCustomSelect) {
    modloaderGameVersionCustomSelect = new CustomSelect('modloader-game-version-wrapper', {
      onChange: () => loadModLoaderVersions()
    });
  }

  const installedBase = installedVersions.filter(v => !v.isFabric && !v.isForge && !v.isNeoForge);
  const versions = installedBase.length > 0 ? installedBase : allVersions.filter(v => v.type === 'release').slice(0, 20);

  const options = versions.map(v => ({
    value: v.id,
    text: v.id
  }));

  modloaderGameVersionCustomSelect.setOptions(options);

  if (gameVersion && options.find(o => o.value === gameVersion)) {
    modloaderGameVersionCustomSelect.setValue(gameVersion);
  }

  loadModLoaderVersions();
  document.getElementById('modloader-install-btn').onclick = installModLoader;
}

function closeModLoaderModal() {
  hideModal('modloader-modal');
}

async function loadModLoaderVersions() {
  const gameVersion = modloaderGameVersionCustomSelect ? modloaderGameVersionCustomSelect.getValue() : '';

  if (!modloaderVersionCustomSelect) {
    modloaderVersionCustomSelect = new CustomSelect('modloader-version-wrapper');
  }

  modloaderVersionCustomSelect.setOptions([{ value: '', text: '加载中...' }]);
  try {
    if (currentLoaderType === 'fabric') {
      const versions = await API.getModLoaderVersions(gameVersion, 'fabric');
      const options = versions.map(v => ({
        value: v.version,
        text: `${v.version} ${v.stable ? '(稳定)' : ''}`
      }));
      modloaderVersionCustomSelect.setOptions(options);
      const stable = versions.find(v => v.stable);
      if (stable) modloaderVersionCustomSelect.setValue(stable.version);
    } else if (currentLoaderType === 'forge') {
      const versions = await API.getModLoaderVersions(gameVersion, 'forge');
      const options = versions.map(v => ({
        value: v.version,
        text: `${v.version} (${v.type})`
      }));
      modloaderVersionCustomSelect.setOptions(options);
    } else if (currentLoaderType === 'neoforge') {
      const versions = await API.getModLoaderVersions(gameVersion, 'neoforge');
      const options = versions.map(v => ({
        value: v.version,
        text: `${v.version} ${v.type ? '(' + v.type + ')' : ''}`
      }));
      modloaderVersionCustomSelect.setOptions(options);
      if (versions.length > 0) modloaderVersionCustomSelect.setValue(versions[0].version);
    }
  } catch (e) { modloaderVersionCustomSelect.setOptions([{ value: '', text: '加载失败' }]); }
}

async function installModLoader() {
  const gameVersion = modloaderGameVersionCustomSelect ? modloaderGameVersionCustomSelect.getValue() : '';
  const loaderVersion = modloaderVersionCustomSelect ? modloaderVersionCustomSelect.getValue() : '';
  if (!gameVersion) { showToast('请选择游戏版本', 'error'); return; }
  try {
    let result;
    const loaderNames = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
    if (currentLoaderType === 'fabric') {
      result = await API.installFabric(gameVersion, loaderVersion);
    } else if (currentLoaderType === 'forge') {
      if (!loaderVersion) { showToast('请选择Forge版本', 'error'); return; }
      result = await API.installForge(gameVersion, loaderVersion);
    } else if (currentLoaderType === 'neoforge') {
      if (!loaderVersion) { showToast('请选择NeoForge版本', 'error'); return; }
      result = await API.installNeoForge(gameVersion, loaderVersion);
    } else {
      showToast('不支持的加载器类型', 'error');
      return;
    }
    if (result.success) {
      let installedId = result.versionId;
      if (!installedId) {
        if (currentLoaderType === 'fabric') installedId = `fabric-loader-${loaderVersion}-${gameVersion}`;
        else if (currentLoaderType === 'forge') installedId = `${gameVersion}-forge-${loaderVersion}`;
        else if (currentLoaderType === 'neoforge') installedId = `${gameVersion}-neoforge-${loaderVersion}`;
        else installedId = `${gameVersion}-${currentLoaderType}-${loaderVersion}`;
      }
      showToast(`${loaderNames[currentLoaderType] || currentLoaderType} 安装成功！`, 'success');
      closeModLoaderModal();
      await loadVersions(true);
      if (launchVersionCustomSelect) {
        launchVersionCustomSelect.setValue(installedId);
        _cachedLastLaunchVersion = installedId;
        try { window.electronAPI.store.set('versepc_last_launch_version', installedId); } catch (_) {}
      }
    } else {
      showToast(result.error || '安装失败', 'error');
    }
  } catch (e) { showToast('安装失败', 'error'); }
}
