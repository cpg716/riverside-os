import pkg from 'mssql';
const { connect } = pkg;
import dotenv from 'dotenv';
dotenv.config();

async function findTables() {
    try {
        await connect(process.env.SQL_CONNECTION_STRING);
        const res = await pkg.query`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME LIKE '%CATEG%'`;
        console.table(res.recordset);
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}
findTables();
