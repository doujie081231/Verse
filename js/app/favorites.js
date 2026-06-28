async function loadFavoritesData() {
    try {
        _favorites = await API.getFavorites();
        console.log('[Fav] loaded favorites:', _favorites.length, _favorites);
        if (_favorites.length > 0 && !_currentFavId) {
            _currentFavId = _favorites[0].id;
        }
        renderFavFolderSelect();
    } catch (e) {
        console.error('[Fav] 加载收藏夹失败:', e);
        _favorites = [{ name: '默认', id: 'default', favs: [], notes: {} }];
    }
}

function renderFavFolderSelect() {
    var sel = document.getElementById('fav-folder-select');
    if (sel) {
        sel.innerHTML = _favorites.map(function(f) {
            return '<option value="' + f.id + '"' + (f.id === _currentFavId ? ' selected' : '') + '>' + escapeHtml(f.name) + ' (' + f.favs.length + ')</option>';
        }).join('');
        sel.onchange = function() {
            _currentFavId = sel.value;
            _favSelectedItems.clear();
            _favMultiSelectMode = false;
            renderFavPage();
        };
    }
    var subSel = document.getElementById('fav-sub-folder-select');
    if (subSel) {
        subSel.innerHTML = _favorites.map(function(f) {
            return '<option value="' + escapeHtml(f.id) + '"' + (f.id === (_favSubCurrentFavId || _currentFavId) ? ' selected' : '') + '>' + escapeHtml(f.name) + ' (' + (f.favs ? f.favs.length : 0) + ')</option>';
        }).join('');
    }
}

async function renderFavPage() {
    var content = document.getElementById('fav-content');
    var empty = document.getElementById('fav-empty');
    if (!content || !empty) return;

    var currentFav = _favorites.find(function(f) { return f.id === _currentFavId; });
    if (!currentFav || !currentFav.favs || currentFav.favs.length === 0) {
        content.style.display = 'none';
        empty.style.display = 'block';
        return;
    }
    content.style.display = 'block';
    empty.style.display = 'none';

    content.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    try {
        var projectIds = currentFav.favs;
        var projects = await fetchFavProjects(projectIds);
        var filtered = _favSearchQuery
            ? projects.filter(function(p) {
                return (p.title || '').toLowerCase().includes(_favSearchQuery.toLowerCase()) ||
                    (p.description || '').toLowerCase().includes(_favSearchQuery.toLowerCase());
              })
            : projects;

        if (filtered.length === 0) {
            content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)"><p>' + (_favSearchQuery ? '没有找到匹配的收藏' : '收藏夹为空') + '</p></div>';
            return;
        }

        var grouped = {};
        filtered.forEach(function(p) {
            var type = p.projectType || p.source || 'mod';
            if (!grouped[type]) grouped[type] = [];
            grouped[type].push(p);
        });

        var typeLabels = { mod: 'Mod', modpack: '整合包', resourcepack: '资源包', shader: '光影', datapack: '数据包' };
        var html = '';
        Object.keys(grouped).forEach(function(type) {
            var items = grouped[type];
            html += '<div class="fav-category-title">' + (typeLabels[type] || type) + ' (' + items.length + ')</div>';
            items.forEach(function(p) {
                var isChecked = _favSelectedItems.has(p.id);
                var note = currentFav.notes && currentFav.notes[p.id] ? currentFav.notes[p.id] : '';
                html += '<div class="fav-item" data-id="' + escapeHtml(p.id) + '" onclick="openFavItemDetail(\'' + escapeOnclick(p.id) + '\', \'' + escapeOnclick(p.source || 'modrinth') + '\')">';
                if (_favMultiSelectMode) {
                    html += '<input type="checkbox" class="fav-item-checkbox"' + (isChecked ? ' checked' : '') + ' onclick="event.stopPropagation(); toggleFavItemSelect(\'' + escapeOnclick(p.id) + '\')">';
                }
                if (p.icon) {
                    html += '<img class="fav-item-icon" src="' + escapeHtml(p.icon) + '" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'"><div class="fav-item-icon-placeholder" style="display:none">' + escapeHtml((p.title||'?')[0]) + '</div>';
                } else {
                    html += '<div class="fav-item-icon-placeholder">' + escapeHtml((p.title||'?')[0]) + '</div>';
                }
                html += '<div class="fav-item-info"><div class="fav-item-name">' + escapeHtml(p.title || p.id) + '</div><div class="fav-item-desc">' + escapeHtml(p.description || '') + '</div>';
                if (note) {
                    html += '<div class="fav-item-note">' + escapeHtml(note) + '</div>';
                }
                html += '</div>';
                html += '<span class="fav-item-type">' + (typeLabels[type] || type) + '</span>';
                html += '<div class="fav-item-actions">';
                html += '<button class="btn-icon" title="编辑备注" onclick="event.stopPropagation(); editFavNote(\'' + escapeOnclick(p.id) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>';
                html += '<button class="btn-icon fav-remove" title="取消收藏" onclick="event.stopPropagation(); removeFavItem(\'' + escapeOnclick(p.id) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
                html += '</div></div>';
            });
        });
        content.innerHTML = html;
    } catch (e) {
        content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)"><p>加载失败: ' + escapeHtml(e.message) + '</p></div>';
    }
}

