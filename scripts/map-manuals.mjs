import fs from 'node:fs';
import path from 'node:path';

const staffDir = 'docs/staff';
const assetsDir = 'client/src/assets/docs';

const staffFiles = fs.readdirSync(staffDir).filter(f => f.endsWith('.md') && f !== '_TEMPLATE.md' && !f.includes('README'));
const assetFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('-manual.md'));

const mapping = [];

for (const sf of staffFiles) {
    let target = sf;
    if (!sf.endsWith('-manual.md')) {
        target = sf.replace(/\.md$/, '-manual.md');
    }
    
    // Check for exact matches first
    let matched = assetFiles.find(af => af === target);
    
    // If no exact match, try to find a component manual that looks similar
    if (!matched) {
        const stem = sf.replace(/\.md$/, '').replace(/-back-office$/, '').replace(/^pos-/, '');
        matched = assetFiles.find(af => af.includes(stem));
    }
    
    mapping.push({ staff: sf, asset: matched || target });
}

console.log(JSON.stringify(mapping, null, 2));
