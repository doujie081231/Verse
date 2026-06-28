// ============================================================================
// 原生 JAR/ZIP 文件解析器 - 纯 JS 实现，不依赖第三方库
// ============================================================================
// ZIP 文件格式结构：
// [Local File Headers + Data] ... [Central Directory] ... [End of Central Directory]
// 解析流程：
// 1. 从文件末尾向前搜索 End of Central Directory (EOCD) 签名 (50 4B 05 06)
// 2. 从 EOCD 中读取 Central Directory 的偏移量和条目数
// 3. 遍历 Central Directory 获取每个文件/目录的元信息

const fs = require('fs');
const zlib = require('zlib');

/**
 * 从 Buffer 中读取 32 位无符号小端整数
 */
function readUInt32LE(buffer, offset) {
    return buffer.readUInt32LE(offset);
}

/**
 * 从 Buffer 中读取 16 位无符号小端整数
 */
function readUInt16LE(buffer, offset) {
    return buffer.readUInt16LE(offset);
}

/**
 * 查找 ZIP 文件的 EOCD（End of Central Directory）记录位置
 * EOCD 签名 = 0x06054b50 (小端: 50 4B 05 06)
 * 从文件末尾向前搜索，因为 EOCD 可能紧跟注释
 */
function findEndOfCentralDirectory(buffer) {
    const length = buffer.length;
    const minEOCDSize = 22;
    const maxCommentLength = 65535;
    const maxEOCDSearch = minEOCDSize + maxCommentLength;

    const searchStart = Math.max(0, length - maxEOCDSearch);
    for (let i = length - minEOCDSize; i >= searchStart; i--) {
        if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b &&
            buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
            return i;
        }
    }
    throw new Error('无法找到ZIP结束标记（End of Central Directory）');
}

/**
 * 解析 JAR/ZIP 文件获取所有条目列表
 * @param {string} jarPath - JAR 文件路径
 * @returns {Array} 条目数组 [{name, isDirectory, size, compressedSize, compressionMethod, localHeaderOffset}]
 */
async function parseJarFile(jarPath) {
    const data = await fs.promises.readFile(jarPath);
    const eocdOffset = findEndOfCentralDirectory(data);

    const diskNumber = readUInt16LE(data, eocdOffset + 4);
    const cdDiskNumber = readUInt16LE(data, eocdOffset + 6);
    const numEntries = readUInt16LE(data, eocdOffset + 10);   // Central Directory 条目总数
    const cdSize = readUInt32LE(data, eocdOffset + 12);       // Central Directory 大小
    const cdOffset = readUInt32LE(data, eocdOffset + 16);     // Central Directory 偏移量

    if (diskNumber !== 0 || cdDiskNumber !== 0) {
        throw new Error('不支持多分卷ZIP文件');
    }

    const entries = [];
    let offset = cdOffset;

    // 遍历 Central Directory 的每个条目
    for (let i = 0; i < numEntries; i++) {
        if (offset + 46 > data.length) break;

        const sig = readUInt32LE(data, offset);
        if (sig !== 0x02014b50) {  // Central Directory 签名
            break;
        }

        const compressionMethod = readUInt16LE(data, offset + 10);  // 0=存储, 8=Deflate
        const compressedSize = readUInt32LE(data, offset + 20);
        const uncompressedSize = readUInt32LE(data, offset + 24);
        const nameLength = readUInt16LE(data, offset + 28);
        const extraLength = readUInt16LE(data, offset + 30);
        const commentLength = readUInt16LE(data, offset + 32);
        const localHeaderOffset = readUInt32LE(data, offset + 42);

        const nameStart = offset + 46;
        const name = data.toString('utf-8', nameStart, nameStart + nameLength);

        entries.push({
            name: name,
            isDirectory: name.endsWith('/'),
            size: uncompressedSize,
            compressedSize: compressedSize,
            compressionMethod: compressionMethod,
            localHeaderOffset: localHeaderOffset,
        });

        offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}

/**
 * 读取 JAR/ZIP 文件中的指定条目内容
 * @param {string} jarPath - JAR 文件路径
 * @param {string} entryName - 条目名称
 * @returns {Buffer|null} 文件内容 Buffer
 *
 * 流程：
 * 1. 解析 Central Directory 找到目标条目
 * 2. 跳转到 Local File Header 读取压缩数据
 * 3. 根据压缩方法（0=存储/8=Deflate）解压返回原始数据
 */
async function readJarEntryContent(jarPath, entryName) {
    const data = await fs.promises.readFile(jarPath);
    const entries = [];

    // 解析 Central Directory
    const eocdOffset = findEndOfCentralDirectory(data);
    const numEntries = readUInt16LE(data, eocdOffset + 10);
    const cdOffset = readUInt32LE(data, eocdOffset + 16);

    let offset = cdOffset;
    for (let i = 0; i < numEntries; i++) {
        if (offset + 46 > data.length) break;
        const sig = readUInt32LE(data, offset);
        if (sig !== 0x02014b50) break;

        const compressionMethod = readUInt16LE(data, offset + 10);
        const compressedSize = readUInt32LE(data, offset + 20);
        const uncompressedSize = readUInt32LE(data, offset + 24);
        const nameLength = readUInt16LE(data, offset + 28);
        const extraLength = readUInt16LE(data, offset + 30);
        const commentLength = readUInt16LE(data, offset + 32);
        const localHeaderOffset = readUInt32LE(data, offset + 42);

        const nameStart = offset + 46;
        const name = data.toString('utf-8', nameStart, nameStart + nameLength);

        entries.push({
            name: name,
            compressionMethod: compressionMethod,
            compressedSize: compressedSize,
            uncompressedSize: uncompressedSize,
            localHeaderOffset: localHeaderOffset,
        });

        offset += 46 + nameLength + extraLength + commentLength;
    }

    const targetEntry = entries.find(e => e.name === entryName || e.name === entryName.replace(/\//g, '/'));
    if (!targetEntry) return null;

    // 读取 Local File Header
    let localOffset = targetEntry.localHeaderOffset;
    const localSig = readUInt32LE(data, localOffset);
    if (localSig !== 0x04034b50) {  // Local File Header 签名
        throw new Error('无效的Local File Header');
    }

    const localNameLength = readUInt16LE(data, localOffset + 26);
    const localExtraLength = readUInt16LE(data, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    const compressedData = data.slice(dataStart, dataStart + targetEntry.compressedSize);

    // 根据压缩方法解压
    if (targetEntry.compressionMethod === 0) {       // 无压缩（STORED）
        return Buffer.from(compressedData);
    } else if (targetEntry.compressionMethod === 8) { // Deflate 压缩
        return new Promise((resolve, reject) => {
            zlib.inflateRaw(compressedData, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
    } else {
        throw new Error('不支持的压缩方法: ' + targetEntry.compressionMethod);
    }
}

module.exports = { parseJarFile, readJarEntryContent };