async function fetchFavProjects(projectIds) {
    var results = [];
    var batchSize = 10;
    for (var i = 0; i < projectIds.length; i += batchSize) {
        var batch = projectIds.slice(i, i + batchSize);
        var promises = batch.map(async function(id) {
            try {
                var detail = await API.getModDetail(id, 'modrinth');
                return Object.assign({}, detail, { source: 'modrinth' });
            } catch (e) {
                return { id: id, title: id, description: '加载失败', source: 'modrinth', projectType: 'mod' };
            }
        });
        var batchResults = await Promise.all(promises);
        results.push.apply(results, batchResults);
    }
    return results;
}

function openFavItemDetail(projectId, source) {
    if (_favMultiSelectMode) {
        toggleFavItemSelect(projectId);
        return;
    }
    openModDetail(projectId, source);
}

var _favSubMultiSelect = false;
var _favSubSelected = new Set();
var _favSubSearchQuery = '';
var _favSubCurrentFavId = null;

function enterFavSubPage() {
    var browseSection = document.getElementById('mod-browse-section');
    var favSection = document.getElementById('mod-fav-section');
    if (!browseSection || !favSection) return;
    browseSection.style.display = 'none';
    favSection.style.display = 'block';
    _favSubCurrentFavId = _currentFavId;
    populateFavSubFolderSelect();
    renderFavSubList();
}

function exitFavSubPage() {
    var browseSection = document.getElementById('mod-browse-section');
    var favSection = document.getElementById('mod-fav-section');
    if (!browseSection || !favSection) return;
    favSection.style.display = 'none';
    browseSection.style.display = 'block';
    _favSubMultiSelect = false;
    _favSubSelected.clear();
    _favSubSearchQuery = '';
}

function populateFavSubFolderSelect() {
    var sel = document.getElementById('fav-sub-folder-select');
    if (!sel) return;
    sel.innerHTML = _favorites.map(function(f) {
        return '<option value="' + escapeHtml(f.id) + '"' + (f.id === _favSubCurrentFavId ? ' selected' : '') + '>' + escapeHtml(f.name) + ' (' + (f.favs ? f.favs.length : 0) + ')</option>';
    }).join('');
}

function onFavSubFolderChange(favId) {
    _favSubCurrentFavId = favId;
    _currentFavId = favId;
    _favSubSelected.clear();
    renderFavSubFolderSelect();
    renderFavSubList();
}

function renderFavSubFolderSelect() {
    populateFavSubFolderSelect();
}

