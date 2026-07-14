# VersePC 版本加载器下载/安装逻辑重写计划

## 概述

本计划基于 PCL2 的安装架构，重写 VersePC 的 Forge/NeoForge/Fabric 安装流程。核心目标是修复 NeoForge 安装的 bug，并建立一个与 PCL2 一致的、可靠的安装架构。

---

## 一、架构对比分析

### PCL2 架构（目标架构）

```
McInstallLoader (编排器)
  ├── 1. 创建 TempMcFolder (临时安装目录)
  ├── 2. 下载原版到 TempMcFolder/versions/{mcVersion}/
  ├── 3. 下载 Forge/NeoForge 到 TempMcFolder/versions/{forge/neoforge}-{version}/
  │     └── ForgelikeInjector: 运行 com.bangbang93.ForgeInstaller
  │           ├── 安装器处理一切: 下载库、执行 processor、remap JAR
  │           └── 在 versions/ 下生成新文件夹 + version JSON
  ├── 4. 下载 Fabric 到 TempMcFolder/versions/fabric-loader-{ver}-{mcVer}/
  ├── 5. MergeJson (最终合并步骤)
  │     ├── 读取所有 loader 的 JSON
  │     ├── 从 Minecraft 原版 JSON 开始，逐个合并 loader JSON
  │     ├── 删除 inheritsFrom 字段
  │     ├── 设置 id 为目标实例名
  │     └── 输出到目标实例目录
  ├── 6. 拷贝原版 JAR 到目标实例目录
  └── 7. 迁移 TempMcFolder/libraries 到正式 libraries 目录
```

**关键特征**:
- `ForgelikeInjector` 是核心：它运行 `com.bangbang93.ForgeInstaller`，这个注入器会处理所有 processor、remap、patch 等工作
- 安装器成功后，PCL2 只是**复制生成的 JSON** 到目标目录
- `MergeJson` 在最后一步把所有 JSON 合并成一个**独立的**（不含 `inheritsFrom`）JSON
- 对于 Forge 方式 B（旧版 Forge 1.12.2-），PCL2 直接从 install_profile.json 提取 version JSON，不运行 processor

### VersePC 当前架构（问题架构）

```
installNeoForge
  ├── 1. ensureBaseVersionInstalled (原版)
  ├── 2. 创建 versionDir 直接在 VERSIONS_DIR/{versionId}/
  ├── 3. 下载 installer JAR
  ├── 4. 三种回退模式:
  │     ├── BMCLAPI forge-installer.jar → 检测新文件夹 → 复制 JSON
  │     ├── 官方 installer → 同上
  │     └── 手动模式: 从 ZIP 提取 JSON + 手动下载库
  ├── 5. mergeNeoForgeLoaderToVersion (问题根源!)
  │     ├── 添加 inheritsFrom
  │     ├── 再次下载 installer 获取 install_profile.json
  │     ├── 添加额外库 (installertools, universal, patched)
  │     ├── 手动执行 processor
  │     └── 复制 patched JAR 作为版本目录 JAR
  └── 6. 写入 version JSON
```

### 根本问题

| 问题 | 原因 | 影响 |
|------|------|------|
| `inheritsFrom` 残留 | installer 生成的 JSON 带 `inheritsFrom: '26.1.2'`，VersePC 不删除它 | resolveVersionJson 尝试解析父版本，可能失败 |
| `mergeNeoForgeLoaderToVersion` 重新添加 `inheritsFrom` | 合并函数假设需要用 inheritsFrom 链式解析 | 破坏了 standalone JSON 的意图 |
| 版本目录 JAR 是 vanilla JAR 副本 | `findMainJar` 优先找版本目录下的 `{versionId}.jar`，而 `installNeoForge` 没有正确复制 patched JAR | 缺少 NeoForge 补丁，游戏启动后行为异常 |
| 多余库 (installertools, universal, patched) | mergeNeoForgeLoaderToVersion 不加选择地添加所有库 | classpath 污染，可能引起冲突 |
| 手动 processor 执行 | 本应由 forge-installer.jar 完成的工作被重复执行 | 可能失败、超时、产物不一致 |

---

## 二、重写策略

