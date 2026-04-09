//! Help Center manual visibility defaults and DB policy merge.
//! Defaults map manual ids (from `*-manual.md`) to workspace-style RBAC.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::permissions::{
    staff_has_permission, ALTERATIONS_MANAGE, CATALOG_VIEW, CUSTOMERS_HUB_VIEW, GIFT_CARDS_MANAGE,
    INSIGHTS_VIEW, LOYALTY_PROGRAM_SETTINGS, NOTIFICATIONS_VIEW, ONLINE_STORE_MANAGE, ORDERS_VIEW,
    PHYSICAL_INVENTORY_VIEW, PROCUREMENT_VIEW, QBO_VIEW, SETTINGS_ADMIN, STAFF_VIEW,
    TASKS_COMPLETE, WEDDINGS_VIEW,
};
use crate::logic::help_corpus::strip_yaml_front_matter;

include!("help_corpus_manuals.generated.rs");

pub fn help_manual_rel_path(manual_id: &str) -> Option<&'static str> {
    HELP_MANUAL_FILES
        .iter()
        .find(|(id, _)| *id == manual_id)
        .map(|(_, p)| *p)
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[derive(Debug, Clone, Deserialize, sqlx::FromRow)]
pub struct HelpManualPolicyRow {
    pub manual_id: String,
    pub hidden: bool,
    pub title_override: Option<String>,
    pub summary_override: Option<String>,
    pub markdown_override: Option<String>,
    pub order_override: Option<i32>,
    pub required_permissions: Option<Vec<String>>,
    pub allow_register_session: Option<bool>,
}

/// Default `(required permission keys — AND), allow_register_session_for_pos_only_viewers)`.
pub fn default_visibility(manual_id: &str) -> (Vec<String>, bool) {
    if manual_id == "pos-procurement-hub" {
        return (vec![PROCUREMENT_VIEW.to_string()], true);
    }

    let id = manual_id;
    if id.starts_with("inventory-")
        || id.starts_with("matrix-")
        || id.starts_with("product-")
        || id.starts_with("vendor-")
        || id.starts_with("category-")
        || id.starts_with("receiving-")
        || id.starts_with("discount-events-")
        || id.starts_with("camera-")
        || id.starts_with("purchase-order-")
        || id.starts_with("universal-importer")
    {
        return (vec![CATALOG_VIEW.to_string()], false);
    }
    if id.starts_with("customers-") || id.starts_with("shipments-hub") || id.contains("rms-charge")
    {
        return (vec![CUSTOMERS_HUB_VIEW.to_string()], false);
    }
    if id.starts_with("orders-") {
        return (vec![ORDERS_VIEW.to_string()], false);
    }
    if id.starts_with("qbo-") {
        return (vec![QBO_VIEW.to_string()], false);
    }
    if id.starts_with("settings-") || id.starts_with("store-page-studio") {
        return (vec![SETTINGS_ADMIN.to_string()], false);
    }
    if id.contains("online-store") {
        return (vec![ONLINE_STORE_MANAGE.to_string()], false);
    }
    if id == "insights" || id.starts_with("insights-") || id.starts_with("historical-") {
        return (vec![INSIGHTS_VIEW.to_string()], false);
    }
    if id.starts_with("staff-") {
        return (vec![STAFF_VIEW.to_string()], false);
    }
    if id.starts_with("gift-cards") {
        return (vec![GIFT_CARDS_MANAGE.to_string()], false);
    }
    if id.starts_with("loyalty-") {
        return (vec![LOYALTY_PROGRAM_SETTINGS.to_string()], false);
    }
    if id.starts_with("alterations-") {
        return (vec![ALTERATIONS_MANAGE.to_string()], false);
    }
    if id.starts_with("scheduler-") || id.starts_with("appointment") {
        return (vec![WEDDINGS_VIEW.to_string()], false);
    }
    if id.starts_with("wedding-") {
        return (vec![WEDDINGS_VIEW.to_string()], false);
    }
    if id.starts_with("notifications-") {
        return (vec![NOTIFICATIONS_VIEW.to_string()], false);
    }
    if id.starts_with("tasks-") && !id.starts_with("tasks-register") {
        return (vec![TASKS_COMPLETE.to_string()], false);
    }
    if id.starts_with("operations-") {
        return (vec![NOTIFICATIONS_VIEW.to_string()], false);
    }
    if id.starts_with("storefront-") {
        return (vec![ONLINE_STORE_MANAGE.to_string()], false);
    }
    if id.starts_with("physical-inventory") {
        return (vec![PHYSICAL_INVENTORY_VIEW.to_string()], false);
    }
    if id.starts_with("pos-")
        || id.starts_with("tasks-register")
        || id.starts_with("layout-")
        || id.starts_with("ui-")
        || id.starts_with("help-")
    {
        return (Vec::new(), true);
    }
    (Vec::new(), false)
}

