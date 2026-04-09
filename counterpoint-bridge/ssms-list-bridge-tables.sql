-- Run in SSMS against your Counterpoint *company* database (same Database= as SQL_CONNECTION_STRING).
-- Read-only. Shows which table names the Riverside bridge probes vs what exists in INFORMATION_SCHEMA.

DECLARE @expected TABLE (table_name SYSNAME PRIMARY KEY);
INSERT @expected (table_name) VALUES
  (N'IM_INV'),
  (N'IM_ITEM'),
  (N'IM_INV_CELL'),
  (N'IM_PRC'),
  (N'IM_BARCOD'),
  (N'AR_CUST'),
  (N'AR_CUST_NOTE'),
  (N'SY_USR'),
  (N'PS_SLS_REP'),
  (N'PO_BUYER'),
  (N'PO_VEND'),
  (N'PO_VEND_ITEM'),
  (N'PS_TKT_HIST'),
  (N'PS_TKT_HIST_LIN'),
  (N'PS_TKT_HIST_PMT'),
  (N'PS_TKT_HIST_CELL'),
  (N'PS_TKT_HIST_LIN_CELL'),
  (N'PS_TKT_HIST_GFT'),
  (N'SY_GFT_CERT'),
  (N'SY_GFT_CERT_HIST'),
  (N'PS_LOY_PTS_HIST'),
  (N'PS_DOC'),
  (N'PS_DOC_LIN'),
  (N'PS_DOC_PMT');

-- Present: schema + name (SQL Server 2014+ friendly — no STRING_AGG)
SELECT
  e.table_name AS expected_name,
  STUFF((
    SELECT N', ' + QUOTENAME(t.TABLE_SCHEMA) + N'.' + QUOTENAME(t.TABLE_NAME)
    FROM INFORMATION_SCHEMA.TABLES t
    WHERE t.TABLE_NAME = e.table_name
      AND t.TABLE_TYPE = N'BASE TABLE'
    ORDER BY CASE WHEN t.TABLE_SCHEMA = N'dbo' THEN 0 ELSE 1 END, t.TABLE_SCHEMA
    FOR XML PATH(N''), TYPE
  ).value(N'.', N'nvarchar(max)'), 1, 2, N'') AS found_as
FROM @expected e
ORDER BY e.table_name;

-- Missing entirely
SELECT e.table_name AS missing_from_database
FROM @expected e
WHERE NOT EXISTS (
  SELECT 1
  FROM INFORMATION_SCHEMA.TABLES t
  WHERE t.TABLE_NAME = e.table_name
    AND t.TABLE_TYPE = N'BASE TABLE'
)
ORDER BY e.table_name;

-- Optional: every user table in dbo (for spotting renames — compare visually)
-- SELECT TABLE_SCHEMA, TABLE_NAME
-- FROM INFORMATION_SCHEMA.TABLES
-- WHERE TABLE_TYPE = N'BASE TABLE' AND TABLE_SCHEMA = N'dbo'
-- ORDER BY TABLE_NAME;
