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
        { label: "Modern Customers (Sold 2021+)", q: "SELECT COUNT(*) as cnt FROM AR_CUST WHERE LST_SAL_DAT >= '2021-01-01'" },
        { label: "Modern Items (Sold/Recv 2021+ or In Stock)", q: "SELECT COUNT(*) as cnt FROM IM_INV WHERE (LST_SAL_DAT >= '2021-01-01' OR LST_RECV_DAT >= '2021-01-01' OR QTY_ON_HND > 0) AND LOC_ID = 'MAIN'" },
        { label: "Modern Variants (Active stock)", q: "SELECT COUNT(*) as cnt FROM IM_INV_CELL WHERE (QTY_ON_HND > 0) AND LOC_ID = 'MAIN'" }
    ];

    console.log("--- 2021+ MODERN AUDIT ---");
    for (const c of counters) {
        const result = await pool.request().query(c.q);
        console.log(`${c.label}: ${result.recordset[0].cnt}`);
    }
    
    await pool.close();
}

test().catch(console.error);
