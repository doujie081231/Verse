/* page-lan-portmap.js - 红石联机页 Vue 组件
 * 改造自原端口映射页，对接红石联机（RedstoneOnline）服务端 API：
 *   - HTTP API (端口 3000)：注册 API Key / 创建隧道 / 关闭隧道
 *   - TCP 控制连接 (端口 7000)：进入连接池 + 隧道数据通道
 *   - 本地中继：游戏端口 ↔ 控制 socket 双向转发
 *
 * UI 风格对齐红石联机模组游戏内 GUI（服务器选择 + 最大人数 + 开/关隧道），
 * 额外补充启动器特有的 API Key 管理和连接日志。
 *
 * 所有网络操作通过主进程 IPC 完成（electronAPI.redstoneOnline.*），
 * 渲染进程只负责 UI 和状态展示。
 */
const PageLanPortmap = {
  template: `
          <div class="page-header">
            <h2>红石联机</h2>
            <p class="page-subtitle">基于 frp 的内网穿透，一键开启外网联机</p>
          </div>
          <div class="lan-container">
            <div class="lan-status-card" id="redstone-status-card">
              <div class="lan-status-dot" id="redstone-status-dot"></div>
              <div class="lan-status-info">
                <div class="lan-status-title" id="redstone-status-title">未连接</div>
                <div class="lan-status-desc" id="redstone-status-desc">选择服务器并开启隧道</div>
              </div>
            </div>

            <div class="lan-room-panel" id="redstone-config-panel">
              <div class="lan-create-form">
                <div class="lan-create-field">
                  <label>服务器</label>
                  <div style="display:flex;gap:8px;align-items:center">
                    <select id="redstone-server-select" class="lan-join-input" style="flex:1"></select>
                    <button class="btn btn-secondary btn-sm" onclick="redstoneRefreshServers()">刷新</button>
                  </div>
                  <div style="font-size:11px;color:var(--text-muted);margin-top:4px" id="redstone-server-info">正在加载节点列表...</div>
                </div>

                <div class="lan-create-field">
                  <label>API Key</label>
                  <div style="display:flex;gap:8px;align-items:center">
                    <input type="text" id="redstone-apikey" class="lan-join-input" readonly style="flex:1;font-family:monospace">
                    <button class="btn btn-secondary btn-sm" onclick="redstoneCopyApikey()">复制</button>
                    <button class="btn btn-secondary btn-sm" onclick="redstoneResetApikey()">重置</button>
                  </div>
                  <div style="font-size:11px;color:var(--text-muted);margin-top:4px">首次使用自动生成，重启不丢失</div>
                </div>

                <div class="lan-create-field">
                  <label>最大人数</label>
                  <input type="number" id="redstone-max-players" value="5" min="1" max="99" class="lan-join-input" style="width:80px">
                  <div style="font-size:11px;color:var(--text-muted);margin-top:4px">0 表示不限制</div>
                </div>

                <div class="lan-create-field">
                  <label>游戏端口</label>
                  <input type="number" id="redstone-game-port" value="25565" min="1" max="65535" class="lan-join-input" style="width:120px">
                  <div style="font-size:11px;color:var(--text-muted);margin-top:4px">需先在游戏内"对局域网开放"且端口固定为此值</div>
                </div>

                <div class="lan-tip-box">
                  <div class="lan-tip-title">使用步骤</div>
                  <ol class="lan-tip-list">
                    <li>启动 Minecraft 并进入存档</li>
                    <li>按 ESC → 对局域网开放（需用其他模组固定端口为 25565）</li>
                    <li>切回启动器，点击下方"开启隧道"按钮</li>
                    <li>隧道就绪后地址会自动复制到剪贴板，发给朋友即可</li>
                  </ol>
                </div>

                <button class="btn btn-primary btn-lg" id="redstone-action-btn" onclick="redstoneToggle()" style="width:100%;justify-content:center">开启隧道</button>
              </div>
            </div>

            <div class="lan-room-panel" id="redstone-connected" style="display:none">
              <div class="lan-room-header">
                <h3 id="redstone-connected-title">隧道信息</h3>
                <button class="btn btn-danger btn-sm" onclick="redstoneToggle()">关闭隧道</button>
              </div>
              <div class="lan-room-info" style="grid-template-columns:1fr">
                <div class="lan-room-field">
                  <label>联机地址</label>
                  <div class="lan-room-value" id="redstone-room-addr" style="font-family:monospace;font-size:16px;color:var(--accent)">--</div>
                  <button class="btn btn-secondary btn-sm" onclick="redstoneCopyAddr()">复制地址</button>
                </div>
                <div class="lan-room-field">
                  <label>隧道端口</label>
                  <div class="lan-room-value" id="redstone-room-port">--</div>
                </div>
              </div>
              <div class="lan-room-log-section" style="margin-top:12px">
                <div class="lan-room-log-title">连接日志</div>
                <div class="lan-room-log" id="redstone-room-log"></div>
              </div>
            </div>
          </div>
  `
};

window.VersePC = window.VersePC || {};
window.VersePC.PageLanPortmap = PageLanPortmap;