function onFavSubSearch(query) {
    _favSubSearchQuery = query;
    renderFavSubList();
}

async function renderFavSubList() {
    var list = document.getElementById('fav-sub-list');
    var empty = document.getElementById('fav-sub-empty');
    if (!list || !empty) return;

    var currentFav = _favorites.find(function(f) { return f.id === _favSubCurrentFavId; });
    if (!currentFav || !currentFav.favs || currentFav.favs.length === 0) {
        list.style.display = 'none';
        empty.style.display = 'block';
        return;
    }
    list.style.display = '';
    empty.style.display = 'none';
    list.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

    try {
        var projects = await fetchFavProjects(currentFav.favs);
        var filtered = _favSubSearchQuery
            ? projects.filter(function(p) {
                return (p.title || '').toLowerCase().includes(_favSubSearchQuery.toLowerCase()) ||
                    (p.description || '').toLowerCase().includes(_favSubSearchQuery.toLowerCase());
              })
            : projects;

        if (filtered.length === 0) {
            list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)"><p>' + (_favSubSearchQuery ? '没有找到匹配的收藏' : '收藏夹为空') + '</p></div>';
            return;
        }

        list.innerHTML = filtered.map(function(p) {
            var isFav = _favorites.some(function(f) { return f.favs.includes(p.id); });
            var isChecked = _favSubSelected.has(p.id);
            var source = p.source || 'modrinth';
            return '<div class="mod-item mod-item-clickable' + (_favSubMultiSelect ? ' mod-multiselect-active' : '') + '" onclick="openModDetail(\'' + escapeOnclick(p.id) + '\', \'' + escapeOnclick(source) + '\')">' +
                (_favSubMultiSelect ? '<div class="mod-checkbox' + (isChecked ? ' checked' : '') + '" data-mod-id="' + escapeHtml(p.id) + '" onclick="event.stopPropagation();toggleFavSubItemSelect(\'' + escapeOnclick(p.id) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>' : '') +
                '<div class="mod-icon"><img src="' + escapeHtml(p.icon || '') + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.parentElement.classList.add(\'mod-icon--fallback\')"></div>' +
                '<div class="mod-info">' +
                    '<div class="mod-name">' + escapeHtml(formatModNameWithChinese(p.slug || p.id, p.title)) + '</div>' +
                    '<div class="mod-desc">' + escapeHtml(p.description || '') + '</div>' +
                    '<div class="mod-meta">' +
                        '<span>\u2B07 ' + formatNumber(p.downloads || 0) + '</span>' +
                        '<span>\u2764 ' + escapeHtml(p.author || '') + '</span>' +
                        '<span>' + (p.categories || []).slice(0, 3).join(', ') + '</span>' +
                    '</div>' +
                '</div>' +
                '<div class="mod-actions" onclick="event.stopPropagation()">' +
                    '<button class="fav-heart-btn active" data-project-id="' + escapeHtml(p.id) + '" onclick="event.stopPropagation(); showFavSelectDropdown(\'' + escapeOnclick(p.id) + '\', this)"><svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg></button>' +
                    '<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openModDetail(\'' + escapeOnclick(p.id) + '\', \'' + escapeOnclick(source) + '\')">安装</button>' +
                '</div>' +
            '</div>';
        }).join('');
    } catch (e) {
        list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary)"><p>加载失败: ' + escapeHtml(e.message) + '</p></div>';
    }
}

function toggleFavSubMultiSelect() {
    _favSubMultiSelect = !_favSubMultiSelect;
    _favSubSelected.clear();
    var bar = document.getElementById('fav-sub-multi-bar');
    var toggle = document.getElementById('fav-sub-multi-toggle');
    if (bar) bar.style.display = _favSubMultiSelect ? 'flex' : 'none';
    if (toggle) toggle.textContent = _favSubMultiSelect ? '取消多选' : '多选';
    updateFavSubMultiBar();
    renderFavSubList();
}

