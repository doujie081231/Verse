const fs = require('fs');
const path = require('path');
const base = 'C:\\Users\\huang\\.versepc\\versions\\1.20.1-forge-47.4.20';
const vj = JSON.parse(fs.readFileSync(path.join(base, '1.20.1-forge-47.4.20.json'), 'utf8'));
const libs = vj.libraries || [];

// 检查 LWJGL 3.3.1 natives-windows
const lwjgl = libs.find(l => l.name && l.name.includes('lwjgl-glfw') && l.name.includes('natives-windows'));
console.log('=== lwjgl-glfw natives-windows ===');
console.log(JSON.stringify(lwjgl, null, 2));

// 统计所有 natives 路径
const libBase = 'C:\\Users\\huang\\.versepc\\libraries';
let existCount = 0, missCount = 0;
for (const lib of libs) {
  if (lib.downloads && lib.downloads.classifiers) {
    for (const [classifier, dl] of Object.entries(lib.downloads.classifiers)) {
      if (classifier.includes('natives')) {
        const full = path.join(libBase, dl.path);
        if (fs.existsSync(full)) {
          existCount++;
        } else {
          missCount++;
          if (missCount <= 3) console.log('  缺失:', dl.path);
        }
      }
    }
  }
}
console.log('存在:', existCount, '缺失:', missCount);

// 直接看 LWJGL 3.3.1 目录
console.log('=== LWJGL 3.3.1 目录 ===');
const lwjglDir = path.join(libBase, 'org', 'lwjgl', 'lwjgl', '3.3.1');
if (fs.existsSync(lwjglDir)) {
  console.log(fs.readdirSync(lwjglDir));
} else {
  console.log('不存在:', lwjglDir);
}
console.log('=== lwjgl-glfw 3.3.1 目录 ===');
const glfwDir = path.join(libBase, 'org', 'lwjgl', 'lwjgl-glfw', '3.3.1');
if (fs.existsSync(glfwDir)) {
  console.log(fs.readdirSync(glfwDir));
} else {
  console.log('不存在:', glfwDir);
}
