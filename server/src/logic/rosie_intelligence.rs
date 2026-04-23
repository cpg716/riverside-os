//! Governed ROSIE intelligence source registry and status helpers.
//!
//! This is intentionally narrow: ROSIE may improve from approved manuals,
//! staff docs, contract docs, generated help outputs, and optional curated /
//! redacted traces. It must not learn from uncontrolled memory, raw
//! production data, or unrestricted conversation logs.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::logic::help_manual_policy::HELP_MANUAL_FILES;

pub const ROSIE_POLICY_PACK_VERSION: &str = "rosie-policy-pack-2026-04-22-v1";
pub const ROSIE_INTELLIGENCE_PACK_VERSION: &str = "rosie-intelligence-pack-2026-04-22-v1";
pub const OPTIONAL_CURATED_TRACE_ROOT: &str = "docs/rosie/curated_examples";

const GENERATED_HELP_OUTPUTS: &[&str] = &[
    "client/src/lib/help/help-manifest.generated.ts",
    "server/src/logic/help_corpus_manuals.generated.rs",
];

const POLICY_CONTRACT_DOCS: &[&str] = &[
    "docs/AI_CONTEXT_FOR_ASSISTANTS.md",
    "docs/AI_REPORTING_DATA_CATALOG.md",
    "docs/PLAN_LOCAL_LLM_HELP.md",
];

