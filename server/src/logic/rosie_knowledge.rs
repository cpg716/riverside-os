//! Cached local ROSIE knowledge retrieval over approved Riverside sources.
//!
//! Help Library search still uses Meilisearch. Ask ROSIE and ROSIE Chat use this
//! in-process index so they can retrieve fast, bounded context without depending
//! on search infrastructure or stuffing full manuals into the model prompt.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use sqlx::PgPool;
use tokio::sync::{OnceCell, RwLock};

use crate::logic::help_corpus::{load_help_chunk_docs_with_policies, slugify_heading};
use crate::logic::rosie_intelligence::load_rosie_intelligence_pack;

const MAX_BODY_CHARS: usize = 2_400;
const MAX_DOC_CHARS: usize = 140_000;

static ROSIE_KNOWLEDGE_INDEX: OnceCell<RwLock<Option<Arc<RosieKnowledgeIndex>>>> =
    OnceCell::const_new();

#[derive(Debug, Clone, Serialize)]
pub struct RosieKnowledgeChunk {
    pub id: String,
    pub source_group: String,
    pub source_path: Option<String>,
    pub manual_id: Option<String>,
    pub manual_title: Option<String>,
    pub section_slug: String,
    pub section_heading: String,
    pub body: String,
    pub rank: u32,
    #[serde(skip_serializing)]
    terms: HashSet<String>,
    #[serde(skip_serializing)]
    trigrams: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct RosieKnowledgeIndex {
    pub chunks: Vec<RosieKnowledgeChunk>,
    pub source_counts: HashMap<String, usize>,
}

#[derive(Debug, Clone, Default)]
pub struct RosieKnowledgeQuery {
    pub question: String,
    pub allowed_manual_ids: Option<HashSet<String>>,
    pub active_manual_id: Option<String>,
    pub current_surface: Option<String>,
    pub limit: usize,
    pub max_total_chars: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RosieKnowledgeHit {
    pub chunk: RosieKnowledgeChunk,
    pub score: i32,
    pub matched_terms: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RosieKnowledgeSearchResult {
    pub reviewed_chunk_count: usize,
    pub indexed_chunk_count: usize,
    pub source_counts: HashMap<String, usize>,
    pub elapsed_ms: u64,
    pub hits: Vec<RosieKnowledgeHit>,
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub async fn invalidate_rosie_knowledge_index() {
    let cell = ROSIE_KNOWLEDGE_INDEX
        .get_or_init(|| async { RwLock::new(None) })
        .await;
    let mut guard = cell.write().await;
    *guard = None;
}

pub async fn search_rosie_knowledge(
    pool: &PgPool,
    query: RosieKnowledgeQuery,
) -> Result<RosieKnowledgeSearchResult, Box<dyn std::error::Error + Send + Sync>> {
    let started = Instant::now();
    let index = load_or_build_index(pool).await?;
    let terms = query_terms(&query.question);
    let query_trigrams = trigrams_for_text(&query.question);
    let surface_terms = query
        .current_surface
        .as_deref()
        .map(query_terms)
        .unwrap_or_default();
    let mut reviewed = 0usize;
    let mut scored = Vec::new();

    for chunk in &index.chunks {
        if let Some(allowed) = &query.allowed_manual_ids {
            if let Some(manual_id) = &chunk.manual_id {
                if !allowed.contains(manual_id) {
                    continue;
                }
            }
        }
        reviewed = reviewed.saturating_add(1);
        let (score, matched_terms) =
            score_chunk(chunk, &query, &terms, &surface_terms, &query_trigrams);
        if score > 0 {
            scored.push(RosieKnowledgeHit {
                chunk: chunk.clone(),
                score,
                matched_terms,
            });
        }
    }

    scored.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.chunk.rank.cmp(&b.chunk.rank))
            .then_with(|| a.chunk.id.cmp(&b.chunk.id))
    });

    let mut selected = Vec::new();
    let mut chars = 0usize;
    for mut hit in scored {
        if selected.len() >= query.limit.max(1) {
            break;
        }
        let body_len = hit.chunk.body.chars().count();
        if !selected.is_empty() && chars.saturating_add(body_len) > query.max_total_chars.max(800) {
            continue;
        }
        chars = chars.saturating_add(body_len);
        hit.chunk.body = trim_text(&hit.chunk.body, MAX_BODY_CHARS);
        selected.push(hit);
    }