function toggleFavSubItemSelect(projectId) {
    if (_favSubSelected.has(projectId)) {
        _favSubSelected.delete(projectId);
    } else {
        _favSubSelected.add(projectId);
    }
    updateFavSubMultiBar();
    var checkbox = document.querySelector('.mod-checkbox[data-mod-id="' + projectId + '"]');
    if (checkbox) checkbox.classList.toggle('checked', _favSubSelected.has(projectId));
}

function toggleFavSubSelectAll(checked) {
    var currentFav = _favorites.find(function(f) { return f.id === _favSubCurrentFavId; });
    if (!currentFav) return;
    _favSubSelected.clear();
    if (checked) {
        currentFav.favs.forEach(function(id) { _favSubSelected.add(id); });
    }
    updateFavSubMultiBar();
    document.querySelectorAll('#fav-sub-list .mod-checkbox').forEach(function(cb) {
        cb.classList.toggle('checked', _favSubSelected.has(cb.getAttribute('data-mod-id')));
    });
}

function updateFavSubMultiBar() {
    var countEl = document.getElementById('fav-sub-selected-count');
    var removeBtn = document.getElementById('fav-sub-batch-remove');
    var downloadBtn = document.getElementById('fav-sub-batch-download');
    if (countEl) countEl.textContent = '已选 ' + _favSubSelected.size + ' 个';
    if (removeBtn) removeBtn.disabled = _favSubSelected.size === 0;
    if (downloadBtn) downloadBtn.disabled = _favSubSelected.size === 0;
}

async function batchRemoveFavSub() {
    if (_favSubSelected.size === 0) return;
    if (!confirm('确定取消收藏选中的 ' + _favSubSelected.size + ' 个项目？')) return;
    try {
        for (var projectId of _favSubSelected) {
            await API.removeFromFavorite(_favSubCurrentFavId, projectId);
            var fav = _favorites.find(function(f) { return f.id === _favSubCurrentFavId; });
            if (fav) fav.favs = fav.favs.filter(function(id) { return id !== projectId; });
        }
        _favSubSelected.clear();
        updateFavSubMultiBar();
        showToast('已取消收藏', 'success');
        renderFavSubList();
        renderFavFolderSelect();
    } catch (e) {
        showToast('操作失败', 'error');
    }
}

async function batchDownloadFavSub() {
    if (_favSubSelected.size === 0) return;
    try {
        var projects = await fetchFavProjects(Array.from(_favSubSelected));
        projects.forEach(function(p) {
            if (p.id) quickInstallMod(p.id, p.source || 'modrinth', '', '');
        });
        showToast('已开始下载 ' + _favSubSelected.size + ' 个模组', 'success');
    } catch (e) {
        showToast('批量下载失败', 'error');
    }
}

function toggleFavItemSelect(projectId) {
    if (_favSelectedItems.has(projectId)) {
        _favSelectedItems.delete(projectId);
    } else {
        _favSelectedItems.add(projectId);
    }
    updateFavSelectUI();
    var cb = document.querySelector('.fav-item[data-id="' + CSS.escape(projectId) + '"] .fav-item-checkbox');
    if (cb) cb.checked = _favSelectedItems.has(projectId);
}

function toggleFavMultiSelect() {
    _favMultiSelectMode = !_favMultiSelectMode;
    _favSelectedItems.clear();
    var bar = document.getElementById('fav-multiselect-bar');
    if (bar) bar.style.display = _favMultiSelectMode ? 'flex' : 'none';
    var btn = document.getElementById('fav-multiselect-toggle');
    if (btn) btn.classList.toggle('active', _favMultiSelectMode);
    renderFavPage();
}

