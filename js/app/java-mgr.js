function setupJavaPage() {
    document.getElementById('refresh-java-btn').addEventListener('click', loadInstalledJava);
    
    loadInstalledJava();
    loadJavaDownloadList();
}

async function loadInstalledJava() {
    const listEl = document.getElementById('installed-java-list');
    listEl.innerHTML = '<div class="loading">正在检测Java...</div>';
    
    try {
        const result = await API.getInstalledJava();
        
        if (result.java.length === 0) {
            listEl.innerHTML = '<div class="hint">未检测到已安装的Java</div>';
            return;
        }
        
        listEl.innerHTML = result.java.map((j, idx) => `
            <div class="java-item" data-java-index="${idx}">
                <div class="java-item-info">
                    <div class="java-version">
                        Java ${j.majorVersion} (${j.version})
                        <span class="java-badge ${j.source}">${j.source === 'system' ? '系统' : '内置'}</span>
                        ${j.isJdk ? '<span class="java-badge jdk">JDK</span>' : '<span class="java-badge jre">JRE</span>'}
                        ${j.is64Bit ? '<span class="java-badge arch">64位</span>' : '<span class="java-badge arch">32位</span>'}
                    </div>
                    <div class="java-path">${escapeHtml(j.path)}</div>
                </div>
                <div class="java-item-actions">
                    ${j.source === 'bundled' ? `<button class="btn btn-danger btn-sm java-delete-btn" data-java-index="${idx}">删除</button>` : ''}
                </div>
            </div>
        `).join('');

        listEl._javaData = result.java;
    } catch (e) {
        listEl.innerHTML = '<div class="hint">检测Java失败</div>';
    }
}

document.addEventListener('click', function(e) {
    const btn = e.target.closest('.java-delete-btn');
    if (!btn) return;
    const idx = parseInt(btn.dataset.javaIndex, 10);
    const listEl = document.getElementById('installed-java-list');
    if (!listEl || !listEl._javaData || !listEl._javaData[idx]) return;
    const j = listEl._javaData[idx];
    deleteJava(j.javaHome, j.majorVersion);
});

async function deleteJava(javaHome, majorVersion) {
    if (!javaHome) {
        showToast('缺少Java路径信息', 'error');
        return;
    }
    const confirmed = await showConfirmDialog('删除 Java', `确定要删除 Java ${majorVersion} 吗？\n\n将删除: ${javaHome}\n\n此操作不可撤销！`, '删除', '取消');
    if (!confirmed) return;
    
    try {
        const result = await API.deleteJava(javaHome);
        if (result.success) {
            showToast(result.message || 'Java已删除', 'success');
            await loadInstalledJava();
        } else {
            showToast(result.message || '删除失败', 'error');
        }
    } catch (e) {
        showToast('删除Java失败: ' + (e.message || '未知错误'), 'error');
    }
}

async function loadJavaDownloadList() {
    const listEl = document.getElementById('java-download-list');
    listEl.innerHTML = '<div class="loading">正在获取Java版本列表...</div>';
    
    try {
        const result = await API.getJavaList();
        
        if (!result.versions || result.versions.length === 0) {
            listEl.innerHTML = '<div class="hint">无法获取Java版本列表，请检查网络后重试<button class="btn btn-secondary btn-sm" style="margin-left:8px" onclick="loadJavaDownloadList()">重试</button></div>';
            return;
        }
        
        listEl.innerHTML = result.versions.map(j => `
            <div class="java-download-item">
                <div class="java-download-version">Java ${j.majorVersion}</div>
                <div class="java-download-info">版本: ${j.version}</div>
                <button class="btn btn-primary" onclick="downloadJava(${j.majorVersion})">下载</button>
            </div>
        `).join('');
    } catch (e) {
        listEl.innerHTML = '<div class="hint">获取Java版本列表失败: ' + escapeHtml(e.message || '网络错误') + ' <button class="btn btn-secondary btn-sm" style="margin-left:8px" onclick="loadJavaDownloadList()">重试</button></div>';
    }
}

let javaDownloadSessionId = null;
let javaDownloadPollTimer = null;
let javaDownloadProgressHistory = [];

