const fs = require('fs');
const p = 'C:/Users/huang/.versepc/versions/Zombie Invade 100 Days/Zombie Invade 100 Days.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));

const installProfileProcessorLibs = new Set([
    'de.oceanlabs.mcp:mcp_config:1.19.2-20220805.130853:zip',
    'de.oceanlabs.mcp:SpecialSource:1.11.0',
    'net.md-5:SpecialSource:1.11.0',
    'net.minecraftforge:ForgeAutoRenamingTool:0.1.22:all',
    'net.minecraftforge:binarypatcher:1.1.1',
    'net.minecraftforge:installertools:1.3.0',
    'net.minecraftforge:jarsplitter:1.1.4',
    'net.minecraftforge:srgutils:0.4.11',
    'net.minecraftforge:srgutils:0.4.3',
    'net.minecraftforge:srgutils:0.4.9',
    'net.sf.jopt-simple:jopt-simple:6.0-alpha-3',
    'com.github.jponge:lzma-java:1.3',
    'com.google.code.findbugs:jsr305:3.0.2',
    'com.google.errorprone:error_prone_annotations:2.1.3',
    'com.google.guava:guava:20.0',
    'com.google.guava:guava:25.1-jre',
    'com.google.j2objc:j2objc-annotations:1.1',
    'com.nothome:javaxdelta:2.0.1',
    'com.opencsv:opencsv:4.4',
    'commons-beanutils:commons-beanutils:1.9.3',
    'commons-collections:commons-collections:3.2.2',
    'commons-io:commons-io:2.4',
    'de.siegmar:fastcsv:2.0.0',
    'net.minecraftforge:fmlcore:1.19.2-43.3.5',
    'net.minecraftforge:javafmllanguage:1.19.2-43.3.5',
    'net.minecraftforge:lowcodelanguage:1.19.2-43.3.5',
    'net.minecraftforge:mclanguage:1.19.2-43.3.5',
    'org.apache.commons:commons-collections4:4.2',
    'org.apache.commons:commons-lang3:3.8.1',
    'org.apache.commons:commons-text:1.3',
    'org.checkerframework:checker-qual:2.0.0',
    'org.codehaus.mojo:animal-sniffer-annotations:1.14',
    'org.ow2.asm:asm-analysis:9.2',
    'org.ow2.asm:asm-analysis:9.3',
    'org.ow2.asm:asm-commons:9.2',
    'org.ow2.asm:asm-commons:9.3',
    'org.ow2.asm:asm-tree:9.2',
    'org.ow2.asm:asm-tree:9.3',
    'org.ow2.asm:asm:9.2',
    'org.ow2.asm:asm:9.3',
    'trove:trove:1.0.2',
]);

const before = j.libraries.length;
j.libraries = j.libraries.filter(l => {
    if (!l.name) return true;
    return !installProfileProcessorLibs.has(l.name);
});
const after = j.libraries.length;

fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
console.log(`Removed ${before - after} install_profile processor libs (before: ${before}, after: ${after})`);
