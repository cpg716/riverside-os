const ExcelJS = require('exceljs');
const path = require('path');

async function dumpExcel() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile('/Users/cpg/riverside-os/RMS Schedules 2026.xlsx');
  const worksheet = workbook.worksheets[0];

  console.log(`Worksheet: ${worksheet.name}`);
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (rowNumber > 20) return; // limit output
    const vals = row.values.slice(1); // exceljs rows are 1-indexed
    console.log(`Row ${rowNumber}: ${vals.join(' | ')}`);
  });
}

dumpExcel().catch(console.error);