pub fn resolved_requirements(
    manual_id: &str,
    row: Option<&HelpManualPolicyRow>,
) -> (Vec<String>, bool) {
    let (def_perm, def_pos) = default_visibility(manual_id);
    let perms = row
        .and_then(|r| r.required_permissions.as_ref())
        .cloned()
        .unwrap_or(def_perm);
    let pos = row
        .and_then(|r| r.allow_register_session)
        .unwrap_or(def_pos);
    (perms, pos)
}

/// `pos_only_mode`: passed help viewer auth was register session only (no staff code).
pub fn viewer_can_see_manual(
    manual_id: &str,
    row: Option<&HelpManualPolicyRow>,
    pos_only_mode: bool,
    staff_perms: &HashSet<String>,
) -> bool {
    if row.map(|r| r.hidden).unwrap_or(false) {
        return false;
    }
    let (req, allow_pos) = resolved_requirements(manual_id, row);
    if pos_only_mode {
        return allow_pos;
    }
    if req.is_empty() {
        return true;
    }
    req.iter().all(|k| staff_has_permission(staff_perms, k))
}

pub async fn load_all_policies(
    pool: &PgPool,
) -> Result<HashMap<String, HelpManualPolicyRow>, sqlx::Error> {
    let rows: Vec<HelpManualPolicyRow> = sqlx::query_as(
        r#"
        SELECT manual_id, hidden, title_override, summary_override, markdown_override,
               order_override, required_permissions, allow_register_session
        FROM help_manual_policy
        "#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| (r.manual_id.clone(), r)).collect())
}

pub fn read_bundled_manual_raw(rel_path: &str) -> Result<String, std::io::Error> {
    let path = repo_root().join(rel_path);
    std::fs::read_to_string(&path)
}

pub fn bundled_front_matter_meta(raw_md: &str, manual_id: &str) -> (String, String, i32) {
    let order = extract_order(raw_md).unwrap_or(100);
    bundled_title_summary_order(raw_md, manual_id, order)
}

pub fn bundled_title_summary_order(
    raw_md: &str,
    manual_id: &str,
    default_order: i32,
) -> (String, String, i32) {
    let body = strip_yaml_front_matter(raw_md);
    let title = extract_title(raw_md, &body, manual_id);
    let summary = extract_summary(raw_md);
    (title, summary, default_order)
}

fn extract_title(raw: &str, body: &str, manual_id: &str) -> String {
    if let Some(t) = yaml_field(raw, "title") {
        if !t.is_empty() {
            return t;
        }
    }
    if let Some(m) = body
        .lines()
        .find_map(|l| l.strip_prefix("# ").map(str::trim))
    {
        if !m.is_empty() {
            return m.to_string();
        }
    }
    manual_id.to_string()
}

fn extract_summary(raw: &str) -> String {
    yaml_field(raw, "summary").unwrap_or_default()
}

fn yaml_field(raw: &str, key: &str) -> Option<String> {
    let t = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let rest = t.strip_prefix("---")?;
    let end = rest.find("\n---")?;
    let block = &rest[..end];
    let prefix = format!("{key}:");
    for line in block.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix(&prefix) {
            let v = v.trim();
            if (v.starts_with('"') && v.ends_with('"'))
                || (v.starts_with('\'') && v.ends_with('\''))
            {
                return Some(v[1..v.len().saturating_sub(1)].to_string());
            }
            return Some(v.to_string());
        }
    }
    None
}

fn extract_order(raw: &str) -> Option<i32> {
    let v = yaml_field(raw, "order")?;
    v.parse().ok()
}