### 核心原则（对标 PCL2）

1. **Forge/NeoForge 安装器负责一切**：`com.bangbang93.ForgeInstaller` 已经处理了 processor、remap、JAR 生成等所有工作。VersePC 不应该重复这些工作
2. **临时目录模式**：所有安装工作在临时目录进行，完成后合并到目标目录
3. **JSON 合并为最后一步**：`MergeJson` 读取所有组件的 JSON，合并成一个独立的 standalone JSON
4. **不使用 `inheritsFrom`**：最终 JSON 是自包含的，不依赖父版本 JSON

### 函数重写映射

| PCL2 函数 | VersePC 对应函数 | 重写后函数 |
|-----------|-----------------|-----------|
| `McInstallLoader` (编排器) | 各 `install*` 函数分散编排 | `installLoader` (新编排器) |
| `McDownloadForgelikeLoader` (Forge/NeoForge) | `installForge` / `installNeoForge` | `installForgelikeLoader` (统一) |
| `ForgelikeInjector` | `runForgeInstallerJar` | `runForgeInstallerJar` (保持) |
| `MergeJson` (JSON 合并) | `mergeNeoForgeLoaderToVersion` 等 | `mergeVersionJsons` (新) |
| `McLibListGetWithJson` | 分散在各处 | 集成在 `mergeVersionJsons` 中 |

---

## 三、详细实施计划

### 阶段一：基础基础设施（无破坏性变更）

#### 任务 1.1：创建临时安装目录管理工具

**目标**：提供临时安装目录的创建和清理功能。

**修改文件**：`server.js`

**新增函数**：
```javascript
function createTempInstallFolder() // 创建临时安装目录，返回路径
function cleanupTempInstallFolder(tempPath) // 清理临时安装目录
function getLoaderTempDir(tempPath, loaderName) // 获取加载器子目录
```

**实现细节**：
- 临时目录位于 `DATA_DIR/temp/install-{timestamp}/`
- `cleanupTempInstallFolder` 使用 `fs.rmSync` 递归清理
- 加载器子目录结构：`{tempPath}/versions/{loaderName}/`

**依赖**：无

**测试**：
- 创建临时目录，确认路径存在
- 清理临时目录，确认已删除
- 在不同平台（Windows）上路径正确

---

#### 任务 1.2：创建 MergeJson 核心函数

**目标**：创建一个 PCL2 风格的 JSON 合并函数，作为版本安装的最后一步。

**修改文件**：`server.js`

**新增函数**：
```javascript
function mergeVersionJsons({
    outputDir,       // 输出目录
    outputId,        // 目标版本 ID
    mcVersion,       // MC 版本号
    loaderType,      // 'forge' | 'neoforge' | 'fabric' | 'optifine' | null
    loaderVersionDir // 加载器 JSON 所在目录 (临时目录中的)
})
```

**实现细节**（对标 PCL2 `MergeJson`，L4065-L4521）：

1. **读取原版 JSON**：
   - 从 `VERSIONS_DIR/{mcVersion}/{mcVersion}.json` 读取
   - 这是合并的起点

2. **读取加载器 JSON**（如有）：
   - 从 `loaderVersionDir` 中读取对应的 JSON 文件
   - Forge: `{loaderVersionDir}/{forgeName}.json`
   - NeoForge: `{loaderVersionDir}/{neoforgeName}.json`
   - Fabric: `{loaderVersionDir}/{fabricName}.json`

3. **执行合并**：
   - 以原版 JSON 为基础（`OutputJson = MinecraftJson`）
   - 移除 loader JSON 的 `releaseTime` 和 `time` 字段（PCL2 做法）
   - 使用 `deepMergeJson` 将 loader JSON 合并到基础 JSON 上
   - 库列表合并：loader 的库优先，原版的库在后（去重）
   - 参数合并：使用现有的 `deduplicateJvmArgs` 和 `deduplicateGameArgs`

4. **清理和设置**：
   - `OutputJson.inheritsFrom` = **删除**（PCL2 L4502: `OutputJson.Remove("inheritsFrom")`）
   - `OutputJson.jar` = **删除**（PCL2 L4503: `OutputJson.Remove("jar")`）
   - `OutputJson.id` = outputId（PCL2 L4504: `OutputJson["id"] = OutputName`）
   - `OutputJson._comment_` = **删除**

