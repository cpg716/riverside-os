import sql from 'mssql';
import fs from 'fs';

async function test() {
    const env = fs.readFileSync('.env', 'utf8');
    const match = env.match(/SQL_CONNECTION_STRING=(.*)/);
    if (!match) throw new Error("SQL_CONNECTION_STRING not found in .env");
    const conn = match[1].trim();
    
    console.log("Connecting...");
    const pool = new sql.ConnectionPool(conn);
    await pool.connect();
    
    console.log("--- Tables with 'BARCOD' or 'SKU' column ---");
    const result = await pool.request().query("SELECT t.name, c.name as col FROM sys.tables t JOIN sys.columns c ON t.object_id = c.object_id WHERE t.name LIKE 'IM_%' AND (c.name LIKE '%BARCOD%' OR c.name LIKE '%SKU%') ORDER BY t.name");
    console.table(result.recordset);
    
    await pool.close();
}

test().catch(console.error);
