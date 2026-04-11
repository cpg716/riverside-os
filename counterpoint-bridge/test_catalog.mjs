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
    
    // The exact query from .env (expanded manually for testing)
    const query = `
        SELECT RTRIM(LTRIM(i.ITEM_NO)) AS item_no, 
        RTRIM(LTRIM(ISNULL((SELECT TOP 1 BARCOD FROM IM_BARCOD WHERE ITEM_NO = i.ITEM_NO), i.ITEM_NO))) AS sku, 
        RTRIM(LTRIM(i.DESCR)) AS name, 
        RTRIM(LTRIM(i.CATEG_COD)) AS category_name, 
        CAST(ISNULL(i.LST_COST, 0) AS DECIMAL(18,2)) AS cost_price, 
        RTRIM(LTRIM(i.VEND_NO)) AS vendor_code, 
        CAST(ISNULL(i.PRC_1, 0) AS DECIMAL(18,2)) AS retail_price 
        FROM IM_ITEM i
    `;
    
    console.log("Executing query...");
    const result = await pool.request().query(query);
    console.log("Rows returned:", result.recordset.length);
    if (result.recordset.length > 0) {
        console.log("Sample row:", result.recordset[0]);
    }
    
    await pool.close();
}

test().catch(console.error);
