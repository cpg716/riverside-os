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
    
    console.log("--- IM_SKU Count ---");
    const count = await pool.request().query("SELECT COUNT(*) as cnt FROM IM_SKU");
    console.log("Total rows in IM_SKU:", count.recordset[0].cnt);
    
    console.log("--- IM_TAG Count ---");
    const tagCount = await pool.request().query("SELECT COUNT(*) as cnt FROM IM_TAG");
    console.log("Total rows in IM_TAG:", tagCount.recordset[0].cnt);

    await pool.close();
}

test().catch(console.error);