    Ok(RosieKnowledgeSearchResult {
        reviewed_chunk_count: reviewed,
        indexed_chunk_count: index.chunks.len(),
        source_counts: index.source_counts.clone(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        hits: selected,
    })
}

async fn load_or_build_index(
    pool: &PgPool,
) -> Result<Arc<RosieKnowledgeIndex>, Box<dyn std::error::Error + Send + Sync>> {
    let cell = ROSIE_KNOWLEDGE_INDEX
        .get_or_init(|| async { RwLock::new(None) })
        .await;

    if let Some(index) = cell.read().await.as_ref().cloned() {
        return Ok(index);
    }

    let mut guard = cell.write().await;
    if let Some(index) = guard.as_ref().cloned() {
        return Ok(index);
    }

    let index = Arc::new(build_index(pool).await?);
    tracing::info!(
        chunks = index.chunks.len(),
        source_groups = index.source_counts.len(),
        "ROSIE local knowledge index loaded"
    );
    *guard = Some(index.clone());
    Ok(index)
}

async fn build_index(
    pool: &PgPool,
) -> Result<RosieKnowledgeIndex, Box<dyn std::error::Error + Send + Sync>> {
    let root = repo_root();
    let mut chunks = Vec::new();

    for help_chunk in load_help_chunk_docs_with_policies(pool).await? {
        chunks.push(RosieKnowledgeChunk {
            id: format!("help:{}", help_chunk.id),
            source_group: "help_manuals".to_string(),
            source_path: None,
            manual_id: Some(help_chunk.manual_id),
            manual_title: Some(help_chunk.manual_title),
            section_slug: help_chunk.section_slug,
            section_heading: help_chunk.section_heading,
            body: normalize_body(&help_chunk.body),
            rank: help_chunk.rank.unwrap_or(999),
            terms: HashSet::new(),
            trigrams: HashSet::new(),
        });
    }

    let pack = load_rosie_intelligence_pack(&root);
    for group in pack.approved_source_groups {
        if matches!(
            group.key.as_str(),
            "help_manuals" | "generated_help_outputs" | "curated_redacted_traces"
        ) {
            continue;
        }
        for path in group.source_paths {
            if let Some(mut source_chunks) = load_markdown_source_chunks(&root, &group.key, &path) {
                chunks.append(&mut source_chunks);
            }
        }
    }

    let mut source_counts = HashMap::new();
    for chunk in &mut chunks {
        chunk.body = trim_text(&chunk.body, MAX_BODY_CHARS);
        let searchable = format!(
            "{} {} {} {}",
            chunk
                .manual_title
                .as_deref()
                .or(chunk.source_path.as_deref())
                .unwrap_or_default(),
            chunk.section_heading,
            chunk.section_slug,
            chunk.body
        );
        chunk.terms = terms_for_text(&searchable);
        chunk.trigrams = trigrams_for_text(&searchable);
        *source_counts.entry(chunk.source_group.clone()).or_insert(0) += 1;
    }

    Ok(RosieKnowledgeIndex {
        chunks,
        source_counts,
    })
}

fn load_markdown_source_chunks(
    root: &Path,
    source_group: &str,
    rel_path: &str,
) -> Option<Vec<RosieKnowledgeChunk>> {
    let normalized = rel_path.replace('\\', "/");
    if !normalized.ends_with(".md") {
        return None;
    }
    let path = root.join(&normalized);
    let raw = std::fs::read_to_string(path).ok()?;
    let body = crate::logic::help_corpus::strip_yaml_front_matter(&raw);
    let body = trim_text(&body, MAX_DOC_CHARS);
    Some(split_doc_sections(source_group, &normalized, &body))
}

fn split_doc_sections(
    source_group: &str,
    rel_path: &str,
    markdown: &str,
) -> Vec<RosieKnowledgeChunk> {
    let lines = markdown.lines().collect::<Vec<_>>();
    let title = markdown
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|value| !value.is_empty())
        .unwrap_or(rel_path);
    let mut sections = Vec::new();
    let mut index = 0usize;
    let mut rank = 0u32;

