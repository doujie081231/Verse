const fs = require('fs');
const p = 'C:/Users/huang/.versepc/versions/Zombie Invade 100 Days/Zombie Invade 100 Days.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const jvm = j.arguments.jvm;
let pIdx = -1;
for (let i = 0; i < jvm.length; i++) { if (jvm[i] === '-p') { pIdx = i; break; } }
const origModulePath = '${library_directory}/cpw/mods/bootstraplauncher/1.1.2/bootstraplauncher-1.1.2.jar${classpath_separator}${library_directory}/cpw/mods/securejarhandler/2.1.4/securejarhandler-2.1.4.jar${classpath_separator}${library_directory}/org/ow2/asm/asm-commons/9.5/asm-commons-9.5.jar${classpath_separator}${library_directory}/org/ow2/asm/asm-util/9.5/asm-util-9.5.jar${classpath_separator}${library_directory}/org/ow2/asm/asm-analysis/9.5/asm-analysis-9.5.jar${classpath_separator}${library_directory}/org/ow2/asm/asm-tree/9.5/asm-tree-9.5.jar${classpath_separator}${library_directory}/org/ow2/asm/asm/9.5/asm-9.5.jar${classpath_separator}${library_directory}/net/minecraftforge/JarJarFileSystems/0.3.16/JarJarFileSystems-0.3.16.jar';
jvm[pIdx + 1] = origModulePath;
fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
console.log('Restored module path to original 8 entries');
