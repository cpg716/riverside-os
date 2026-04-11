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
    
    const count = await pool.request().query("SELECT COUNT(*) as cnt FROM IM_INV WHERE LOC_ID = 'MAIN' AND (LST_SAL_DAT >= '2021-01-01' OR LST_RECV_DAT >= '2021-01-01' OR QTY_ON_HND > 0)");
    console.log("Total Active items in IM_INV since 2021:", count.recordset[0].cnt);
    
    await pool.close();
}

test().catch(console.error);
