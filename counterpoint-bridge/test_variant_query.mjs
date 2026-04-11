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
    
    console.log("Testing Variation Query (IM_INV_CELL)...");
    const q = `SELECT TOP 5 c.ITEM_NO, c.DIM_1_UPR FROM IM_INV_CELL c JOIN IM_INV inv ON c.ITEM_NO = inv.ITEM_NO WHERE c.LOC_ID = 'MAIN' AND (inv.LST_SAL_DAT >= '2021-01-01' OR inv.LST_RECV_DAT >= '2021-01-01' OR inv.QTY_ON_HND > 0)`;
    const result = await pool.request().query(q);
    console.log(result.recordset);
    
    await pool.close();
}

test().catch(console.error);
