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
        )
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

        // Strip psql meta-commands before parsing, then skip pg_dump session-state
        // statements after parsing so UPDATE ... SET clauses remain intact.
        let clean_sql = sql_content
            .lines()
            .filter(|line| {
                let t = line.trim_start();
                !t.starts_with('\\')
            })
            .collect::<Vec<_>>()
            .join("\n");

        let mut tx = pool.begin().await?;

        let statements = split_postgres_statements(&clean_sql)
            .into_iter()
            .filter(|stmt| !is_ignored_pg_dump_statement(stmt))
            .collect::<Vec<_>>();

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

fn split_postgres_statements(sql: &str) -> Vec<&str> {
    #[derive(Debug)]
    enum State {
        Normal,
        SingleQuote,
        DoubleQuote,
        LineComment,
        BlockComment(usize),
        DollarQuote(String),
    }

    fn dollar_quote_delimiter_at(sql: &str, index: usize) -> Option<String> {
        let rest = sql.get(index..)?;
        if !rest.starts_with('$') {
            return None;
        }

        let closing = rest.get(1..)?.find('$')? + 1;
        let tag = rest.get(1..closing)?;
        if tag
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            Some(rest.get(..=closing)?.to_string())
        } else {
            None
        }
    }

    fn has_executable_sql(statement: &str) -> bool {
        statement.lines().any(|line| {
            let trimmed = line.trim();
            !trimmed.is_empty() && !trimmed.starts_with("--") && !trimmed.starts_with("/*")
        })
    }

    let mut statements = Vec::new();
    let mut statement_start = 0;
    let mut index = 0;
    let mut state = State::Normal;

    while index < sql.len() {
        let current = &sql[index..];
        let ch = current
            .chars()
            .next()
            .expect("index is always on a valid char boundary");

        match &mut state {
            State::Normal => {
                if current.starts_with("--") {
                    state = State::LineComment;
                    index += 2;
                    continue;
                }
                if current.starts_with("/*") {
                    state = State::BlockComment(1);
                    index += 2;
                    continue;
                }
                if ch == '\'' {
                    state = State::SingleQuote;
                    index += ch.len_utf8();
                    continue;
                }
                if ch == '"' {
                    state = State::DoubleQuote;
                    index += ch.len_utf8();
                    continue;
                }
                if ch == '$' {
                    if let Some(delimiter) = dollar_quote_delimiter_at(sql, index) {
                        index += delimiter.len();
                        state = State::DollarQuote(delimiter);
                        continue;
                    }
                }
                if ch == ';' {
                    let statement = sql[statement_start..index].trim();
                    if has_executable_sql(statement) {
                        statements.push(statement);
                    }
                    statement_start = index + ch.len_utf8();
                }
            }
            State::SingleQuote => {
                if ch == '\'' {
                    if current.get(1..).is_some_and(|rest| rest.starts_with('\'')) {
                        index += 2;
                        continue;
                    }
                    state = State::Normal;
                }
            }
            State::DoubleQuote => {
                if ch == '"' {
                    if current.get(1..).is_some_and(|rest| rest.starts_with('"')) {
                        index += 2;
                        continue;
                    }
                    state = State::Normal;
                }
            }
            State::LineComment => {
                if ch == '\n' {
                    state = State::Normal;
                }
            }
            State::BlockComment(depth) => {
                if current.starts_with("/*") {
                    *depth += 1;
                    index += 2;
                    continue;
                }
                if current.starts_with("*/") {
                    *depth -= 1;
                    index += 2;
                    if *depth == 0 {
                        state = State::Normal;
                    }
                    continue;
                }
            }
            State::DollarQuote(delimiter) => {
                if current.starts_with(delimiter.as_str()) {
                    index += delimiter.len();
                    state = State::Normal;
                    continue;
                }
            }
        }

        index += ch.len_utf8();
    }

    let statement = sql[statement_start..].trim();
    if has_executable_sql(statement) {
        statements.push(statement);
    }

    statements
}

fn is_ignored_pg_dump_statement(statement: &str) -> bool {
    let Some(first_executable_line) = statement.lines().find_map(|line| {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with("--") || trimmed.starts_with("/*") {
            None
        } else {
            Some(trimmed)
        }
    }) else {
        return true;
    };

    first_executable_line.starts_with("SET ")
        || first_executable_line.starts_with("SELECT pg_catalog.set_config")
}

#[cfg(test)]
mod tests {
    use super::{is_ignored_pg_dump_statement, split_postgres_statements};

    #[test]
    fn split_postgres_statements_preserves_plpgsql_body() {
        let sql = r#"
            CREATE OR REPLACE FUNCTION update_timestamp()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;

            CREATE TABLE IF NOT EXISTS after_function (id uuid);
        "#;

        let statements = split_postgres_statements(sql);

        assert_eq!(statements.len(), 2);
        assert!(statements[0].contains("NEW.updated_at = NOW();"));
        assert!(statements[0].contains("$$ LANGUAGE plpgsql"));
        assert!(statements[1].contains("CREATE TABLE IF NOT EXISTS after_function"));
    }

    #[test]
    fn split_postgres_statements_ignores_semicolons_in_literals_and_comments() {
        let sql = r#"
            -- comment with ; semicolon
            CREATE TABLE "semi;table" (note text DEFAULT 'value;still literal');
            /* block ; comment */
            SELECT $tag$body;still body$tag$;
        "#;

        let statements = split_postgres_statements(sql);

        assert_eq!(statements.len(), 2);
        assert!(statements[0].contains("\"semi;table\""));
        assert!(statements[0].contains("'value;still literal'"));
        assert!(statements[1].contains("$tag$body;still body$tag$"));
    }

    #[test]
    fn pg_dump_statement_filter_preserves_update_set_clauses() {
        let sql = r#"
            SET statement_timeout = 0;

            UPDATE qbo_sync_outbox
            SET status = 'retired_daily_staging_only',
                last_error = 'Retired: use reviewed Daily QBO Staging Journal.',
                updated_at = NOW()
            WHERE status IN ('pending', 'processing', 'failed');

            SELECT pg_catalog.set_config('search_path', '', false);
        "#;

        let executable = split_postgres_statements(sql)
            .into_iter()
            .filter(|stmt| !is_ignored_pg_dump_statement(stmt))
            .collect::<Vec<_>>();

        assert_eq!(executable.len(), 1);
        assert!(executable[0].starts_with("UPDATE qbo_sync_outbox"));
        assert!(executable[0].contains("SET status = 'retired_daily_staging_only'"));
    }
}