5. **保存**：
   - 写入 `outputDir/{outputId}.json`

**deepMergeJson 辅助函数**：
```javascript
function deepMergeJson(base, overlay)
```
- 字符串/数字/布尔值：overlay 覆盖 base
- 数组：overlay 覆盖 base（特别是 libraries 和 arguments）
- 对象：递归合并
- 移除 `releaseTime`、`time` 字段

**依赖**：无

**测试**：
- 创建模拟的原版 JSON 和 loader JSON，验证合并结果
- 验证 `inheritsFrom` 被删除
- 验证库列表正确合并且无重复
- 验证 arguments 正确合并

---

#### 任务 1.3：创建 `forge-installer.jar` 运行成功后的 JSON 复制函数

**目标**：当 `forge-installer.jar` 成功运行后，从新生成的版本文件夹中复制 JSON。

**修改文件**：`server.js`

**新增函数**：
```javascript
function copyInstallerGeneratedJson({
    mcDir,           // forge-installer 使用的游戏目录（可能是临时目录）
    targetVersionDir, // 目标版本目录
    targetVersionId,  // 目标版本 ID
    oldVersionList    // 安装前的版本文件夹列表
})
```

**实现细节**（对标 PCL2 `McDownloadForgelikeLoader` L2115-L2145）：

1. 扫描 `mcDir/versions/` 目录
2. 找到 `oldVersionList` 中不存在的新文件夹
3. 如果恰好有 1 个新文件夹，复制其中的 JSON 到 `targetVersionDir/{targetVersionId}.json`
4. 如果有多个新文件夹，选择包含 "forge" 或 "neoforge" 的那个
5. 如果没有找到新文件夹，返回失败
6. **不修改** JSON 内容（不添加 `inheritsFrom`，不修改 `id`）

**依赖**：任务 1.2

**测试**：
- 模拟 installer 创建新版本文件夹，验证 JSON 被正确复制
- 验证多文件夹情况下的选择逻辑
- 验证不修改 JSON 内容

---

### 阶段二：NeoForge 安装重写（核心修复）

#### 任务 2.1：重写 `installNeoForge` 函数

**目标**：使用 PCL2 的两阶段安装模式重写 NeoForge 安装。

**修改文件**：`server.js`  
**替换**：L14091-L14551 的 `installNeoForge` 函数

**新架构**：

```
installNeoForge(gameVersion, neoVersion, onProgress)
  ├── 1. ensureBaseVersionInstalled (不变)
  ├── 2. 创建 TempMcFolder
  ├── 3. 下载 installer JAR (到 TempMcFolder/temp/)
  ├── 4. 下载 NeoForge 支持库 (从 installer JSON 分析，到 libraries 目录)
  │     ├── 解压 installer 获取 install_profile.json + version.json
  │     ├── 合并两个 JSON，获取完整库列表
  │     ├── 下载 MOJMAPS mappings (如有)
  │     └── 下载所有 support libraries
  ├── 5. 运行 forge-installer.jar (以 TempMcFolder 作为 mcDir)
  │     └── 这一步处理 processor、remap、JAR 生成等所有工作
  ├── 6. 复制 installer 生成的 JSON (到 TempMcFolder 的 loader 子目录)
  ├── 7. MergeJson (合并原版 JSON + loader JSON → 目标目录)
  ├── 8. 复制原版 JAR 到目标目录 (或使用 patched JAR)
  ├── 9. 清理临时目录和 installer JAR
  └── 10. 补全支持库 (在目标目录上运行 verifyLoaderLibs)
```

**关键变更**：

1. **不再有 fallback 手动模式**：如果 installer 失败，直接报错（PCL2 也是这样）
2. **不调用 `mergeNeoForgeLoaderToVersion`**：替换为 `mergeVersionJsons`
3. **不手动执行 processor**：forge-installer.jar 已处理
4. **`inheritsFrom` 不再被添加**：`mergeVersionJsons` 会删除它
5. **版本目录 JAR 正确处理**：
   - 如果 installer 生成了 patched JAR，使用它
   - 否则复制原版 JAR（PCL2 的 MergeJson 就是这么做的：`ModBase.CopyFile(MinecraftJar, OutputJar)`）

