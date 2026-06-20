const fs = require('fs');
const path = require('path');
const p = 'C:/Users/huang/.versepc/versions/Zombie Invade 100 Days/Zombie Invade 100 Days.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));

// The 1.19.2 vanilla version JSON has all the base libraries
const renPath = 'C:/Users/huang/.versepc/versions/人一天/人一天.json';
const ren = JSON.parse(fs.readFileSync(renPath, 'utf8'));

const zombieNames = new Set(j.libraries.map(l => l.name).filter(Boolean));
const missingFromVanilla = (ren.libraries || []).filter(l => l.name && !zombieNames.has(l.name));

console.log('Zombie currently:', j.libraries.length, 'libs');
console.log('人一天 has', missingFromVanilla.length, 'libs that Zombie is missing');

for (const lib of missingFromVanilla) {
    j.libraries.push(lib);
}

fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
console.log('After restore:', j.libraries.length, 'libs');
