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
    
    console.log("Checking Active Count across ALL locations (2021+)...");
    const q = `SELECT COUNT(DISTINCT ITEM_NO) as total FROM IM_INV WHERE LST_SAL_DAT >= '2021-01-01' OR LST_RECV_DAT >= '2021-01-01' OR QTY_ON_HND > 0`;
    const result = await pool.request().query(q);
    console.log("Total unique active items across ALL locs:", result.recordset[0].total);
    
    await pool.close();
}

test().catch(console.error);
