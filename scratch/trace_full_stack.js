
import fs from 'fs';

const content = fs.readFileSync('/Users/cpg/riverside-os/client/src/components/settings/SettingsWorkspace.tsx', 'utf8');
const lines = content.split('\n');

let stack = [];
const openTagRegex = /<([a-zA-Z0-9]+)[\s>]/g;
const closeTagRegex = /<\/([a-zA-Z0-9]+)>/g;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    let tagsOnLine = [];
    
    // Simple regex search (no attribute parsing, just tags)
    while ((match = openTagRegex.exec(line)) !== null) { tagsOnLine.push({ type: 'open', tag: match[1], pos: match.index }); }
    while ((match = closeTagRegex.exec(line)) !== null) { tagsOnLine.push({ type: 'close', tag: match[1], pos: match.index }); }
    tagsOnLine.sort((a, b) => a.pos - b.pos);
    
    for (const t of tagsOnLine) {
        if (t.type === 'open') {
            stack.push({ tag: t.tag, line: i + 1 });
        } else {
            if (stack.length > 0) {
                const last = stack.pop();
                if (last.tag !== t.tag) {
                    console.log(`MISMATCH at line ${i + 1}: Expected </${last.tag}> (from line ${last.line}), got </${t.tag}>`);
                }
            } else {
                console.log(`EXTRA CLOSE </${t.tag}> at line ${i + 1}`);
            }
        }
    }
}
console.log(`REMAINING: ${stack.map(s => `${s.tag}(L${s.line})`).join(', ')}`);
