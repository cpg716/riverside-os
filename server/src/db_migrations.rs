use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::collections::HashSet;

use crate::embedded_migrations;

pub async fn run_migrations(pool: &PgPool) -> Result<(), anyhow::Error> {
    // 1. Check if the schema migrations ledger exists
    let ledger_exists_query = "
        SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'ros_schema_migrations'
        );
    ";

    let ledger_exists: bool = sqlx::query_scalar(ledger_exists_query)
        .fetch_one(pool)
        .await?;

    if !ledger_exists {
        tracing::info!(
            "Unified Engine: Creating migrations ledger public.ros_schema_migrations..."
        );
        let create_ledger_sql = "
            CREATE TABLE IF NOT EXISTS public.ros_schema_migrations (
                version text PRIMARY KEY,
                file_sha256 text,
                applied_at timestamp with time zone DEFAULT now()
            );
        ";
        sqlx::query(create_ledger_sql).execute(pool).await?;
    } else {
        // Ensure checksum column is present (drift protection backfill)
        let alter_column_sql = "
            ALTER TABLE ros_schema_migrations ADD COLUMN IF NOT EXISTS file_sha256 text;
        ";
        let _ = sqlx::query(alter_column_sql).execute(pool).await;
    }

    // 2. Fetch applied migration versions
    let applied_query = "SELECT version FROM ros_schema_migrations;";
    let rows = sqlx::query(applied_query).fetch_all(pool).await?;
    let applied_versions: HashSet<String> = rows
        .into_iter()
        .map(|r| r.get::<String, _>("version"))
        .collect();

    // 3. Apply missing migrations in sequence
    for &(file_name, sql_content) in embedded_migrations::EMBEDDED_MIGRATIONS {
        if applied_versions.contains(file_name) {
            continue;
        }

        tracing::info!("Unified Engine: Applying migration: {}...", file_name);

        // Strip psql meta-commands and pg_dump session-state preamble
        let clean_sql = sql_content
            .lines()
            .filter(|line| {
                let t = line.trim_start();
                !t.starts_with('\\')
                    && !t.starts_with("SET ")
                    && !t.starts_with("SELECT pg_catalog.set_config")
            })
            .collect::<Vec<_>>()
            .join("\n");

        let mut tx = pool.begin().await?;

        // Split multi-statement SQL and execute each individually.
        // PostgreSQL rejects multiple commands in a single prepared statement,
        // so we split on semicolons and execute each non-empty, non-comment chunk.
        // This is Send-safe (unlike sqlx::raw_sql()) and works across tokio::spawn.
        let statements: Vec<&str> = clean_sql
            .split(';')
            .map(|s| s.trim())
            .filter(|s| {
                !s.is_empty()
                    && s.lines().any(|line| {
                        let t = line.trim();
                        !t.is_empty() && !t.starts_with("--")
                    })
            })
            .collect();

        for stmt in &statements {
            if let Err(e) = sqlx::query(stmt).execute(&mut *tx).await {
                tracing::error!(
                    error = %e,
                    "Unified Engine: Failed to execute migration sql: {}",
                    file_name
                );
                return Err(e.into());
            }
        }

        // Calculate current file SHA256 to register in the ledger
        let mut hasher = Sha256::new();
        hasher.update(sql_content.as_bytes());
        let current_sha = hex::encode(hasher.finalize());

        let insert_ledger_sql = "
            INSERT INTO ros_schema_migrations (version, file_sha256)
            VALUES ($1, $2)
            ON CONFLICT (version) DO NOTHING;
        ";
        sqlx::query(insert_ledger_sql)
            .bind(file_name)
            .bind(&current_sha)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        tracing::info!(
            "Unified Engine: Migration {} applied successfully.",
            file_name
        );
    }

    tracing::info!("Unified Engine: All migrations checked and verified.");
    Ok(())
}
