const ExcelJS = require('exceljs');
const path = require('path');

async function inspect() {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile('/Users/cpg/riverside-os/RMS Schedules 2026.xlsx');
    const sheet = workbook.worksheets[0];
    
    console.log('Sheet Name:', sheet.name);
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        if (rowNumber > 20) return;
        const values = row.values.slice(1).map(v => v && v.toString() || '');
        console.log(`Row ${rowNumber}:`, values.join(' | '));
    });
}

inspect();
