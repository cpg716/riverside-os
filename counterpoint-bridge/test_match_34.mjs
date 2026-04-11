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
    
    console.log("Checking for 'Item 34' in the Inventory Query...");
    const q = `SELECT TOP 1 b.BARCOD, inv.QTY_ON_HND FROM IM_INV inv JOIN IM_BARCOD b ON inv.ITEM_NO = b.ITEM_NO WHERE b.ITEM_NO = '34' AND inv.LOC_ID = 'MAIN'`;
    const result = await pool.request().query(q);
    console.log("Result for item 34:", result.recordset);
    
    await pool.close();
}

test().catch(console.error);
