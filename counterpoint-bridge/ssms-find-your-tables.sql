-- =============================================================================
-- FIND tables that exist in YOUR database (discovery), not "verify our template"
-- =============================================================================
-- 1) Replace YourCompanyDatabaseName with your Counterpoint company DB.
-- 2) Run the whole script (F5).
-- 3) Grid A: names that look like classic Counterpoint (IM/PS/AR/SY/PO...).
--    Grid B: every table in dbo (full list).
--    Grid C: tables outside dbo (if your vendor uses other schemas).
-- Map any differences into counterpoint-bridge/.env (CP_*_QUERY) — the bridge
-- does not auto-rename tables; it runs the SQL you give it.
-- =============================================================================

USE [YourCompanyDatabaseName];
GO

-- A) Counterpoint-*style* names (pattern match — your site might use extra prefixes)
SELECT TABLE_SCHEMA, TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = N'BASE TABLE'
  AND (
    TABLE_NAME LIKE N'IM[_]%'
    OR TABLE_NAME LIKE N'PS[_]%'
    OR TABLE_NAME LIKE N'AR[_]%'
    OR TABLE_NAME LIKE N'SY[_]%'
    OR TABLE_NAME LIKE N'PO[_]%'
    OR TABLE_NAME LIKE N'PS_DOC%'
  )
ORDER BY TABLE_SCHEMA, TABLE_NAME;

-- B) All base tables in dbo (export to CSV if you want to search offline)
SELECT TABLE_SCHEMA, TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = N'BASE TABLE'
  AND TABLE_SCHEMA = N'dbo'
ORDER BY TABLE_NAME;

-- C) Base tables outside dbo (often empty; if not, you may need schema-qualified names in queries)
SELECT TABLE_SCHEMA, TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_TYPE = N'BASE TABLE'
  AND TABLE_SCHEMA NOT IN (N'dbo', N'INFORMATION_SCHEMA', N'sys')
ORDER BY TABLE_SCHEMA, TABLE_NAME;