**具体实现步骤**：

```javascript
async function installNeoForge(gameVersion, neoVersion, onProgress = null) {
    const isLegacy = neoVersion.startsWith('1.20.1-');
    const packageName = isLegacy ? 'forge' : 'neoforge';
    const versionId = `${gameVersion}-NeoForge-${neoVersion}`;
    const loaderName = `neoforge-${neoVersion}`;

    try {
        // 1. 确保原版已安装
        const baseResult = await ensureBaseVersionInstalled(gameVersion);
        if (baseResult.error) return { success: false, error: baseResult.error };

        // 2. 创建临时安装目录
        const tempPath = createTempInstallFolder();

        try {
            // 3. 下载 installer JAR
            const installerPath = path.join(tempPath, 'temp', `neoforge-installer-${neoVersion}.jar`);
            // ... 下载逻辑（保留现有的多源下载和校验逻辑）

            // 4. 下载支持库（从 installer 的 install_profile.json 分析）
            const loaderVersionDir = path.join(tempPath, 'versions', loaderName);
            fs.mkdirSync(loaderVersionDir, { recursive: true });

            // 分析 installer 的库列表并下载
            // ... (保留现有的库下载逻辑，但下载到正确的位置)

            // 5. 运行 forge-installer.jar
            const installerResult = await runForgeInstallerJar(installerPath, tempPath, onProgress);

            // 6. 复制 installer 生成的 JSON
            const oldList = getExistingVersionDirs(tempPath);
            // 运行 installer 后，检测新生成的版本文件夹
            const copyResult = copyInstallerGeneratedJson({
                mcDir: tempPath,
                targetVersionDir: loaderVersionDir,
                targetVersionId: loaderName,
                oldVersionList: oldList
            });

            if (!copyResult.success) {
                throw new Error('installer 未生成版本 JSON');
            }

            // 7. MergeJson: 合并到目标目录
            const targetDir = path.join(VERSIONS_DIR, versionId);
            fs.mkdirSync(targetDir, { recursive: true });
            mergeVersionJsons({
                outputDir: targetDir,
                outputId: versionId,
                mcVersion: gameVersion,
                loaderType: 'neoforge',
                loaderVersionDir: loaderVersionDir,
                loaderVersion: neoVersion
            });

            // 8. 复制原版 JAR
            const srcJar = path.join(VERSIONS_DIR, gameVersion, `${gameVersion}.jar`);
            const dstJar = path.join(targetDir, `${versionId}.jar`);
            if (!fs.existsSync(dstJar) && fs.existsSync(srcJar)) {
                fs.copyFileSync(srcJar, dstJar);
            }

            // 9. 清理
            try { fs.unlinkSync(installerPath); } catch (_) {}
            cleanupTempInstallFolder(tempPath);

            // 10. 补全支持库
            await verifyLoaderLibs(versionId);

            _invalidateResolvedJsonCache(versionId);
            return { success: true, versionId };
        } catch (e) {
            cleanupTempInstallFolder(tempPath);
            throw e;
        }
    } catch (e) {
        console.error(`[NeoForge] Installation failed: ${e.message}`);
        // 清理失败的版本目录
        try {
            const vDir = path.join(VERSIONS_DIR, versionId);
            if (fs.existsSync(vDir)) fs.rmSync(vDir, { recursive: true, force: true });
        } catch (_) {}
        return { success: false, error: e.message };
    }
}
```

**依赖**：任务 1.1, 1.2, 1.3

**测试**：
- 安装 NeoForge 1.21.1-21.1.1，验证：
  - 版本目录下有正确的 JSON（无 `inheritsFrom`）
  - `resolveVersionJson` 能正确返回 standalone JSON
  - 版本目录下有正确的 JAR
  - 所有库文件在 libraries 目录下
- 运行游戏验证 NeoForge 正常加载

---

#### 任务 2.2：删除 `mergeNeoForgeLoaderToVersion` 函数

**目标**：删除不再需要的合并函数。

