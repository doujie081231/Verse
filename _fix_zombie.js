const fs = require('fs');
const path = require('path');
const DATA_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.versepc');
const LIBRARIES_DIR = path.join(DATA_DIR, 'libraries');

const p = 'C:/Users/huang/.versepc/versions/Zombie Invade 100 Days/Zombie Invade 100 Days.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));

const forgeLibs = new Set([
    'cpw.mods:bootstraplauncher:1.1.2',
    'cpw.mods:securejarhandler:2.1.4',
    'org.ow2.asm:asm-commons:9.5',
    'org.ow2.asm:asm-util:9.5',
    'org.ow2.asm:asm-analysis:9.5',
    'org.ow2.asm:asm-tree:9.5',
    'org.ow2.asm:asm:9.5',
    'net.minecraftforge:JarJarFileSystems:0.3.16',
    'net.minecraftforge:fmlcore:1.19.2-43.3.5',
    'net.minecraftforge:fmlloader:1.19.2-43.3.5',
    'net.minecraftforge:forge:1.19.2-43.3.5',
    'net.minecraftforge:javafmllanguage:1.19.2-43.3.5',
    'net.minecraftforge:lowcodelanguage:1.19.2-43.3.5',
    'net.minecraftforge:mclanguage:1.19.2-43.3.5',
    'net.minecraftforge:accesstransformer:4.0.1:jar@at',
    'net.sf.jopt-simple:jopt-simple:5.0.4',
    'org.lwjgl:lwjgl:3.3.1',
    'org.lwjgl:lwjgl-ffi:3.3.1',
    'org.lwjgl:lwjgl-jemalloc:3.3.1',
    'org.lwjgl:lwjgl-openal:3.3.1',
    'org.lwjgl:lwjgl-opengl:3.3.1',
    'org.lwjgl:lwjgl-stb:3.3.1',
    'org.lwjgl:lwjgl-tinyfd:3.3.1',
    'org.lwjgl:lwjgl:3.3.1:natives-windows',
    'org.lwjgl:lwjgl-ffi:3.3.1:natives-windows',
    'org.lwjgl:lwjgl-jemalloc:3.3.1:natives-windows',
    'org.lwjgl:lwjgl-openal:3.3.1:natives-windows',
    'org.lwjgl:lwjgl-opengl:3.3.1:natives-windows',
    'org.lwjgl:lwjgl-stb:3.3.1:natives-windows',
    'org.lwjgl:lwjgl-tinyfd:3.3.1:natives-windows',
    'com.mojang:text2speech:1.17.9',
    'com.mojang:text2speech:1.17.9:natives-windows',
    'net.java.jinput:jinput-platform:2.0.9:natives-windows',
    'net.java.jinput:jinput:2.0.9',
    'net.java.jutils:jutils:1.0.0',
    'org.apache.logging.log4j:log4j-api:2.17.1',
    'org.apache.logging.log4j:log4j-core:2.17.1',
    'org.apache.logging.log4j:log4j-slf4j-impl:2.17.1',
    'org.apache.logging.log4j:log4j-1.2-api:2.17.1',
    'org.lwjgl:lwjgl:3.3.1:natives-linux',
    'org.lwjgl:lwjgl-ffi:3.3.1:natives-linux',
    'org.lwjgl:lwjgl-jemalloc:3.3.1:natives-linux',
    'org.lwjgl:lwjgl-openal:3.3.1:natives-linux',
    'org.lwjgl:lwjgl-opengl:3.3.1:natives-linux',
    'org.lwjgl:lwjgl-stb:3.3.1:natives-linux',
    'org.lwjgl:lwjgl-tinyfd:3.3.1:natives-linux',
    'net.java.jinput:jinput-platform:2.0.9:natives-linux',
    'org.lwjgl:lwjgl:3.3.1:natives-macos',
    'org.lwjgl:lwjgl-ffi:3.3.1:natives-macos',
    'org.lwjgl:lwjgl-jemalloc:3.3.1:natives-macos',
    'org.lwjgl:lwjgl-openal:3.3.1:natives-macos',
    'org.lwjgl:lwjgl-opengl:3.3.1:natives-macos',
    'org.lwjgl:lwjgl-stb:3.3.1:natives-macos',
    'org.lwjgl:lwjgl-tinyfd:3.3.1:natives-macos',
    'net.java.jinput:jinput-platform:2.0.9:natives-macos',
    'net.java.jinput:jinput-platform:2.0.9:natives-osx',
    'org.lwjgl:lwjgl:3.3.1:natives-windows-arm64',
    'org.lwjgl:lwjgl-ffi:3.3.1:natives-windows-arm64',
    'org.lwjgl:lwjgl-jemalloc:3.3.1:natives-windows-arm64',
    'org.lwjgl:lwjgl-openal:3.3.1:natives-windows-arm64',
    'org.lwjgl:lwjgl-opengl:3.3.1:natives-windows-arm64',
    'org.lwjgl:lwjgl-stb:3.3.1:natives-windows-arm64',
    'org.lwjgl:lwjgl-tinyfd:3.3.1:natives-windows-arm64',
    'org.lwjgl:lwjgl:3.3.1:natives-linux-arm64',
    'org.lwjgl:lwjgl-ffi:3.3.1:natives-linux-arm64',
    'org.lwjgl:lwjgl-jemalloc:3.3.1:natives-linux-arm64',
    'org.lwjgl:lwjgl-openal:3.3.1:natives-linux-arm64',
    'org.lwjgl:lwjgl-opengl:3.3.1:natives-linux-arm64',
    'org.lwjgl:lwjgl-stb:3.3.1:natives-linux-arm64',
    'org.lwjgl:lwjgl-tinyfd:3.3.1:natives-linux-arm64',
    'org.lwjgl:lwjgl:3.3.1:natives-macos-arm64',
    'org.lwjgl:lwjgl-ffi:3.3.1:natives-macos-arm64',
    'org.lwjgl:lwjgl-jemalloc:3.3.1:natives-macos-arm64',
    'org.lwjgl:lwjgl-openal:3.3.1:natives-macos-arm64',
    'org.lwjgl:lwjgl-opengl:3.3.1:natives-macos-arm64',
    'org.lwjgl:lwjgl-stb:3.3.1:natives-macos-arm64',
    'org.lwjgl:lwjgl-tinyfd:3.3.1:natives-macos-arm64',
]);

const before = j.libraries.length;
j.libraries = j.libraries.filter(l => {
    if (!l.name) return true;
    return forgeLibs.has(l.name);
});
const after = j.libraries.length;

fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
console.log(`Removed ${before - after} extra libraries (before: ${before}, after: ${after})`);
