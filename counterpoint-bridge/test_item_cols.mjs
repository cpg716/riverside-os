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
    
    console.log("Listing columns for IM_ITEM...");
    const result = await pool.request().query("SELECT TOP 1 * FROM IM_ITEM");
    console.log(Object.keys(result.recordset[0]).filter(k => k.includes('GRID') || k.includes('TYP') || k.includes('CELL')));
    
    await pool.close();
}

test().catch(console.error);
