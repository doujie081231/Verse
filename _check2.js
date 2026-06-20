const fs = require('fs');
const renVJ = 'C:/Users/huang/.versepc/versions/人一天/version.json';
const renMain = 'C:/Users/huang/.versepc/versions/人一天/人一天.json';

if (fs.existsSync(renVJ)) {
    const vj = JSON.parse(fs.readFileSync(renVJ, 'utf8'));
    const mj = JSON.parse(fs.readFileSync(renMain, 'utf8'));

    console.log('=== version.json vs 人一天.json ===');
    console.log('version.json id:', vj.id);
    console.log('人一天.json id:', mj.id);

    console.log('\n=== version.json mainClass ===');
    console.log(vj.mainClass);

    console.log('\n=== version.json libs count ===');
    console.log(vj.libraries?.length || 0);

    console.log('\n=== version.json JVM -p ===');
    const jvm = vj.arguments?.jvm || [];
    for (let i = 0; i < jvm.length; i++) {
        if (jvm[i] === '-p') {
            const mp = jvm[i + 1] || '';
            const entries = mp.split(/\$\{classpath_separator\}/);
            console.log('entries:', entries.length);
            entries.forEach((e, idx) => {
                const short = e.replace('${library_directory}/', '');
                console.log(' ', idx, short.substring(0, 80));
            });
            break;
        }
    }

    console.log('\n=== version.json has -cp? ===');
    for (let i = 0; i < jvm.length; i++) {
        if (jvm[i] === '-cp') {
            console.log('YES, -cp at index', i);
            const cp = jvm[i + 1] || '';
            console.log('classpath length:', cp.length, 'chars');
            console.log('has fmlcore:', cp.includes('fmlcore'));
            console.log('has jopt-simple:', cp.includes('jopt-simple'));
            break;
        }
    }
}

// Also check what file the launcher actually loads
console.log('\n=== Zombie 版本文件结构 ===');
const zombieDir = 'C:/Users/huang/.versepc/versions/Zombie Invade 100 Days';
const files = fs.readdirSync(zombieDir);
files.forEach(f => console.log(' ', f));

// Check if there's a version.json in Zombie
if (fs.existsSync(zombieDir + '/version.json')) {
    console.log('\nZombie has version.json!');
    const zvj = JSON.parse(fs.readFileSync(zombieDir + '/version.json', 'utf8'));
    console.log('Zombie version.json id:', zvj.id);
} else {
    console.log('\nZombie does NOT have version.json');
}
