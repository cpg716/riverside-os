
import fs from 'fs';

const content = fs.readFileSync('/Users/cpg/riverside-os/client/src/components/settings/SettingsWorkspace.tsx', 'utf8');
const lines = content.split('\n');

function checkLine(tag) {
    let openCount = 0;
    const openTag = `<${tag}`;
    const closeTag = `</${tag}>`;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const opens = (line.match(new RegExp(openTag, 'g')) || []).length;
        const closes = (line.match(new RegExp(closeTag, 'g')) || []).length;
        
        const prev = openCount;
        openCount += (opens - closes);
        
        if (openCount < 0) {
            console.log(`Overly closed ${tag} at line ${i + 1}: ${line.trim()}`);
            openCount = 0;
        }
    }
    if (openCount > 0) {
        console.log(`Unclosed ${tag} remaining count: ${openCount}`);
    }
}

console.log('--- DIV ---');
checkLine('div');
console.log('--- SPAN ---');
checkLine('span');
console.log('--- P ---');
checkLine('p');
console.log('--- CODE ---');
checkLine('code');
