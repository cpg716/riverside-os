import pkg from 'mssql';
const { connect } = pkg;
import dotenv from 'dotenv';
dotenv.config();

async function debugCatalog() {
    try {
        await connect(process.env.SQL_CONNECTION_STRING);
        
        console.log("--- SAMPLE: Parent Item with Dim ---");
        const parentRes = await pkg.query`SELECT TOP 2 ITEM_NO, DESCR, CATEG_COD, DIM_COUNT FROM IM_ITEM WHERE DIM_COUNT > 0`;
        console.table(parentRes.recordset);

        if (parentRes.recordset.length > 0) {
            const itemNo = parentRes.recordset[0].ITEM_NO;
            console.log(`--- SAMPLE: Children for Item ${itemNo} ---`);
            const childRes = await pkg.query`SELECT TOP 5 ITEM_NO, DIM_1_UPR, DIM_2_UPR, DIM_3_UPR, QTY_ON_HND FROM IM_INV_CELL WHERE ITEM_NO = ${itemNo} AND LOC_ID = 'MAIN'`;
            console.table(childRes.recordset);
        }

        console.log("--- SAMPLE: Category Mappings ---");
        const catRes = await pkg.query`SELECT TOP 5 i.CATEG_COD, c.DESCR FROM IM_ITEM i LEFT JOIN IM_CATEG c ON i.CATEG_COD = c.CATEG_COD WHERE i.CATEG_COD IS NOT NULL`;
        console.table(catRes.recordset);

    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

debugCatalog();
