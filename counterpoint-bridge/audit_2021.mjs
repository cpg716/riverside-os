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
    
    const counters = [
        { label: "Active Customers (Sold since 2021)", q: "SELECT COUNT(*) as cnt FROM AR_CUST WHERE LST_SAL_DAT >= '2021-01-01'" },
        { label: "Active Items (Sold since 2021 or In Stock)", q: "SELECT COUNT(*) as cnt FROM IM_ITEM WHERE LST_SAL_DAT >= '2021-01-01' OR LST_RECV_DAT >= '2021-01-01' OR STAT = 'A'" },
        { label: "Active Variants (Filtered)", q: "SELECT COUNT(*) as cnt FROM IM_INV_CELL c JOIN IM_ITEM i ON c.ITEM_NO = i.ITEM_NO WHERE c.LOC_ID = 'MAIN' AND (i.LST_SAL_DAT >= '2021-01-01' OR i.LST_RECV_DAT >= '2021-01-01' OR i.STAT = 'A')" }
    ];

    console.log("--- 2021+ ACTIVITY AUDIT ---");
    for (const c of counters) {
        const result = await pool.request().query(c.q);
        console.log(`${c.label}: ${result.recordset[0].cnt}`);
    }
    
    await pool.close();
}

test().catch(console.error);
