/**
 * VersePC - Minecraft Launcher
 * Copyright (c) 2026 豆杰. All Rights Reserved.
 *
 * AI TRAINING PROHIBITED: This code is protected by copyright law.
 * Unauthorized use for AI model training, machine learning datasets,
 * or any form of artificial intelligence training is strictly prohibited.
 *
 * This software is proprietary and confidential.
 * Any unauthorized reproduction or distribution is prohibited.
 */

/**
 * app.js - VersePC 前端主应用逻辑
 * ============================================================================
 * 所有渲染进程(前端)的UI交互逻辑，是用户界面的核心控制器。
 *
 * 核心功能：
 * 1. 版本管理 - 版本列表加载、渲染、筛选、选择
 * 2. 启动流程 - 启动按钮处理、启动模态框、进度轮询/SSE监听
 * 3. 模组管理 - 模组搜索、安装、详情、多选操作
 * 4. 系统设置 - Java路径/内存/窗口/语言/下载等设置
 * 5. 账户管理 - Microsoft/离线登录、皮肤显示
 * 6. Java管理 - Java运行时下载、切换、自动检测
 * 7. 整合包 - Modrinth/CurseForge整合包浏览和安装
 * 8. 地图/Saves - 存档和世界管理
 * 9. 资源下载 - 光影/材质/数据包等资源下载
 * 10. 界面框架 - Toast通知、Modal对话框、页面导航
 *
 * 架构说明：
 * - 单页面应用(SPA)架构，通过页面切换实现多视图
 * - 全局状态变量管理应用数据
 * - 通过 API 对象调用后端接口
 * - DOM缓存(domCache)优化频繁的DOM查询
 */

/* 全局状态变量 - 应用数据状态中心 */
let currentVersionTab = 'release';
let allVersions = [];
let installedVersions = [];
let versionIconsTimestamp = Date.now();
let currentModTab = 'installed-mods';
let modSearchOffset = 0;
let modSearchTotal = 0;
let modSearchQuery = '';
let modSearchResults = [];
let _modDownloadVersionId = '';
let currentInstallSessionId = null;
let msAuthPollInterval = null;
let currentLoaderType = 'fabric';
let gameLogEventSource = null;
let currentModDetailId = null;
let currentModDetailSource = 'modrinth';
let previousPage = null;
let modDetailHistory = [];
let modDetailVersions = [];
let modDownloadPollTimers = [];
let _isRestoringModDetail = false;
let _favorites = [];
let _currentFavId = '';
let _favMultiSelectMode = false;
let _favSelectedItems = new Set();
let _favSearchQuery = '';


let launchDepPollTimer = null;
let modMultiSelectMode = false;
let modSelectedIds = new Set();
let modSelectedVersions = new Map();

/* 优化基础设施 - DOM缓存、防抖节流等 */

/* DOM 缓存对象 */




/* 原有函数 */






document.addEventListener('DOMContentLoaded', () => {
  init();
  setTimeout(initSettingsPages, 500);
  renderSponsors();
  loadMachineId();
  updateActivationStatus();
  // 启动时不再自动弹出"更新公告"，新版本提示由更新检测单独处理，避免同时出现两个弹窗

  if (window.electronAPI?.platform && window.electronAPI.platform !== 'win32') {
    document.querySelectorAll('.win-only').forEach((el) => (el.style.display = 'none'));
  }

  let _acChk = 0;
  const _acTick = async () => {
    try {
      const s = await window.electronAPI?.activateStatus?.();
      if (!s || !s.activated) {
        _acChk++;
        if (_acChk > 2) {
          document.querySelectorAll('.nav-btn').forEach((b) => {
            if (b.id === 'nav-explore-btn') b.style.display = 'none';
          });
        }
      } else {
        _acChk = 0;
      }
    } catch (_) {}
  };
  setInterval(_acTick, 120000);
  setTimeout(_acTick, 30000);
});

/* @versepc-protected: anti-ai-plagiarism-v1.0 */



















