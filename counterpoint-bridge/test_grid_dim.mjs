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
    
    console.log("--- IM_GRID_DIM_1 Sample ---");
    const result = await pool.request().query("SELECT TOP 5 * FROM IM_GRID_DIM_1");
    console.log(result.recordset);
    
    await pool.close();
}

test().catch(console.error);