function toggleFavSelectAll(checked) {
    var currentFav = _favorites.find(function(f) { return f.id === _currentFavId; });
    if (!currentFav) return;
    _favSelectedItems.clear();
    if (checked) currentFav.favs.forEach(function(id) { _favSelectedItems.add(id); });
    updateFavSelectUI();
    renderFavPage();
}

function updateFavSelectUI() {
    var count = _favSelectedItems.size;
    var countEl = document.getElementById('fav-selected-count');
    if (countEl) countEl.textContent = '已选 ' + count + ' 个';
    var removeBtn = document.getElementById('fav-batch-remove-btn');
    if (removeBtn) removeBtn.disabled = count === 0;
    var downloadBtn = document.getElementById('fav-batch-download-btn');
    if (downloadBtn) downloadBtn.disabled = count === 0;
}

async function removeFavItem(projectId) {
    if (!_currentFavId) return;
    try {
        await API.removeFromFavorite(_currentFavId, projectId);
        var fav = _favorites.find(function(f) { return f.id === _currentFavId; });
        if (fav) fav.favs = fav.favs.filter(function(id) { return id !== projectId; });
        renderFavFolderSelect();
        renderFavPage();
        updateFavHeartButtons();
        showToast('已取消收藏', 'success');
    } catch (e) {
        showToast('操作失败', 'error');
    }
}

async function batchRemoveFavorites() {
    if (_favSelectedItems.size === 0) return;
    var count = _favSelectedItems.size;
    if (!confirm('确定要取消收藏 ' + count + ' 个项目吗？')) return;
    try {
        var idsToRemove = Array.from(_favSelectedItems);
        for (var i = 0; i < idsToRemove.length; i++) {
            await API.removeFromFavorite(_currentFavId, idsToRemove[i]);
        }
        var fav = _favorites.find(function(f) { return f.id === _currentFavId; });
        if (fav) fav.favs = fav.favs.filter(function(id) { return !_favSelectedItems.has(id); });
        _favSelectedItems.clear();
        updateFavSelectUI();
        renderFavFolderSelect();
        renderFavPage();
        updateFavHeartButtons();
        showToast('已取消 ' + count + ' 个收藏', 'success');
    } catch (e) {
        showToast('操作失败', 'error');
    }
}

async function editFavNote(projectId) {
    var currentFav = _favorites.find(function(f) { return f.id === _currentFavId; });
    if (!currentFav) return;
    var oldNote = currentFav.notes && currentFav.notes[projectId] ? currentFav.notes[projectId] : '';
    var note = prompt('编辑备注:', oldNote);
    if (note === null) return;
    try {
        await API.updateFavNote(_currentFavId, projectId, note);
        if (!currentFav.notes) currentFav.notes = {};
        if (note) currentFav.notes[projectId] = note;
        else delete currentFav.notes[projectId];
        renderFavPage();
        showToast('备注已更新', 'success');
    } catch (e) {
        showToast('操作失败', 'error');
    }
}

function showFavManageMenu() {
    closeFavMenus();
    var btn = event.currentTarget;
    var rect = btn.getBoundingClientRect();
    var menu = document.createElement('div');
    menu.className = 'fav-manage-menu';
    menu.id = 'fav-manage-menu-popup';
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.right = (window.innerWidth - rect.right) + 'px';
    menu.innerHTML = '<div class="fav-manage-menu-item" onclick="createNewFavorite()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新建收藏夹</div>' +
        '<div class="fav-manage-menu-item" onclick="renameCurrentFavorite()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>重命名当前收藏夹</div>' +
        '<div class="fav-manage-menu-item danger" onclick="deleteCurrentFavorite()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>删除当前收藏夹</div>';
    document.body.appendChild(menu);
    setTimeout(function() { document.addEventListener('click', closeFavMenusHandler, { once: true }); }, 0);
}

function closeFavMenus() {
    document.querySelectorAll('.fav-manage-menu, .fav-select-dropdown').forEach(function(el) { el.remove(); });
}

