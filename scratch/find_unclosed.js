
import fs from 'fs';

const content = fs.readFileSync('/Users/cpg/riverside-os/client/src/components/settings/SettingsWorkspace.tsx', 'utf8');
const lines = content.split('\n');

function findUnclosed(tag) {
    let stack = [];
    const openTagRegex = new RegExp(`<${tag}[\\s>]`, 'g');
    const closeTagRegex = new RegExp(`</${tag}>`, 'g');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let match;
        
        // Find all opens and closes on this line
        let tagsOnLine = [];
        while ((match = openTagRegex.exec(line)) !== null) {
            tagsOnLine.push({ type: 'open', pos: match.index });
        }
        while ((match = closeTagRegex.exec(line)) !== null) {
            tagsOnLine.push({ type: 'close', pos: match.index });
        }
        
        // Sort by position
        tagsOnLine.sort((a, b) => a.pos - b.pos);
        
        for (const t of tagsOnLine) {
            if (t.type === 'open') {
                stack.push(i + 1);
            } else {
                if (stack.length > 0) {
                    stack.pop();
                } else {
                    console.log(`EXTRA CLOSE </${tag}> at line ${i + 1}: ${line.trim()}`);
                }
            }
        }
    }
    
    if (stack.length > 0) {
        console.log(`UNCLOSED <${tag}> from lines: ${stack.join(', ')}`);
    }
}

console.log('--- DIV ---');
findUnclosed('div');
console.log('--- SPAN ---');
findUnclosed('span');
console.log('--- P ---');
findUnclosed('p');
console.log('--- CODE ---');
findUnclosed('code');
findUnclosed('section');
findUnclosed('header');
