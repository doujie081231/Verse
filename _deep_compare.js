const fs = require('fs');
const a = require('C:/Users/huang/.versepc/versions/人一天/人一天.json');
const b = require('C:/Users/huang/.versepc/versions/Zombie Invade 100 Days/Zombie Invade 100 Days.json');

console.log('=== 顶层字段对比 ===');
for (const key of ['id', 'inheritsFrom', 'mainClass', 'type', 'minecraftArguments']) {
    const av = a[key] ? JSON.stringify(a[key]).substring(0, 100) : '(undefined)';
    const bv = b[key] ? JSON.stringify(b[key]).substring(0, 100) : '(undefined)';
    const same = av === bv ? 'SAME' : 'DIFF';
    console.log(`${same} ${key}: 人一天=${av} | Zombie=${bv}`);
}

console.log('\n=== arguments.game 对比 ===');
const ag = (a.arguments?.game || []).map(x => typeof x === 'object' ? JSON.stringify(x) : x);
const bg = (b.arguments?.game || []).map(x => typeof x === 'object' ? JSON.stringify(x) : x);
const agSet = new Set(ag);
const bgSet = new Set(bg);
const gameMissing = [...bgSet].filter(s => !agSet.has(s));
const gameExtra = [...agSet].filter(s => !bgSet.has(s));
console.log('Zombie game args missing:', gameMissing.length ? gameMissing : 'none');
console.log('Extra game args:', gameExtra.length ? gameExtra : 'none');

console.log('\n=== arguments.jvm 对比 ===');
const aj = (a.arguments?.jvm || []).map(x => typeof x === 'object' ? JSON.stringify(x) : x);
const bj = (b.arguments?.jvm || []).map(x => typeof x === 'object' ? JSON.stringify(x) : x);
const ajSet = new Set(aj);
const bjSet = new Set(bj);
const jvmMissing = [...bjSet].filter(s => !ajSet.has(s));
const jvmExtra = [...ajSet].filter(s => !bjSet.has(s));
console.log('Zombie jvm args missing:', jvmMissing.length);
jvmMissing.forEach(s => console.log(' +', s.substring(0, 200)));
console.log('Extra jvm args:', jvmExtra.length);
jvmExtra.forEach(s => console.log(' -', s.substring(0, 200)));

console.log('\n=== Forge 安装目录内容对比 ===');
const renDir = 'C:/Users/huang/.versepc/versions/人一天';
const zombieDir = 'C:/Users/huang/.versepc/versions/Zombie Invade 100 Days';
const renFiles = fs.readdirSync(renDir).filter(f => f.endsWith('.json'));
const zombieFiles = fs.readdirSync(zombieDir).filter(f => f.endsWith('.json'));
console.log('人一天 .json files:', renFiles);
console.log('Zombie .json files:', zombieFiles);
const hasInstallProfile = fs.existsSync(zombieDir + '/install_profile.json');
console.log('Zombie has install_profile.json:', hasInstallProfile);
const hasRenInstallProfile = fs.existsSync(renDir + '/install_profile.json');
console.log('人一天 has install_profile.json:', hasRenInstallProfile);

console.log('\n=== 人一天 的 install_profile.json 中的 mainClass ===');
if (hasRenInstallProfile) {
    const rip = JSON.parse(fs.readFileSync(renDir + '/install_profile.json', 'utf8'));
    console.log('mainClass:', rip.mainClass);
    console.log('processors count:', (rip.processors || []).length);
    console.log('libraries count:', (rip.libraries || []).length);
}