    while index < lines.len() {
        let heading = lines[index]
            .trim()
            .strip_prefix("### ")
            .or_else(|| lines[index].trim().strip_prefix("## "))
            .or_else(|| lines[index].trim().strip_prefix("# "));
        let Some(heading) = heading.map(str::trim).filter(|value| !value.is_empty()) else {
            index += 1;
            continue;
        };
        index += 1;
        let start = index;
        while index < lines.len() {
            let next = lines[index].trim();
            if next.starts_with("# ") || next.starts_with("## ") || next.starts_with("### ") {
                break;
            }
            index += 1;
        }
        let body = normalize_body(&lines[start..index].join("\n"));
        if body.is_empty() {
            continue;
        }
        let section_slug = slugify_heading(heading);
        let section_slug = if section_slug.is_empty() {
            format!("section-{rank}")
        } else {
            section_slug
        };
        sections.push(RosieKnowledgeChunk {
            id: format!("{source_group}:{rel_path}:{section_slug}"),
            source_group: source_group.to_string(),
            source_path: Some(rel_path.to_string()),
            manual_id: None,
            manual_title: None,
            section_slug,
            section_heading: if rank == 0 && heading == title {
                title.to_string()
            } else {
                heading.to_string()
            },
            body,
            rank,
            terms: HashSet::new(),
            trigrams: HashSet::new(),
        });
        rank = rank.saturating_add(1);
    }

    if sections.is_empty() {
        let body = normalize_body(markdown);
        if !body.is_empty() {
            sections.push(RosieKnowledgeChunk {
                id: format!("{source_group}:{rel_path}:overview"),
                source_group: source_group.to_string(),
                source_path: Some(rel_path.to_string()),
                manual_id: None,
                manual_title: None,
                section_slug: "overview".to_string(),
                section_heading: title.to_string(),
                body,
                rank: 0,
                terms: HashSet::new(),
                trigrams: HashSet::new(),
            });
        }
    }

