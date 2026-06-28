const resourceState = {
    modpack: { offset: 0, total: 0, query: '' },
    datapack: { offset: 0, total: 0, query: '' },
    resourcepack: { offset: 0, total: 0, query: '' },
    shader: { offset: 0, total: 0, query: '' },
};

const typeNames = {
    modpack: '整合包', datapack: '数据包',
    resourcepack: '材质包', shader: '光影包'
};

const typeIcons = {
    modpack: '📦', datapack: '🗄️',
    resourcepack: '🎨', shader: '☀️'
};

function getImportStageText(msg) {
    if (!msg) return '处理中...';
    if (msg.includes('download') || msg.includes('下载')) return '下载整合包内容...';
    if (msg.includes('read') || msg.includes('读取') || msg.includes('分析')) return '分析整合包...';
    if (msg.includes('mod') || msg.includes('模组')) return '下载整合包模组...';
    if (msg.includes('override') || msg.includes('配置')) return '解压整合包配置...';
    if (msg.includes('install') || msg.includes('安装')) return '安装整合包...';
    return msg;
}

async function importModpackFromFile() {
    if (window._modpackImporting) {
        showToast('整合包正在导入中，请等待完成', 'warning');
        return;
    }
    try {
        const result = await API.selectModpackFile();
        if (result && result.filePath) {
            const filePath = result.filePath;
            console.log(`[Modpack][前端] 选择文件: ${filePath}`);
            window._modpackImporting = true;
            try {
                if (typeof dlManager !== 'undefined') {
                    const sessionId = 'local-modpack-' + Date.now();
                    const taskId = 'modpack-' + sessionId;
                    dlManager.add(taskId, result.name || '整合包导入', 'modpack', sessionId, '');
                    navigateToPage('downloads');
                    if (window.electronAPI?.onImportProgress) {
                        if (window.electronAPI.removeImportProgressListener) window.electronAPI.removeImportProgressListener();
                        window.electronAPI.onImportProgress(function (data) {
                            const stageText = getImportStageText(data.message);
                            let speedText = '';
                            if (data.files && data.files.length > 0) {
                                let totalSpeed = 0;
                                let activeCount = 0;
                                for (const f of data.files) {
                                    if (f.s === 'downloading' && f.sp > 0) { totalSpeed += f.sp; activeCount++; }
                                }
                                if (totalSpeed > 0) {
                                    const speedMB = (totalSpeed / 1024 / 1024).toFixed(1);
                                    const speedKB = (totalSpeed / 1024).toFixed(0);
                                    speedText = totalSpeed > 1024 * 1024 ? ` | ${speedMB} MB/s` : ` | ${speedKB} KB/s`;
                                }
                            }
                            console.log(`[Modpack][前端] 进度: ${data.stage} ${data.progress}% ${data.message}` + (data.stageHistory ? ` (阶段数: ${data.stageHistory.length})` : ''));
                            dlManager.update(taskId, {
                                progress: data.progress || 0,
                                status: 'downloading',
                                message: stageText + speedText,
                                stageHistory: data.stageHistory || []
                            });
                        });
                    }
                    showToast('正在导入整合包...', 'info');
                    console.log(`[Modpack][前端] 调用 IPC importModpack...`);
                    const importResult = await window.electronAPI.importModpack(filePath, '');
                    console.log(`[Modpack][前端] IPC 返回:`, importResult?.success ? '成功' : '失败', importResult?.error || '');
                    if (importResult && importResult.success) {
                        dlManager.update(taskId, { status: 'completed', progress: 100, message: '导入完成' });
                        showToast(`整合包 "${importResult.name || '未知'}" 导入成功！`, 'success');
                    } else {
                        dlManager.update(taskId, { status: 'failed', progress: 100, message: importResult?.error || '未知错误', stageHistory: importResult?.stageHistory || [] });
                        showToast(`导入失败: ${importResult?.error || '未知错误'}`, 'error');
                    }
                } else {
                    navigateToPage('downloads');
                    showToast('正在导入整合包...', 'info');
                    const importResult = await window.electronAPI.importModpack(filePath, '');
                    if (importResult && importResult.success) {
                        showToast(`整合包 "${importResult.name || '未知'}" 导入成功！`, 'success');
                    } else {
                        showToast(`导入失败: ${importResult?.error || '未知错误'}`, 'error');
                    }
                }
            } finally {
                window._modpackImporting = false;
            }
        }
    } catch (e) {
        showToast('导入失败: ' + (e.message || ''), 'error');
    }
}

