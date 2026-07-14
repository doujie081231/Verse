/**
 * @file server/crash-analyzer/constants.js - 崩溃原因枚举与默认路径常量
 */

const path = require('path');
const os = require('os');

const DEFAULT_MINECRAFT_DIR = path.join(os.homedir(), '.minecraft');

/* 崩溃原因枚举：键为内部标识，值为面向用户的中文描述 */
const CrashReason = {
  JavaVersionTooHigh: 'Java版本过高',
  ModFileExtracted: 'Mod文件被解压',
  MixinBootstrapError: 'Mixin引导失败',
  OutOfMemory: '内存不足',
  UsingJDK: '使用JDK',
  UsingOpenJ9: '使用OpenJ9',
  JavaTooOld: 'Java版本过旧',
  ModDuplicateModFiles: 'Mod重复文件',
  ModRequiresJava11: 'Mod需要Java11',
  ModMissingDependency: 'Mod缺少前置或MC版本错误',
  ModIncompatible: 'Mod不兼容',
  ModMissingOrIncompatible: 'Mod缺失或不兼容',
  ModCrashed: 'Mod崩溃',
  ModNoInfo: 'Mod无信息',
  ModMixinError: 'Mod Mixin错误',
  ModNameContainsSpecialChars: 'Mod名称包含特殊字符',
  ModNameDuplicate: 'Mod名称重复',
  OptiFineIncompatible: 'OptiFine不兼容',
  AMDDriverCrash: 'AMD驱动崩溃',
  NVidiaDriverCrash: 'NVIDIA驱动崩溃',
  IntelDriverCrash: 'Intel驱动崩溃',
  PixelFormatNotAccelerated: '像素格式未加速',
  ManuallyTriggeredCrash: '手动触发崩溃',
  OptiFineMissingForge: 'OptiFine缺少Forge',
  ShadersModWithOptiFine: 'ShadersMod与OptiFine冲突',
  ForgeMissing: 'Forge缺失',
  FabricCrash: 'Fabric崩溃',
  FabricModCrash: 'Fabric Mod崩溃',
  ForgeCrash: 'Forge崩溃',
  ModLoaderVersionIncompatible: 'Mod加载器版本不兼容',
  NightConfigBug: 'NightConfig Bug',
  OpenJ9Crash: 'OpenJ9崩溃',
  OpenGL1282Error: 'OpenGL 1282错误',
  ModIdConflict: 'Mod ID冲突',
  InvalidPath: '无效路径',
  ModCyclicIssue: 'Mod循环问题',
  SecurityException: '安全异常',
  NativeLinkError: '本地库加载失败',
  Unknown: '未知错误'
};

module.exports = {
  CrashReason,
  DEFAULT_MINECRAFT_DIR
};