    sections
}

fn score_chunk(
    chunk: &RosieKnowledgeChunk,
    query: &RosieKnowledgeQuery,
    terms: &[String],
    surface_terms: &[String],
    query_trigrams: &HashSet<String>,
) -> (i32, Vec<String>) {
    let source_base = match chunk.source_group.as_str() {
        "help_manuals" => 16,
        "staff_corpus" => 12,
        "policy_contracts" => 7,
        _ => 3,
    };
    let mut score = 0;
    let mut evidence = 0;
    let mut matched = Vec::new();

    if let (Some(active), Some(manual_id)) = (&query.active_manual_id, &chunk.manual_id) {
        if active == manual_id {
            score += 34;
            evidence += 1;
        }
    }

    let heading = chunk.section_heading.to_ascii_lowercase();
    let title = chunk
        .manual_title
        .as_deref()
        .or(chunk.source_path.as_deref())
        .unwrap_or_default()
        .to_ascii_lowercase();

    for term in terms {
        if title.contains(term) {
            score += 18;
            evidence += 1;
        }
        if heading.contains(term) {
            score += 22;
            evidence += 1;
        }
        if chunk.terms.contains(term) {
            score += 5;
            evidence += 1;
            matched.push(term.clone());
        } else if let Some(fuzzy_term) = best_fuzzy_term_match(term, &chunk.terms) {
            score += 3;
            evidence += 1;
            matched.push(format!("{term}~{fuzzy_term}"));
        }
    }

    for term in surface_terms {
        if title.contains(term)
            || heading.contains(term)
            || chunk.terms.contains(term)
            || best_fuzzy_term_match(term, &chunk.terms).is_some()
        {
            score += 2;
            evidence += 1;
        }
    }

    let trigram_overlap = trigram_overlap_count(query_trigrams, &chunk.trigrams);
    if trigram_overlap >= 3 {
        score += i32::try_from(trigram_overlap.min(14) * 2).unwrap_or(0);
        evidence += 1;
        matched.push(format!("phrase~{trigram_overlap}"));
    }

    let phrase = query.question.to_ascii_lowercase();
    let checkout_signal = phrase.contains("cash out")
        || phrase.contains("cash a sale")
        || phrase.contains("checkout")
        || terms.iter().any(|term| fuzzy_equals(term, "checkout"));
    let complete_signal =
        phrase.contains("complete sale") || terms.iter().any(|term| fuzzy_equals(term, "complete"));
    let sale_signal = terms.iter().any(|term| term == "sale");
    let return_signal = terms
        .iter()
        .any(|term| matches!(term.as_str(), "return" | "refund" | "exchange"));

    if checkout_signal || phrase.contains("cashout") {
        if matches!(
            chunk.manual_id.as_deref(),
            Some("pos") | Some("pos-nexo-checkout-drawer") | Some("pos-receipt-summary-modal")
        ) {
            score += 48;
            evidence += 1;
        }
        if heading.contains("checkout") || heading.contains("payment") || heading.contains("sale") {
            score += 24;
            evidence += 1;
        }
        if (complete_signal || sale_signal)
            && (heading.contains("checkout")
                || heading.contains("payment")
                || heading.contains("complete")
                || heading.contains("receipt delivery"))
        {
            score += 34;
            evidence += 1;
        }
        if !return_signal && (heading.contains("return") || heading.contains("exchange")) {
            score -= 28;
        }
    }
    if return_signal
        || phrase.contains("return")
        || phrase.contains("refund")
        || phrase.contains("exchange")
    {
        if heading.contains("return") || heading.contains("refund") || heading.contains("exchange")
        {
            score += 36;
            evidence += 1;
        }
    }

    if evidence == 0 {
        return (0, matched);
    }
    score += source_base;
    score -= i32::try_from(chunk.rank.min(30)).unwrap_or(0);
    matched.sort();
    matched.dedup();
    (score, matched)
}

fn query_terms(value: &str) -> Vec<String> {
    let mut terms = terms_for_text(value).into_iter().collect::<Vec<_>>();
    let normalized = value.to_ascii_lowercase();
    if normalized.contains("cash out")
        || normalized.contains("cashout")
        || normalized.contains("cash a sale")
        || normalized.contains("complete sale")
    {
        terms.extend(
            [
                "register", "checkout", "payment", "complete", "sale", "receipt", "tender",
            ]
            .into_iter()
            .map(str::to_string),
        );
    }
    terms.sort();
    terms.dedup();
    let mut expanded = Vec::with_capacity(terms.len() * 2);
    for term in terms {
        expanded.push(term.clone());
        expanded.extend(term_variants(&term));
    }
    expanded.sort();
    expanded.dedup();
    expanded
}

fn best_fuzzy_term_match<'a>(
    query_term: &str,
    chunk_terms: &'a HashSet<String>,
) -> Option<&'a str> {
    if query_term.len() < 4 {
        return None;
    }
    let mut best: Option<(&str, usize)> = None;

    for candidate in chunk_terms {
        let candidate = candidate.as_str();
        if candidate.len() < 4 {
            continue;
        }
        if is_prefix_match(query_term, candidate) || is_prefix_match(candidate, query_term) {
            return Some(candidate);
        }
        if !first_char_matches(query_term, candidate) {
            continue;
        }
        let Some(max_distance) = fuzzy_distance_limit(query_term, candidate) else {
            continue;
        };
        let Some(distance) = capped_damerau_levenshtein(query_term, candidate, max_distance) else {
            continue;
        };
        match best {
            Some((_, best_distance)) if best_distance <= distance => {}
            _ => best = Some((candidate, distance)),
        }
    }

    best.map(|(candidate, _)| candidate)
}

fn first_char_matches(left: &str, right: &str) -> bool {
    left.as_bytes().first() == right.as_bytes().first()
}

fn fuzzy_equals(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let Some(limit) = fuzzy_distance_limit(left, right) else {
        return false;
    };
    capped_damerau_levenshtein(left, right, limit).is_some()
}

fn is_prefix_match(left: &str, right: &str) -> bool {
    left.len() >= 4
        && right.len() >= 4
        && (left.starts_with(right) || right.starts_with(left))
        && left.len().abs_diff(right.len()) <= 4
}

fn fuzzy_distance_limit(left: &str, right: &str) -> Option<usize> {
    let max_len = left.len().max(right.len());
    let diff = left.len().abs_diff(right.len());
    let limit = if max_len >= 8 {
        2
    } else if max_len >= 5 {
        1
    } else {
        0
    };
    if diff > limit {
        None
    } else {
        Some(limit)
    }
}

