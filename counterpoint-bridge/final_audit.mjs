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
        { label: "Total Customers", q: "SELECT COUNT(*) as cnt FROM AR_CUST" },
        { label: "Total Vendors", q: "SELECT COUNT(*) as cnt FROM PO_VEND" },
        { label: "Total Parent Items", q: "SELECT COUNT(*) as cnt FROM IM_ITEM" },
        { label: "Total Barcodes", q: "SELECT COUNT(*) as cnt FROM IM_BARCOD" },
        { label: "Total Matrix Variants (Active)", q: "SELECT COUNT(*) as cnt FROM IM_INV_CELL WHERE LOC_ID = 'MAIN'" },
        { label: "Total Tickets (History)", q: "SELECT COUNT(*) as cnt FROM PS_TKT_HIST" },
        { label: "Total Tickets (Open)", q: "SELECT COUNT(*) as cnt FROM PS_DOC" },
        { label: "Total Gift Cards", q: "SELECT COUNT(*) as cnt FROM SY_GFC" }
    ];

    console.log("--- FINAL DATABASE AUDIT ---");
    for (const c of counters) {
        try {
            const result = await pool.request().query(c.q);
            console.log(`${c.label}: ${result.recordset[0].cnt}`);
        } catch (e) {
            console.log(`${c.label}: ERROR - ${e.message}`);
        }
    }
    
    await pool.close();
}

test().catch(console.error);