**修改文件**：`server.js`  
**删除**：L14808-L15201 的 `mergeNeoForgeLoaderToVersion` 函数

**前提**：
- 确认没有其他地方调用此函数
- 确认任务 2.1 已完成

**依赖**：任务 2.1

**测试**：
- 确保没有残留引用
- 确保 NeoForge 安装仍然正常（已由新函数处理）

---

### 阶段三：Forge 安装重写

#### 任务 3.1：重写 `installForge` 函数

**目标**：使用 PCL2 的两阶段安装模式重写 Forge 安装。

**修改文件**：`server.js`  
**替换**：L13197-L14062 的 `installForge` 函数

**新架构**（与 NeoForge 类似，但处理旧版 Forge）：

```
installForge(gameVersion, forgeVersion, onProgress)
  ├── 1. ensureBaseVersionInstalled
  ├── 2. 下载 installer JAR
  ├── 3. 判断新旧版 Forge
  │     ├── 新版 (>= 1.20 或 Forge >= 20):
  │     │   ├── 下载支持库
  │     │   ├── 运行 forge-installer.jar
  │     │   └── 复制生成的 JSON
  │     └── 旧版 (< 1.20 且 Forge < 20):
  │         ├── 从 install_profile.json 提取 version JSON
  │         ├── 解压 maven 文件到 libraries
  │         └── 手动执行 processor (Legacy 方式)
  ├── 4. MergeJson → 目标目录
  ├── 5. 复制原版 JAR
  ├── 6. 清理
  └── 7. 补全支持库
```

**关键变更**：
1. 使用临时目录模式
2. 新版 Forge 使用 forge-installer.jar（同 NeoForge）
3. 旧版 Forge (<= 1.19.4) 的 processor 执行保留（PCL2 也不使用 installer 处理旧版）
4. 最终使用 `mergeVersionJsons` 而非 `mergeForgeLoaderToVersion`
5. 不再有 fallback 手动模式（新版 Forge）
6. 不再单独下载 "Forge 核心库"（`downloadForgeCoreLibsFromMaven`）

**依赖**：任务 1.1, 1.2, 1.3

**测试**：
- 安装新 Forge (如 1.21.1-47.3.0)，验证 standalone JSON
- 安装旧 Forge (如 1.12.2-14.23.5.2860)，验证 legacy processor 执行
- 验证 version 目录下 JAR 正确

---

#### 任务 3.2：删除 `mergeForgeLoaderToVersion` 函数

**目标**：删除不再需要的 Forge 合并函数。

**修改文件**：`server.js`  
**删除**：L14724-L14801 的 `mergeForgeLoaderToVersion` 函数

**依赖**：任务 3.1

---

### 阶段四：Fabric 安装优化

#### 任务 4.1：优化 `installFabric` 函数

**目标**：确保 Fabric 安装也遵循 PCL2 架构。

**修改文件**：`server.js`  
**修改**：L12583-L12779 的 `installFabric` 函数

**变更点**：

Fabric 安装相对简单（没有 processor），但需要调整最终 JSON 的生成方式：

1. **使用 MergeJson 模式**：
   - 将现有 `installFabric` 中的 `fullProfile` 构建逻辑移到临时目录
   - 最终通过 `mergeVersionJsons` 合并到目标目录

2. **移除 `inheritsFrom`**：
   - 当前代码在 `fullProfile` 中设置了 `inheritsFrom: gameVersion`
   - 重写后，`mergeVersionJsons` 会自动处理

3. **简化版本**：
   - 如果临时目录模式改动太大，可以保持现有逻辑
   - 但确保最终 JSON 中**不包含** `inheritsFrom`

**实现细节**：

