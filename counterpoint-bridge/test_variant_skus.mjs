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
    
    const q = `SELECT TOP 10 c.ITEM_NO, ISNULL((SELECT TOP 1 BARCOD FROM IM_BARCOD WHERE ITEM_NO = c.ITEM_NO AND DIM_1_UPR = c.DIM_1_UPR AND DIM_2_UPR = c.DIM_2_UPR AND DIM_3_UPR = c.DIM_3_UPR), c.ITEM_NO + '-' + c.DIM_1_UPR) AS sku FROM IM_INV_CELL c JOIN IM_INV inv ON c.ITEM_NO = inv.ITEM_NO WHERE c.LOC_ID = 'MAIN' AND (inv.LST_SAL_DAT >= '2021-01-01' OR inv.LST_RECV_DAT >= '2021-01-01' OR inv.QTY_ON_HND > 0)`;
    
    console.log("Testing Variant SKU Generation...");
    const result = await pool.request().query(q);
    console.log(result.recordset);
    
    await pool.close();
}

test().catch(console.error);
