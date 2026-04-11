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
    
    console.log("--- Sales History Audit ---");
    const linCount = await pool.request().query("SELECT COUNT(*) as cnt FROM PS_TKT_HIST_LIN");
    console.log("Total Sale Lines (History):", linCount.recordset[0].cnt);
    
    const cellLinCount = await pool.request().query("SELECT COUNT(*) as cnt FROM PS_TKT_HIST_LIN_CELL");
    console.log("Total Sale Lines with Variants (History):", cellLinCount.recordset[0].cnt);

    await pool.close();
}

test().catch(console.error);