pub fn merged_markdown(raw_bundled: &str, row: Option<&HelpManualPolicyRow>) -> String {
    if let Some(ov) = row.and_then(|r| r.markdown_override.as_ref()) {
        if !ov.trim().is_empty() {
            return ov.clone();
        }
    }
    raw_bundled.to_string()
}

pub fn merged_display_markdown(raw_merged: &str) -> String {
    strip_yaml_front_matter(raw_merged).trim().to_string()
}

#[derive(Debug, Serialize)]
pub struct HelpManualListItemOut {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub order: i32,
    pub has_markdown_override: bool,
}

#[derive(Debug, Serialize)]
pub struct HelpManualDetailOut {
    pub id: String,
    pub title: String,
    pub markdown: String,
}

#[derive(Debug, Serialize)]
pub struct HelpDefaultVisibilityOut {
    pub required_permissions: Vec<String>,
    pub allow_register_session: bool,
}

#[derive(Debug, Serialize)]
pub struct HelpAdminManualOut {
    pub manual_id: String,
    pub bundled_relative_path: String,
    pub default_visibility: HelpDefaultVisibilityOut,
    pub hidden: bool,
    pub title_override: Option<String>,
    pub summary_override: Option<String>,
    pub markdown_override: Option<String>,
    pub order_override: Option<i32>,
    pub required_permissions: Option<Vec<String>>,
    pub allow_register_session: Option<bool>,
    pub bundled_title: String,
    pub bundled_summary: String,
    pub bundled_order: i32,
}

#[derive(Debug, Deserialize)]
pub struct PutHelpManualPolicyBody {
    pub hidden: bool,
    #[serde(default)]
    pub title_override: Option<String>,
    #[serde(default)]
    pub summary_override: Option<String>,
    #[serde(default)]
    pub markdown_override: Option<String>,
    #[serde(default)]
    pub order_override: Option<i32>,
    /// When true, store `NULL` in DB so [`default_visibility`] applies.
    pub permissions_inherit: bool,
    #[serde(default)]
    pub required_permissions: Vec<String>,
    /// When true, store `NULL` for register-session visibility.
    pub register_session_inherit: bool,
    #[serde(default)]
    pub allow_register_session: bool,
}

