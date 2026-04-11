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
    
    console.log("Checking IM_ITEM count (Maintenance since 2021)...");
    const result = await pool.request().query("SELECT COUNT(*) as total FROM IM_ITEM WHERE LST_MAINT_DT >= '2021-01-01'");
    console.log("Total products modified since 2021:", result.recordset[0].total);
    
    await pool.close();
}

test().catch(console.error);
