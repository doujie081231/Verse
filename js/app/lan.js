function switchLanTab(page, tab, btnEl) {
    const tabsContainer = btnEl.closest('.lan-tabs');
    tabsContainer.querySelectorAll('.lan-tab').forEach(t => t.classList.remove('active'));
    btnEl.classList.add('active');
    
    if (page === 'terracotta') {
        const hostPanel = document.getElementById('terracotta-host-panel');
        const joinPanel = document.getElementById('terracotta-join-panel');
        const connected = document.getElementById('terracotta-connected');
        if (connected.style.display !== 'none') return;
        hostPanel.style.display = tab === 'host' ? '' : 'none';
        joinPanel.style.display = tab === 'join' ? '' : 'none';
        if (tab === 'host') {
            terracottaHost();
        } else {
            updateTerracottaStatus('陶瓦联机 - 加入房间', '输入房间码加入', 'disconnected');
        }
    } else if (page === 'portmap') {
        const createPanel = document.getElementById('portmap-create-panel');
        const joinPanel = document.getElementById('portmap-join-panel');
        const connected = document.getElementById('portmap-connected');
        if (connected.style.display !== 'none') return;
        createPanel.style.display = tab === 'create' ? '' : 'none';
        joinPanel.style.display = tab === 'join' ? '' : 'none';
    }
}

let terracottaPollTimer = null;
let _terracottaPollRefresher = null;
let terracottaState = { mode: null, connected: false };

function updateTerracottaStatus(title, desc, state) {
    document.getElementById('terracotta-status-title').textContent = title;
    document.getElementById('terracotta-status-desc').textContent = desc;
    const dot = document.getElementById('terracotta-status-dot');
    dot.className = 'lan-status-dot';
    if (state === 'connected') dot.classList.add('connected');
    else if (state === 'connecting') dot.classList.add('connecting');
    else dot.classList.add('disconnected');
}

async function terracottaHost() {
    document.getElementById('terracotta-host-panel').style.display = '';
    document.getElementById('terracotta-join-panel').style.display = 'none';
    document.getElementById('terracotta-connected').style.display = 'none';
    document.getElementById('terracotta-tabs').style.display = '';
    updateTerracottaStatus('陶瓦联机 - 创建房间', '准备创建房间', 'disconnected');
    try {
        const lanResult = await fetch('/api/lan/port');
        if (lanResult.ok) {
            const data = await lanResult.json();
            if (data.port) {
                document.getElementById('terracotta-host-port').value = data.port;
            }
        }
    } catch (e) {}
}

async function terracottaJoin() {
    document.getElementById('terracotta-join-panel').style.display = '';
    document.getElementById('terracotta-host-panel').style.display = 'none';
    document.getElementById('terracotta-connected').style.display = 'none';
    document.getElementById('terracotta-tabs').style.display = '';
    updateTerracottaStatus('陶瓦联机 - 加入房间', '输入房间码加入', 'disconnected');
}