async function downloadJava(majorVersion) {
    try {
        const result = await API.downloadJava(majorVersion);
        javaDownloadSessionId = result.sessionId;
        javaDownloadProgressHistory = [];
        
        document.getElementById('java-download-progress').style.display = 'block';
        document.getElementById('java-progress-fill').style.width = '0%';
        document.getElementById('java-progress-text').textContent = '0%';
        document.getElementById('java-progress-message').textContent = '准备下载...';
        const cancelBtn = document.getElementById('java-cancel-btn');
        if (cancelBtn) { cancelBtn.style.display = 'inline-block'; cancelBtn.disabled = false; cancelBtn.textContent = '取消下载'; }
        
        if (javaDownloadPollTimer) clearInterval(javaDownloadPollTimer);
        javaDownloadPollTimer = setInterval(pollJavaDownloadStatus, 500);
        
        showToast('开始下载Java ' + majorVersion, 'info');
    } catch (e) {
        showToast('启动下载失败: ' + e.message, 'error');
    }
}

async function cancelJavaDownload() {
    if (!javaDownloadSessionId) return;
    const cancelBtn = document.getElementById('java-cancel-btn');
    if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.textContent = '取消中...'; }
    try {
        await API.cancelJavaDownload(javaDownloadSessionId);
        if (javaDownloadPollTimer) { clearInterval(javaDownloadPollTimer); javaDownloadPollTimer = null; }
        const msgEl = document.getElementById('java-progress-message');
        if (msgEl) msgEl.textContent = '下载已取消';
        if (cancelBtn) cancelBtn.style.display = 'none';
        javaDownloadSessionId = null;
        showToast('Java下载已取消', 'info');
    } catch (e) {
        showToast('取消失败: ' + e.message, 'error');
        if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = '取消下载'; }
    }
}

async function pollJavaDownloadStatus() {
    if (!javaDownloadSessionId) return;
    
    try {
        const status = await API.getJavaDownloadStatus(javaDownloadSessionId);
        const now = Date.now();
        
        document.getElementById('java-progress-fill').style.width = status.progress + '%';
        document.getElementById('java-progress-text').textContent = status.progress + '%';
        let msg = status.message || '处理中...';
        if (status.speed && status.speed > 0) {
            const speedKB = (status.speed / 1024).toFixed(1);
            msg += ` (${speedKB} KB/s)`;
        }
        
        javaDownloadProgressHistory.push({ time: now, progress: status.progress });
        if (javaDownloadProgressHistory.length > 20) javaDownloadProgressHistory.shift();
        
        if (status.progress > 0 && status.progress < 100 && javaDownloadProgressHistory.length >= 2) {
            const oldest = javaDownloadProgressHistory[0];
            const elapsed = (now - oldest.time) / 1000;
            const progressDelta = status.progress - oldest.progress;
            if (elapsed > 0 && progressDelta > 0) {
                const progressPerSec = progressDelta / elapsed;
                const remaining = (100 - status.progress) / progressPerSec;
                if (remaining > 0 && remaining < 86400) {
                    msg += ' · 剩余 ' + formatDuration(remaining);
                }
            }
        }
        
        document.getElementById('java-progress-message').textContent = msg;
        
        if (status.status === 'completed') {
            clearInterval(javaDownloadPollTimer);
            javaDownloadPollTimer = null;
            javaDownloadSessionId = null;
            const cancelBtn2 = document.getElementById('java-cancel-btn');
            if (cancelBtn2) cancelBtn2.style.display = 'none';
            
            showToast('Java安装成功！环境变量已自动配置', 'success');
            
            setTimeout(() => {
                document.getElementById('java-download-progress').style.display = 'none';
                loadInstalledJava();
            }, 2000);
        } else if (status.status === 'error') {
            clearInterval(javaDownloadPollTimer);
            javaDownloadPollTimer = null;
            javaDownloadSessionId = null;
            const cancelBtn3 = document.getElementById('java-cancel-btn');
            if (cancelBtn3) cancelBtn3.style.display = 'none';
            
            showToast('安装失败: ' + (status.message || '未知错误'), 'error');
        } else if (status.status === 'cancelled') {
            clearInterval(javaDownloadPollTimer);
            javaDownloadPollTimer = null;
            javaDownloadSessionId = null;
            const cancelBtn4 = document.getElementById('java-cancel-btn');
            if (cancelBtn4) cancelBtn4.style.display = 'none';
            
            document.getElementById('java-progress-message').textContent = '下载已取消';
        }
    } catch (e) {
        console.error('轮询Java下载状态失败:', e);
    }
}
