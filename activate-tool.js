const crypto = require('crypto');

const SECRET = 'VersePC$ecureK3y#2026@Activation!Gen';
const HASH_LEN = 12;

const args = process.argv.slice(2);

if (args.length === 0) {
    console.log('');
    console.log('========================================');
    console.log('  VersePC 密钥激活工具 v1.0');
    console.log('========================================');
    console.log('');
    console.log('用法:');
    console.log('  node activate.js <机器识别码> [类型] [版本]');
    console.log('');
    console.log('参数:');
    console.log('  机器识别码  16位大写字母 (必填)');
    console.log('  类型        vp=永久 vs=单次 (默认 vp)');
    console.log('  版本        版本号 (默认 1.2.5)');
    console.log('');
    console.log('示例:');
    console.log('  node activate.js A1B2C3D4E5F6G7H8');
    console.log('  node activate.js A1B2C3D4E5F6G7H8 vs 1.2.5');
    console.log('');
    process.exit(0);
}

const machineId = args[0].toUpperCase();
const type = (args[1] || 'vp').toLowerCase();
const version = args[2] || '1.2.5';

if (machineId.length !== 16) {
    console.log('错误: 机器识别码必须是16位大写字母');
    process.exit(1);
}

let data;
if (type === 'vp' || type === 'permanent') {
    data = machineId + '|PERM';
} else {
    data = machineId + '|SINGLE|' + version;
}

const prefix = (type === 'vp' || type === 'permanent') ? 'VP' : 'VS';
const hash = crypto.createHmac('sha256', SECRET).update(data).digest('hex').toUpperCase().substring(0, HASH_LEN);
const code = prefix + '-' + hash;

console.log('');
console.log('========================================');
console.log('机器识别码: ' + machineId);
console.log('激活码类型: ' + (prefix === 'VP' ? '永久激活' : '单次激活'));
if (prefix === 'VS') console.log('版本号: ' + version);
console.log('----------------------------------------');
console.log('生成的激活码: ' + code);
console.log('========================================');
console.log('');