fn capped_damerau_levenshtein(left: &str, right: &str, max_distance: usize) -> Option<usize> {
    if left == right {
        return Some(0);
    }
    if left.len().abs_diff(right.len()) > max_distance {
        return None;
    }

    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    let mut current = vec![0usize; right.len() + 1];
    let mut before_previous = previous.clone();

    for (i, left_byte) in left.iter().enumerate() {
        current[0] = i + 1;
        let mut row_min = current[0];
        for (j, right_byte) in right.iter().enumerate() {
            let cost = usize::from(left_byte != right_byte);
            let deletion = previous[j + 1] + 1;
            let insertion = current[j] + 1;
            let substitution = previous[j] + cost;
            let mut value = deletion.min(insertion).min(substitution);
            if i > 0
                && j > 0
                && left[i] == right[j - 1]
                && left[i - 1] == right[j]
                && before_previous[j - 1] + 1 < value
            {
                value = before_previous[j - 1] + 1;
            }
            current[j + 1] = value;
            row_min = row_min.min(value);
        }
        if row_min > max_distance {
            return None;
        }
        before_previous.clone_from(&previous);
        previous.clone_from(&current);
    }

    let distance = previous[right.len()];
    if distance <= max_distance {
        Some(distance)
    } else {
        None
    }
}

fn term_variants(term: &str) -> Vec<String> {
    let mut variants = Vec::new();
    for suffix in ["ing", "ed", "es", "s"] {
        if term.len() > suffix.len() + 3 && term.ends_with(suffix) {
            variants.push(term[..term.len() - suffix.len()].to_string());
        }
    }
    variants
}

fn trigrams_for_text(value: &str) -> HashSet<String> {
    let normalized = value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|term| term.len() >= 4)
        .flat_map(|term| {
            let chars = term.chars().collect::<Vec<_>>();
            if chars.len() < 3 {
                return Vec::new();
            }
            chars
                .windows(3)
                .map(|window| window.iter().collect::<String>())
                .collect::<Vec<_>>()
        })
        .collect::<HashSet<_>>();
    normalized
}

fn trigram_overlap_count(left: &HashSet<String>, right: &HashSet<String>) -> usize {
    if left.is_empty() || right.is_empty() {
        return 0;
    }
    left.iter().filter(|gram| right.contains(*gram)).count()
}

fn terms_for_text(value: &str) -> HashSet<String> {
    value
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|term| term.len() >= 3)
        .filter(|term| {
            !matches!(
                *term,
                "the"
                    | "and"
                    | "for"
                    | "how"
                    | "what"
                    | "when"
                    | "where"
                    | "with"
                    | "from"
                    | "that"
                    | "this"
                    | "into"
                    | "about"
                    | "staff"
                    | "riverside"
            )
        })
        .map(str::to_string)
        .collect()
}

fn normalize_body(value: &str) -> String {
    value
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().eq("---"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn trim_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut out = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_chunk(body: &str) -> RosieKnowledgeChunk {
        let searchable = format!("Register POS Checkout and payment {body}");
        RosieKnowledgeChunk {
            id: "test".to_string(),
            source_group: "help_manuals".to_string(),
            source_path: None,
            manual_id: Some("pos".to_string()),
            manual_title: Some("Register (POS)".to_string()),
            section_slug: "checkout-and-payment".to_string(),
            section_heading: "Checkout and payment".to_string(),
            body: body.to_string(),
            rank: 1,
            terms: terms_for_text(&searchable),
            trigrams: trigrams_for_text(&searchable),
        }
    }

    #[test]
    fn fuzzy_term_match_handles_typos_and_transpositions() {
        let terms = terms_for_text("checkout payment register return receipt");
        assert_eq!(best_fuzzy_term_match("chekout", &terms), Some("checkout"));
        assert_eq!(best_fuzzy_term_match("retrun", &terms), Some("return"));
    }

    #[test]
    fn query_terms_expand_simple_word_variants() {
        let terms = query_terms("completing returned receipts");
        assert!(terms.contains(&"complet".to_string()));
        assert!(terms.contains(&"return".to_string()));
        assert!(terms.contains(&"receipt".to_string()));
    }

    #[test]
    fn score_chunk_uses_fuzzy_and_phrase_overlap() {
        let chunk = test_chunk(
            "Use Proceed to Payment, collect the tender, then Complete Sale to open the receipt summary.",
        );
        let query = RosieKnowledgeQuery {
            question: "How do I chekout and complete a sale?".to_string(),
            active_manual_id: None,
            current_surface: None,
            limit: 5,
            allowed_manual_ids: None,
            max_total_chars: 2_000,
        };
        let terms = query_terms(&query.question);
        let grams = trigrams_for_text(&query.question);
        let (score, matched) = score_chunk(&chunk, &query, &terms, &[], &grams);

        assert!(score > 20, "expected useful score, got {score}");
        assert!(
            matched.iter().any(|term| term.contains("chekout~checkout")),
            "expected fuzzy checkout match, got {matched:?}"
        );
    }
}