document.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (window._modpackImporting) return;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    const name = (file.name || '').toLowerCase();
    const isModpackFile = name.endsWith('.mrpack') || name.endsWith('.cursemodpack') || name.endsWith('.zip');
    if (isModpackFile) {
        let filePath = file.path;
        if (!filePath && window.electronAPI?.getDroppedFilePath) {
            filePath = window.electronAPI.getDroppedFilePath(file);
        }
        if (filePath) {
            window._modpackImporting = true;
            if (typeof dlManager !== 'undefined') {
                const sessionId = 'local-modpack-' + Date.now();
                const taskId = 'modpack-' + sessionId;
                dlManager.add(taskId, name || '整合包导入', 'modpack', sessionId, '');
                navigateToPage('downloads');
                if (window.electronAPI?.onImportProgress) {
                    if (window.electronAPI.removeImportProgressListener) window.electronAPI.removeImportProgressListener();
                    window.electronAPI.onImportProgress(function (data) {
                        const stageText = getImportStageText(data.message);
                        dlManager.update(taskId, {
                            progress: data.progress || 0,
                            status: 'downloading',
                            message: stageText
                        });
                    });
                }
                showToast('正在导入整合包...', 'info');
                window.electronAPI.importModpack(filePath, '').then(result => {
                    window._modpackImporting = false;
                    if (result && result.success) {
                        dlManager.update(taskId, { status: 'completed', progress: 100, message: '导入完成' });
                        showToast(`整合包 "${result.name || '未知'}" 导入成功！`, 'success');
                    } else {
                        dlManager.update(taskId, { status: 'error', message: result?.error || '未知错误' });
                        showToast(`导入失败: ${result?.error || '未知错误'}`, 'error');
                    }
                }).catch(err => {
                    window._modpackImporting = false;
                    dlManager.update(taskId, { status: 'error', message: err.message || '' });
                    showToast('导入失败: ' + (err.message || ''), 'error');
                });
            } else {
                navigateToPage('downloads');
                showToast('正在导入整合包...', 'info');
                window.electronAPI.importModpack(filePath, '').then(result => {
                    window._modpackImporting = false;
                    if (result && result.success) {
                        showToast(`整合包 "${result.name || '未知'}" 导入成功！`, 'success');
                    } else {
                        showToast(`导入失败: ${result?.error || '未知错误'}`, 'error');
                    }
                }).catch(err => {
                    window._modpackImporting = false;
                    showToast('导入失败: ' + (err.message || ''), 'error');
                });
            }
        }
    }
});

function loadResourcePage(type) {
    const state = resourceState[type];
    state.offset = 0;
    state.query = '';
    loadResourceList(type);
    setupResourceEvents(type);
}