```javascript
// 方案 A（完全 PCL2 模式）：
async function installFabric(gameVersion, loaderVersion, onProgress = null) {
    const versionId = `fabric-loader-${loaderVersion}-${gameVersion}`;
    const tempPath = createTempInstallFolder();

    try {
        // 1. 确保原版已安装
        await ensureBaseVersionInstalled(gameVersion);

        // 2. 在临时目录构建 Fabric JSON
        const loaderVersionDir = path.join(tempPath, 'versions', `fabric-loader-${loaderVersion}-${gameVersion}`);
        fs.mkdirSync(loaderVersionDir, { recursive: true });

        // ... 现有的 Fabric profile 构建逻辑，输出到 loaderVersionDir ...

        // 3. 下载库
        // ... 保留现有逻辑 ...

        // 4. MergeJson
        const targetDir = path.join(VERSIONS_DIR, versionId);
        fs.mkdirSync(targetDir, { recursive: true });
        mergeVersionJsons({
            outputDir: targetDir,
            outputId: versionId,
            mcVersion: gameVersion,
            loaderType: 'fabric',
            loaderVersionDir: loaderVersionDir
        });

        // 5. 复制原版 JAR
        const srcJar = path.join(VERSIONS_DIR, gameVersion, `${gameVersion}.jar`);
        const dstJar = path.join(targetDir, `${versionId}.jar`);
        if (!fs.existsSync(dstJar) && fs.existsSync(srcJar)) {
            fs.copyFileSync(srcJar, dstJar);
        }

        // 6. 清理
        cleanupTempInstallFolder(tempPath);

        return { success: true, versionId };
    } catch (e) {
        cleanupTempInstallFolder(tempPath);
        throw e;
    }
}

// 方案 B（最小变更）：
// 保留 installFabric 现有逻辑，但最后不写入 inheritsFrom
// 这样改动最小，风险最低
```

**建议**：先采用方案 B（最小变更），确保兼容性后再考虑方案 A。

**依赖**：任务 1.2

**测试**：
- 安装 Fabric，验证版本 JSON 无 `inheritsFrom`
- 启动游戏验证 Fabric 正常加载

---

#### 任务 4.2：删除 `mergeFabricLoaderToVersion` 函数

**目标**：如果 Fabric 安装不再需要单独的 merge 步骤，删除此函数。

**修改文件**：`server.js`  
**删除**：L14553-L14722 的 `mergeFabricLoaderToVersion` 函数

**前提**：确认没有其他调用方（如安装整合包时需要重新 merge）

**依赖**：任务 4.1

---

### 阶段五：版本解析修复

#### 任务 5.1：修改 `resolveVersionJson` 支持 standalone JSON

**目标**：确保版本 JSON 解析在 standalone（无 `inheritsFrom`）和 legacy（有 `inheritsFrom`）模式下都能正常工作。

**修改文件**：`server.js`  
**修改**：L8828-L8901 的 `resolveVersionJson` 函数

**变更点**：

当前逻辑：
```javascript
if (!data.inheritsFrom) {
    const detectedParent = detectModLoaderParent(data, externalVersionDir);
    if (detectedParent) {
        data.inheritsFrom = detectedParent;
    }
}
if (data.inheritsFrom) {
    // ... 递归解析父版本并合并
}
```

重写后逻辑：
```javascript
if (!data.inheritsFrom) {
    // Standalone JSON（新安装方式）
    // 不再尝试 detectModLoaderParent
    // 直接返回 JSON 本身
}
if (data.inheritsFrom) {
    // Legacy JSON（旧安装方式，有 inheritsFrom）
    // 保持现有递归解析逻辑不变（向后兼容）
}
```

**关键决策**：
- **保留** `detectModLoaderParent` 调用，但只在用户明确需要时使用（如检测到旧版安装）
- **新增**快速路径：如果 JSON 没有 `inheritsFrom`，直接返回，不尝试检测父版本
- **确保** standalone JSON 包含所有必要信息（库、参数、mainClass 等）

**依赖**：任务 1.2, 2.1, 3.1, 4.1

**测试**：
- 独立版本 JSON（无 inheritsFrom）能正确解析
- 旧版安装的 JSON（有 inheritsFrom）仍能正确解析
- 不出现循环引用

---

#### 任务 5.2：修改 `findMainJar` 支持 standalone JSON

**目标**：确保 `findMainJar` 在 standalone JSON 模式下能正确找到版本目录下的 JAR。

**修改文件**：`server.js`  
**修改**：L8556-L8675 的 `findMainJar` 函数

**变更点**：

