const fs = require('fs');
const ren = JSON.parse(fs.readFileSync('C:/Users/huang/.versepc/versions/人一天/人一天.json', 'utf8'));
const zombie = JSON.parse(fs.readFileSync('C:/Users/huang/.versepc/versions/Zombie Invade 100 Days/Zombie Invade 100 Days.json', 'utf8'));

const renSet = new Set((ren.libraries || []).map(l => l.name).filter(Boolean));
const zombieSet = new Set((zombie.libraries || []).map(l => l.name).filter(Boolean));

const missing = [...renSet].filter(n => !zombieSet.has(n));
const extra = [...zombieSet].filter(n => !renSet.has(n));

console.log('人一天 libs:', renSet.size, 'Zombie libs:', zombieSet.size);
console.log('\n--- 人一天有但Zombie没有 ---');
missing.forEach(n => console.log(' -', n));
console.log('\n--- Zombie有但人一天没有 ---');
extra.forEach(n => console.log(' +', n));
