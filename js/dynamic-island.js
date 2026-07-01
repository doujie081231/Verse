/**
 * dynamic-island.js - V岛 (灵动岛) 组件
 * 左侧：圆环+数字（任务数），圆环显示总进度
 * 右侧：文字描述
 * 展开：每个任务的进度条
 */

(function () {
    'use strict';

    var _el = null;
    var _hoverZone = null;
    var _expanded = false;
    var _visible = false;
    var _state = 'idle';
    var _autoDismissTimer = null;
    var _hoverTimer = null;
    var _leaveTimer = null;
    var _hideTimer = null;
    var _tasks = {};  // 任务列表，key=任务名
    var _currentName = null;  // 当前活跃任务名

    function isEnabled() {
        try {
            var el = document.getElementById('vIsland');
            if (el) return !!el.checked;
            return document.body.classList.contains('v-island-enabled');
        } catch (_) { return false; }
    }

    function _clearHideTimer() {
        if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
    }

    function _startHideTimer(delay) {
        _clearHideTimer();
        _hideTimer = setTimeout(function () {
            if (_state === 'idle' && !_expanded && _visible) _hide();
        }, delay || 1200);
    }

    function _ensureHoverZone() {
        if (_hoverZone) return _hoverZone;
        _hoverZone = document.createElement('div');
        _hoverZone.className = 'v-island-hover-zone';
        document.body.appendChild(_hoverZone);

        _hoverZone.addEventListener('mouseenter', function () {
            if (!isEnabled()) return;
            _clearHideTimer();
            if (_hoverTimer) clearTimeout(_hoverTimer);
            _hoverTimer = setTimeout(function () {
                if (!_visible && _state === 'idle') _showIdle();
            }, 250);
        });

        _hoverZone.addEventListener('mouseleave', function () {
            if (_hoverTimer) { clearTimeout(_hoverTimer); _hoverTimer = null; }
            if (_state === 'idle' && _visible && !_expanded) {
                _startHideTimer(800);
            }
        });

        return _hoverZone;
    }

    function _ensureEl() {
        if (_el) return _el;
        _el = document.createElement('div');
        _el.id = 'v-island';
        _el.className = 'v-island';
        _el.innerHTML =
            '<div class="v-island__pill">' +
                '<div class="v-island__ring">' +
                    '<svg viewBox="0 0 36 36">' +
                        '<circle class="v-island__ring-track" cx="18" cy="18" r="15"/>' +
                        '<circle class="v-island__ring-fill" cx="18" cy="18" r="15"/>' +
                    '</svg>' +
                    '<img class="v-island__ring-icon" src="img/icon.svg" alt="">' +
                    '<span class="v-island__ring-num">0</span>' +
                '</div>' +
                '<div class="v-island__info">' +
                    '<div class="v-island__subtitle">点击展开</div>' +
                '</div>' +
                '<button class="v-island__close" title="关闭" style="display:none;">×</button>' +
                '<div class="v-island__detail"></div>' +
            '</div>';

        document.body.appendChild(_el);

        var pill = _el.querySelector('.v-island__pill');
        pill.addEventListener('click', function (e) {
            if (e.target.closest('.v-island__close')) {
                e.stopPropagation();
                _hide();
                return;
            }
            _toggleExpand();
        });

        _el.addEventListener('mouseenter', function () {
            _clearHideTimer();
            if (_leaveTimer) { clearTimeout(_leaveTimer); _leaveTimer = null; }
        });

        _el.addEventListener('mouseleave', function () {
            if (_state === 'idle' && _expanded) {
                _leaveTimer = setTimeout(function () {
                    if (_state === 'idle' && _expanded) _collapse();
                    if (_state === 'idle' && _visible) _startHideTimer(800);
                }, 600);
            } else if (_state === 'idle' && !_expanded && _visible) {
                _startHideTimer(800);
            }
        });

        return _el;
    }

    // 圆环周长 = 2 * PI * 15 ≈ 94.25
    var _circumference = 94.25;

    function _setRingProgress(pct) {
        if (!_el) return;
        var offset = _circumference - (Math.min(pct, 100) / 100) * _circumference;
        var fill = _el.querySelector('.v-island__ring-fill');
        if (fill) fill.style.strokeDashoffset = offset;
    }

    function _setRingNum(num) {
        if (!_el) return;
        var numEl = _el.querySelector('.v-island__ring-num');
        var iconEl = _el.querySelector('.v-island__ring-icon');
        if (numEl) {
            numEl.textContent = num;
            numEl.style.display = num > 0 ? '' : 'none';
        }
        if (iconEl) {
            iconEl.style.display = num > 0 ? 'none' : '';
        }
    }

    function _getActiveTaskCount() {
        var count = 0;
        var keys = Object.keys(_tasks);
        for (var i = 0; i < keys.length; i++) {
            var t = _tasks[keys[i]];
            if (t.status === 'downloading') count++;
        }
        return count;
    }

    function _getTotalProgress() {
        var keys = Object.keys(_tasks);
        if (keys.length === 0) return 0;
        var total = 0;
        var count = 0;
        for (var i = 0; i < keys.length; i++) {
            var t = _tasks[keys[i]];
            if (t.status === 'downloading' || t.status === 'completed') {
                total += Math.max(0, Math.min(100, t.progress || 0));
                count++;
            }
        }
        return count > 0 ? Math.round(total / count) : 0;
    }

    function _esc(s) {
        if (!s) return '';
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function _fmtSpeed(speed) {
        if (!speed || speed <= 0) return '';
        if (speed > 1024 * 1024) return (speed / 1024 / 1024).toFixed(1) + ' MB/s';
        return (speed / 1024).toFixed(0) + ' KB/s';
    }

    function _buildStageHistoryHtml(stages) {
        if (!stages || stages.length === 0) return '';
        var html = '<div class="v-island__stages">';
        for (var i = 0; i < stages.length; i++) {
            var s = stages[i];
            // 后端格式: { stage, message, progress }
            var name = s.message || s.stage || s.name || '';
            var pct = Math.round(s.progress || s.percent || 0);
            var dc = 'v-island__stage-dot';
            if (pct >= 100) dc += ' v-island__stage-dot--done';
            else if (pct > 0) dc += ' v-island__stage-dot--active';
            var pctText = pct > 0 && pct < 100 ? pct + '%' : '';
            html += '<div class="v-island__stage"><span class="' + dc + '"></span><span class="v-island__stage-name">' + _esc(name) + '</span><span class="v-island__stage-pct">' + pctText + '</span></div>';
        }
        return html + '</div>';
    }

    function _buildFilesHtml(files) {
        if (!files || files.length === 0) return '';
        var shown = files.slice(0, 8);
        var html = '<div class="v-island__files">';
        for (var i = 0; i < shown.length; i++) {
            var f = shown[i];
            // 兼容两种格式: { name, status, progress } 和 { n, s, p }
            var fname = f.name || f.n || f.filename || '';
            var fstatus = f.status || f.s || 'pending';
            var fprogress = Math.round(f.progress || f.p || 0);
            var st = '';
            if (fstatus === 'downloading') st = fprogress + '%';
            else if (fstatus === 'completed' || fstatus === 'done') st = '✓';
            else if (fstatus === 'failed') st = '✗';
            html += '<div class="v-island__file"><span class="v-island__file-name">' + _esc(fname) + '</span><span class="v-island__file-status">' + st + '</span></div>';
        }
        if (files.length > 8) {
            html += '<div class="v-island__file"><span class="v-island__file-name" style="color:var(--text-muted)">... 还有 ' + (files.length - 8) + ' 个文件</span></div>';
        }
        return html + '</div>';
    }

    function _buildTasksHtml() {
        var keys = Object.keys(_tasks);
        if (keys.length === 0) {
            return '<div class="v-island__empty">暂无下载任务</div>';
        }

        var html = '<div class="v-island__tasks">';
        for (var i = 0; i < keys.length; i++) {
            var t = _tasks[keys[i]];
            var pct = Math.max(0, Math.min(100, t.progress || 0));
            var statusText = '';
            var statusClass = '';

            if (t.status === 'downloading') {
                statusText = Math.round(pct) + '%';
                statusClass = 'task--downloading';
            } else if (t.status === 'completed') {
                statusText = '完成';
                statusClass = 'task--completed';
                pct = 100;
            } else if (t.status === 'failed') {
                statusText = '失败';
                statusClass = 'task--failed';
            }

            html += '<div class="v-island__task ' + statusClass + '">' +
                '<div class="v-island__task-head">' +
                    '<span class="v-island__task-name">' + _esc(t.name) + '</span>' +
                    '<span class="v-island__task-pct">' + statusText + '</span>' +
                '</div>' +
                '<div class="v-island__task-bar">' +
                    '<div class="v-island__task-bar-fill" style="width:' + pct + '%"></div>' +
                '</div>';

            // 失败时显示错误信息
            if (t.status === 'failed' && t.message) {
                html += '<div class="v-island__task-error">' + _esc(t.message) + '</div>';
            }

            // 下载中显示阶段步骤和文件列表
            if (t.status === 'downloading') {
                if (t.stageHistory && t.stageHistory.length > 0) html += _buildStageHistoryHtml(t.stageHistory);
                if (t.files && t.files.length > 0) html += _buildFilesHtml(t.files);
                else if (t.currentFile) html += '<div class="v-island__task-current">正在下载: ' + _esc(t.currentFile) + '</div>';
            }

            html += '</div>';
        }
        return html + '</div>';
    }

    function _updateDetail() {
        if (!_expanded || !_el) return;
        var detail = _el.querySelector('.v-island__detail');
        if (!detail) return;
        detail.innerHTML = _buildTasksHtml();
    }

    function _refreshDisplay() {
        if (!_el) return;
        var active = _getActiveTaskCount();
        var totalPct = _getTotalProgress();

        _setRingNum(active);
        _setRingProgress(totalPct);

        var subEl = _el.querySelector('.v-island__subtitle');
        if (subEl) {
            if (active > 0) {
                subEl.textContent = active + ' 个任务进行中  ' + Math.round(totalPct) + '%';
            } else {
                subEl.textContent = '点击展开查看任务';
            }
        }

        if (_expanded) _updateDetail();
    }

    function _expand() {
        _expanded = true;
        _clearHideTimer();
        if (_el) {
            _el.classList.add('v-island--expanded');
            _updateDetail();
        }
    }

    function _collapse() {
        _expanded = false;
        if (_el) _el.classList.remove('v-island--expanded');
    }

    function _toggleExpand() {
        if (_expanded) _collapse(); else _expand();
    }

    function _showIdle() {
        if (!isEnabled()) return;
        var el = _ensureEl();
        _visible = true;
        _state = 'idle';

        var subEl = el.querySelector('.v-island__subtitle');
        var closeBtn = el.querySelector('.v-island__close');
        if (subEl) {
            var active = _getActiveTaskCount();
            subEl.textContent = active > 0 ? active + ' 个任务进行中' : '点击展开查看任务';
        }
        if (closeBtn) closeBtn.style.display = 'none';

        _setRingNum(_getActiveTaskCount());
        _setRingProgress(_getTotalProgress());

        el.classList.remove('v-island--completed', 'v-island--failed', 'v-island--expanded', 'island--active');
        el.classList.add('island--idle');
        _expanded = false;
        el.classList.add('v-island--visible');
    }

    function _hide() {
        _clearHideTimer();
        if (_autoDismissTimer) { clearTimeout(_autoDismissTimer); _autoDismissTimer = null; }
        if (_leaveTimer) { clearTimeout(_leaveTimer); _leaveTimer = null; }
        _visible = false;
        _expanded = false;
        _state = 'idle';
        if (_el) {
            _el.classList.remove('v-island--visible', 'v-island--expanded', 'v-island--completed', 'v-island--failed', 'island--active', 'island--idle');
        }
    }

    // ── 公开接口 ───────────────────────────────────────────────────────────

    function show(title) {
        if (!isEnabled()) return;
        var el = _ensureEl();
        var name = title || '导入中';
        _currentName = name;

        // 添加任务
        if (!_tasks[name]) {
            _tasks[name] = { name: name, progress: 0, status: 'downloading' };
        } else {
            _tasks[name].status = 'downloading';
            _tasks[name].progress = 0;
        }

        _visible = true;
        _state = 'downloading';
        _clearHideTimer();
        if (_autoDismissTimer) { clearTimeout(_autoDismissTimer); _autoDismissTimer = null; }
        if (_leaveTimer) { clearTimeout(_leaveTimer); _leaveTimer = null; }

        el.classList.remove('v-island--completed', 'v-island--failed', 'v-island--expanded', 'island--idle');
        el.classList.add('v-island--visible', 'island--active');

        _refreshDisplay();
    }

    function update(data) {
        if (!isEnabled() || !_el) return;
        if (!data) return;

        var name = data.name || _currentName;
        if (!name || !_tasks[name]) return;

        var task = _tasks[name];
        if (data.progress != null) task.progress = Math.max(0, Math.min(100, data.progress));
        if (data.status) task.status = data.status;
        if (data.speed != null) task.speed = data.speed;
        if (data.message) task.message = data.message;
        if (data.stageHistory) task.stageHistory = data.stageHistory;
        if (data.files) task.files = data.files;
        if (data.currentFile) task.currentFile = data.currentFile;

        var el = _el;

        if (data.status === 'completed') {
            task.progress = 100;
            task.status = 'completed';
            _state = 'completed';
            el.classList.remove('v-island--failed', 'island--active', 'island--idle');
            el.classList.add('v-island--completed', 'v-island--visible');
            _visible = true;

            var subEl = el.querySelector('.v-island__subtitle');
            if (subEl) subEl.textContent = '导入完成';
            var cb = el.querySelector('.v-island__close');
            if (cb) cb.style.display = '';

            // 3秒后移除任务并隐藏（如果没有其他活跃任务）
            (function (taskName) {
                _autoDismissTimer = setTimeout(function () {
                    delete _tasks[taskName];
                    if (_getActiveTaskCount() === 0) {
                        _hide();
                    } else {
                        _state = 'downloading';
                        el.classList.remove('v-island--completed');
                        el.classList.add('island--active');
                        _refreshDisplay();
                    }
                }, 3000);
            })(name);
            _refreshDisplay();
            return;
        }

        if (data.status === 'failed') {
            task.status = 'failed';
            task.message = data.message || '未知错误';
            _state = 'failed';
            el.classList.remove('v-island--completed', 'island--active', 'island--idle');
            el.classList.add('v-island--failed', 'v-island--visible');
            _visible = true;

            var subEl2 = el.querySelector('.v-island__subtitle');
            if (subEl2) subEl2.textContent = (data.message || '导入失败');
            var cb2 = el.querySelector('.v-island__close');
            if (cb2) cb2.style.display = '';
            _refreshDisplay();
            return;
        }

        // 下载中
        _state = 'downloading';
        el.classList.remove('island--idle', 'v-island--completed', 'v-island--failed');
        el.classList.add('island--active');
        _refreshDisplay();
    }

    function dismiss() {
        _tasks = {};
        _currentName = null;
        _hide();
    }

    function preview() {
        if (!isEnabled()) return;
        var el = _ensureEl();
        _visible = true;
        el.classList.remove('v-island--visible', 'v-island--preview', 'v-island--completed', 'v-island--failed', 'island--active', 'island--idle');
        void el.offsetWidth;
        el.classList.add('v-island--preview', 'island--idle');

        _setRingNum(0);
        _setRingProgress(0);
        var subEl = el.querySelector('.v-island__subtitle');
        if (subEl) subEl.textContent = '鼠标移到顶部可唤出';

        el.addEventListener('animationend', function () {
            el.classList.remove('v-island--preview', 'island--idle');
            _visible = false;
        }, { once: true });
    }

    function setupHoverZone() { _ensureHoverZone(); }
    function isVisible() { return _visible; }

    window.DynamicIsland = {
        show: show,
        update: update,
        dismiss: dismiss,
        preview: preview,
        setupHoverZone: setupHoverZone,
        isEnabled: isEnabled,
        isVisible: isVisible
    };
})();