const EXCLUDED_SOURCE_RULES: &[&str] = &[
    "raw live customer, order, payment, and catalog database content",
    "arbitrary production database exports or ad-hoc SQL results",
    "unrestricted conversation history or chat transcripts",
    "unreviewed generated content outside approved Help/manual outputs",
    "autonomous prompt or policy mutation",
    "customer PII or payment artifacts used as learning corpora",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RosieIntelligenceSourceGroup {
    pub key: String,
    pub label: String,
    pub description: String,
    pub source_count: usize,
    pub source_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RosieIntelligenceIssue {
    pub path: String,
    pub issue: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosieIntelligencePack {
    pub policy_pack_version: String,
    pub intelligence_pack_version: String,
    pub approved_source_groups: Vec<RosieIntelligenceSourceGroup>,
    pub excluded_source_rules: Vec<String>,
    pub issues_detected: Vec<RosieIntelligenceIssue>,
    pub last_generated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct StaffCorpusManifest {
    files: Vec<String>,
}

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn load_rosie_intelligence_pack(root: &Path) -> RosieIntelligencePack {
    let help_manuals = HELP_MANUAL_FILES
        .iter()
        .map(|(_, path)| (*path).to_string())
        .collect::<Vec<_>>();
    let staff_corpus = load_staff_corpus_paths();
    let curated_traces = load_optional_curated_trace_paths(root);

    let approved_source_groups = vec![
        RosieIntelligenceSourceGroup {
            key: "help_manuals".to_string(),
            label: "Help manuals".to_string(),
            description: "Bundled in-app Help Center manuals generated from client/src/assets/docs/*-manual.md.".to_string(),
            source_count: help_manuals.len(),
            source_paths: help_manuals,
        },
        RosieIntelligenceSourceGroup {
            key: "staff_corpus".to_string(),
            label: "Staff docs".to_string(),
            description: "Approved docs/staff and linked operational docs from docs/staff/CORPUS.manifest.json.".to_string(),
            source_count: staff_corpus.len(),
            source_paths: staff_corpus,
        },
        RosieIntelligenceSourceGroup {
            key: "policy_contracts".to_string(),
            label: "ROSIE contract docs".to_string(),
            description:
                "Versioned ROSIE policy and reporting contract bundle loaded only from reviewed repo docs."
                    .to_string(),
            source_count: POLICY_CONTRACT_DOCS.len(),
            source_paths: POLICY_CONTRACT_DOCS.iter().map(|path| (*path).to_string()).collect(),
        },
        RosieIntelligenceSourceGroup {
            key: "generated_help_outputs".to_string(),
            label: "Generated help outputs".to_string(),
            description:
                "Generated help manifest outputs that keep bundled manuals and server help corpus wiring aligned."
                    .to_string(),
            source_count: GENERATED_HELP_OUTPUTS.len(),
            source_paths: GENERATED_HELP_OUTPUTS
                .iter()
                .map(|path| (*path).to_string())
                .collect(),
        },
        RosieIntelligenceSourceGroup {
            key: "curated_redacted_traces".to_string(),
            label: "Curated redacted traces".to_string(),
            description:
                "Optional curated/redacted tool traces under docs/rosie/curated_examples only when explicitly reviewed and present."
                    .to_string(),
            source_count: curated_traces.len(),
            source_paths: curated_traces,
        },
    ];

    RosieIntelligencePack {
        policy_pack_version: ROSIE_POLICY_PACK_VERSION.to_string(),
        intelligence_pack_version: ROSIE_INTELLIGENCE_PACK_VERSION.to_string(),
        issues_detected: detect_pack_issues(root, &approved_source_groups),
        excluded_source_rules: EXCLUDED_SOURCE_RULES
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        last_generated_at: latest_generated_artifact_time(root),
        approved_source_groups,
    }
}

pub fn is_approved_curated_trace_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.starts_with(OPTIONAL_CURATED_TRACE_ROOT) && normalized.ends_with(".md")
}

fn detect_pack_issues(
    root: &Path,
    approved_source_groups: &[RosieIntelligenceSourceGroup],
) -> Vec<RosieIntelligenceIssue> {
    let mut issues = Vec::new();

    for group in approved_source_groups {
        if group.key == "curated_redacted_traces" {
            continue;
        }
        for rel_path in &group.source_paths {
            let full_path = root.join(rel_path);
            if !full_path.exists() {
                issues.push(RosieIntelligenceIssue {
                    path: rel_path.clone(),
                    issue: "approved source path is missing on disk".to_string(),
                });
            }
        }
    }

    issues
}

fn load_staff_corpus_paths() -> Vec<String> {
    let manifest: StaffCorpusManifest =
        serde_json::from_str(include_str!("../../../docs/staff/CORPUS.manifest.json"))
            .unwrap_or_else(|_| StaffCorpusManifest { files: Vec::new() });
    manifest.files
}

fn load_optional_curated_trace_paths(root: &Path) -> Vec<String> {
    let traces_dir = root.join(OPTIONAL_CURATED_TRACE_ROOT);
    let mut paths = Vec::new();

    let Ok(entries) = fs::read_dir(traces_dir) else {
        return paths;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        if is_approved_curated_trace_path(&relative) {
            paths.push(relative);
        }
    }

    paths.sort();
    paths
}

fn latest_generated_artifact_time(root: &Path) -> Option<DateTime<Utc>> {
    GENERATED_HELP_OUTPUTS
        .iter()
        .filter_map(|path| fs::metadata(root.join(path)).ok())
        .filter_map(|metadata| metadata.modified().ok())
        .max()
        .map(system_time_to_utc)
}

fn system_time_to_utc(value: SystemTime) -> DateTime<Utc> {
    DateTime::<Utc>::from(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intelligence_pack_includes_expected_groups() {
        let pack = load_rosie_intelligence_pack(&repo_root());
        let keys = pack
            .approved_source_groups
            .iter()
            .map(|group| group.key.as_str())
            .collect::<Vec<_>>();

        assert!(keys.contains(&"help_manuals"));
        assert!(keys.contains(&"staff_corpus"));
        assert!(keys.contains(&"policy_contracts"));
        assert!(keys.contains(&"generated_help_outputs"));
        assert!(keys.contains(&"curated_redacted_traces"));
    }

    #[test]
    fn intelligence_pack_contract_docs_are_explicit() {
        let pack = load_rosie_intelligence_pack(&repo_root());
        let contracts = pack
            .approved_source_groups
            .iter()
            .find(|group| group.key == "policy_contracts")
            .expect("policy contract group");

        assert_eq!(contracts.source_paths, POLICY_CONTRACT_DOCS);
    }

    #[test]
    fn rejects_non_approved_curated_trace_paths() {
        assert!(is_approved_curated_trace_path(
            "docs/rosie/curated_examples/register-close.md"
        ));
        assert!(!is_approved_curated_trace_path(
            "docs/rosie/raw/customer-export.json"
        ));
        assert!(!is_approved_curated_trace_path("docs/staff/README.md"));
    }

    #[test]
    fn excluded_source_rules_block_uncontrolled_learning_inputs() {
        let pack = load_rosie_intelligence_pack(&repo_root());

        assert!(pack
            .excluded_source_rules
            .iter()
            .any(|rule| rule.contains("conversation history")));
        assert!(pack
            .excluded_source_rules
            .iter()
            .any(|rule| rule.contains("production database")));
        assert!(pack
            .excluded_source_rules
            .iter()
            .any(|rule| rule.contains("autonomous prompt or policy mutation")));
    }
}
