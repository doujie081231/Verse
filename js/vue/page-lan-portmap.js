/* page-lan-portmap.js - 端口映射页 Vue 组件（渐进式改造）
 * 原则：
 *   1. CSS 一行不动（class 名保留原样）
 *   2. HTML 结构原样搬运（标签、层级、id 全部不变）
 *   3. JS 函数全部复用（来自 js/app/*.js 的全局函数）
 */
const PageLanPortmap = {
  template: `
          <div class="page-header">
            <h2>端口映射联机</h2>
            <p class="page-subtitle">通过 UPnP 或手动端口转发实现远程联机</p>
          </div>
          <div class="lan-container">
            <div class="lan-status-card" id="portmap-status-card">
              <div class="lan-status-dot" id="portmap-status-dot"></div>
              <div class="lan-status-info">
                <div class="lan-status-title" id="portmap-status-title">未连接</div>
                <div class="lan-status-desc" id="portmap-status-desc">创建房间或加入朋友的房间</div>
              </div>
            </div>
            <div class="lan-tabs" id="portmap-tabs">
              <button class="lan-tab active" data-panel="portmap-create-panel" onclick="switchLanTab('portmap', 'create', this)">创建房间</button>
              <button class="lan-tab" data-panel="portmap-join-panel" onclick="switchLanTab('portmap', 'join', this)">加入房间</button>
            </div>
            <div class="lan-room-panel" id="portmap-create-panel">
              <div class="lan-create-form">
                <div class="lan-create-field">
                  <label>房间名称</label>
                  <input type="text" id="portmap-create-name" placeholder="我的房间" class="lan-join-input">
                </div>
                <div class="lan-create-field">
                  <label>游戏端口</label>
                  <input type="number" id="portmap-create-port" value="25565" class="lan-join-input">
                </div>
                <div class="lan-create-field">
                  <label>玩家名称</label>
                  <input type="text" id="portmap-create-player-name" placeholder="你的游戏名称" class="lan-join-input">
                </div>
                <div class="lan-create-field">
                  <label class="lan-checkbox-label">
                    <input type="checkbox" id="portmap-create-upnp" checked>
                    <span>自动 UPnP 端口映射</span>
                  </label>
                  <div style="font-size:11px;color:var(--text-muted);margin-top:4px">自动配置路由器端口转发，无需手动设置</div>
                  <button class="btn btn-secondary btn-sm" onclick="portmapUPnPDiagnose()" style="margin-top:8px;font-size:11px">诊断 UPnP</button>
                </div>
                <div class="lan-tip-box">
                  <div class="lan-tip-title"><svg class="lan-tip-icon" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>如果 UPnP 失败，请手动配置端口转发：</div>
                  <ol class="lan-tip-list">
                    <li>打开路由器管理页面（通常是 192.168.1.1 或 192.168.0.1）</li>
                    <li>找到"端口转发/虚拟服务器"设置</li>
                    <li>添加规则：将端口 <span id="portmap-manual-port" class="lan-highlight">25565</span> 转发到本机 IP</li>
                    <li>确保防火墙允许 Java 通过端口 <span id="portmap-manual-port2" class="lan-highlight">25565</span></li>
                  </ol>
                </div>
                <button class="btn btn-primary btn-lg" onclick="portmapDoCreate()" style="width:100%;justify-content:center">创建房间</button>
              </div>
            </div>
            <div class="lan-room-panel" id="portmap-join-panel" style="display:none">
              <div class="lan-create-form">
                <div class="lan-tip-box" style="background:rgba(74,158,255,0.08)">
                  <div class="lan-tip-title" style="color:var(--accent)">加入步骤</div>
                  <ol class="lan-tip-list">
                    <li>向房主获取连接地址（IP:端口）</li>
                    <li>在下方输入房主的连接地址</li>
                    <li>在 Minecraft 多人游戏中添加该地址即可加入</li>
                  </ol>
                </div>
                <div class="lan-create-field">
                  <label>服务器地址</label>
                  <input type="text" id="portmap-join-addr" placeholder="例如: 123.45.67.89:25565" class="lan-join-input">
                </div>
                <div class="lan-create-field">
                  <label>玩家名称</label>
                  <input type="text" id="portmap-join-name" placeholder="你的游戏名称" class="lan-join-input">
                </div>
                <button class="btn btn-primary btn-lg" onclick="portmapDoJoin()" style="width:100%;justify-content:center">复制地址并查看连接指南</button>
              </div>
            </div>
            <div class="lan-room-panel" id="portmap-connected" style="display:none">
              <div class="lan-room-header">
                <h3 id="portmap-connected-title">房间信息</h3>
                <button class="btn btn-danger btn-sm" onclick="portmapLeave()">离开房间</button>
              </div>
              <div class="lan-room-info" style="grid-template-columns:1fr">
                <div class="lan-room-field">
                  <label>连接地址</label>
                  <div class="lan-room-value" id="portmap-room-addr" style="font-family:monospace">--</div>
                  <button class="btn btn-secondary btn-sm" onclick="portmapCopyAddr()">复制</button>
                </div>
                <div class="lan-room-field">
                  <label>游戏端口</label>
                  <div class="lan-room-value" id="portmap-room-port">25565</div>
                </div>
              </div>
              <div class="lan-room-log-section" style="margin-top:12px">
                <div class="lan-room-log-title">连接日志</div>
                <div class="lan-room-log" id="portmap-room-log"></div>
              </div>
            </div>
          </div>
  `
};

window.VersePC = window.VersePC || {};
window.VersePC.PageLanPortmap = PageLanPortmap;
