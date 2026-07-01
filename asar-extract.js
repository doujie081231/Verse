/**
 * 解析 asar 文件，提取指定文件内容
 * 用法：node asar-extract.js <asar-path> <file-path-in-asar>
 */
const fs = require('fs');
const path = require('path');

const asarPath = process.argv[2];
const filePath = process.argv[3];

if (!asarPath || !filePath) {
  console.error('Usage: node asar-extract.js <asar-path> <file-path-in-asar>');
  process.exit(1);
}

const buf = fs.readFileSync(asarPath);

// asar header: 4 bytes (size) + 4 bytes + 4 bytes (headerSize) + 4 bytes + JSON
const size1 = buf.readUInt32LE(0);
const size2 = buf.readUInt32LE(4);
const headerSize = buf.readUInt32LE(8);
const size4 = buf.readUInt32LE(12);

// JSON header starts at offset 16
const headerJson = buf.slice(16, 16 + headerSize).toString('utf8');
const header = JSON.parse(headerJson);

// 在 header 中查找文件
function findFile(node, parts) {
  if (parts.length === 0) return node;
  const name = parts[0];
  if (!node.files || !node.files[name]) return null;
  return findFile(node.files[name], parts.slice(1));
}

const parts = filePath.split(/[/\\]/);
const fileNode = findFile(header, parts);

if (!fileNode || !fileNode.offset) {
  console.error('File not found in asar:', filePath);
  console.error('Available top-level entries:', Object.keys(header.files || {}));
  process.exit(1);
}

const offset = parseInt(fileNode.offset, 10) + 16 + headerSize;
const size = fileNode.size;
const content = buf.slice(offset, offset + size).toString('utf8');
process.stdout.write(content);
