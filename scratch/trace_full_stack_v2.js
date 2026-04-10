
import fs from 'fs';

const content = fs.readFileSync('/Users/cpg/riverside-os/client/src/components/settings/SettingsWorkspace.tsx', 'utf8');
const lines = content.split('\n');

let stack = [];
// Match open tags, but NOT if they self-close.
// This is tricky with regex. I'll search for <Tag and then see if it ends with />.
const openTagRegex = /<([a-zA-Z0-9.]+)([\s\S]*?)>/g;
const closeTagRegex = /<\/([a-zA-Z0-9.]+)>/g;

// I'll use a better approach: parse the line for tags.
for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Find all tags: <Tag ... />, <Tag ...>, </Tag>
    // I'll find all < or </ and then find the closing >.
    let pos = 0;
    while (pos < line.length) {
        let openPos = line.indexOf('<', pos);
        if (openPos === -1) break;
        
        let closePos = line.indexOf('>', openPos);
        if (closePos === -1) break;
        
        const tagContent = line.substring(openPos, closePos + 1);
        pos = closePos + 1;
        
        if (tagContent.startsWith('</')) {
            // Close tag
            const name = tagContent.substring(2, tagContent.length - 1).trim();
            if (stack.length > 0) {
                const last = stack.pop();
                if (last.tag !== name) {
                    // console.log(`MISMATCH at line ${i + 1}: Expected </${last.tag}> (from line ${last.line}), got </${name}>`);
                }
            } else {
                console.log(`EXTRA CLOSE </${name}> at line ${i + 1}`);
            }
        } else if (tagContent.endsWith('/>')) {
            // Self-closing
            continue;
        } else if (tagContent.match(/^<[a-zA-Z]/)) {
            // Open tag
            const name = tagContent.match(/^<([a-zA-Z0-9.]+)/)[1];
            // Ignore common non-JSX things like <N
            if (['number', 'string', 'boolean'].includes(name)) continue;
            stack.push({ tag: name, line: i + 1 });
        }
    }
}
console.log(`REMAINING: ${stack.map(s => `${s.tag}(L${s.line})`).join(', ')}`);