当前逻辑的问题：
```javascript
const jarName = versionJson.jar || versionJson.inheritsFrom || actualVersionId;
```
当 `inheritsFrom` 不存在时，使用 `actualVersionId`，这通常是对的。但搜索路径中如果没有 `inheritsFrom`，可能会漏掉某些查找路径。

重写后：
- 优先查找版本目录下的 `{versionId}.jar`
- 如果没有，再尝试 `inheritsFrom` 路径（兼容旧版）
- 如果 JSON 有 `jar` 字段，按 `jar` 字段查找（PCL2 行为）

**依赖**：无

**测试**：
- standalone JSON（无 inheritsFrom）能找到正确的 JAR
- legacy JSON（有 inheritsFrom）仍能找到正确的 JAR

---

### 阶段六：删除废弃函数

#### 任务 6.1：删除 `mergeNeoForgeLoaderToVersion`

**修改文件**：`server.js`  
**删除**：L14808-L15201

**依赖**：任务 2.1 完成

#### 任务 6.2：删除 `mergeForgeLoaderToVersion`

**修改文件**：`server.js`  
**删除**：L14724-L14801

**依赖**：任务 3.1 完成

#### 任务 6.3：审查并清理 `mergeFabricLoaderToVersion`

**修改文件**：`server.js`  
**删除或简化**：L14553-L14722

**依赖**：任务 4.1 完成

---

### 阶段七：向后兼容

#### 任务 7.1：处理已有安装（有 `inheritsFrom` 的 JSON）

**目标**：确保旧版安装的版本仍能正常使用。

**修改文件**：`server.js`

**实现**：在 `resolveVersionJson` 中，保留完整的 `inheritsFrom` 解析链。这不需要修改，因为现有逻辑已经支持。

**关键检查点**：
- 旧版安装的 NeoForge 版本（有 `inheritsFrom: '1.21.1'`）仍能启动
- `mergeVersionJson` 函数不受影响（它处理运行时 JSON 合并）
- `buildClasspath` 不受影响（它只看 libraries 数组）

**依赖**：任务 5.1

**测试**：
- 用旧版方式安装的 NeoForge 版本能正常启动
- 新版方式安装的 NeoForge 版本能正常启动

---

#### 任务 7.2：创建版本迁移检测函数

**目标**：检测用户是否有旧版安装需要迁移。

**修改文件**：`server.js`

**新增函数**：
```javascript
function detectLegacyInstall(versionId)
```

**逻辑**：
- 检查版本 JSON 是否有 `inheritsFrom`
- 检查是否有 `mergeNeoForgeLoaderToVersion` 添加的多余库
- 返回是否需要迁移

**注意**：此函数仅用于检测，不自动迁移（避免破坏用户配置）。

**依赖**：无

---

### 阶段八：前端兼容性

#### 任务 8.1：确保 API 端点兼容

**目标**：所有现有的 API 端点保持不变。

**检查点**：
- `/api/install/neoforge` - 传参不变
- `/api/install/forge` - 传参不变
- `/api/install/fabric` - 传参不变
- `/api/versions` - 版本列表不受影响
- `/api/launch` - 启动参数构建不受影响

**实现**：所有重写函数的签名保持与现有 API 端点兼容。

**依赖**：任务 2.1, 3.1, 4.1

---

## 四、执行顺序和依赖关系

```
阶段一（基础）
  ├── 1.1 临时目录管理工具 ─────────────────┐
  ├── 1.2 MergeJson 核心函数 ───────────────┤
  └── 1.3 Installer JSON 复制函数 ──────────┤
                                              │
阶段二（NeoForge）                            │
  └── 2.1 重写 installNeoForge ──────────────┤
      └── 2.2 删除 mergeNeoForgeLoader ─────┤
                                              │
阶段三（Forge）                               │
  └── 3.1 重写 installForge ─────────────────┤
      └── 3.2 删除 mergeForgeLoader ────────┤
                                              │
阶段四（Fabric）                              │
  └── 4.1 优化 installFabric ────────────────┤
      └── 4.2 删除 mergeFabricLoader ───────┤
                                              │
阶段五（版本解析）                            │
  ├── 5.1 修改 resolveVersionJson ──────────┤
  └── 5.2 修改 findMainJar ─────────────────┤
                                              │
阶段六（清理）                                │
  └── 6.1-6.3 删除废弃函数 ─────────────────┤
                                              │
阶段七（兼容）                                │
  ├── 7.1 向后兼容验证 ─────────────────────┤
  └── 7.2 迁移检测 ─────────────────────────┤
                                              │
阶段八（前端）                                │
  └── 8.1 API 兼容性验证 ───────────────────┘
```

