//! Canonical wedding party display for Riverside OS: compact name + event date (e.g. `Newell-052226`).

use chrono::NaiveDate;

/// SQL expression when `wp` is in scope (PostgreSQL).
pub const SQL_PARTY_TRACKING_LABEL_WP: &str = "(CASE \
     WHEN length(regexp_replace(trim(COALESCE(wp.party_name, wp.groom_name, '')), '[[:space:]]', '', 'g')) = 0 \
     THEN 'Party' \
     ELSE regexp_replace(trim(COALESCE(wp.party_name, wp.groom_name, '')), '[[:space:]]', '', 'g') \
     END || '-' || to_char(wp.event_date, 'MMDDYY'))";

/// `party_name` without spaces + `-` + `MMDDYY` (e.g. May 22, 2026 → `…-052226`).
pub fn wedding_party_tracking_label(
    party_name: Option<&str>,
    groom_name: &str,
    event_date: NaiveDate,
) -> String {
    let base = party_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| groom_name.trim());
    let compact: String = base.chars().filter(|c| !c.is_whitespace()).collect();
    let name = if compact.is_empty() {
        "Party".to_string()
    } else {
        compact
    };
    format!("{}-{}", name, event_date.format("%m%d%y"))
}