function setupResourceEvents(type) {
    const searchInput = document.getElementById(`${type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack'}-search-input`);
    const searchBtn = document.getElementById(`${type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack'}-search-btn`);
    const prevBtn = document.getElementById(`${type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack'}-prev-btn`);
    const nextBtn = document.getElementById(`${type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack'}-next-btn`);

    const prefix = type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack';

    if (searchBtn && !searchBtn._bound) {
        searchBtn._bound = true;
        searchBtn.addEventListener('click', () => {
            resourceState[type].query = searchInput.value.trim();
            resourceState[type].offset = 0;
            loadResourceList(type);
        });
    }
    if (searchInput && !searchInput._bound) {
        searchInput._bound = true;
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                resourceState[type].query = searchInput.value.trim();
                resourceState[type].offset = 0;
                loadResourceList(type);
            }
        });
    }
    if (prevBtn && !prevBtn._bound) {
        prevBtn._bound = true;
        prevBtn.addEventListener('click', () => {
            if (resourceState[type].offset >= 15) {
                resourceState[type].offset -= 15;
                loadResourceList(type);
            }
        });
    }
    if (nextBtn && !nextBtn._bound) {
        nextBtn._bound = true;
        nextBtn.addEventListener('click', () => {
            resourceState[type].offset += 15;
            loadResourceList(type);
        });
    }

    const loaderInstance = customSelectInstances[`${prefix}-filter-loader`];
    const versionInstance = customSelectInstances[`${prefix}-filter-version`];
    if (loaderInstance && !loaderInstance._resourceBound) {
        loaderInstance._resourceBound = true;
        loaderInstance.onChange = () => {
            resourceState[type].offset = 0;
            loadResourceList(type);
        };
    }
    if (versionInstance && !versionInstance._resourceBound) {
        versionInstance._resourceBound = true;
        const origOnChange = versionInstance.onChange;
        versionInstance.onChange = () => {
            if (origOnChange) origOnChange();
            resourceState[type].offset = 0;
            loadResourceList(type);
        };
    }
    if (type === 'resourcepack') {
        const resolutionInstance = customSelectInstances['resourcepack-filter-resolution'];
        if (resolutionInstance && !resolutionInstance._resourceBound) {
            resolutionInstance._resourceBound = true;
            resolutionInstance.onChange = () => {
                resourceState[type].offset = 0;
                loadResourceList(type);
            };
        }
    }
}

