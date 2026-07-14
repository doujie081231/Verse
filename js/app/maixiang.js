// 麦香主题：页面内显示激活框
function showMaixiangActivateInline() {
    let el = document.getElementById('maixiang-activate-inline');
    if (el) { el.style.display = ''; return; }
    const auroraOpt = document.querySelector('.wallpaper-option[data-wallpaper="auroraVideo"]');
    if (!auroraOpt) return;
    el = document.createElement('div');
    el.id = 'maixiang-activate-inline';
    el.style.cssText = 'margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);';
    el.innerHTML = '<p style="margin:0 0 8px;font-size:13px;color:var(--text-secondary);">请输入麦香主题激活码（VT-开头）</p><div style="display:flex;gap:8px;"><input id="maixiang-activate-input" type="text" placeholder="VT-XXXXXXXXXXXX" style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;outline:none;" /><button id="maixiang-activate-submit" class="btn-primary" style="padding:8px 16px;font-size:13px;" onclick="submitMaixiangActivate()">激活</button></div><p id="maixiang-activate-error" style="display:none;margin:6px 0 0;font-size:12px;color:#ff4444;"></p>';
    auroraOpt.parentElement.insertBefore(el, auroraOpt.nextSibling);
    const input = el.querySelector('input');
    if (input) input.focus();
}

function hideMaixiangActivateInline() {
    const el = document.getElementById('maixiang-activate-inline');
    if (el) el.style.display = 'none';
}

async function submitMaixiangActivate() {
    const input = document.getElementById('maixiang-activate-input');
    const errEl = document.getElementById('maixiang-activate-error');
    const submitBtn = document.getElementById('maixiang-activate-submit');
    if (!input) return;
    const code = input.value.trim();
    if (!code) {
        if (errEl) { errEl.textContent = '请输入激活码'; errEl.style.display = 'block'; }
        return;
    }
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '验证中...'; }
    try {
        const result = await window.electronAPI?.themeActivateVerify?.(code);
        if (result && result.success) {
            hideMaixiangActivateInline();
            if (typeof showToast === 'function') showToast('麦香主题已解锁', 'success');
            else alert('麦香主题已解锁');
            refreshMaixiangLock();
            const auroraOpt = document.querySelector('.wallpaper-option[data-wallpaper="auroraVideo"]');
            if (auroraOpt && typeof selectWallpaper === 'function') selectWallpaper(auroraOpt);
        } else {
            if (errEl) { errEl.textContent = result?.message || '激活失败'; errEl.style.display = 'block'; }
        }
    } catch (e) {
        if (errEl) { errEl.textContent = '验证出错: ' + e.message; errEl.style.display = 'block'; }
    } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '激活'; }
    }
}

// 刷新麦香主题选项的锁标志
async function refreshMaixiangLock() {
    const auroraOpt = document.querySelector('.wallpaper-option[data-wallpaper="auroraVideo"]');
    if (!auroraOpt) return;
    let activated = false;
    try {
        if (window.electronAPI?.themeActivateStatus) {
            const status = await window.electronAPI.themeActivateStatus();
            activated = !!status?.activated;
        }
    } catch (e) {}
    const existingLock = auroraOpt.querySelector('.maixiang-lock');
    if (activated) {
        if (existingLock) existingLock.remove();
    } else {
        if (!existingLock) {
            const lock = document.createElement('span');
            lock.className = 'maixiang-lock';
            lock.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="margin-left:4px;vertical-align:middle;opacity:0.7;"><path d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zm-3 8V6a3 3 0 1 1 6 0v3H9z"/></svg>';
            auroraOpt.appendChild(lock);
        }
    }
}
