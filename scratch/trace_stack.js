
import fs from 'fs';

const content = fs.readFileSync('/Users/cpg/riverside-os/client/src/components/settings/SettingsWorkspace.tsx', 'utf8');
const lines = content.split('\n');

function trace(tag) {
    let stack = [];
    const openTagRegex = new RegExp(`<${tag}[\\s>]`, 'g');
    const closeTagRegex = new RegExp(`</${tag}>`, 'g');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match;
        
        let tagsOnLine = [];
        while ((match = openTagRegex.exec(line)) !== null) { tagsOnLine.push({ type: 'open', pos: match.index }); }
        while ((match = closeTagRegex.exec(line)) !== null) { tagsOnLine.push({ type: 'close', pos: match.index }); }
        tagsOnLine.sort((a, b) => a.pos - b.pos);
        
        for (const t of tagsOnLine) {
            if (t.type === 'open') {
                stack.push(i + 1);
            } else {
                if (stack.length > 0) {
                    stack.pop();
                } else {
                    console.log(`[${tag}] UNMATCHED CLOSE at line ${i + 1}: ${line.trim()}`);
                }
            }
        }
    }
    if (stack.length > 0) {
        console.log(`[${tag}] REMAINING UNCLOSED from lines: ${stack.join(', ')}`);
    }
}

trace('div');
trace('span');
trace('p');
trace('section');
