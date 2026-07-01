/**
 * @file server/launch/process-manager.js
 * @description 进程管理模块。从原 server/launch.js 拆分而来。
 *              包含：JVM 预热、性能优化、doLaunch（实际启动进程）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const ctx = require('../context');
const utils = require('../utils');
const java = require('../java');
const versions = require('../versions');
const natives = require('../natives');
const shared = require('./shared');
const argsBuilder = require('./args-builder');

// 将跨模块函数绑定到本地名（保持 doLaunch/preheatJvm 内部调用不变）
const buildLaunchArguments = argsBuilder.buildLaunchArguments;
const DoRound = shared.DoRound;
const analyzeExitCode = shared.analyzeExitCode;
const setGameLanguage = shared.setGameLanguage;
const applyWindowSettings = shared.applyWindowSettings;

// 模块级：活跃的游戏日志定时器集合 + JVM 预热 PID 列表
// 用于应用退出时统一清理，避免泄漏
const _activeLogTimers = new Set();
if (!global._preheatPids) global._preheatPids = [];

/**
 * 清理所有游戏日志定时器（app.before-quit 时调用）
 * @returns {void}
 */
function cleanupGameLogs() {
  for (const timer of _activeLogTimers) {
    try {
      clearInterval(timer);
    } catch (e) {}
  }
  _activeLogTimers.clear();
}

/* JVM 预热 */
/**
 * 预热 JVM：后台启动一个轻量 Java 进程，让 JVM 与类库加载到内存中
 * @param {string} javaPath - Java 可执行文件路径
 * @param {number} maxMemMB - 预热进程内存上限（MB）
 * @returns {Promise<void>}
 */
async function preheatJvm(javaPath, maxMemMB) {
  if (ctx.jvm.preheatedJvm) return;
  try {
    const preheatArgs = [
      `-Xmx${Math.min(maxMemMB, 512)}M`,
      '-XX:+UseG1GC',
      '-XX:MaxGCPauseMillis=200',
      '-cp', '.',
      'java.lang.Object'
    ];
    const proc = spawn(javaPath, preheatArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    proc.unref();
    ctx.jvm.preheatedJvm = { pid: proc.pid, javaPath, startTime: Date.now() };
    // 加入全局列表，应用退出时统一清理
    if (proc.pid) global._preheatPids.push(proc.pid);

    proc.on('exit', () => {
      ctx.jvm.preheatedJvm = null;
      // 从全局列表移除
      const idx = global._preheatPids.indexOf(proc.pid);
      if (idx >= 0) global._preheatPids.splice(idx, 1);
    });

    // 5 分钟超时自动清理，避免预热进程长期占用内存
    if (ctx.jvm.preheatTimer) clearTimeout(ctx.jvm.preheatTimer);
    ctx.jvm.preheatTimer = setTimeout(() => {
      if (ctx.jvm.preheatedJvm) {
        try {
          process.kill(ctx.jvm.preheatedJvm.pid);
        } catch (e) {}
        ctx.jvm.preheatedJvm = null;
      }
    }, 300000);
  } catch (e) {
  }
}

/**
 * 清理 JVM 预热进程（游戏真正启动后调用，立即释放预热进程占用的内存）
 * @returns {void}
 */
function cleanupPreheatedJvm() {
  try {
    const preheated = ctx.jvm.preheatedJvm;
    if (preheated) {
      try {
        if (preheated.pid) process.kill(preheated.pid);
      } catch (e) {}
      ctx.jvm.preheatedJvm = null;
      if (preheated.pid) {
        const idx = global._preheatPids.indexOf(preheated.pid);
        if (idx >= 0) global._preheatPids.splice(idx, 1);
      }
    }
    if (ctx.jvm.preheatTimer) {
      clearTimeout(ctx.jvm.preheatTimer);
      ctx.jvm.preheatTimer = null;
    }
  } catch (e) {
  }
}

/* 性能优化 */
/**
 * 应用性能优化：提升进程优先级、设置 CPU 亲和性与 I/O 优先级
 * @param {number} pid - 游戏进程 PID
 * @returns {Promise<void>}
 */
async function applyPerformanceOptimizations(pid) {
  if (!pid) return;

  // 读取用户设置：未开启性能加速时仅设为 NORMAL 优先级
  let performanceBoost = true;
  try {
    const storePath = path.join(ctx.dirs.DATA_DIR, 'app-store.json');
    if (fs.existsSync(storePath)) {
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const launchStr = store['versepc_launch_settings'];
      if (launchStr) {
        const launchSettings = JSON.parse(launchStr);
        if (launchSettings.performanceBoost !== undefined) performanceBoost = launchSettings.performanceBoost;
      }
    }
  } catch (e) {}

  if (!performanceBoost) {
    try {
      os.setPriority(pid, os.constants.priority.PRIORITY_NORMAL);
    } catch (e) {}
    return;
  }

  // 优先尝试 HIGH 优先级，失败则回退到 ABOVE_NORMAL
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_HIGH);
  } catch (e) {
    try {
      os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
    } catch (e2) {
    }
  }

  // Windows 平台额外通过 PowerShell 设置 CPU 亲和性（使用 75% 核心数）与 I/O 优先级
  try {
    if (process.platform === 'win32') {
      const psScript = `
$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($proc) {
    $cpu = Get-CimInstance Win32_Processor
    $coreCount = $cpu.NumberOfLogicalProcessors
    if ($coreCount -ge 8) {
        $pCores = [math]::Floor($coreCount * 0.75)
        $mask = [math]::Pow(2, $pCores) - 1
        $proc.ProcessorAffinity = $mask
    }
    try {
        $proc.PriorityClass = 'High'
    } catch {}
    try {
        $proc.IOPriority = [System.Diagnostics.ProcessPriorityClass]::High
    } catch {}
}
`.trim();
      const tmpScript = path.join(os.tmpdir(), `versepc_perf_${pid}.ps1`);
      fs.writeFileSync(tmpScript, psScript, 'utf8');
      exec(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpScript}"`, { timeout: 10000 }, (err) => {
        try {
          fs.unlinkSync(tmpScript);
        } catch (e) {}
      });
    }
  } catch (e) {
  }
}

