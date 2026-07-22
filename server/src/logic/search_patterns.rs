/// PostgreSQL `ILIKE` contains pattern that treats staff input literally.
/// Callers should use the default backslash escape or add `ESCAPE '\\'` explicitly.
pub fn literal_contains_pattern(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

#[cfg(test)]
mod tests {
    use super::literal_contains_pattern;

    #[test]
    fn contains_pattern_escapes_sql_wildcards() {
        assert_eq!(literal_contains_pattern(r"A%_B\C"), r"%A\%\_B\\C%");
    }
}
