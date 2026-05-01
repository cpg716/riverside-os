//! Help manual chunking for Meilisearch (`ros_help`). Paths align with bundled client markdown.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use meilisearch_sdk::client::Client;
use meilisearch_sdk::client::SwapIndexes;
use serde::Serialize;
use uuid::Uuid;

use crate::logic::meilisearch_client::INDEX_HELP;

include!("help_corpus_manuals.generated.rs");

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// Slug rules kept in sync with `client/src/lib/help/helpSlug.ts`.
pub fn slugify_heading(raw: &str) -> String {
    let mut out = String::new();
    let mut last_was_hyphen = true;
    for c in raw.trim().chars() {
        let mapped = if c.is_ascii_alphanumeric() {
            Some(c.to_ascii_lowercase())
        } else {
            Some('-')
        };
        if let Some(mc) = mapped {
            if mc == '-' {
                if !last_was_hyphen {
                    out.push('-');
                    last_was_hyphen = true;
                }
            } else {
                out.push(mc);
                last_was_hyphen = false;
            }
        }
    }
    out.trim_matches('-').to_string()
}

#[derive(Debug, Clone, Serialize)]
pub struct HelpChunkDoc {
    pub id: String,
    pub manual_id: String,
    pub manual_title: String,
    pub section_slug: String,
    pub section_heading: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank: Option<u32>,
}

/// Match `client/src/lib/help/helpFrontMatter.ts` so Meilisearch chunks exclude YAML metadata.
pub(crate) fn strip_yaml_front_matter(md: &str) -> String {
    let t = md.trim_start_matches('\u{feff}');
    if !t.starts_with("---") {
        return md.to_string();
    }
    let Some(nl_pos) = t.find('\n') else {
        return md.to_string();
    };
    let rest = &t[nl_pos + 1..];
    let Some(idx) = rest.find("\n---") else {
        return md.to_string();
    };
    rest[idx + "\n---".len()..]
        .trim_start_matches(['\r', '\n'])
        .to_string()
}