function closeFavMenusHandler(e) {
    if (!e.target.closest('.fav-manage-menu') && !e.target.closest('.fav-select-dropdown')) {
        closeFavMenus();
    }
}

async function createNewFavorite() {
    closeFavMenus();
    var name = prompt('请输入收藏夹名称:');
    if (!name) return;
    try {
        var result = await API.createFavorite(name);
        if (result && result.favorite) {
            _favorites.push(result.favorite);
            _currentFavId = result.favorite.id;
            renderFavFolderSelect();
            renderFavPage();
            showToast('收藏夹已创建', 'success');
        }
    } catch (e) {
        showToast('创建失败', 'error');
    }
}

async function renameCurrentFavorite() {
    closeFavMenus();
    var fav = _favorites.find(function(f) { return f.id === _currentFavId; });
    if (!fav) return;
    var name = prompt('请输入新名称:', fav.name);
    if (!name || name === fav.name) return;
    try {
        await API.renameFavorite(_currentFavId, name);
        fav.name = name;
        renderFavFolderSelect();
        showToast('重命名成功', 'success');
    } catch (e) {
        showToast('重命名失败', 'error');
    }
}

async function deleteCurrentFavorite() {
    closeFavMenus();
    if (_favorites.length <= 1) {
        showToast('至少保留一个收藏夹', 'error');
        return;
    }
    var fav = _favorites.find(function(f) { return f.id === _currentFavId; });
    if (!fav) return;
    if (!confirm('确定要删除收藏夹"' + fav.name + '"吗？')) return;
    try {
        await API.deleteFavorite(_currentFavId);
        _favorites = _favorites.filter(function(f) { return f.id !== _currentFavId; });
        _currentFavId = _favorites.length > 0 ? _favorites[0].id : '';
        renderFavFolderSelect();
        renderFavPage();
        showToast('收藏夹已删除', 'success');
    } catch (e) {
        showToast('删除失败', 'error');
    }
}

function exportCurrentFav() {
    var fav = _favorites.find(function(f) { return f.id === _currentFavId; });
    if (!fav) return;
    var data = JSON.stringify(fav.favs);
    navigator.clipboard.writeText(data).then(function() {
        showToast('已复制到剪贴板', 'success');
    }).catch(function() {
        prompt('复制以下内容:', data);
    });
}

function showFavImportModal() {
    var data = prompt('请粘贴收藏分享码:');
    if (!data) return;
    importFavData(data);
}

async function importFavData(data) {
    try {
        var result = await API.importFavorite(data, _currentFavId);
        if (result && result.success) {
            await loadFavoritesData();
            renderFavPage();
            showToast('已导入 ' + result.imported + ' 个项目', 'success');
        }
    } catch (e) {
        showToast('导入失败: ' + e.message, 'error');
    }
}

async function batchDownloadFavorites() {
    if (_favSelectedItems.size === 0) return;
    var ids = Array.from(_favSelectedItems);
    showToast('正在准备下载 ' + ids.length + ' 个模组...', 'info');
    for (var i = 0; i < ids.length; i++) {
        try {
            const result = await API.downloadMod(ids[i], 'modrinth', '', '');
            if (result.success && result.sessionId) {
                showModDownloadModal(result.fileName, result.sessionId, result.path || '');
            }
        } catch (e) {
            console.error('下载失败:', ids[i], e);
        }
    }
    showToast('批量下载已启动', 'success');
}

function updateFavHeartButtons() {
    document.querySelectorAll('.fav-heart-btn').forEach(function(btn) {
        var projectId = btn.dataset.projectId;
        if (!projectId) return;
        var isFav = _favorites.some(function(f) { return f.favs.includes(projectId); });
        btn.classList.toggle('active', isFav);
    });
}

