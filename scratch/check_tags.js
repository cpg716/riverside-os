
import fs from 'fs';

const content = fs.readFileSync('/Users/cpg/riverside-os/client/src/components/settings/SettingsWorkspace.tsx', 'utf8');

function checkBalance(tag) {
    const open = (content.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const close = (content.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    console.log(`${tag}: open=${open}, close=${close}, diff=${open - close}`);
}

checkBalance('div');
checkBalance('section');
checkBalance('header');
checkBalance('aside');
checkBalance('main');
checkBalance('nav');
checkBalance('button');
checkBalance('label');
checkBalance('span');
checkBalance('p');
checkBalance('h1');
checkBalance('h2');
checkBalance('h3');
checkBalance('h4');
checkBalance('ul');
checkBalance('li');
checkBalance('table');
checkBalance('thead');
checkBalance('tbody');
checkBalance('tr');
checkBalance('th');
checkBalance('td');
checkBalance('input');
checkBalance('textarea');
checkBalance('select');
checkBalance('option');
checkBalance('strong');
checkBalance('code');
checkBalance('a');
