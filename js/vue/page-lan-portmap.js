/* page-lan-portmap.js - 红石联机页 Vue 组件
 * 改造自原端口映射页，对接红石联机（RedstoneOnline）服务端 API。
 *
 * UI 布局对齐红石联机模组游戏内 GUI（RedstoneScreen.java）：
 *   三级标签页：联机（主操作）/ 日志 / 服务器
 *   联机标签页居中紧凑布局：服务器循环选择 → 最大人数 → 开启/关闭隧道
 *   日志标签页：滚动日志窗口
 *   服务器标签页：API Key 管理 + 节点列表
 *
 * 所有网络操作通过主进程 IPC 完成（electronAPI.redstoneOnline.*）。
 */
const PageLanPortmap = {
  template: `
    <div class="page-header">
      <h2>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:22px;height:22px;margin-right:8px;vertical-align:-4px;color:#e74c3c">
          <rect x="2" y="2" width="20" height="20" rx="4" fill="currentColor" opacity="0.15"/>
          <path d="M12 4L12 8" stroke="currentColor" stroke-linecap="round"/>
          <path d="M6 12L10 12" stroke="currentColor" stroke-linecap="round"/>
          <path d="M14 12L18 12" stroke="currentColor" stroke-linecap="round"/>
          <path d="M12 16L12 20" stroke="currentColor" stroke-linecap="round"/>
          <circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.5"/>
          <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
        </svg>
        红石联机
      </h2>
      <p class="page-subtitle">基于 frp 的内网穿透，一键开启外网联机</p>
    </div>

    <!-- 三级标签页 -->
    <div class="lan-tabs redstone-tabs" style="max-width:360px;margin:0 auto 16px">
      <button class="lan-tab active" data-redstone-tab="connect" onclick="redstoneSwitchTab('connect')">联机</button>
      <button class="lan-tab" data-redstone-tab="log" onclick="redstoneSwitchTab('log')">日志</button>
      <button class="lan-tab" data-redstone-tab="server" onclick="redstoneSwitchTab('server')">服务器</button>
    </div>

    <!-- ===== 联机标签页（对齐 RedstoneScreen.java 布局） ===== -->
    <div id="redstone-tab-connect" class="redstone-tab-content" style="display:block">
      <div id="redstone-connect-status" style="text-align:center;margin:8px 0 16px">
        <span id="redstone-status-dot" class="lan-status-dot disconnected"></span>
        <span id="redstone-status-text" style="margin-left:6px;font-size:13px;color:var(--text-secondary)">未连接</span>
      </div>
      <div style="max-width:280px;margin:0 auto;display:flex;flex-direction:column;align-items:center;gap:6px">
        <!-- 服务器循环按钮（对齐模组：点击切换下一个服务器） -->
        <button id="redstone-server-btn" onclick="redstoneCycleServer()" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text-primary);font-size:13px;text-align:center;cursor:default">
          服务器: 加载中...
        </button>

        <!-- 最大人数（对齐模组：label + input 同行） -->
        <div style="width:100%;display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary)">
          <span style="font-size:13px;color:var(--text-secondary);min-width:60px">最大人数</span>
          <input type="number" id="redstone-max-players" value="5" min="1" max="99" style="flex:1;padding:0;border:none;background:transparent;color:var(--text-primary);font-size:13px;text-align:right">
        </div>

        <!-- 开启/关闭隧道按钮（对齐模组：主操作按钮） -->
        <button id="redstone-action-btn" onclick="redstoneToggle()" class="btn btn-primary" style="width:100%;justify-content:center;margin-top:10px;padding:10px 0;font-size:15px">开启隧道</button>

        <!-- 隧道已连接状态的地址信息 -->
        <div id="redstone-connected-info" style="display:none;width:100%;text-align:center">
          <div style="padding:14px;background:rgba(16,185,129,0.1);border-radius:10px;margin-top:4px">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px">联机地址</div>
            <div id="redstone-room-addr" style="font-family:monospace;font-size:20px;font-weight:700;color:var(--green);margin:4px 0">--</div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">已复制到剪贴板</div>
            <button class="btn btn-secondary btn-sm" onclick="redstoneCopyAddr()" style="margin:0 auto">重新复制</button>
          </div>
        </div>
      </div>

      <!-- 使用步骤提示 -->
      <div class="lan-tip-box" style="max-width:360px;margin:20px auto 0">
        <div class="lan-tip-title">使用步骤</div>
        <ol class="lan-tip-list">
          <li>启动 Minecraft 并进入存档</li>
          <li>按 ESC → 对局域网开放（端口保持 25565）</li>
          <li>切回启动器，点击"开启隧道"</li>
          <li>地址自动复制，发给朋友即可加入</li>
        </ol>
      </div>
    </div>

    <!-- ===== 日志标签页 ===== -->
    <div id="redstone-tab-log" class="redstone-tab-content" style="display:none">
      <div style="max-width:600px;margin:0 auto;padding:0 16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-size:13px;font-weight:600;color:var(--text-primary)">连接日志</div>
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('redstone-room-log').textContent='';addRedstoneLog('日志已清空')">清空</button>
        </div>
        <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:12px;max-height:320px;min-height:120px;overflow-y:auto;font-family:monospace;font-size:12px;line-height:1.7;white-space:pre-wrap;color:var(--text-primary)" id="redstone-room-log"></div>
      </div>
    </div>

    <!-- ===== 服务器标签页 ===== -->
    <div id="redstone-tab-server" class="redstone-tab-content" style="display:none">
      <div style="max-width:400px;margin:0 auto;padding:0 16px">
        <!-- API Key -->
        <div style="margin-bottom:20px">
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px">API Key</div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="redstone-apikey" readonly style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);color:var(--text-primary);font-family:monospace;font-size:12px">
            <button class="btn btn-secondary btn-sm" onclick="redstoneCopyApikey()">复制</button>
            <button class="btn btn-secondary btn-sm" onclick="redstoneResetApikey()">重置</button>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">首次使用自动生成，重启不丢失</div>
        </div>

        <!-- 服务器节点列表 -->
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px">服务器节点</div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px" id="redstone-server-info">正在加载节点列表...</div>
          <button class="btn btn-secondary btn-sm" onclick="redstoneRefreshServers()" style="width:100%;justify-content:center;margin-bottom:8px">刷新节点列表</button>
        </div>
      </div>
    </div>
  `
};

window.VersePC = window.VersePC || {};
window.VersePC.PageLanPortmap = PageLanPortmap;