fn manual_title_from_h1(md: &str) -> Option<String> {
    for line in md.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("# ") {
            if !rest.starts_with('#') {
                let s = rest.trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

fn parse_sections(md: &str, manual_id: &str, manual_title_fallback: &str) -> Vec<HelpChunkDoc> {
    let lines: Vec<&str> = md.lines().collect();
    let mut i = 0usize;
    let h1 = manual_title_from_h1(md);

    if let Some(l0) = lines.first() {
        if l0.trim().starts_with("# ") && !l0.trim().starts_with("## ") {
            i += 1;
        }
    }
    while i < lines.len() && lines[i].trim().is_empty() {
        i += 1;
    }

    let mut intro_end = lines.len();
    for (j, l) in lines.iter().enumerate().skip(i) {
        if (l.starts_with("## ") && !l.starts_with("### ")) || l.starts_with("### ") {
            intro_end = j;
            break;
        }
    }

    let mut slug_counts: HashMap<String, u32> = HashMap::new();
    let mut out: Vec<HelpChunkDoc> = Vec::new();

    let intro = lines[i..intro_end]
        .join("\n")
        .lines()
        .filter(|l| l.trim() != "---")
        .collect::<Vec<_>>()
        .join("\n");
    let intro = intro.trim().to_string();
    if !intro.is_empty() {
        let heading = h1.clone().unwrap_or_else(|| "Overview".to_string());
        let slug = unique_slug("overview", &mut slug_counts);
        out.push(HelpChunkDoc {
            id: format!("{manual_id}__{slug}"),
            manual_id: manual_id.to_string(),
            manual_title: h1
                .clone()
                .unwrap_or_else(|| manual_title_fallback.to_string()),
            section_slug: slug,
            section_heading: heading,
            body: intro,
            rank: Some(0),
        });
    }

    i = intro_end;
    let mut rank: u32 = 1;
    while i < lines.len() {
        let line = lines[i];
        let heading = if let Some(h) = line.strip_prefix("### ") {
            h.trim()
        } else if let Some(h) = line.strip_prefix("## ") {
            h.trim()
        } else {
            i += 1;
            continue;
        };
        i += 1;
        let body_start = i;
        while i < lines.len() {
            let l = lines[i];
            if (l.starts_with("## ") && !l.starts_with("### ")) || l.starts_with("### ") {
                break;
            }
            i += 1;
        }
        let body = lines[body_start..i].join("\n");
        let body = body.trim().to_string();
        let base = slugify_heading(heading);
        let base = if base.is_empty() {
            format!("section-{rank}")
        } else {
            base
        };
        let slug = unique_slug(&base, &mut slug_counts);
        let title = h1
            .clone()
            .unwrap_or_else(|| manual_title_fallback.to_string());
        out.push(HelpChunkDoc {
            id: format!("{manual_id}__{slug}"),
            manual_id: manual_id.to_string(),
            manual_title: title,
            section_slug: slug,
            section_heading: heading.to_string(),
            body,
            rank: Some(rank),
        });
        rank = rank.saturating_add(1);
    }

    out
}

fn unique_slug(base: &str, counts: &mut HashMap<String, u32>) -> String {
    let entry = counts.entry(base.to_string()).or_insert(0);
    *entry += 1;
    if *entry == 1 {
        base.to_string()
    } else {
        format!("{base}-{}", *entry)
    }
}

/// Load and chunk all configured manuals from disk (repo layout).
pub fn load_help_chunk_docs() -> Result<Vec<HelpChunkDoc>, std::io::Error> {
    let root = repo_root();
    let mut all = Vec::new();
    for (manual_id, rel) in HELP_MANUAL_FILES {
        let path = root.join(rel);
        let md_raw = std::fs::read_to_string(&path).map_err(|e| {
            std::io::Error::new(
                e.kind(),
                format!("read help manual {}: {e}", path.display()),
            )
        })?;
        let md = strip_yaml_front_matter(&md_raw);
        let fallback = format!("Manual {manual_id}");
        all.extend(parse_sections(&md, manual_id, &fallback));
    }
    Ok(all)
}

fn log_meili_help_err(e: &meilisearch_sdk::errors::Error) {
    tracing::warn!(error = %e, "Meilisearch help index operation failed");
}

fn help_reindex_temp_uid() -> String {
    format!("{INDEX_HELP}__rebuild__{}", Uuid::new_v4().simple())
}

async fn ensure_help_live_index_exists(
    client: &Client,
) -> Result<(), meilisearch_sdk::errors::Error> {
    if client.get_raw_index(INDEX_HELP).await.is_ok() {
        return Ok(());
    }
    let task = client.create_index(INDEX_HELP, Some("id")).await?;
    crate::logic::meilisearch_client::wait_task_ok(client, task).await
}

/// Full rebuild of `ros_help` into a temporary index, then swap when ready.
pub async fn reindex_help_meilisearch(
    client: &Client,
) -> Result<(), meilisearch_sdk::errors::Error> {
    use meilisearch_sdk::errors::Error as MeiliError;

    let chunks = load_help_chunk_docs().map_err(|e| MeiliError::Other(Box::new(e)))?;

    let temp_uid = help_reindex_temp_uid();
    let create = client.create_index(&temp_uid, Some("id")).await?;
    crate::logic::meilisearch_client::wait_task_ok(client, create).await?;
    crate::logic::meilisearch_client::ensure_index_settings_for_uid(client, INDEX_HELP, &temp_uid)
        .await?;

    let temp_index = client.index(&temp_uid);
    if !chunks.is_empty() {
        let add = temp_index.add_or_replace(&chunks, Some("id")).await?;
        crate::logic::meilisearch_client::wait_task_ok(client, add).await?;
    }

    ensure_help_live_index_exists(client).await?;
    let swap = SwapIndexes {
        indexes: (INDEX_HELP.to_string(), temp_uid.clone()),
        rename: None,
    };
    let swap_task = client.swap_indexes([&swap]).await?;
    crate::logic::meilisearch_client::wait_task_ok(client, swap_task).await?;

    match client.delete_index(&temp_uid).await {
        Ok(task) => {
            if let Err(e) = crate::logic::meilisearch_client::wait_task_ok(client, task).await {
                log_meili_help_err(&e);
            }
        }
        Err(e) => {
            log_meili_help_err(&e);
        }
    }

    tracing::info!(chunks = chunks.len(), "Meilisearch help index rebuilt");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn live_help_reindex_smoke_when_configured() {
        let Some(url) = std::env::var("RIVERSIDE_MEILISEARCH_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        else {
            eprintln!("skipping live Meilisearch smoke: RIVERSIDE_MEILISEARCH_URL is unset");
            return;
        };
        let key = std::env::var("RIVERSIDE_MEILISEARCH_API_KEY")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let client = Client::new(url.trim_end_matches('/'), key.as_deref())
            .expect("Meilisearch client should initialize for live smoke");

        reindex_help_meilisearch(&client)
            .await
            .expect("staged help reindex should complete");
        let hits = client
            .index(INDEX_HELP)
            .search()
            .with_query("settings")
            .with_limit(1)
            .execute::<serde_json::Value>()
            .await
            .expect("live help index search should be readable");
        assert!(
            !hits.hits.is_empty(),
            "help reindex should publish searchable chunks"
        );
    }
}
