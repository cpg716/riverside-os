const receiptline = require('receiptline');
const doc = `
^6470 Transit Rd
| 6470 Transit Rd |
`;
console.log(receiptline.transform(doc, {cpl: 42, encoding: 'cp437', command: 'svg'}));
