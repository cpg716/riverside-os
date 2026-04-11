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
    
    console.log("--- IM_INV_CELL Columns ---");
    const result = await pool.request().query("SELECT TOP 1 * FROM IM_INV_CELL");
    console.log(Object.keys(result.recordset[0]).sort().join(", "));
    
    await pool.close();
}

test().catch(console.error);