async function loadResourceList(type) {
    const prefix = type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'datapack' ? 'datapack' : 'modpack';
    const container = document.getElementById(`${prefix}-browse-list`);
    if (!container) return;
    container.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><p>正在获取${typeNames[type] || '资源'}列表...</p></div>`;

    const state = resourceState[type];
    const loader = getCustomSelectValue(`${prefix}-filter-loader`);
    const version = getCustomSelectValue(`${prefix}-filter-version`);
    const resolution = type === 'resourcepack' ? getCustomSelectValue('resourcepack-filter-resolution') : '';

    try {
        const data = await API.searchResources(state.query, type, loader, version, resolution, 'downloads', 15, state.offset);
        const hits = data.hits || [];
        state.total = data.total || 0;
        hits.forEach(item => _projectDataCache.set(item.id, item));

        if (hits.length === 0) {
            if (state.query) {
                container.innerHTML = `<p class="empty-text">暂无匹配的${typeNames[type]}</p><p class="empty-hint">试试其他关键词吧</p>`;
            } else {
                container.innerHTML = `<p class="empty-text">暂无${typeNames[type]}</p>`;
            }
        } else {
            container.innerHTML = hits.map(item => `
                <div class="mod-item mod-item-clickable" onclick="openResourceDetail('${item.id}', '${type}')" onmouseenter="preloadModVersions('${item.id}', 'modrinth')">
                    ${item.icon ? `<div class="mod-icon"><img src="${item.icon}" alt="" onerror="this.parentElement.remove()"></div>` : ''}
                    <div class="mod-info">
                        <div class="mod-name">${escapeHtml(formatModNameWithChinese(item.slug || item.id, item.title))}</div>
                        <div class="mod-desc">${escapeHtml(item.description)}</div>
                        <div class="mod-meta">
                            <span>⬇ ${formatNumber(item.downloads)}</span>
                            <span>❤ ${escapeHtml(item.author)}</span>
                            <span>${(item.categories || []).slice(0, 3).join(', ')}</span>
                        </div>
                    </div>
                    <div class="mod-actions" onclick="event.stopPropagation()">
                        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openResourceDetail('${item.id}', '${type}')">安装</button>
                    </div>
                </div>
            `).join('');
        }

        const pageInfo = document.getElementById(`${prefix}-page-info`);
        const totalPages = Math.max(1, Math.ceil(state.total / 15));
        const currentPage = Math.floor(state.offset / 15) + 1;
        if (pageInfo) pageInfo.textContent = `${currentPage}/${totalPages}`;
    } catch (e) {
        container.innerHTML = `<p class="empty-text">加载失败</p><button class="btn btn-secondary btn-sm" onclick="loadResourceList('${type}')" style="margin-top:8px">重试</button>`;
    }
}

async function openResourceDetail(projectId, type) {
    currentModDetailId = projectId;
    currentModDetailSource = 'modrinth';
    currentModDetailType = type;

    navigateToPage('mod-detail');

    const depsSection = document.getElementById('md-deps-section');
    if (depsSection) depsSection.style.display = 'none';
    if (type !== 'mod' && modMultiSelectMode) {
        modMultiSelectMode = false;
    }
    mdCurrentDeps = [];
    mdDepsResolved = {};
    mdDepsVersionInfo = {};

    const backBtn = document.querySelector('#page-mod-detail .moddetail-page-header .btn-icon');
    if (backBtn) {
        const pageMap = { mod: 'mods', modpack: 'modpacks', datapack: 'datapacks', resourcepack: 'resourcepacks', shader: 'shaders' };
        backBtn.setAttribute('onclick', `navigateToPage('${pageMap[type] || 'mods'}')`);
    }

    const mdName = document.getElementById('md-name');
    const mdDesc = document.getElementById('md-desc');
    const mdIconImg = document.getElementById('md-icon-img');
    const mdIconFallback = document.getElementById('md-icon-fallback');
    const mdVersionList = document.getElementById('md-version-list');
    const mdVersionTabs = document.getElementById('md-version-tabs');

    if (!mdName || !mdVersionList) return;

    // 立即清空旧内容，防止切换整合包时短暂显示上一个整合包的版本列表
    mdVersionList.innerHTML = '';
    if (mdVersionTabs) mdVersionTabs.innerHTML = '';

    // 竞态保护：记录本次请求的 ID，API 返回时检查是否仍是最新的
    const _reqId = projectId;

    const typeNames = { mod: '模组', modpack: '整合包', resourcepack: '材质包', shader: '光影包', datapack: '数据包' };
    const typeIcons = { mod: '🧩', modpack: '📦', resourcepack: '🎨', shader: '✨', datapack: '📊' };

    const cached = _projectDataCache.get(projectId);
    if (cached) {
        console.log('[ResDetail] Cache hit, rendering immediately');
        currentModDetailData = cached;
        mdName.textContent = formatModNameWithChinese(cached.slug || cached.id, cached.title || typeNames[type] || '未知');
        if (mdDesc) mdDesc.textContent = (cached.description || '').substring(0, 200);
        if (cached.icon && mdIconImg && mdIconFallback) { mdIconImg.src = cached.icon; mdIconImg.style.display = ''; mdIconFallback.style.display = 'none'; }
        const mdDownloads = document.getElementById('md-downloads');
        const mdFollowers = document.getElementById('md-followers');
        if (mdDownloads) mdDownloads.textContent = `⬇ ${formatNumber(cached.downloads || 0)}`;
        if (mdFollowers) mdFollowers.textContent = `❤ ${formatNumber(cached.followers || 0)}`;
        const srcBadge = document.getElementById('md-source-badge');
        if (srcBadge) { srcBadge.textContent = typeNames[type] || type; srcBadge.style.color = '#f59e0b'; srcBadge.style.background = 'rgba(245,158,11,0.12)'; }
    } else {
        mdName.textContent = '加载中...';
    }

    const _hasPreloaded = _versionPreloadCache.has(projectId);
    let _resLoadingTimer = null;
    if (!_hasPreloaded) {
        _resLoadingTimer = setTimeout(() => {
            if (mdVersionList && !mdVersionList.querySelector('.mdv-group')) {
                mdVersionList.innerHTML = '<p class="empty-text" style="padding:30px 0;text-align:center;color:var(--text-muted)">加载版本列表...</p>';
            }
        }, 400);
    }
    if (mdVersionTabs) mdVersionTabs.innerHTML = '';

    try {
        const versionsPromise = _hasPreloaded
            ? Promise.resolve(_versionPreloadCache.get(projectId))
            : API.getModVersions(projectId, 'modrinth').catch(e => { console.error('[ResDetail] getModVersions failed:', e); return null; });
        _versionPreloadCache.delete(projectId);
        const detailPromise = cached ? Promise.resolve(cached) : API.getModDetail(projectId, 'modrinth').catch(e => { console.error('[ResDetail] getModDetail failed:', e); return null; });

        const [detail, data] = await Promise.all([detailPromise, versionsPromise]);
        if (_resLoadingTimer) { clearTimeout(_resLoadingTimer); _resLoadingTimer = null; }
        // 竞态保护：如果在等待 API 期间用户已经打开了另一个整合包，丢弃本次结果
        if (currentModDetailId !== _reqId) { console.log(`[ResDetail] 请求 ${_reqId} 已过期，当前 ${currentModDetailId}，跳过渲染`); return; }
        if (!detail) {
            mdName.textContent = '加载失败';
            mdVersionList.innerHTML = `<p class="empty-text" style="padding:30px 0;text-align:center;color:var(--text-muted)">无法加载详情: API请求失败，请检查网络连接</p>`;
            return;
        }
        if (!cached) {
            _projectDataCache.set(projectId, detail);
            currentModDetailData = detail;
            mdName.textContent = formatModNameWithChinese(detail.slug || detail.id, detail.title || typeNames[type] || '未知');
            if (mdDesc) mdDesc.textContent = (detail.description || '').substring(0, 200);
            if (detail.icon && mdIconImg && mdIconFallback) { mdIconImg.src = detail.icon; mdIconImg.style.display = ''; mdIconFallback.style.display = 'none'; }
            const mdDownloads = document.getElementById('md-downloads');
            const mdFollowers = document.getElementById('md-followers');
            if (mdDownloads) mdDownloads.textContent = `⬇ ${formatNumber(detail.downloads || 0)}`;
            if (mdFollowers) mdFollowers.textContent = `❤ ${formatNumber(detail.followers || 0)}`;
            const srcBadge = document.getElementById('md-source-badge');
            if (srcBadge) { srcBadge.textContent = typeNames[type] || type; srcBadge.style.color = '#f59e0b'; srcBadge.style.background = 'rgba(245,158,11,0.12)'; }
        }

        mdAllVersions = data ? (data.versions || []) : [];
        if (!Array.isArray(mdAllVersions)) mdAllVersions = [];

        const currentGameVersion = getCustomSelectValue('mod-filter-version') || '';
        const currentLoader = getCustomSelectValue('mod-filter-loader') || '';

        if (currentGameVersion || currentLoader) {
            const filtered = mdAllVersions.filter(v => {
                const gv = v.gameVersions || [];
                const loaders = (v.loaders || []).map(l => l.toLowerCase());
                let match = true;
                if (currentGameVersion && !gv.includes(currentGameVersion)) match = false;
                if (currentLoader && !loaders.includes(currentLoader.toLowerCase())) match = false;
                return match;
            });
            renderMdVersionList(filtered);
            
            if (mdVersionTabs) {
                mdVersionTabs.innerHTML = `<button class="md-vtab active" data-ver="_filtered" onclick="switchMdVersionTab('_filtered')">筛选结果 (${filtered.length})</button><button class="md-vtab" data-ver="" onclick="switchMdVersionTab('')">全部 (${mdAllVersions.length})</button>`;
            }
        } else {
            const tabsContainer = document.getElementById('md-version-tabs');
            const gameVersions = new Set();
            mdAllVersions.forEach(v => {
                (v.gameVersions || []).forEach(gv => gameVersions.add(gv));
            });

            let tabsHtml = '<button class="md-vtab active" data-ver="" onclick="switchMdVersionTab(\'\')">全部</button>';
            [...gameVersions].sort().reverse().forEach(gv => {
                tabsHtml += `<button class="md-vtab" data-ver="${escapeHtml(gv)}" onclick="switchMdVersionTab('${escapeOnclick(gv)}')">${escapeHtml(gv)}</button>`;
            });
            if (tabsContainer) tabsContainer.innerHTML = tabsHtml;
            
            renderMdVersionList(mdAllVersions);
        }
    } catch (e) {
        mdName.textContent = '加载失败';
        mdVersionList.innerHTML = `<p class="empty-text" style="padding:30px 0;text-align:center;color:var(--text-muted)">无法加载详情: ${e.message || e}</p>`;
    }
}

// 全局变量：当前整合包详情的目标版本
async function quickInstallResource(projectId, type) {
    if (type === 'modpack') {
        showToast('正在下载整合包，将创建为新版本...', 'info');
        try {
            const result = await API.downloadResource('', projectId, type, '');
            if (result.success) {
                showModpackInstallModal(result.fileName, result.sessionId);
            } else {
                showToast(result.error || '安装失败', 'error');
            }
        } catch (e) {
            showToast('安装失败', 'error');
        }
    } else {
        showToast('请选择保存文件夹...', 'info');
        try {
            const defaultPath = await resolveResourceSavePath(type);
            const folderResult = await API.selectSaveFolder(defaultPath);
            if (folderResult.cancelled) {
                if (folderResult.error) {
                    showToast('文件夹选择失败: ' + folderResult.error, 'error');
                }
                return;
            }
            const savePath = folderResult.path;
            if (!savePath) {
                showToast('未选择文件夹', 'error');
                return;
            }
            localStorage.setItem('lastResourceSavePath_' + type, savePath);
            showToast(`正在安装${typeNames[type]}...`, 'info');
            const result = await API.downloadResource('', projectId, type, '', savePath);
            if (result.success) {
                showModDownloadModal(result.fileName, result.sessionId);
            } else {
                showToast(result.error || '安装失败', 'error');
            }
        } catch (e) {
            showToast('安装失败', 'error');
        }
    }
}

// 显示版本选择对话框
async function showVersionSelectDialog() {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;';
        
        modal.innerHTML = `
            <div style="background:var(--bg-secondary,#1a1a2e);border-radius:12px;padding:24px;min-width:320px;max-width:400px;border:1px solid var(--border-color,rgba(255,255,255,0.1));">
                <h3 style="margin:0 0 16px;color:var(--text-primary,#fff);">选择目标版本</h3>
                <p style="margin:0 0 16px;color:var(--text-muted,#aaa);font-size:13px;">整合包将安装到所选版本中</p>
                <select id="version-select-dialog" style="width:100%;padding:10px 12px;background:var(--bg-input,#252540);border:1px solid var(--border-color,rgba(255,255,255,0.15));border-radius:8px;color:var(--text-primary,#fff);font-size:14px;">
                    <option value="">加载中...</option>
                </select>
                <div style="display:flex;gap:12px;margin-top:20px;justify-content:flex-end;">
                    <button id="version-select-cancel" style="padding:8px 16px;background:transparent;border:1px solid var(--border-color,rgba(255,255,255,0.2));border-radius:6px;color:var(--text-secondary,#ccc);cursor:pointer;">取消</button>
                    <button id="version-select-confirm" style="padding:8px 16px;background:var(--accent,#60a5fa);border:none;border-radius:6px;color:#fff;cursor:pointer;font-weight:500;">确认安装</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        const select = modal.querySelector('#version-select-dialog');
        const cancelBtn = modal.querySelector('#version-select-cancel');
        const confirmBtn = modal.querySelector('#version-select-confirm');
        
        API.getVersions(true).then(data => {
            select.innerHTML = '';
            const installed = (data?.installed || []).filter(v => v.id && v.type !== '(old)');
            if (installed.length === 0) {
                select.innerHTML = '<option value="">没有已安装的版本</option>';
            } else {
                installed.forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v.id;
                    let label = v.id;
                    if (v.isModpack) label += ` [${v.modpackLoader || '整合包'}]`;
                    else if (v.isFabric) label += ' [Fabric]';
                    else if (v.isForge) label += ' [Forge]';
                    else if (v.isNeoForge) label += ' [NeoForge]';
                    else if (v.isOptiFine) label += ' [OptiFine]';
                    opt.textContent = label;
                    select.appendChild(opt);
                });
            }
        }).catch(() => {
            select.innerHTML = '<option value="">加载失败</option>';
        });
        
        const close = (result) => {
            document.body.removeChild(modal);
            resolve(result);
        };
        
        cancelBtn.addEventListener('click', () => close(''));
        confirmBtn.addEventListener('click', () => close(select.value));
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close('');
        });
    });
}
