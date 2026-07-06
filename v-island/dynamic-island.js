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
    var _replyHideTimer = null;
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
                    '<input type="text" class="v-island__input" placeholder="问我点什么..." style="display:none">' +
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
            // 输入框已显示时，点击 pill 不切换状态（让用户能点输入框）
            if (e.target.classList && e.target.classList.contains('v-island__input')) return;
            _toggleExpand();
        });

        // 输入框回车触发对话
        var input = _el.querySelector('.v-island__input');
        if (input) {
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.keyCode === 13) {
                    e.preventDefault();
                    e.stopPropagation();
                    var q = input.value.trim();
                    if (q) _askQuestion(q);
                } else if (e.key === 'Escape' || e.keyCode === 27) {
                    _collapseChatInput();
                }
            });
            // 阻止输入框点击冒泡到 pill
            input.addEventListener('click', function (e) { e.stopPropagation(); });
        }

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
        // 空闲状态：点击切换对话输入框
        if (_state === 'idle') {
            if (_expanded) {
                _collapseChatInput();
            } else {
                _expandChatInput();
            }
            return;
        }
        // 有任务时：展开/收起进度详情（原行为）
        if (_expanded) _collapse(); else _expand();
    }

    // 展开 V 岛对话输入框
    function _expandChatInput() {
        _expanded = true;
        _clearHideTimer();
        if (!_el) _ensureEl();
        _el.classList.add('v-island--expanded', 'v-island--chat');
        var input = _el.querySelector('.v-island__input');
        var sub = _el.querySelector('.v-island__subtitle');
        if (sub) sub.style.display = 'none';
        if (input) {
            input.style.display = '';
            setTimeout(function () { input.focus(); }, 50);
        }
    }

    // 收起对话输入框
    function _collapseChatInput() {
        if (!_el) return;
        _expanded = false;
        _el.classList.remove('v-island--expanded', 'v-island--chat');
        var input = _el.querySelector('.v-island__input');
        var sub = _el.querySelector('.v-island__subtitle');
        if (input) { input.style.display = 'none'; input.value = ''; }
        if (sub) sub.style.display = '';
        // 回到圆环默认状态
        _el.classList.remove('v-island--thinking');
    }

    // 提问 → V 岛变圆环旋转思考 → 展开显示回复
    async function _askQuestion(q) {
        if (!_el) _ensureEl();
        var input = _el.querySelector('.v-island__input');
        var sub = _el.querySelector('.v-island__subtitle');
        // 隐藏输入框，显示思考状态
        if (input) input.style.display = 'none';
        _el.classList.add('v-island--thinking');
        if (sub) {
            sub.style.display = '';
            sub.textContent = '思考中...';
        }

        // 加入对话历史
        _dialogHistory.push({ role: 'user', content: q });
        if (_dialogHistory.length > 10) _dialogHistory = _dialogHistory.slice(-10);

        try {
            var reply = await chatWithAI(_dialogHistory);
            _dialogHistory.push({ role: 'assistant', content: reply });
            if (_dialogHistory.length > 10) _dialogHistory = _dialogHistory.slice(-10);
            _showReply(q, reply);
        } catch (e) {
            _showReply(q, '出错了：' + (e.message || e));
        }
    }

    // 在 detail 里显示回复（打字机效果逐字输出），并 TTS 朗读
    function _showReply(question, reply) {
        if (!_el) return;
        _el.classList.remove('v-island--thinking');
        _el.classList.remove('v-island--chat');  // 切回展开态展示回复
        _el.classList.add('v-island--expanded');
        _expanded = true;
        var sub = _el.querySelector('.v-island__subtitle');
        var detail = _el.querySelector('.v-island__detail');
        if (sub) {
            sub.style.display = '';
            sub.textContent = 'V 岛回复';
        }
        if (detail) {
            detail.innerHTML =
                '<div class="v-island__reply">' +
                    '<div class="v-island__reply-a"><span class="v-typing-text"></span><span class="v-typing-cursor"></span></div>' +
                '</div>';
            _typewriter(detail.querySelector('.v-typing-text'), reply, 30);
        }
        // TTS 朗读回复
        speak(reply);

        // 打字机结束后 10 秒自动收起（时间按字数动态计算）
        var typingDuration = Math.min(reply.length * 30 + 500, 8000);
        var totalDelay = typingDuration + 10000;
        if (_replyHideTimer) clearTimeout(_replyHideTimer);
        _replyHideTimer = setTimeout(function () {
            if (_state === 'idle' && _expanded) _collapseChatInput();
        }, totalDelay);
    }

    // 打字机效果：逐字输出
    function _typewriter(el, text, speed) {
        if (!el) return;
        var i = 0;
        el.textContent = '';
        var timer = setInterval(function () {
            if (i >= text.length) {
                clearInterval(timer);
                // 打字结束，移除光标
                var cursor = el.parentNode.querySelector('.v-typing-cursor');
                if (cursor) cursor.remove();
                return;
            }
            el.textContent += text.charAt(i);
            i++;
        }, speed);
    }

    function _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

    // ========================================================================
    // 扩展模块 1：Edge TTS（微软温柔女声 zh-CN-XiaoxiaoNeural，零安装）
    // ========================================================================
    var _tts = null;
    function _getTTS() {
        if (_tts) return _tts;
        _tts = {
            queue: [],
            playing: false,
            audio: null,
            ws: null,

            speak: function (text, onEnd) {
                if (!text || !String(text).trim()) { if (onEnd) onEnd(); return; }
                var self = this;
                this.queue.push({ text: String(text), onEnd: onEnd });
                if (!this.playing) this._drain();
            },

            stop: function () {
                this.queue = [];
                this.playing = false;
                if (this.audio) { try { this.audio.pause(); } catch (e) {} }
                if (this.ws) { try { this.ws.close(); } catch (e) {} }
            },

            _drain: function () {
                var self = this;
                if (this.queue.length === 0) { this.playing = false; return; }
                this.playing = true;
                var item = this.queue.shift();
                this._synthesize(item.text, function (err, blob) {
                    if (err || !blob || blob.size === 0) {
                        if (item.onEnd) item.onEnd();
                        self._drain();
                        return;
                    }
                    var url = URL.createObjectURL(blob);
                    var audio = new Audio(url);
                    self.audio = audio;
                    var next = function () {
                        URL.revokeObjectURL(url);
                        if (item.onEnd) item.onEnd();
                        self._drain();
                    };
                    audio.onended = next;
                    audio.onerror = next;
                    audio.play().catch(function () { next(); });
                });
            },

            _synthesize: function (text, cb) {
                var self = this;
                var token = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
                var url = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + token;
                var ws;
                try { ws = new WebSocket(url); ws.binaryType = 'arraybuffer'; }
                catch (e) { cb(e); return; }
                this.ws = ws;

                var chunks = [];
                var finished = false;
                var timer = setTimeout(function () {
                    if (!finished) {
                        finished = true;
                        try { ws.close(); } catch (e) {}
                        cb(null, chunks.length > 0 ? new Blob(chunks, { type: 'audio/mpeg' }) : null);
                    }
                }, 20000);

                ws.onopen = function () {
                    var rid = self._rid();
                    var cfg = 'X-RequestId:' + rid + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
                        JSON.stringify({ context: { synthesis: { audio: { outputFormat: 'audio-24khz-48kbitrate-mono-mp3', metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false } } } } });
                    ws.send(cfg);
                    var ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><voice name="zh-CN-XiaoxiaoNeural"><prosody rate="0" pitch="0">' + self._xml(text) + '</prosody></voice></speak>';
                    ws.send('X-RequestId:' + rid + '\r\nContent-Type:application/ssml+xml\r\nPath:ssynthesis\r\n\r\n' + ssml);
                };

                ws.onmessage = function (ev) {
                    if (typeof ev.data === 'string') {
                        if (ev.data.indexOf('Path:turn.end') !== -1 && !finished) {
                            finished = true;
                            clearTimeout(timer);
                            try { ws.close(); } catch (e) {}
                            cb(null, new Blob(chunks, { type: 'audio/mpeg' }));
                        }
                    } else if (ev.data.byteLength > 2) {
                        var dv = new DataView(ev.data);
                        var hlen = dv.getUint16(0);
                        if (2 + hlen < ev.data.byteLength) chunks.push(ev.data.slice(2 + hlen));
                    }
                };

                ws.onerror = function () {
                    if (!finished) {
                        finished = true;
                        clearTimeout(timer);
                        cb(null, chunks.length > 0 ? new Blob(chunks, { type: 'audio/mpeg' }) : null);
                    }
                };
            },

            _xml: function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
            _rid: function () {
                var s = ''; var c = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
                for (var i = 0; i < 16; i++) s += c[Math.floor(Math.random() * 62)];
                return s;
            }
        };
        return _tts;
    }

    function speak(text, onEnd) { _getTTS().speak(text, onEnd); }
    function stopSpeak() { if (_tts) _tts.stop(); }

    // ========================================================================
    // 扩展模块 2：AI 对话（云端供应商，支持 openai/anthropic/google 格式）
    // ========================================================================
    var AI_PROVIDERS = {
        zhipu:     { name: '智谱清言', icon: 'zhipu',     apiFormat: 'openai',     endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'glm-4-flash', name: 'GLM-4-Flash', free: true }, { id: 'glm-4', name: 'GLM-4' }] },
        deepseek:  { name: 'DeepSeek', icon: 'deepseek',  apiFormat: 'openai',     endpoint: 'https://api.deepseek.com/chat/completions',          authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'deepseek-chat', name: 'DeepSeek-V3' }, { id: 'deepseek-reasoner', name: 'DeepSeek-R1' }] },
        qwen:      { name: '通义千问', icon: 'qwen',      apiFormat: 'openai',     endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'qwen-turbo', name: 'Qwen Turbo' }, { id: 'qwen-plus', name: 'Qwen Plus' }] },
        moonshot:  { name: 'Kimi',     icon: 'moonshot',   apiFormat: 'openai',     endpoint: 'https://api.moonshot.cn/v1/chat/completions',          authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'moonshot-v1-8k', name: 'Moonshot 8K' }] },
        yi:        { name: '零一万物', icon: 'yi',        apiFormat: 'openai',     endpoint: 'https://api.lingyiwanwu.com/v1/chat/completions',    authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'yi-large', name: 'Yi-Large' }] },
        minimax:   { name: 'MiniMax', icon: 'minimax',    apiFormat: 'openai',     endpoint: 'https://api.minimax.chat/v1/text/chatcompletion_v2', authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'MiniMax-Text-01', name: 'MiniMax-Text-01' }] },
        stepfun:   { name: '阶跃星辰', icon: 'stepfun',    apiFormat: 'openai',     endpoint: 'https://api.stepfun.com/v1/chat/completions',         authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'step-1-8k', name: 'Step-1 8K' }] },
        doubao:    { name: '豆包',     icon: 'doubao',     apiFormat: 'openai',     endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'doubao-pro-4k', name: 'Doubao Pro 4K' }] },
        siliconflow: { name: '硅基流动', icon: 'siliconflow', apiFormat: 'openai',  endpoint: 'https://api.siliconflow.cn/v1/chat/completions',      authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5-7B', free: true }] },
        openrouter: { name: 'OpenRouter', icon: 'openrouter', apiFormat: 'openai',   endpoint: 'https://openrouter.ai/api/v1/chat/completions',      authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' }] },
        groq:      { name: 'Groq',     icon: 'groq',       apiFormat: 'openai',     endpoint: 'https://api.groq.com/openai/v1/chat/completions',     authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', free: true }] },
        openai:    { name: 'OpenAI',   icon: 'openai',     apiFormat: 'openai',     endpoint: 'https://api.openai.com/v1/chat/completions',          authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }, { id: 'gpt-4o', name: 'GPT-4o' }] },
        anthropic: { name: 'Anthropic', icon: 'anthropic', apiFormat: 'anthropic',  endpoint: 'https://api.anthropic.com/v1/messages',              authHeader: 'x-api-key',     authPrefix: '',        models: [{ id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' }] },
        google:    { name: 'Google Gemini', icon: 'gemini', apiFormat: 'google',    endpoint: '',                                                   authHeader: 'url_key',      authPrefix: '',        models: [{ id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', free: true }] },
        baichuan:  { name: '百川',     icon: 'baichuan',   apiFormat: 'openai',     endpoint: 'https://api.baichuan-ai.com/v1/chat/completions',     authHeader: 'Authorization', authPrefix: 'Bearer ', models: [{ id: 'Baichuan4', name: 'Baichuan4' }] }
    };

    function _getAIConfig() {
        try { return JSON.parse(localStorage.getItem('v-island-ai-config') || '{}'); }
        catch (_) { return {}; }
    }

    function _saveAIConfig(cfg) {
        try { localStorage.setItem('v-island-ai-config', JSON.stringify(cfg)); return true; }
        catch (_) { return false; }
    }

    function _buildBody(format, model, messages) {
        if (format === 'anthropic') return { model: model, messages: messages, max_tokens: 1024 };
        if (format === 'google') return { contents: messages.map(function (m) { return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }; }) };
        return { model: model, messages: messages, stream: false };
    }

    function _extractReply(format, data) {
        try {
            if (format === 'anthropic') return (data.content || []).map(function (c) { return c.text; }).join('') || '(空回复)';
            if (format === 'google') return (data.candidates[0].content.parts || []).map(function (p) { return p.text; }).join('') || '(空回复)';
            return data.choices[0].message.content || '(空回复)';
        } catch (e) { return '(解析回复失败)'; }
    }

    async function chatWithAI(messages) {
        var cfg = _getAIConfig();
        if (!cfg.provider || !cfg.apiKey) return '我还没接入 AI，请先在 V 岛设置中配置供应商。';
        var p = AI_PROVIDERS[cfg.provider];
        if (!p) return '不支持的供应商：' + cfg.provider;
        var model = cfg.model || (p.models[0] && p.models[0].id);
        if (!model) return '未选择模型。';
        try {
            var headers = { 'Content-Type': 'application/json' };
            if (p.authHeader === 'url_key') {
                var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + cfg.apiKey;
            } else {
                headers[p.authHeader] = p.authPrefix + cfg.apiKey;
                var url = p.endpoint;
            }
            var body = _buildBody(p.apiFormat, model, messages);
            var resp = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
            if (!resp.ok) {
                var t = await resp.text().catch(function () { return ''; });
                return 'AI 请求失败（' + resp.status + '）：' + t.substring(0, 200);
            }
            var data = await resp.json();
            return _extractReply(p.apiFormat, data);
        } catch (e) {
            return '对话出错：' + (e.message || e);
        }
    }

    // ========================================================================
    // 扩展模块 3：语音识别与唤醒词（嘿 Verse）
    // ========================================================================
    var _wakeRec = null;
    var _wakeListening = false;
    var _inDialog = false;
    var _dialogHistory = [];

    function _startWake() {
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { console.warn('[V岛] 浏览器不支持语音识别，唤醒词功能不可用'); return; }
        if (_wakeRec) _stopWake();
        var rec = new SR();
        rec.lang = 'zh-CN';
        rec.continuous = true;
        rec.interimResults = true;
        rec.onresult = function (ev) {
            var txt = '';
            for (var i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
            if (txt.indexOf('嘿Verse') !== -1 || txt.indexOf('嘿verse') !== -1 ||
                txt.toLowerCase().indexOf('hey verse') !== -1 || txt.indexOf('嘿 V') !== -1) {
                _onWake();
            }
        };
        rec.onerror = function (e) {
            if (e.error === 'not-allowed') console.warn('[V岛] 麦克风未授权');
        };
        rec.onend = function () {
            if (_wakeListening && !_inDialog) { try { rec.start(); } catch (e) {} }
        };
        try { rec.start(); _wakeListening = true; _wakeRec = rec; }
        catch (e) { console.warn('[V岛] 唤醒监听启动失败:', e); }
    }

    function _stopWake() {
        _wakeListening = false;
        if (_wakeRec) { try { _wakeRec.stop(); } catch (e) {} _wakeRec = null; }
    }

    function _onWake() {
        if (_inDialog) return;
        _inDialog = true;
        _stopWake();
        _setStatusIndicator('正在聆听...', 'listening');
        speak('我在听，请说');
        var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { _endDialog(); return; }
        var rec = new SR();
        rec.lang = 'zh-CN';
        rec.continuous = false;
        rec.interimResults = false;
        var gotReply = false;
        rec.onresult = function (ev) {
            var q = ev.results[0][0].transcript;
            _setStatusIndicator('思考中...', 'processing');
            _askAI(q);
        };
        rec.onerror = function () { _endDialog(); };
        rec.onend = function () {
            if (_inDialog && !gotReply) setTimeout(function () { if (_inDialog && !gotReply) _endDialog(); }, 3000);
        };
        setTimeout(function () { try { rec.start(); } catch (e) {} }, 600);
    }

    async function _askAI(q) {
        _dialogHistory.push({ role: 'user', content: q });
        if (_dialogHistory.length > 10) _dialogHistory = _dialogHistory.slice(-10);
        _dialogHistory.unshift({ role: 'system', content: '你是 V 岛，一个住在 Minecraft 启动器里的语音助手，回答简洁友好，不超过两句话。' });
        var reply = await chatWithAI(_dialogHistory);
        _dialogHistory.shift();
        _dialogHistory.push({ role: 'assistant', content: reply });
        _setStatusIndicator('回答中...', 'processing');
        var self = this;
        speak(reply, function () { _endDialog(); });
    }

    function _endDialog() {
        _inDialog = false;
        _setStatusIndicator('V 岛 · 待命', 'ready');
        _startWake();
    }

    function _setStatusIndicator(text, state) {
        // 在 V 岛 pill 上显示对话状态（复用 subtitle）
        if (!_el) return;
        var subEl = _el.querySelector('.v-island__subtitle');
        if (subEl) subEl.textContent = text;
        // 状态切换 class
        _el.classList.remove('island--idle', 'island--active', 'v-island--listening', 'v-island--processing');
        if (state === 'listening') _el.classList.add('v-island--listening');
        else if (state === 'processing') _el.classList.add('v-island--processing');
        _el.classList.add('v-island--visible');
    }

    // ========================================================================
    // 扩展模块 4：首次引导页（大字浮现 + TTS 朗读）
    // ========================================================================
    function _isOnboardingComplete() {
        return localStorage.getItem('v-island-onboarding-complete') === 'true';
    }

    function _completeOnboarding() {
        localStorage.setItem('v-island-onboarding-complete', 'true');
    }

    function _resetOnboarding() {
        localStorage.removeItem('v-island-onboarding-complete');
    }

    function _showOnboarding() {
        // 动态创建引导页 DOM
        var existing = document.getElementById('v-island-onboarding');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'v-island-onboarding';
        overlay.className = 'v-island-onboarding';
        overlay.innerHTML =
            '<div class="v-island-onboarding__bg"></div>' +
            '<div class="v-island-onboarding__content">' +
                '<div class="v-island-onboarding__phase" data-phase="greeting">' +
                    '<h1 class="v-island-onboarding__title" data-line="1">Hi～我是 V 岛</h1>' +
                    '<h1 class="v-island-onboarding__title" data-line="2">一个活在你启动器的助手</h1>' +
                    '<h1 class="v-island-onboarding__title" data-line="3">接下来，我将帮助你完成很多工作</h1>' +
                    '<h1 class="v-island-onboarding__title" data-line="4">在此之前，我们先完成一些配置</h1>' +
                '</div>' +
                '<div class="v-island-onboarding__phase" data-phase="provider" style="display:none">' +
                    '<h2 class="v-island-onboarding__subtitle">选择你的 AI 供应商</h2>' +
                    '<p class="v-island-onboarding__desc">接入 AI 后，你可以唤醒 V 岛进行语音对话</p>' +
                    '<div class="v-island-onboarding__providers" id="v-island-onboarding-providers"></div>' +
                    '<div class="v-island-onboarding__config" id="v-island-onboarding-config" style="display:none">' +
                        '<div class="form-group"><label>API Key</label>' +
                            '<input type="password" class="text-input" id="v-island-onboarding-key" placeholder="粘贴你的 API Key"></div>' +
                        '<div class="form-group"><label>模型</label>' +
                            '<select class="select-input" id="v-island-onboarding-model"></select></div>' +
                    '</div>' +
                    '<div class="v-island-onboarding__actions">' +
                        '<button class="btn btn-ghost" id="v-island-onboarding-skip">先不配置</button>' +
                        '<button class="btn btn-primary" id="v-island-onboarding-next" disabled>下一步</button>' +
                    '</div>' +
                '</div>' +
                '<div class="v-island-onboarding__phase" data-phase="done" style="display:none">' +
                    '<h1 class="v-island-onboarding__title">准备就绪</h1>' +
                    '<p class="v-island-onboarding__desc">说「嘿 Verse」唤醒 V 岛，开始对话吧</p>' +
                    '<div class="v-island-onboarding__actions" style="margin-top:24px">' +
                        '<button class="btn btn-primary" id="v-island-onboarding-finish">进入 V 岛</button>' +
                    '</div>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);
        requestAnimationFrame(function () { overlay.classList.add('v-island-onboarding--visible'); });

        _runGreetingPhase();
    }

    function _hideOnboarding() {
        var overlay = document.getElementById('v-island-onboarding');
        if (!overlay) return;
        overlay.classList.add('v-island-onboarding--fadeout');
        setTimeout(function () {
            overlay.classList.remove('v-island-onboarding--visible', 'v-island-onboarding--fadeout');
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }, 600);
    }

    function _runGreetingPhase() {
        var lines = document.querySelectorAll('.v-island-onboarding__phase[data-phase="greeting"] .v-island-onboarding__title');
        var texts = ['Hi～我是 V 岛', '一个活在你启动器的助手', '接下来，我将帮助你完成很多工作', '在此之前，我们先完成一些配置'];
        var i = 0;
        var self = this;
        var step = function () {
            if (i >= lines.length) {
                setTimeout(function () { _switchPhase('provider'); _runProviderPhase(); }, 1200);
                return;
            }
            var el = lines[i];
            if (el) el.classList.add('v-appear');
            speak(texts[i], function () { i++; setTimeout(step, 400); });
        };
        setTimeout(step, 500);
    }

    function _switchPhase(name) {
        var phases = document.querySelectorAll('.v-island-onboarding__phase');
        for (var i = 0; i < phases.length; i++) {
            phases[i].style.display = (phases[i].getAttribute('data-phase') === name) ? '' : 'none';
        }
    }

    function _runProviderPhase() {
        var grid = document.getElementById('v-island-onboarding-providers');
        var cfgBox = document.getElementById('v-island-onboarding-config');
        var nextBtn = document.getElementById('v-island-onboarding-next');
        var skipBtn = document.getElementById('v-island-onboarding-skip');
        if (!grid) return;

        grid.innerHTML = '';
        var selectedProvider = null;
        if (cfgBox) cfgBox.style.display = 'none';
        if (nextBtn) nextBtn.disabled = true;

        // 先绑定按钮事件（无论供应商是否加载成功）
        if (skipBtn) skipBtn.onclick = function () { _saveProviderSelection(null); _switchPhase('done'); };
        if (nextBtn) nextBtn.onclick = function () { _saveProviderSelection(selectedProvider); _switchPhase('done'); };

        // 渲染供应商列表
        Object.keys(AI_PROVIDERS).forEach(function (id) {
            var p = AI_PROVIDERS[id];
            var card = document.createElement('div');
            card.className = 'v-island-onboarding-provider-card';
            card.innerHTML = '<img src="img/providers/' + p.icon + '.png" alt="" onerror="this.style.visibility=\'hidden\'"><span>' + p.name + '</span>';
            card.onclick = function () {
                var all = grid.querySelectorAll('.v-island-onboarding-provider-card');
                for (var j = 0; j < all.length; j++) all[j].classList.remove('v-island-onboarding-provider-card--active');
                card.classList.add('v-island-onboarding-provider-card--active');
                selectedProvider = id;
                _showProviderConfig(id, nextBtn);
            };
            grid.appendChild(card);
        });

        // 完成按钮
        var finishBtn = document.getElementById('v-island-onboarding-finish');
        if (finishBtn) finishBtn.onclick = function () {
            _completeOnboarding();
            stopSpeak();
            _hideOnboarding();
            _startVoiceAssistant();
        };
    }

    function _showProviderConfig(id, nextBtn) {
        var p = AI_PROVIDERS[id];
        var cfgBox = document.getElementById('v-island-onboarding-config');
        var keyInput = document.getElementById('v-island-onboarding-key');
        var modelSel = document.getElementById('v-island-onboarding-model');
        if (!cfgBox || !p) return;
        cfgBox.style.display = '';
        if (modelSel) {
            modelSel.innerHTML = '';
            (p.models || []).forEach(function (m) {
                var opt = document.createElement('option');
                opt.value = m.id; opt.textContent = m.name + (m.free ? ' (免费)' : '');
                modelSel.appendChild(opt);
            });
        }
        var check = function () { if (nextBtn) nextBtn.disabled = !(keyInput && keyInput.value && keyInput.value.trim()); };
        if (keyInput) { keyInput.value = ''; keyInput.oninput = check; }
        check();
    }

    function _saveProviderSelection(providerId) {
        if (!providerId) return;
        var keyInput = document.getElementById('v-island-onboarding-key');
        var modelSel = document.getElementById('v-island-onboarding-model');
        var cfg = _getAIConfig();
        cfg.provider = providerId;
        cfg.apiKey = keyInput ? keyInput.value.trim() : '';
        cfg.model = modelSel ? modelSel.value : '';
        _saveAIConfig(cfg);
    }

    // 启动语音助手（引导完成后或已启用时调用）
    function _startVoiceAssistant() {
        if (!isEnabled()) return;
        _ensureHoverZone();
        _startWake();
        console.log('[V岛] 语音助手已启动，说"嘿 Verse"唤醒');
    }

    // ========================================================================
    // V 岛开关初始化（从 other-settings.js 迁移过来）
    // ========================================================================
    function _initToggle() {
        var el = document.getElementById('vIsland');
        if (!el) return;
        // 恢复保存的状态
        var saved = localStorage.getItem('vIsland-enabled');
        if (saved === 'true') {
            el.checked = true;
            document.body.classList.add('v-island-enabled');
        }
        // 启动时：已启用且已完成引导 → 直接启动语音助手（不主动弹引导）
        if (el.checked && _isOnboardingComplete()) {
            _startVoiceAssistant();
        }
        el.addEventListener('change', function () {
            localStorage.setItem('vIsland-enabled', el.checked ? 'true' : 'false');
            if (el.checked) {
                document.body.classList.add('v-island-enabled');
                _ensureHoverZone();
                preview();
                // 用户主动勾选时：若未完成引导，才弹引导页
                if (!_isOnboardingComplete()) {
                    setTimeout(function () { _showOnboarding(); }, 800);
                } else {
                    _startVoiceAssistant();
                }
            } else {
                document.body.classList.remove('v-island-enabled');
                _stopWake();
                stopSpeak();
                dismiss();
            }
        });

        // "重新播放引导"按钮
        var replayBtn = document.getElementById('v-island-replay-onboarding');
        if (replayBtn) {
            replayBtn.onclick = function () {
                _resetOnboarding();
                _showOnboarding();
            };
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _initToggle);
    } else {
        _initToggle();
    }

    // ========================================================================
    // 公开接口
    // ========================================================================
    window.DynamicIsland = {
        show: show,
        update: update,
        dismiss: dismiss,
        preview: preview,
        setupHoverZone: setupHoverZone,
        isEnabled: isEnabled,
        isVisible: isVisible,
        // 扩展接口
        speak: speak,
        stopSpeak: stopSpeak,
        chatWithAI: chatWithAI,
        showOnboarding: _showOnboarding,
        AI_PROVIDERS: AI_PROVIDERS
    };
})();