**推荐执行顺序**：
1. 1.1 → 1.2 → 1.3（基础工具）
2. 2.1（NeoForge 重写，最紧急的修复）
3. 5.1（版本解析适配）
4. 2.2（清理旧 NeoForge 合并函数）
5. 3.1（Forge 重写）
6. 3.2（清理旧 Forge 合并函数）
7. 4.1 → 4.2（Fabric 优化和清理）
8. 5.2（findMainJar 优化）
9. 7.1 → 7.2（兼容性验证）
10. 8.1（API 验证）

---

## 五、风险评估

### 高风险
| 风险 | 缓解措施 |
|------|----------|
| forge-installer.jar 在临时目录下运行失败 | 保留现有的 `--installClient` 原生模式作为备选 |
| 新的 MergeJson 逻辑与旧版安装不兼容 | `resolveVersionJson` 保留 inheritsFrom 解析路径 |
| 临时目录权限问题 | 使用 `os.tmpdir()` 作为临时目录根 |

### 中风险
| 风险 | 缓解措施 |
|------|----------|
| 旧版 Forge (< 1.20) 的 processor 执行逻辑有误 | 保留现有的 processor 执行代码，仅在旧版分支中使用 |
| 合并后 JSON 中库重复 | `mergeVersionJsons` 实现去重逻辑 |
| MOJMAPS mappings 下载时机变化 | 在运行 installer 之前下载（保持现有逻辑） |

### 低风险
| 风险 | 缓解措施 |
|------|----------|
| Fabric 安装格式变化 | 方案 B（最小变更）减少风险 |
| findMainJar 查找路径变化 | 多层 fallback 机制 |

---

## 六、验证标准

### NeoForge 安装验证
- [ ] `1.21.1-21.1.1` 安装成功
- [ ] 版本 JSON 无 `inheritsFrom` 字段
- [ ] 版本目录下有正确的 JAR（约 38MB，非 vanilla 的 15MB）
- [ ] `resolveVersionJson` 返回完整 standalone JSON
- [ ] 游戏启动正常，NeoForge 加载成功
- [ ] 多版本共存不冲突

### Forge 安装验证
- [ ] 新版 Forge (>= 1.20) 安装成功
- [ ] 旧版 Forge (< 1.20) 安装成功
- [ ] 版本 JSON 无 `inheritsFrom` 字段
- [ ] 游戏启动正常

### Fabric 安装验证
- [ ] 安装成功
- [ ] 版本 JSON 无 `inheritsFrom` 字段
- [ ] 游戏启动正常

### 向后兼容验证
- [ ] 旧版安装的 NeoForge 版本仍能启动
- [ ] 旧版安装的 Forge 版本仍能启动
- [ ] 整合包导入功能正常

### 性能验证
- [ ] 安装时间无显著增加
- [ ] 磁盘占用无显著增加（临时目录已清理）

---

## 七、关键代码片段参考

### PCL2 MergeJson 的核心操作（L4496-4504）
```csharp
OutputJson.Remove("_comment_");
OutputJson.Remove("inheritsFrom");
OutputJson.Remove("jar");
OutputJson["id"] = OutputName;
```

### PCL2 ForgelikeInjector 的成功检测（L1704-1705）
```csharp
if (LastResults.Reverse().Take(5).Any(l => l == "true"))
    return;
```

### PCL2 MergeJson 的合并顺序（L4360-4422）
```
1. OutputJson = MinecraftJson (原版)
2. Merge OptiFineJson
3. Merge ForgeJson
4. Merge NeoForgeJson
5. Merge CleanroomJson
6. Merge LiteLoaderJson
7. Merge FabricJson
8. Merge LegacyFabricJson
9. Merge QuiltJson
10. Remove inheritsFrom, jar, _comment_
11. Set id
```