/* 启动游戏（实际启动进程） */
/**
 * 实际启动游戏进程：构造参数、写入调试日志、spawn 进程、绑定日志与退出处理
 * @param {string} versionId - 版本 ID
 * @param {object} versionJson - 版本 JSON
 * @param {object} settings - 启动设置
 * @param {object} account - 账户信息
 * @param {string|null} [externalVersionDir=null] - 外部版本目录
 * @param {string|null} [fullVersionId=null] - 完整版本 ID（含外部标记）
 * @returns {Promise<{success:boolean,error?:string,sessionId?:string,pid?:number,...}>} 启动结果
 */
async function doLaunch(versionId, versionJson, settings, account, externalVersionDir = null, fullVersionId = null) {
  let launchVersionId = versionId;

  let javaPath = java.selectJavaForVersion(versionId, settings, versionJson);
  if (!javaPath) {
    const errorMsg = '未找到Java运行环境，请在设置中配置Java路径';
    console.error(`[Launch] 错误: ${errorMsg}`);
    return { success: false, error: errorMsg, details: { versionId, mainClass: versionJson.mainClass } };
  }

  // 解析游戏目录：外部版本优先；否则按版本隔离或全局 gameDir
  let gameDir;
  if (externalVersionDir) {
    gameDir = externalVersionDir;
  } else {
    const settingsVersionId = fullVersionId || versionId;
    const effectiveIsolation = versions.resolveVersionIsolation(settingsVersionId);
    if (effectiveIsolation) {
      // 同版本多开时使用 instance_N 子目录避免存档冲突
      const sameVersionCount = [...ctx.sessions.gameInstances.values()].filter((g) => g.versionId === versionId).length;
      if (sameVersionCount > 0) {
        gameDir = path.join(ctx.dirs.VERSIONS_DIR, versionId, `instance_${sameVersionCount + 1}`);
      } else {
        gameDir = path.join(ctx.dirs.VERSIONS_DIR, versionId);
      }
    } else {
      gameDir = settings.gameDir || ctx.dirs.DATA_DIR;
    }
  }

  const nativesDir = natives.getNativesFolder(versionId);
  const launchResult = buildLaunchArguments(versionJson, settings, account, versionId, gameDir, externalVersionDir);
  const args = launchResult.args;
  const maxMemMB = launchResult.maxMemMB;

  // 写入启动调试日志：完整 JVM 参数 + classpath 条目 + 缺失文件清单
  {
    const debugLogPath = path.join(ctx.dirs.LOGS_DIR, `launch-debug-${Date.now()}.log`);
    try {
      const debugLines = [];
      debugLines.push(`=== VersePC 启动调试日志 ===`);
      debugLines.push(`时间: ${new Date().toISOString()}`);
      debugLines.push(`版本: ${versionId}`);
      debugLines.push(`外部版本: ${!!externalVersionDir}`);
      debugLines.push(`游戏目录: ${gameDir}`);
      debugLines.push(`JVM参数总数: ${args.length}`);
      debugLines.push(``);
      debugLines.push(`=== 完整JVM参数 ===`);
      args.forEach((a, i) => debugLines.push(`[${i}] ${a}`));

      const cpIdx2 = args.indexOf('-cp');
      if (cpIdx2 >= 0 && cpIdx2 + 1 < args.length) {
        const sep = process.platform === 'win32' ? ';' : ':';
        const entries = args[cpIdx2 + 1].split(sep);
        debugLines.push(``);
        debugLines.push(`=== Classpath (${entries.length}条目) ===`);
        entries.forEach((e) => debugLines.push(`  ${e}`));
        const missing = entries.filter((e) => !fs.existsSync(e));
        if (missing.length > 0) {
          debugLines.push(``);
          debugLines.push(`=== 缺失文件 (${missing.length}) ===`);
          missing.forEach((m) => debugLines.push(`  ${m}`));
        }
      }

      fs.writeFileSync(debugLogPath, debugLines.join('\n'), 'utf-8');
    } catch (e) {
      console.error(`[Launch] 调试日志写入失败: ${e.message}`);
    }
  }

  // classpath 完整性预检：Forge/Fabric 关键库是否存在，缺失时高亮告警
  const cpIdx = args.indexOf('-cp');
  if (cpIdx !== -1 && cpIdx + 1 < args.length) {
    const classpathStr = args[cpIdx + 1];
    const separator = process.platform === 'win32' ? ';' : ':';
    const classpathEntries = classpathStr.split(separator);

    const mainClass = versionJson.mainClass || '';
    const isForgeLike = mainClass.includes('modlauncher') || mainClass.includes('fmlloader') ||
      mainClass.includes('forge') || mainClass.includes('neoforge');

    if (isForgeLike) {
      const criticalLibs = ['securejarhandler', 'forge', 'neoforge', 'fmlloader', 'modlauncher'];
      for (const crit of criticalLibs) {
        const found = classpathEntries.some((e) => e.toLowerCase().includes(crit));
      }
      const missingEntries = classpathEntries.filter((e) => !fs.existsSync(e));
      if (missingEntries.length > 0) {
        console.error(`[Launch] ⚠ ${missingEntries.length} 个classpath条目文件不存在!`);
        missingEntries.slice(0, 5).forEach((m) =>
          console.error(`[Launch]   不存在: ${path.basename(m)}`)
        );
      }
    }

    if (mainClass.includes('fabric') || mainClass.includes('knot')) {
      const fabricLibs = classpathEntries.filter((e) =>
        e.includes('fabric') || e.includes('fabricmc') || e.includes('intermediary')
      );
      if (fabricLibs.length === 0) {
        console.error(`[Launch] 警告: Fabric版本但没有找到Fabric库!`);
      }
    }
  }

  ctx.sessions.gameInstanceCounter++;
  const sessionId = `game_${ctx.sessions.gameInstanceCounter}_${Date.now()}`;

  try {
    // 设置游戏语言与窗口模式（失败不阻塞启动流程）
    try {
      setGameLanguage(gameDir, versionJson, settings);
    } catch (langErr) {
      console.error('[Language] 设置游戏语言失败:', langErr.message);
    }

    applyWindowSettings(gameDir, settings);

    const mainClass = versionJson.mainClass || 'net.minecraft.client.main.Main';

    // 再次校验 classpath：检查主类对应 JAR 是否存在
    const cpIdx = args.indexOf('-cp');
    if (cpIdx !== -1 && cpIdx + 1 < args.length) {
      const cpStr = args[cpIdx + 1];
      const cpEntries = cpStr.split(';');
      const missingCp = cpEntries.filter((e) => !fs.existsSync(e));
    }

    const spawnOptions = {
      cwd: gameDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    };

    // Windows 启动前内存优化：执行 DoRound PowerShell 脚本回收系统缓存
    if (process.platform === 'win32') {
      let shouldOptimizeMemory = false;
      try {
        const storePath = path.join(ctx.dirs.DATA_DIR, 'app-store.json');
        if (fs.existsSync(storePath)) {
          const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
          const otherStr = store['versepc_other_settings'];
          if (otherStr) {
            const otherSettings = JSON.parse(otherStr);
            if (otherSettings.autoMemoryOptimize !== false) shouldOptimizeMemory = true;
          }
        }
      } catch (_) {}
      // 单版本设置可覆盖全局开关
      if (shouldOptimizeMemory) {
        try {
          const verSettings = versions.loadVersionSettings(versionId);
          if (verSettings.memOptimize === 'off') shouldOptimizeMemory = false;
          else if (verSettings.memOptimize === 'on') shouldOptimizeMemory = true;
        } catch (_) {}
      }
      if (shouldOptimizeMemory) {
        const freeMB = Math.floor(os.freemem() / 1024 / 1024);
        try {
          const tmpScript = path.join(os.tmpdir(), 'versepc_memopt.ps1');
          const psScript = DoRound;
          fs.writeFileSync(tmpScript, psScript, 'utf8');
          const { execFile } = require('child_process');
          await new Promise((resolve) => {
            execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpScript], { timeout: 90000, windowsHide: true }, (err, stdout) => {
              try {
                fs.unlinkSync(tmpScript);
              } catch (_) {}
              if (err) {
                resolve(null);
                return;
              }
              resolve(parseInt(stdout.trim(), 10) || null);
            });
          });
        } catch (e) {
        }
      }
    }

    // Linux/macOS 注入 natives 目录到动态库搜索路径
    if (process.platform === 'linux' && nativesDir) {
      const existingLdPath = spawnOptions.env.LD_LIBRARY_PATH || '';
      spawnOptions.env.LD_LIBRARY_PATH = [nativesDir, existingLdPath].filter(Boolean).join(':');
    }

    if (process.platform === 'darwin' && nativesDir) {
      const existingDyldPath = spawnOptions.env.DYLD_LIBRARY_PATH || '';
      spawnOptions.env.DYLD_LIBRARY_PATH = [nativesDir, existingDyldPath].filter(Boolean).join(':');
    }

    // 自动推断 JAVA_HOME（若未设置）
    if (!spawnOptions.env.JAVA_HOME && javaPath) {
      try {
        const detectedHome = path.dirname(path.dirname(javaPath));
        spawnOptions.env.JAVA_HOME = detectedHome;
      } catch (e) {}
    }

    // 写入启动调试命令行（脱敏后）方便用户排查
    try {
      const debugCmd = [javaPath, ...args].map((a) => {
        if (a.includes(' ') || a.includes('"') || a.includes('=')) return `"${a}"`;
        return a;
      }).join(' ');
      const debugPath = path.join(ctx.dirs.DATA_DIR, 'launch-debug.txt');
      fs.writeFileSync(debugPath, utils.filterSensitiveInfo(debugCmd), 'utf-8');
    } catch (e) {}

    // 命令行过长时使用 @argfile 方式启动（Windows 限制 ~25K，通用限制 ~30K）
    const totalCmdLength = args.reduce((sum, a) => sum + a.length + 3, javaPath.length + 3);

    if (totalCmdLength > 30000 || (process.platform === 'win32' && totalCmdLength > 25000)) {
      const tmpDir = path.join(os.tmpdir(), 'versepc-launch');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      const argFilePath = path.join(tmpDir, `args-${Date.now()}.txt`);
      const argFileLines = [];
      for (const a of args) {
        // Windows 下含空格或圆括号的参数需加引号
        if (process.platform === 'win32' && (a.includes(' ') || a.includes('(') || a.includes(')'))) {
          argFileLines.push(`"${a}"`);
        } else {
          argFileLines.push(a);
        }
      }
      fs.writeFileSync(argFilePath, argFileLines.join('\r\n'), 'utf-8');
      const newArgs = [`@${argFilePath}`];

      let skinBackups = [];
      try {
        skinBackups = natives.injectOfflineSkin(versionJson, account, ctx.dirs.ASSETS_DIR);
      } catch (e) {}

      const gameProcess = spawn(javaPath, newArgs, spawnOptions);

      // 日志批量节流：累积到缓冲区，每 500ms 批量处理一次，降低高频日志时的 CPU 占用
      // 注意：节流逻辑（缓冲、定时器、阶段识别）请勿随意修改，影响日志展示与启动阶段判定
      let _logBuffer = '';
      let _logFlushTimer = null;
      const _flushLogs = () => {
        if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
        if (!_logBuffer) return;
        const lines = _logBuffer.split('\n').filter((l) => l.trim()).map(utils.filterSensitiveInfo);
        _logBuffer = '';
        instanceInfo.logBuffer.push(...lines);
        if (instanceInfo.logBuffer.length > 5000) instanceInfo.logBuffer = instanceInfo.logBuffer.slice(-3000);
        ctx.sessions.gameLogBuffer.push(...lines);
        if (ctx.sessions.gameLogBuffer.length > 5000) ctx.sessions.gameLogBuffer = ctx.sessions.gameLogBuffer.slice(-3000);
        for (const line of lines) {
          // 检测局域网联机端口（多种日志格式）
          const lanMatch = line.match(/Local game hosted on.*?(\d{4,5})/i) ||
            line.match(/Started serving on.*?(\d{4,5})/i) ||
            line.match(/Opening LAN server.*?(\d{4,5})/i) ||
            line.match(/LAN server started.*?(\d{4,5})/i) ||
            line.match(/本地游戏已托管.*?(\d{4,5})/i);
          if (lanMatch) {
            instanceInfo.lanPort = parseInt(lanMatch[1], 10);
            ctx.sessions.detectedLanPort = parseInt(lanMatch[1], 10);
          }
          // 启动阶段识别：5 个关键节点用于前端进度展示
          if (instanceInfo.loadStage < 1) { instanceInfo.loadStage = 1; }
          if (instanceInfo.loadStage < 2 && line.includes('Setting user:')) { instanceInfo.loadStage = 2; }
          if (instanceInfo.loadStage < 3 && /lwjgl version/i.test(line)) { instanceInfo.loadStage = 3; }
          if (instanceInfo.loadStage < 4 && (line.includes('OpenAL initialized') || line.includes('Starting up SoundSystem'))) { instanceInfo.loadStage = 4; }
          if (instanceInfo.loadStage < 5 && ((line.includes('Created') && line.includes('textures') && line.includes('-atlas')) || line.includes('Found animation info'))) {
            instanceInfo.loadStage = 5;
            if (!instanceInfo.gameReady) {
              instanceInfo.gameReady = true;
              instanceInfo.readyTime = Date.now();
            }
          }
        }
      };
      const _scheduleLogFlush = () => {
        if (_logFlushTimer) return;
        _logFlushTimer = setTimeout(_flushLogs, 500);
      };

      gameProcess.on('exit', () => {
        if (_logBuffer) { try { _flushLogs(); } catch (e) {} }
        try { clearInterval(_logSaveTimer); _activeLogTimers.delete(_logSaveTimer); } catch (e) {}
        try { fs.unlinkSync(argFilePath); } catch (e) {}
        try { natives.restoreOfflineSkin(skinBackups); } catch (e) {}
      });

      cleanupPreheatedJvm();

      setTimeout(() => {
        try { applyPerformanceOptimizations(gameProcess.pid); } catch (e) {}
      }, 500);

      const instanceInfo = {
        sessionId,
        process: gameProcess,
        versionId,
        pid: gameProcess.pid,
        gameDir,
        startTime: Date.now(),
        logBuffer: [],
        lanPort: null,
        gameReady: false,
        readyTime: null,
        loadStage: 0,
        launchInfo: {
          versionId,
          fullVersionId: fullVersionId || versionId,
          externalVersionDir,
          mainClass: versionJson.mainClass,
          javaPath,
          gameDir
        }
      };

      ctx.sessions.gameInstances.set(sessionId, instanceInfo);

      // 周期性保存游戏日志：启动器最小化时暂停写盘以减少 IO
      const _gameLogsDir = path.join(gameDir, 'logs');
      const _safeVersionId = versionId.replace(/[\\/:*?"<>|]/g, '_');
      const _crashLogPath = path.join(ctx.dirs.LOGS_DIR, `game-crash-${_safeVersionId}-${Date.now()}.log`);
      const _readGameLog = (name) => {
        try {
          return fs.readFileSync(path.join(_gameLogsDir, name), 'utf8');
        } catch (e) {
          return '';
        }
      };
      const _saveGameLog = (label) => {
        if (label === 'periodic') {
          try {
            const sharedState = require('../../main/shared-state');
            if (sharedState.getLauncherMinimized && sharedState.getLauncherMinimized()) {
              return; // 启动器最小化期间暂停写盘
            }
          } catch (e) {}
        }
        let parts;
        try {
          parts = [`=== VersePC ${label || 'Game Log'} ===\nSession: ${sessionId}\nPID: ${gameProcess ? gameProcess.pid : 'N/A'}\nTime: ${new Date().toISOString()}\nVersion: ${versionId}\nGameDir: ${gameDir}\n`];
          if (instanceInfo.logBuffer.length > 0) {
            parts.push(`\n=== stdout/stderr (last 1000 lines) ===\n${instanceInfo.logBuffer.slice(-1000).join('\n')}\n`);
          }
          const latest = _readGameLog('latest.log');
          if (latest) parts.push(`\n=== latest.log (last 500 lines) ===\n${latest.split('\n').slice(-500).join('\n')}\n`);
          const debug = _readGameLog('debug.log');
          if (debug) parts.push(`\n=== debug.log (last 500 lines) ===\n${debug.split('\n').slice(-500).join('\n')}\n`);
          fs.writeFileSync(_crashLogPath, parts.join(''));
        } catch (e) {
          // 兜底：写入 DATA_DIR 根目录
          try {
            const fbPath = path.join(ctx.dirs.DATA_DIR, `crash-${_safeVersionId}-${Date.now()}.log`);
            fs.writeFileSync(fbPath, parts.join(''));
          } catch (e2) {}
        }
      };
      const _logSaveTimer = setInterval(() => _saveGameLog('periodic'), 10000);
      _activeLogTimers.add(_logSaveTimer);
      try { _saveGameLog('initial'); } catch (e) {}

      if (gameProcess.stdout) {
        gameProcess.stdout.on('data', (data) => {
          _logBuffer += data.toString();
          _scheduleLogFlush();
        });
      }

      if (gameProcess.stderr) {
        gameProcess.stderr.on('data', (data) => {
          _logBuffer += data.toString();
          _scheduleLogFlush();
        });
      }

      gameProcess.unref();

      // 进程关闭：写入崩溃日志、分析退出码、扫描 JVM hs_err 文件、累计游戏时长
      gameProcess.on('close', (code) => {
        if (_logBuffer) { try { _flushLogs(); } catch (e) {} }
        try { clearInterval(_logSaveTimer); _activeLogTimers.delete(_logSaveTimer); } catch (e) {}
        const _sysInfo = utils.getSystemInfo();
        const crashParts = [`=== VersePC Game Crash Log ===\nSession: ${sessionId}\nExit Code: ${code}\nTime: ${new Date().toISOString()}\nVersion: ${versionId}\nJava: ${javaPath}\nGameDir: ${gameDir}\nOS: ${_sysInfo.osType} ${_sysInfo.osRelease} (${_sysInfo.osArch})\nCPU: ${_sysInfo.cpuModel}\nGPU: ${_sysInfo.gpuInfo}\nMemory: ${_sysInfo.totalMemMB}MB total, ${_sysInfo.freeMemMB}MB free\n`];
        try {
          if (instanceInfo.logBuffer.length > 0) {
            crashParts.push(`\n=== stdout/stderr (last 3000 lines) ===\n${instanceInfo.logBuffer.slice(-3000).join('\n')}\n`);
          }
          const latest = _readGameLog('latest.log');
          if (latest) crashParts.push(`\n=== latest.log (last 500 lines) ===\n${latest.split('\n').slice(-500).join('\n')}\n`);
          const debug = _readGameLog('debug.log');
          if (debug) crashParts.push(`\n=== debug.log (last 500 lines) ===\n${debug.split('\n').slice(-500).join('\n')}\n`);
          fs.writeFileSync(_crashLogPath, crashParts.join(''));
        } catch (e) {
          // 兜底：写入DATA_DIR根目录
          try {
            const fbPath = path.join(ctx.dirs.DATA_DIR, `crash-${_safeVersionId}-${Date.now()}.log`);
            fs.writeFileSync(fbPath, crashParts.join(''));
          } catch (e2) {}
        }
        const recentLogs = instanceInfo.logBuffer.slice(-100).join('\n');
        let analysis = analyzeExitCode(code, launchVersionId || versionId);
        // 补充：读取游戏日志文件进行更准确的分析
        const gameLatestLog = _readGameLog('latest.log');
        const gameDebugLog = _readGameLog('debug.log');
        const gameAllLogs = (gameLatestLog + '\n' + gameDebugLog).toLowerCase();
        if (gameAllLogs.includes('invalid paths argument') || gameAllLogs.includes('contained no existing paths')) {
          analysis.reason = 'Forge核心库文件缺失（Invalid paths argument）';
          analysis.suggestion = 'Forge安装不完整(fmlcore/javafmllanguage/mclanguage/lowcodelanguage缺失)。\n修复: 1)版本设置→文件修复 2)重新安装Forge 3)检查杀毒白名单';
        }
        instanceInfo.logBuffer.push(`[VersePC] 游戏进程退出(session:${sessionId}),代码:${code}`);
        ctx.sessions.gameLogBuffer.push(`[VersePC] 游戏进程退出 (session: ${sessionId})，代码: ${code}`);
        if (analysis.isCrash) {
          instanceInfo.logBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
          instanceInfo.logBuffer.push(`[VersePC] 建议: ${analysis.suggestion}`);
          ctx.sessions.gameLogBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
        } else {
          instanceInfo.logBuffer.push(`[VersePC] ${analysis.reason}`);
          ctx.sessions.gameLogBuffer.push(`[VersePC] ${analysis.reason}`);
        }
        ctx.sessions.lastGameExitAnalysis = {
          ...analysis,
          launchInfo: instanceInfo.launchInfo,
          logBuffer: instanceInfo.logBuffer.slice(-50),
          systemInfo: _sysInfo
        };
        // 扫描 JVM hs_err_pid*.log 崩溃文件（版本目录、游戏目录、系统 temp）
        try {
          const crashLogs = [];
          const _verDir2 = path.join(ctx.dirs.VERSIONS_DIR, launchVersionId || versionId);
          if (fs.existsSync(_verDir2)) {
            fs.readdirSync(_verDir2).filter((f) => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach((f) => crashLogs.push(path.join(_verDir2, f)));
          }
          if (fs.existsSync(gameDir)) {
            fs.readdirSync(gameDir).filter((f) => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach((f) => crashLogs.push(path.join(gameDir, f)));
          }
          try {
            const tmpDir = os.tmpdir();
            if (fs.existsSync(tmpDir)) {
              fs.readdirSync(tmpDir).filter((f) => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach((f) => crashLogs.push(path.join(tmpDir, f)));
            }
          } catch (_) {}
          if (crashLogs.length > 0) {
            crashLogs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
            ctx.sessions.lastGameExitAnalysis.crashLog = crashLogs[0];
            ctx.sessions.lastGameExitAnalysis.crashLogs = crashLogs;
            ctx.sessions.lastGameExitAnalysis.reason = (ctx.sessions.lastGameExitAnalysis.reason || '') + `\nJVM 崩溃日志: ${crashLogs[0]}`;
            instanceInfo.logBuffer.push(`[VersePC] JVM崩溃日志: ${crashLogs[0]}`);
            ctx.sessions.gameLogBuffer.push(`[VersePC] JVM崩溃日志: ${crashLogs[0]}`);
          }
        } catch (_) {}
        // 累计游戏时长到 play-time.json（串行化写入避免并发覆盖）
        try {
          const playTimePath = path.join(ctx.dirs.DATA_DIR, 'play-time.json');
          if (fs.existsSync(playTimePath)) {
            if (!global._playTimeWriteQueue) global._playTimeWriteQueue = Promise.resolve();
            global._playTimeWriteQueue = global._playTimeWriteQueue.then(() => {
              let ptData = JSON.parse(fs.readFileSync(playTimePath, 'utf8'));
              const vData = ptData[launchVersionId || versionId];
              if (vData && vData._launchTime) {
                const elapsed = (Date.now() - vData._launchTime) / 1000;
                vData.totalSeconds = (vData.totalSeconds || 0) + elapsed;
                delete vData._launchTime;
                fs.writeFileSync(playTimePath, JSON.stringify(ptData, null, 2), 'utf8');
              }
            });
          }
        } catch (e) {}
        ctx.sessions.gameInstances.delete(sessionId);
        if (ctx.sessions.gameInstances.size === 0) {
          ctx.sessions.gameLogBuffer = [];
        }
      });

      gameProcess.on('error', (err) => {
        instanceInfo.logBuffer.push(`[VersePC] 启动错误: ${err.message}`);
        ctx.sessions.gameLogBuffer.push(`[VersePC] 启动错误 (session: ${sessionId}): ${err.message}`);
        ctx.sessions.lastGameExitAnalysis = {
          code: -1,
          reason: `启动错误: ${err.message}`,
          suggestion: '请检查Java路径是否正确',
          isCrash: true,
          launchInfo: instanceInfo.launchInfo,
          systemInfo: utils.getSystemInfo()
        };
        ctx.sessions.gameInstances.delete(sessionId);
      });

      return {
        success: true,
        sessionId,
        pid: gameProcess.pid,
        gameDir,
        versionId
      };
    }

    let skinBackups = [];
    try {
      skinBackups = natives.injectOfflineSkin(versionJson, account, ctx.dirs.ASSETS_DIR);
    } catch (e) {}

    const gameProcess = spawn(javaPath, args, spawnOptions);

    cleanupPreheatedJvm();

    setTimeout(() => {
      try { applyPerformanceOptimizations(gameProcess.pid); } catch (e) {}
    }, 500);

    // 日志批量节流：累积到缓冲区，每 500ms 批量处理一次，降低高频日志时的 CPU 占用
    // 注意：节流逻辑（缓冲、定时器、阶段识别）请勿随意修改，影响日志展示与启动阶段判定
    let _logBuffer = '';
    let _logFlushTimer = null;
    const _flushLogs = () => {
      if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
      if (!_logBuffer) return;
      const lines = _logBuffer.split('\n').filter((l) => l.trim()).map(utils.filterSensitiveInfo);
      _logBuffer = '';
      instanceInfo.logBuffer.push(...lines);
      if (instanceInfo.logBuffer.length > 5000) instanceInfo.logBuffer = instanceInfo.logBuffer.slice(-3000);
      ctx.sessions.gameLogBuffer.push(...lines);
      if (ctx.sessions.gameLogBuffer.length > 5000) ctx.sessions.gameLogBuffer = ctx.sessions.gameLogBuffer.slice(-3000);
      for (const line of lines) {
        // 检测局域网联机端口（多种日志格式）
        const lanMatch = line.match(/Local game hosted on.*?(\d{4,5})/i) ||
          line.match(/Started serving on.*?(\d{4,5})/i) ||
          line.match(/Opening LAN server.*?(\d{4,5})/i) ||
          line.match(/LAN server started.*?(\d{4,5})/i) ||
          line.match(/本地游戏已托管.*?(\d{4,5})/i);
        if (lanMatch) {
          instanceInfo.lanPort = parseInt(lanMatch[1], 10);
          ctx.sessions.detectedLanPort = parseInt(lanMatch[1], 10);
        }
        // 启动阶段识别：5 个关键节点用于前端进度展示
        if (instanceInfo.loadStage < 1) { instanceInfo.loadStage = 1; }
        if (instanceInfo.loadStage < 2 && line.includes('Setting user:')) { instanceInfo.loadStage = 2; }
        if (instanceInfo.loadStage < 3 && /lwjgl version/i.test(line)) { instanceInfo.loadStage = 3; }
        if (instanceInfo.loadStage < 4 && (line.includes('OpenAL initialized') || line.includes('Starting up SoundSystem'))) { instanceInfo.loadStage = 4; }
        if (instanceInfo.loadStage < 5 && ((line.includes('Created') && line.includes('textures') && line.includes('-atlas')) || line.includes('Found animation info'))) {
          instanceInfo.loadStage = 5;
          if (!instanceInfo.gameReady) {
            instanceInfo.gameReady = true;
            instanceInfo.readyTime = Date.now();
          }
        }
      }
    };
    const _scheduleLogFlush = () => {
      if (_logFlushTimer) return;
      _logFlushTimer = setTimeout(_flushLogs, 500);
    };

    const instanceInfo = {
      sessionId,
      process: gameProcess,
      versionId,
      pid: gameProcess.pid,
      gameDir,
      startTime: Date.now(),
      logBuffer: [],
      lanPort: null,
      gameReady: false,
      readyTime: null,
      loadStage: 0,
      launchInfo: {
        versionId,
        fullVersionId: fullVersionId || versionId,
        externalVersionDir,
        mainClass: versionJson.mainClass,
        javaPath,
        gameDir
      }
    };

    ctx.sessions.gameInstances.set(sessionId, instanceInfo);

    if (gameProcess.stdout) {
      gameProcess.stdout.on('data', (data) => {
        _logBuffer += data.toString();
        _scheduleLogFlush();
      });
    }

    if (gameProcess.stderr) {
      gameProcess.stderr.on('data', (data) => {
        _logBuffer += data.toString();
        _scheduleLogFlush();
      });
    }

    gameProcess.unref();

    // 进程关闭：分析退出码、扫描 JVM hs_err 文件、累计游戏时长
    gameProcess.on('close', (code) => {
      if (_logBuffer) { try { _flushLogs(); } catch (e) {} }
      try { natives.restoreOfflineSkin(skinBackups); } catch (e) {}
      const _sysInfo = utils.getSystemInfo();
      const recentLogs = instanceInfo.logBuffer.slice(-100).join('\n');
      let analysis = analyzeExitCode(code, launchVersionId);
      // 补充：读取游戏日志文件进行更准确的分析
      const gameLatestLog = (() => { try { return fs.readFileSync(path.join(gameDir, 'logs', 'latest.log'), 'utf8'); } catch (e) { return ''; } })();
      const gameDebugLog = (() => { try { return fs.readFileSync(path.join(gameDir, 'logs', 'debug.log'), 'utf8'); } catch (e) { return ''; } })();
      const gameAllLogs = (gameLatestLog + '\n' + gameDebugLog).toLowerCase();
      if (gameAllLogs.includes('invalid paths argument') || gameAllLogs.includes('contained no existing paths')) {
        analysis.reason = 'Forge核心库文件缺失（Invalid paths argument）';
        analysis.suggestion = 'Forge安装不完整(fmlcore/javafmllanguage/mclanguage/lowcodelanguage缺失)。\n修复: 1)版本设置→文件修复 2)重新安装Forge 3)检查杀毒白名单';
      }
      instanceInfo.logBuffer.push(`[VersePC] 游戏进程退出(session:${sessionId}),代码:${code}`);
      ctx.sessions.gameLogBuffer.push(`[VersePC] 游戏进程退出 (session: ${sessionId})，代码: ${code}`);
      if (analysis.isCrash) {
        instanceInfo.logBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
        instanceInfo.logBuffer.push(`[VersePC] 建议: ${analysis.suggestion}`);
        ctx.sessions.gameLogBuffer.push(`[VersePC] 崩溃分析: ${analysis.reason}`);
      } else {
        instanceInfo.logBuffer.push(`[VersePC] ${analysis.reason}`);
        ctx.sessions.gameLogBuffer.push(`[VersePC] ${analysis.reason}`);
      }
      ctx.sessions.lastGameExitAnalysis = {
        ...analysis,
        launchInfo: instanceInfo.launchInfo,
        logBuffer: instanceInfo.logBuffer.slice(-50),
        systemInfo: _sysInfo
      };
      // 扫描 JVM hs_err_pid*.log 崩溃文件（版本目录、游戏目录、系统 temp）
      try {
        const crashLogs = [];
        const _verDir = path.join(ctx.dirs.VERSIONS_DIR, launchVersionId || versionId);
        if (fs.existsSync(_verDir)) {
          fs.readdirSync(_verDir).filter((f) => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach((f) => crashLogs.push(path.join(_verDir, f)));
        }
        if (fs.existsSync(gameDir)) {
          fs.readdirSync(gameDir).filter((f) => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach((f) => crashLogs.push(path.join(gameDir, f)));
        }
        try {
          const tmpDir = os.tmpdir();
          if (fs.existsSync(tmpDir)) {
            fs.readdirSync(tmpDir).filter((f) => f.startsWith('hs_err_pid') && f.endsWith('.log')).forEach((f) => crashLogs.push(path.join(tmpDir, f)));
          }
        } catch (_) {}
        if (crashLogs.length > 0) {
          crashLogs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
          ctx.sessions.lastGameExitAnalysis.crashLog = crashLogs[0];
          ctx.sessions.lastGameExitAnalysis.crashLogs = crashLogs;
          ctx.sessions.lastGameExitAnalysis.reason = (ctx.sessions.lastGameExitAnalysis.reason || '') + `\nJVM 崩溃日志: ${crashLogs[0]}`;
          instanceInfo.logBuffer.push(`[VersePC] JVM崩溃日志: ${crashLogs[0]}`);
          ctx.sessions.gameLogBuffer.push(`[VersePC] JVM崩溃日志: ${crashLogs[0]}`);
        }
      } catch (_) {}
      // 累计游戏时长到 play-time.json
      try {
        const playTimePath = path.join(ctx.dirs.DATA_DIR, 'play-time.json');
        if (fs.existsSync(playTimePath)) {
          let ptData = JSON.parse(fs.readFileSync(playTimePath, 'utf8'));
          const vData = ptData[launchVersionId];
          if (vData && vData._launchTime) {
            const elapsed = (Date.now() - vData._launchTime) / 1000;
            vData.totalSeconds = (vData.totalSeconds || 0) + elapsed;
            delete vData._launchTime;
            fs.writeFileSync(playTimePath, JSON.stringify(ptData, null, 2), 'utf8');
          }
        }
      } catch (e) {}
      ctx.sessions.gameInstances.delete(sessionId);
      if (ctx.sessions.gameInstances.size === 0) {
        ctx.sessions.gameLogBuffer = [];
      }
    });

    gameProcess.on('error', (err) => {
      instanceInfo.logBuffer.push(`[VersePC] 启动错误: ${err.message}`);
      ctx.sessions.gameLogBuffer.push(`[VersePC] 启动错误 (session: ${sessionId}): ${err.message}`);
      ctx.sessions.lastGameExitAnalysis = {
        code: -1,
        reason: `启动错误: ${err.message}`,
        suggestion: '请检查Java路径是否正确',
        isCrash: true,
        launchInfo: instanceInfo.launchInfo,
        systemInfo: utils.getSystemInfo()
      };
      ctx.sessions.gameInstances.delete(sessionId);
    });

    return { success: true, pid: gameProcess.pid, sessionId, launchInfo: instanceInfo.launchInfo };
  } catch (e) {
    console.error(`[Launch] 启动异常: ${e.message}`);
    console.error(`[Launch] 堆栈: ${e.stack}`);
    return {
      success: false,
      error: '启动失败: ' + e.message,
      details: {
        versionId,
        mainClass: versionJson.mainClass,
        externalVersionDir,
        error: e.message,
        stack: e.stack
      }
    };
  }
}

module.exports = { preheatJvm, cleanupPreheatedJvm, applyPerformanceOptimizations, doLaunch, cleanupGameLogs };