function terracottaBackToActions() {
    document.getElementById('terracotta-host-panel').style.display = '';
    document.getElementById('terracotta-join-panel').style.display = 'none';
    document.getElementById('terracotta-connected').style.display = 'none';
    document.getElementById('terracotta-tabs').style.display = '';
    const tabs = document.getElementById('terracotta-tabs');
    tabs.querySelectorAll('.lan-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
    updateTerracottaStatus('未连接', '创建房间或输入房间码加入', 'disconnected');
}

function terracottaHide() {
    document.getElementById('terracotta-host-panel').style.display = 'none';
    document.getElementById('terracotta-join-panel').style.display = 'none';
    document.getElementById('terracotta-connected').style.display = 'none';
    document.getElementById('terracotta-tabs').style.display = 'none';
    if (terracottaPollTimer) { clearInterval(terracottaPollTimer); terracottaPollTimer = null; }
    if (_terracottaPollRefresher) { clearInterval(_terracottaPollRefresher); _terracottaPollRefresher = null; }
}

async function terracottaStartHost() {
    try {
        const agreed = await terracottaShowAgreement();
        if (!agreed) return;

        const gameStatus = await API.getGameStatus();
        if (!gameStatus.running) {
            showToast('请先启动游戏，然后在游戏内开放局域网联机', 'error');
            return;
        }
        
        let gamePort = gameStatus.lanPort;
        if (!gamePort) {
            const manualPort = parseInt(document.getElementById('terracotta-host-port').value, 10);
            if (manualPort > 0 && manualPort < 65536) {
                gamePort = manualPort;
            }
        }
        if (!gamePort) {
            showToast('请在游戏内先开放局域网联机（按Esc → 对局域网开放）', 'error');
            return;
        }
        
        document.getElementById('terracotta-host-port').value = gamePort;
        
        const playerName = localStorage.getItem('cachedPlayerName') || 'Player';
        showToast('正在初始化陶瓦联机...', 'info');
        
        const result = await API.easytierHost(gamePort, playerName);
        if (result.success) {
            terracottaState = { mode: 'host', connected: true };
            
            document.getElementById('terracotta-host-panel').style.display = 'none';
            document.getElementById('terracotta-connected').style.display = '';
            document.getElementById('terracotta-addr-field').style.display = 'none';
            document.getElementById('terracotta-roomcode').textContent = '等待分配房间码...';
            document.getElementById('terracotta-conn-status').textContent = '正在创建房间...';
            document.getElementById('terracotta-hint').textContent = `已检测到局域网端口 ${gamePort}，房间创建中...`;
            document.getElementById('terracotta-hint').style.background = 'rgba(59,130,246,0.1)';
            document.getElementById('terracotta-hint').style.color = 'var(--blue)';
            
            updateTerracottaStatus('陶瓦联机 - 主机', '正在创建房间...', 'connecting');
            
            terracottaStartPolling();
        }
    } catch (e) {
        showToast('创建联机失败: ' + e.message, 'error');
    }
}

async function terracottaJoinRoom() {
    const codeText = document.getElementById('terracotta-join-code').value.trim();
    if (!codeText) {
        showToast('请输入房间码', 'error');
        return;
    }
    
    try {
        const agreed = await terracottaShowAgreement();
        if (!agreed) return;

        showToast('正在初始化陶瓦联机...', 'info');
        
        const playerName = localStorage.getItem('cachedPlayerName') || 'Player';
        const result = await API.easytierGuest(codeText, playerName);
        if (result.success) {
            terracottaState = { mode: 'guest', connected: true };
            
            document.getElementById('terracotta-join-panel').style.display = 'none';
            document.getElementById('terracotta-connected').style.display = '';
            document.getElementById('terracotta-addr-field').style.display = '';
            document.getElementById('terracotta-roomcode').textContent = '--';
            document.getElementById('terracotta-connect-addr').textContent = '等待分配...';
            document.getElementById('terracotta-conn-status').textContent = '正在连接...';
            document.getElementById('terracotta-hint').textContent = '正在连接到主机...';
            document.getElementById('terracotta-hint').style.background = 'rgba(59,130,246,0.1)';
            document.getElementById('terracotta-hint').style.color = 'var(--blue)';
            
            updateTerracottaStatus('陶瓦联机 - 客户端', '正在连接...', 'connecting');
            
            terracottaStartPolling();
        }
    } catch (e) {
        showToast('加入联机失败: ' + e.message, 'error');
    }
}

async function terracottaDisconnect() {
    try {
        await API.easytierStop();
    } catch (e) {}
    
    terracottaState = { mode: null, connected: false };
    if (terracottaPollTimer) { clearInterval(terracottaPollTimer); terracottaPollTimer = null; }
    
    terracottaBackToActions();
    showToast('已断开陶瓦联机', 'info');
}

function terracottaCopyRoomCode() {
    const code = document.getElementById('terracotta-roomcode').textContent;
    if (!code || code === '--' || code === '等待分配房间码...') return;
    window.electronAPI.clipboard.writeText(code).then(() => {
        showToast('房间码已复制！发送给朋友即可加入', 'success');
    });
}

function terracottaCopyAddr() {
    const addr = document.getElementById('terracotta-connect-addr').textContent;
    if (!addr || addr === '等待分配...') return;
    window.electronAPI.clipboard.writeText(addr).then(() => {
        showToast('连接地址已复制', 'success');
    });
}

function terracottaShowAgreement() {
    const agreementSeen = localStorage.getItem('terracotta_agreement_v2');
    if (agreementSeen) return Promise.resolve(true);
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';
    modal.innerHTML = `<div style="background:var(--bg-primary);border-radius:12px;padding:24px;max-width:500px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
        <h3 style="margin-bottom:12px">陶瓦联机使用须知</h3>
        <div style="color:var(--text-secondary);font-size:13px;line-height:1.7;margin-bottom:16px">
            <p>陶瓦联机基于 <a href="https://github.com/EasyTier/EasyTier" style="color:var(--primary)">EasyTier</a> 开源项目，由第三方提供公共节点。</p>
            <p style="margin-top:8px">• 联机质量取决于网络环境，可能有延迟</p>
            <p>• 公共节点由社区维护，不保证100%可用</p>
            <p>• 游戏数据通过P2P加密传输，不经过服务器</p>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-primary" id="terracotta-agree-btn">我已了解，开始使用</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
    return new Promise(resolve => {
        document.getElementById('terracotta-agree-btn').onclick = () => {
            localStorage.setItem('terracotta_agreement_v2', '1');
            modal.remove();
            resolve(true);
        };
        modal.onclick = (e) => { if (e.target === modal) { modal.remove(); resolve(false); } };
    });
}

async function terracottaExportLog() {
    try {
        const result = await API.easytierLog();
        if (result && result.log) {
            const blob = new Blob([result.log], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `terracotta-log-${new Date().toISOString().slice(0,10)}.txt`;
            a.click();
            URL.revokeObjectURL(url);
            showToast('日志已导出', 'success');
        } else {
            showToast('暂无日志', 'info');
        }
    } catch (e) {
        showToast('导出日志失败: ' + e.message, 'error');
    }
}

let _lastTerracottaStateIndex = -1;
let _terracottaPollFailCount = 0;

function terracottaStartPolling() {
    if (terracottaPollTimer) clearInterval(terracottaPollTimer);
    if (_terracottaPollRefresher) { clearInterval(_terracottaPollRefresher); _terracottaPollRefresher = null; }
    _lastTerracottaStateIndex = -1;
    _terracottaPollFailCount = 0;
    let pollInterval = 3000;
    let idleCount = 0;

    const doPoll = async () => {
        try {
            const result = await API.easytierStatus();
            _terracottaPollFailCount = 0;
            if (!result.running) {
                _terracottaPollFailCount++;
                if (_terracottaPollFailCount < 5) return;
                document.getElementById('terracotta-conn-status').textContent = '已断开';
                document.getElementById('terracotta-conn-status').style.color = 'var(--red)';
                clearInterval(terracottaPollTimer);
                terracottaPollTimer = null;
                return;
            }
            if (!result.state) return;

            const state = result.state;
            const stateType = state.state;
            const stateIndex = result.stateIndex || state.index || -1;

            if (stateIndex > 0 && stateIndex === _lastTerracottaStateIndex) {
                idleCount++;
                if (idleCount > 5) pollInterval = 5000;
                return;
            }
            _lastTerracottaStateIndex = stateIndex;
            idleCount = 0;
            pollInterval = 1500;
            if (terracottaPollTimer) { clearInterval(terracottaPollTimer); terracottaPollTimer = setInterval(doPoll, pollInterval); }

            const profiles = result.profiles || state.profiles || [];
            const difficulty = result.difficulty || state.difficulty || null;
            const errorType = result.errorType || null;
            const errorMessage = result.errorMessage || null;

            if (terracottaState.mode === 'host') {
                if (stateType === 'host-scanning') {
                    document.getElementById('terracotta-conn-status').textContent = '正在扫描局域网游戏...';
                    document.getElementById('terracotta-conn-status').style.color = 'var(--blue)';
                } else if (stateType === 'host-starting') {
                    document.getElementById('terracotta-conn-status').textContent = '正在启动房间...';
                    document.getElementById('terracotta-conn-status').style.color = 'var(--blue)';
                } else if (stateType === 'host-ok') {
                    const roomObj = state.room;
                    const roomCode = (typeof roomObj === 'object' && roomObj !== null) ? (roomObj.code || '') : (roomObj || result.roomCode || '');
                    document.getElementById('terracotta-roomcode').textContent = roomCode;
                    const profileText = profiles.length > 0 ? ` (${profiles.length}人已连接)` : '';
                    document.getElementById('terracotta-conn-status').textContent = '房间已创建 (P2P)' + profileText;
                    document.getElementById('terracotta-conn-status').style.color = 'var(--green)';
                    document.getElementById('terracotta-hint').textContent = '将房间码发送给朋友即可联机';
                    document.getElementById('terracotta-hint').style.background = 'rgba(16,185,129,0.1)';
                    document.getElementById('terracotta-hint').style.color = 'var(--green)';
                    updateTerracottaStatus('陶瓦联机 - 主机', `房间码: ${roomCode}`, 'connected');
                } else if (stateType === 'exception') {
                    const errMsg = errorMessage || '连接异常';
                    document.getElementById('terracotta-conn-status').textContent = errMsg;
                    document.getElementById('terracotta-conn-status').style.color = 'var(--red)';
                    document.getElementById('terracotta-hint').textContent = errorType ? `错误类型: ${errorType}` : '';
                    document.getElementById('terracotta-hint').style.background = 'rgba(239,68,68,0.1)';
                    document.getElementById('terracotta-hint').style.color = 'var(--red)';
                }
            } else if (terracottaState.mode === 'guest') {
                if (stateType === 'guest-connecting') {
                    document.getElementById('terracotta-conn-status').textContent = '正在连接...';
                    document.getElementById('terracotta-conn-status').style.color = 'var(--blue)';
                } else if (stateType === 'guest-starting') {
                    const diffMap = { 'EASIEST': '和平', 'SIMPLE': '简单', 'MEDIUM': '普通', 'TOUGH': '困难' };
                    const diffText = difficulty && difficulty !== 'UNKNOWN' ? ` | 难度: ${diffMap[difficulty] || difficulty}` : '';
                    document.getElementById('terracotta-conn-status').textContent = '正在建立P2P连接...' + diffText;
                    document.getElementById('terracotta-conn-status').style.color = 'var(--blue)';
                } else if (stateType === 'guest-ok') {
                    const rawUrl = state.url || result.virtualIP || '';
                    const connectUrl = rawUrl.startsWith('127.0.0.1') ? rawUrl : `127.0.0.1${rawUrl.includes(':') ? ':' + rawUrl.split(':').pop() : ''}`;
                    document.getElementById('terracotta-roomcode').textContent = connectUrl;
                    document.getElementById('terracotta-connect-addr').textContent = connectUrl;
                    const profileText = profiles.length > 0 ? ` (${profiles.length}人在线)` : '';
                    document.getElementById('terracotta-conn-status').textContent = '已连接 (P2P)' + profileText;
                    document.getElementById('terracotta-conn-status').style.color = 'var(--green)';
                    document.getElementById('terracotta-hint').textContent = `在Minecraft多人游戏中添加服务器地址: ${connectUrl}`;
                    document.getElementById('terracotta-hint').style.background = 'rgba(16,185,129,0.1)';
                    document.getElementById('terracotta-hint').style.color = 'var(--green)';
                    updateTerracottaStatus('陶瓦联机 - 客户端', `连接地址: ${connectUrl}`, 'connected');
                } else if (stateType === 'exception') {
                    const errMsg = errorMessage || '连接异常';
                    document.getElementById('terracotta-conn-status').textContent = errMsg;
                    document.getElementById('terracotta-conn-status').style.color = 'var(--red)';
                    document.getElementById('terracotta-hint').textContent = errorType ? `错误类型: ${errorType}` : '';
                    document.getElementById('terracotta-hint').style.background = 'rgba(239,68,68,0.1)';
                    document.getElementById('terracotta-hint').style.color = 'var(--red)';
                }
            }
        } catch (e) {
            _terracottaPollFailCount++;
            console.warn(`[Terracotta] 状态轮询失败 (连续${_terracottaPollFailCount}次):`, e.message || e);
            if (_terracottaPollFailCount >= 8) {
                document.getElementById('terracotta-conn-status').textContent = '网络连接异常，请检查网络';
                document.getElementById('terracotta-conn-status').style.color = 'var(--red)';
            }
        }
    };

    doPoll();
    terracottaPollTimer = setInterval(doPoll, pollInterval);

    _terracottaPollRefresher = setInterval(() => {
        if (terracottaPollTimer) {
            clearInterval(terracottaPollTimer);
            terracottaPollTimer = setInterval(doPoll, pollInterval);
        }
    }, 30000);
}

function updatePortmapStatus(title, desc, state) {
    document.getElementById('portmap-status-title').textContent = title;
    document.getElementById('portmap-status-desc').textContent = desc;
    const dot = document.getElementById('portmap-status-dot');
    dot.className = 'lan-status-dot';
    if (state === 'connected') dot.classList.add('connected');
    else if (state === 'connecting') dot.classList.add('connecting');
    else dot.classList.add('disconnected');
}

function portmapCreateRoom() {
    document.getElementById('portmap-create-panel').style.display = '';
    document.getElementById('portmap-join-panel').style.display = 'none';
    document.getElementById('portmap-connected').style.display = 'none';
    document.getElementById('portmap-tabs').style.display = '';
}

function portmapJoinRoom() {
    document.getElementById('portmap-join-panel').style.display = '';
    document.getElementById('portmap-create-panel').style.display = 'none';
    document.getElementById('portmap-connected').style.display = 'none';
    document.getElementById('portmap-tabs').style.display = '';
}

function portmapBackToActions() {
    document.getElementById('portmap-create-panel').style.display = '';
    document.getElementById('portmap-join-panel').style.display = 'none';
    document.getElementById('portmap-connected').style.display = 'none';
    document.getElementById('portmap-tabs').style.display = '';
    const tabs = document.getElementById('portmap-tabs');
    tabs.querySelectorAll('.lan-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
    updatePortmapStatus('未连接', '创建房间或加入朋友的房间', 'disconnected');
}

async function portmapDoCreate() {
    const name = document.getElementById('portmap-create-name').value || 'VersePC';
    const port = document.getElementById('portmap-create-port').value || '25565';
    const playerName = document.getElementById('portmap-create-player-name').value || '';
    const useUPnP = document.getElementById('portmap-create-upnp').checked;
    try {
        const res = await fetch('/api/lan/remote-create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, port: parseInt(port), playerName, useUPnP })
        });
        const result = await res.json();
        if (result.success) {
            document.getElementById('portmap-create-panel').style.display = 'none';
            document.getElementById('portmap-connected').style.display = 'block';
            document.getElementById('portmap-connected-title').textContent = name;
            document.getElementById('portmap-room-addr').textContent = result.connectInfo || (result.publicIP ? result.publicIP + ':' + port : (result.localIPs && result.localIPs[0] ? result.localIPs[0] + ':' + port : '检测失败'));
            document.getElementById('portmap-room-port').textContent = port;
            if (result.upnp && result.upnp.success) {
                addPortmapLog('UPnP 端口映射成功');
            } else if (result.upnp) {
                addPortmapLog('端口映射失败: ' + (result.upnp.error || '未知'));
                addPortmapLog('提示: UPnP不可用不影响局域网联机，但远程联机需要路由器开启UPnP或手动设置端口转发');
            }
            addPortmapLog('公网IP: ' + (result.publicIP || '未检测到'));
            addPortmapLog('连接地址: ' + (result.connectInfo || '未获取'));
            updatePortmapStatus('已创建房间', '等待朋友加入...', 'connected');
        } else {
            alert('创建失败: ' + (result.error || '未知错误'));
        }
    } catch(e) {
        alert('创建失败: ' + e.message);
    }
}

function portmapDoJoin() {
    const addr = document.getElementById('portmap-join-addr').value.trim();
    const name = document.getElementById('portmap-join-name').value.trim();
    if (!addr) { alert('请输入服务器地址'); return; }
    navigator.clipboard.writeText(addr).then(() => {
        alert('已复制地址: ' + addr + '\n\n在Minecraft多人游戏中添加该地址即可加入。' + (name ? '\n建议使用名称: ' + name : ''));
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = addr;
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        alert('已复制地址: ' + addr + '\n\n在Minecraft多人游戏中添加该地址即可加入。');
    });
}

function portmapLeave() {
    document.getElementById('portmap-connected').style.display = 'none';
    document.getElementById('portmap-tabs').style.display = '';
    document.getElementById('portmap-create-panel').style.display = '';
    document.getElementById('portmap-join-panel').style.display = 'none';
    const tabs = document.getElementById('portmap-tabs');
    tabs.querySelectorAll('.lan-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
    const logEl = document.getElementById('portmap-room-log');
    if (logEl) logEl.textContent = '';
    updatePortmapStatus('未连接', '创建房间或加入朋友的房间', 'disconnected');
}

async function portmapUPnPDiagnose() {
    try {
        const res = await fetch('/api/lan/upnp-diagnose');
        const result = await res.json();
        if (result.success) {
            let msg = '=== UPnP 诊断 ===\n\n';
            msg += '平台: ' + result.platform + '\n';
            msg += 'UPnP可用: ' + (result.canUseUPnP ? '是' : '否') + '\n\n';
            msg += '检查项目:\n';
            if (result.checks) {
                result.checks.forEach((c, i) => {
                    msg += `  ${i+1}. [${c.status}] ${c.name}: ${typeof c.result === 'object' ? JSON.stringify(c.result) : c.result}\n`;
                });
            }
            if (result.recommendations && result.recommendations.length > 0) {
                msg += '\n建议:\n';
                result.recommendations.forEach((r, i) => {
                    msg += `  ${i+1}. ${r}\n`;
                });
            }
            alert(msg);
        } else {
            alert('UPnP 诊断失败: ' + (result.error || '未知错误'));
        }
    } catch(e) {
        alert('UPnP 诊断失败: ' + e.message);
    }
}

function addPortmapLog(msg) {
    const logEl = document.getElementById('portmap-room-log');
    if (!logEl) return;
    const time = new Date().toLocaleTimeString();
    logEl.textContent += `[${time}] ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

function portmapCopyAddr() {
    const addr = document.getElementById('portmap-room-addr').textContent;
    if (!addr || addr === '--') return;
    navigator.clipboard.writeText(addr).then(() => {
        const btn = document.querySelector('#portmap-connected .lan-room-field:first-child button');
        if (btn) { btn.textContent = '已复制!'; setTimeout(() => { btn.textContent = '复制'; }, 2000); }
    }).catch(() => {});
}
