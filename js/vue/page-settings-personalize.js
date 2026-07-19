/* page-settings-personalize.js - 个性化设置页 Vue 组件（渐进式改造）
 * 原则：
 *   1. CSS 一行不动（class 名保留原样）
 *   2. HTML 结构原样搬运（标签、层级、id 全部不变）
 *   3. JS 函数全部复用（来自 js/app/*.js 的全局函数）
 */
const PageSettingsPersonalize = {
  template: `
          <div class="page-header">
            <h2>个性化设置</h2>
          </div>
          <div class="settings-container">
            <div class="card">
              <h3>主题外观</h3>
              <div class="form-group">
                <label>主题颜色</label>
                <div class="theme-picker-grid">
                  <div class="theme-option" data-theme="dark" onclick="selectTheme(this)">
                    <div class="theme-swatch">
                      <div class="theme-dot" style="background: #ffffff;"></div>
                      <div class="theme-dot" style="background: #d0d0d0;"></div>
                      <div class="theme-dot" style="background: #0a0a0a;"></div>
                    </div>
                    <span class="theme-name">黑色</span>
                  </div>
                  <div class="theme-option active" data-theme="light" onclick="selectTheme(this)">
                    <div class="theme-swatch">
                      <div class="theme-dot" style="background: #1a1a1a;"></div>
                      <div class="theme-dot" style="background: #333333;"></div>
                      <div class="theme-dot" style="background: #ffffff;"></div>
                    </div>
                    <span class="theme-name">白色</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="card">
              <h3>背景</h3>
              <div class="form-group">
                <label>选择背景风格</label>
                <div class="wallpaper-picker-grid wallpaper-picker-text-only">
                  <div class="wallpaper-option active" data-wallpaper="none" onclick="selectWallpaper(this)">
                    <span class="wallpaper-name">无背景</span>
                  </div>
                  <div class="wallpaper-option" data-wallpaper="panorama" onclick="selectWallpaper(this)">
                    <span class="wallpaper-name">MC全景</span>
                  </div>
                  <div class="wallpaper-option" data-wallpaper="customImage" onclick="selectWallpaper(this)">
                    <span class="wallpaper-name">自定义图片</span>
                  </div>
                  <div class="wallpaper-option" data-wallpaper="customVideo" onclick="selectWallpaper(this)">
                    <span class="wallpaper-name">自定义视频</span>
                  </div>
                  <div class="wallpaper-option" data-wallpaper="auroraVideo" onclick="selectWallpaper(this)">
                    <span class="wallpaper-name">麦香</span>
                  </div>
                  <span class="form-hint">除 无背景 选项，其他选项均会大量消耗性能与内存。开启后卡顿为正常现象</span>
                </div>
              </div>
              <div class="form-group" id="panorama-theme-group" style="display:none;">
                <label>全景主题</label>
                <div class="wallpaper-picker-grid wallpaper-picker-text-only">
                  <div class="panorama-theme-option active" data-theme="overworld" onclick="selectPanoramaTheme(this)">
                    <span class="wallpaper-name">主世界</span>
                  </div>
                  <div class="panorama-theme-option" data-theme="nether" onclick="selectPanoramaTheme(this)">
                    <span class="wallpaper-name">下界</span>
                  </div>
                  <div class="panorama-theme-option" data-theme="wild" onclick="selectPanoramaTheme(this)">
                    <span class="wallpaper-name">荒野</span>
                  </div>
                  <div class="panorama-theme-option" data-theme="end" onclick="selectPanoramaTheme(this)">
                    <span class="wallpaper-name">试炼</span>
                  </div>
                  <div class="panorama-theme-option" data-theme="darkforest" onclick="selectPanoramaTheme(this)">
                    <span class="wallpaper-name">蜜蜂林地</span>
                  </div>
                  <div class="panorama-theme-option" data-theme="desert" onclick="selectPanoramaTheme(this)">
                    <span class="wallpaper-name">地下洞穴</span>
                  </div>
                  <div class="panorama-theme-option" data-theme="mountains" onclick="selectPanoramaTheme(this)">
                    <span class="wallpaper-name">山脉</span>
                  </div>
                  <div class="panorama-theme-option" data-theme="cherry" onclick="selectPanoramaTheme(this)">
                    <span class="wallpaper-name">樱花</span>
                  </div>
                  <div class="panorama-theme-option" data-theme="deep_dark" onclick="selectPanoramaTheme(this)">
                    <span class="wallpaper-name">苍白森林</span>
                  </div>
                </div>
              </div>
              <div class="wallpaper-control-row" id="panoramaSpeedRow" style="display:none;">
                <label>转速</label>
                <input type="range" min="1" max="20" value="5" step="1" id="panoramaSpeedSlider" oninput="onPanoramaSpeedChange(this.value)" style="flex:1;margin:0 12px;">
                <span id="panoramaSpeedLabel" style="min-width:20px;text-align:center;">5</span>
              </div>
              <div class="wallpaper-control-row" id="panoramaMouseFollowRow" style="display:none;">
                <label>跟随鼠标</label>
                <label class="switch" style="margin-left:12px;">
                  <input type="checkbox" id="panoramaMouseFollowToggle" onchange="onPanoramaMouseFollowChange(this.checked)">
                  <span class="slider"></span>
                </label>
              </div>
              <div class="form-group" id="custom-wallpaper-file-group" style="display:none;">
                <label id="custom-wallpaper-file-label">选择文件</label>
                <div class="custom-wallpaper-file-row">
                  <button class="btn btn-secondary btn-sm" onclick="pickCustomWallpaperFile()">选择文件</button>
                  <span id="custom-wallpaper-file-name" class="custom-wallpaper-file-name">未选择</span>
                </div>
                <div id="custom-wallpaper-drop-zone" class="custom-wallpaper-drop-zone">
                  拖放图片到此处
                </div>
              </div>
              <div class="form-group" id="wallpaper-opacity-group" style="display:none;">
                <label>不透明度 <span id="wallpaper-opacity-value">100%</span></label>
                <input type="range" id="wallpaper-opacity-slider" min="0" max="100" value="100" class="wallpaper-slider" oninput="onWallpaperOpacityChange(this.value)">
              </div>
              <div class="form-group" id="wallpaper-blur-group" style="display:none;">
                <label>背景模糊 <span id="wallpaper-blur-value">0px</span></label>
                <input type="range" id="wallpaper-blur-slider" min="0" max="40" value="0" class="wallpaper-slider" oninput="onWallpaperBlurChange(this.value)">
              </div>
              <div class="form-group" id="wallpaper-fit-group" style="display:none;">
                <label>自适应方式</label>
                <select id="wallpaper-fit-select" class="custom-select" onchange="onWallpaperFitChange(this.value)">
                  <option value="smart">智能</option>
                  <option value="center">居中</option>
                  <option value="cover" selected>适应</option>
                  <option value="stretch">拉伸</option>
                  <option value="tile">平铺</option>
                  <option value="topLeft">左上</option>
                  <option value="topRight">右上</option>
                  <option value="bottomLeft">左下</option>
                  <option value="bottomRight">右下</option>
                </select>
              </div>
            </div>

            <div class="card">
              <h3>视觉效果</h3>
              <div class="form-group">
                <label class="checkbox-label">
                  <input type="checkbox" id="setting-glass-effect" onchange="toggleGlassEffect(this.checked)">
                  <span>毛玻璃效果</span>
                </label>
                <span class="form-hint">开启后界面元素将呈现半透明毛玻璃质感，关闭可提升性能</span>
              </div>
            </div>

            <div class="form-actions">
              <button class="btn btn-primary" onclick="savePersonalizeSettings()">保存设置</button>
              <button class="btn btn-secondary" onclick="resetPersonalizeSettings()">重置默认</button>
            </div>
          </div>
  `
};

window.VersePC = window.VersePC || {};
window.VersePC.PageSettingsPersonalize = PageSettingsPersonalize;
