import sql from 'mssql';
import fs from 'fs';

async function test() {
    const env = fs.readFileSync('.env', 'utf8');
    const match = env.match(/SQL_CONNECTION_STRING=(.*)/);
    if (!match) throw new Error("SQL_CONNECTION_STRING not found in .env");
    const conn = match[1].trim();
    
    const pool = new sql.ConnectionPool(conn);
    await pool.connect();
    
    const catalogSql = `SELECT RTRIM(LTRIM(i.ITEM_NO)) AS item_no, RTRIM(LTRIM(i.ITEM_NO)) AS sku, RTRIM(LTRIM(i.DESCR)) AS name, RTRIM(LTRIM(i.CATEG_COD)) AS category_name, CAST(ISNULL(i.LST_COST, 0) AS DECIMAL(18,2)) AS cost_price, RTRIM(LTRIM(i.ITEM_VEND_NO)) AS vendor_code, CAST(ISNULL(i.PRC_1, 0) AS DECIMAL(18,2)) AS retail_price, i.IS_GRID FROM IM_ITEM i JOIN IM_INV inv ON i.ITEM_NO = inv.ITEM_NO WHERE inv.LOC_ID = 'MAIN' AND (inv.LST_SAL_DAT >= '2021-01-01' OR inv.LST_RECV_DAT >= '2021-01-01' OR inv.QTY_ON_HND > 0)`;

    console.log("--- Catalog Stream Test ---");
    let rowsReceived = 0;
    
    return new Promise((resolve, reject) => {
        const request = pool.request();
        request.stream = true;
        request.query(catalogSql);

        request.on('row', row => {
            rowsReceived++;
            if (rowsReceived % 100 === 0) console.log(`Received ${rowsReceived} rows...`);
        });

        request.on('error', err => {
            console.error("Stream Error:", err);
            reject(err);
        });

        request.on('done', () => {
            console.log(`Stream Finished. Total Rows: ${rowsReceived}`);
            pool.close();
            resolve();
        });
    });
}

test().catch(console.error);
