//! Canonical wedding party display for Riverside OS: groom last name + event date (e.g. `SMITH-072026`).

use chrono::NaiveDate;

/// SQL expression when `wp` is in scope (PostgreSQL).
pub const SQL_PARTY_TRACKING_LABEL_WP: &str =
    "COALESCE(NULLIF(wp.wedding_number, ''), wedding_number_base(wp.groom_name, wp.event_date))";

/// Stored `wedding_number` when available; otherwise groom last name + `-` + `MMDDYY`.
pub fn wedding_party_tracking_label(
    wedding_number: Option<&str>,
    groom_name: &str,
    event_date: NaiveDate,
) -> String {
    if let Some(value) = wedding_number.map(str::trim).filter(|s| !s.is_empty()) {
        return value.to_string();
    }

    let cleaned = groom_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                ' '
            }
        })
        .collect::<String>();
    let last_name = cleaned.split_whitespace().last().unwrap_or("WEDDING");
    let name = if last_name.is_empty() {
        "WEDDING"
    } else {
        last_name
    };
    format!("{}-{}", name, event_date.format("%m%d%y"))
}
