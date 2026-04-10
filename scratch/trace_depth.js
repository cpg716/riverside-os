
import fs from 'fs';

const content = fs.readFileSync('/Users/cpg/riverside-os/client/src/components/settings/SettingsWorkspace.tsx', 'utf8');
const lines = content.split('\n');

function trace(tag) {
    let depth = 0;
    const openTagRegex = new RegExp(`<${tag}[\\s>]`, 'g');
    const closeTagRegex = new RegExp(`</${tag}>`, 'g');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const opens = (line.match(openTagRegex) || []).length;
        const closes = (line.match(closeTagRegex) || []).length;
        
        const oldDepth = depth;
        depth += opens - closes;
        
        if (depth < 0) {
            console.log(`[${tag}] NEGATIVE DEPTH at line ${i + 1}: ${line.trim()}`);
            depth = 0;
        }
    }
    console.log(`[${tag}] Final depth: ${depth}`);
}

trace('div');
trace('span');
trace('p');
trace('code');
trace('section');