function showFavSelectDropdown(projectId, anchorEl) {
    closeFavMenus();
    console.log('[Fav] showFavSelectDropdown called:', projectId, '_favorites:', _favorites.length, _favorites);
    var rect = anchorEl.getBoundingClientRect();
    var dropdown = document.createElement('div');
    dropdown.className = 'fav-select-dropdown';
    dropdown.id = 'fav-select-dropdown-popup';
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = Math.min(rect.left, window.innerWidth - 220) + 'px';

    var isFavInAny = _favorites.some(function(f) { return f.favs.includes(projectId); });
    var innerHtml = '';
    if (isFavInAny) {
        innerHtml += '<div class="fav-select-item" style="color:var(--red)" onclick="removeFromAllFavs(\'' + escapeOnclick(projectId) + '\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>取消所有收藏</div>';
    }

    _favorites.forEach(function(f) {
        var has = f.favs.includes(projectId);
        innerHtml += '<div class="fav-select-item' + (has ? ' active' : '') + '" onclick="toggleFavForProject(\'' + escapeOnclick(f.id) + '\', \'' + escapeOnclick(projectId) + '\', ' + has + ')">';
        if (has) {
            innerHtml += '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>';
        } else {
            innerHtml += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>';
        }
        innerHtml += (has ? '取消收藏 ' : '收藏到 ') + escapeHtml(f.name) + '</div>';
    });
    dropdown.innerHTML = innerHtml;
    document.body.appendChild(dropdown);
    console.log('[Fav] dropdown appended, items:', _favorites.length, 'innerHTML length:', innerHtml.length);
    setTimeout(function() { document.addEventListener('click', closeFavMenusHandler, { once: true }); }, 0);
}

async function toggleFavForProject(favId, projectId, isRemove) {
    closeFavMenus();
    try {
        if (isRemove) {
            await API.removeFromFavorite(favId, projectId);
            var fav = _favorites.find(function(f) { return f.id === favId; });
            if (fav) fav.favs = fav.favs.filter(function(id) { return id !== projectId; });
            showToast('已取消收藏', 'success');
        } else {
            await API.addToFavorite(favId, projectId);
            var fav2 = _favorites.find(function(f) { return f.id === favId; });
            if (fav2 && !fav2.favs.includes(projectId)) fav2.favs.push(projectId);
            showToast('已添加到收藏夹', 'success');
        }
        renderFavFolderSelect();
        updateFavHeartButtons();
        if (document.getElementById('page-mod-favorites') && document.getElementById('page-mod-favorites').classList.contains('active')) {
            renderFavPage();
        }
        if (document.getElementById('mod-fav-section') && document.getElementById('mod-fav-section').style.display !== 'none') {
            renderFavSubList();
        }
    } catch (e) {
        showToast('操作失败', 'error');
    }
}

async function removeFromAllFavs(projectId) {
    closeFavMenus();
    try {
        for (var i = 0; i < _favorites.length; i++) {
            var fav = _favorites[i];
            if (fav.favs.includes(projectId)) {
                await API.removeFromFavorite(fav.id, projectId);
                fav.favs = fav.favs.filter(function(id) { return id !== projectId; });
            }
        }
        renderFavFolderSelect();
        updateFavHeartButtons();
        if (document.getElementById('mod-fav-section') && document.getElementById('mod-fav-section').style.display !== 'none') {
            renderFavSubList();
        }
        showToast('已取消所有收藏', 'success');
    } catch (e) {
        showToast('操作失败', 'error');
    }
}

function setupFavSearchListeners() {
    var searchBtn = document.getElementById('fav-search-btn');
    var searchInput = document.getElementById('fav-search-input');
    if (searchBtn) {
        searchBtn.addEventListener('click', function() {
            _favSearchQuery = searchInput ? searchInput.value : '';
            renderFavPage();
        });
    }
    if (searchInput) {
        searchInput.addEventListener('keyup', function(e) {
            if (e.key === 'Enter' && !e.isComposing) {
                _favSearchQuery = e.target.value;
                renderFavPage();
            }
        });
    }
}