pub async fn upsert_help_manual_policy(
    pool: &PgPool,
    manual_id: &str,
    body: &PutHelpManualPolicyBody,
    staff_id: Uuid,
) -> Result<(), sqlx::Error> {
    let title = empty_to_none(body.title_override.clone());
    let summary = empty_to_none(body.summary_override.clone());
    let md = empty_to_none(body.markdown_override.clone());
    let req_perm = if body.permissions_inherit {
        None
    } else {
        Some(body.required_permissions.clone())
    };
    let allow_pos = if body.register_session_inherit {
        None
    } else {
        Some(body.allow_register_session)
    };

    sqlx::query(
        r#"
        INSERT INTO help_manual_policy (
            manual_id, hidden, title_override, summary_override, markdown_override,
            order_override, required_permissions, allow_register_session, updated_at, updated_by_staff_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
        ON CONFLICT (manual_id) DO UPDATE SET
            hidden = EXCLUDED.hidden,
            title_override = EXCLUDED.title_override,
            summary_override = EXCLUDED.summary_override,
            markdown_override = EXCLUDED.markdown_override,
            order_override = EXCLUDED.order_override,
            required_permissions = EXCLUDED.required_permissions,
            allow_register_session = EXCLUDED.allow_register_session,
            updated_at = now(),
            updated_by_staff_id = EXCLUDED.updated_by_staff_id
        "#,
    )
    .bind(manual_id)
    .bind(body.hidden)
    .bind(&title)
    .bind(&summary)
    .bind(&md)
    .bind(body.order_override)
    .bind(&req_perm)
    .bind(allow_pos)
    .bind(staff_id)
    .execute(pool)
    .await?;

    Ok(())
}

fn empty_to_none(s: Option<String>) -> Option<String> {
    match s {
        None => None,
        Some(x) if x.trim().is_empty() => None,
        Some(x) => Some(x),
    }
}

pub async fn delete_help_manual_policy(
    pool: &PgPool,
    manual_id: &str,
) -> Result<bool, sqlx::Error> {
    let r = sqlx::query("DELETE FROM help_manual_policy WHERE manual_id = $1")
        .bind(manual_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// Build catalog list for viewers (filtered).
pub async fn build_visible_manual_list(
    pool: &PgPool,
    pos_only_mode: bool,
    staff_perms: &HashSet<String>,
) -> Result<Vec<HelpManualListItemOut>, std::io::Error> {
    let policies = load_all_policies(pool)
        .await
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let mut out: Vec<HelpManualListItemOut> = Vec::new();

    for (manual_id, rel) in HELP_MANUAL_FILES {
        let row = policies.get(*manual_id);
        if !viewer_can_see_manual(manual_id, row, pos_only_mode, staff_perms) {
            continue;
        }
        let raw = read_bundled_manual_raw(rel)?;
        let bundled_order = extract_order(&raw).unwrap_or(100);
        let order = row.and_then(|r| r.order_override).unwrap_or(bundled_order);
        let (btitle, bsum, _) = bundled_title_summary_order(&raw, manual_id, bundled_order);
        let title = row
            .and_then(|r| r.title_override.as_ref())
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or(btitle);
        let summary = row
            .and_then(|r| r.summary_override.as_ref())
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or(bsum);
        let has_markdown_override = row
            .and_then(|r| r.markdown_override.as_ref())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

        out.push(HelpManualListItemOut {
            id: (*manual_id).to_string(),
            title,
            summary,
            order,
            has_markdown_override,
        });
    }

    out.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

pub async fn build_manual_detail(
    pool: &PgPool,
    manual_id: &str,
    pos_only_mode: bool,
    staff_perms: &HashSet<String>,
) -> Result<Option<HelpManualDetailOut>, Box<dyn std::error::Error + Send + Sync>> {
    let policies = load_all_policies(pool).await?;
    let row = policies.get(manual_id);
    let Some((_, rel)) = HELP_MANUAL_FILES.iter().find(|(id, _)| *id == manual_id) else {
        return Ok(None);
    };
    if !viewer_can_see_manual(manual_id, row, pos_only_mode, staff_perms) {
        return Ok(None);
    }
    let raw = read_bundled_manual_raw(rel)?;
    let merged = merged_markdown(&raw, row);
    let display = merged_display_markdown(&merged);
    let bundled_order = extract_order(&raw).unwrap_or(100);
    let (btitle, _, _) = bundled_title_summary_order(&raw, manual_id, bundled_order);
    let title = row
        .and_then(|r| r.title_override.as_ref())
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or(btitle);
    Ok(Some(HelpManualDetailOut {
        id: manual_id.to_string(),
        title,
        markdown: display,
    }))
}

pub fn build_admin_manual_catalog(
    policies: &HashMap<String, HelpManualPolicyRow>,
) -> Result<Vec<HelpAdminManualOut>, std::io::Error> {
    let mut out = Vec::new();
    for (manual_id, rel) in HELP_MANUAL_FILES {
        let raw = read_bundled_manual_raw(rel)?;
        let bundled_order = extract_order(&raw).unwrap_or(100);
        let (bundled_title, bundled_summary, _) =
            bundled_title_summary_order(&raw, manual_id, bundled_order);
        let row = policies.get(*manual_id);
        let (req, pos) = default_visibility(manual_id);
        let def = HelpDefaultVisibilityOut {
            required_permissions: req,
            allow_register_session: pos,
        };
        out.push(HelpAdminManualOut {
            manual_id: (*manual_id).to_string(),
            bundled_relative_path: (*rel).to_string(),
            default_visibility: def,
            hidden: row.map(|r| r.hidden).unwrap_or(false),
            title_override: row.and_then(|r| r.title_override.clone()),
            summary_override: row.and_then(|r| r.summary_override.clone()),
            markdown_override: row.and_then(|r| r.markdown_override.clone()),
            order_override: row.and_then(|r| r.order_override),
            required_permissions: row.and_then(|r| r.required_permissions.clone()),
            allow_register_session: row.and_then(|r| r.allow_register_session),
            bundled_title,
            bundled_summary,
            bundled_order,
        });
    }
    out.sort_by(|a, b| a.manual_id.cmp(&b.manual_id));
    Ok(out)
}
