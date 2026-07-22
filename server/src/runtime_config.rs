use axum::http::{HeaderValue, Uri};

#[derive(Debug, Clone)]
pub struct EffectiveCorsPolicy {
    pub header_values: Vec<HeaderValue>,
    pub configured_origin_count: usize,
    pub invalid_origin_count: usize,
}

impl EffectiveCorsPolicy {
    pub fn uses_wildcard(&self) -> bool {
        self.header_values.is_empty()
    }
}

pub fn parse_cors_origins(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

pub fn cors_origins_from_env() -> Vec<String> {
    parse_cors_origins(std::env::var("RIVERSIDE_CORS_ORIGINS").ok().as_deref())
}

fn exact_browser_origin_header(origin: &str) -> Option<HeaderValue> {
    let (raw_scheme, raw_authority) = origin.split_once("://")?;
    if !(raw_scheme.eq_ignore_ascii_case("http") || raw_scheme.eq_ignore_ascii_case("https"))
        || raw_authority.is_empty()
        || raw_authority
            .chars()
            .any(|character| matches!(character, '/' | '?' | '#' | '@'))
    {
        return None;
    }
    let uri = origin.parse::<Uri>().ok()?;
    if !uri.scheme_str().is_some_and(|scheme| {
        scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
    }) {
        return None;
    }
    let authority = uri.authority()?;
    let authority_text = authority.as_str();
    let has_explicit_port = if authority_text.starts_with('[') {
        authority_text
            .find(']')
            .is_some_and(|end| !authority_text[end + 1..].is_empty())
    } else {
        authority_text.contains(':')
    };
    if authority.host().is_empty()
        || authority_text.contains('@')
        || (has_explicit_port && authority.port().is_none())
        || uri.query().is_some()
    {
        return None;
    }
    HeaderValue::from_str(origin).ok()
}

pub fn effective_cors_policy(origins: &[String]) -> EffectiveCorsPolicy {
    let header_values = origins
        .iter()
        .filter_map(|origin| exact_browser_origin_header(origin))
        .collect::<Vec<_>>();
    EffectiveCorsPolicy {
        configured_origin_count: origins.len(),
        invalid_origin_count: origins.len().saturating_sub(header_values.len()),
        header_values,
    }
}

pub fn effective_cors_policy_from_env() -> EffectiveCorsPolicy {
    effective_cors_policy(&cors_origins_from_env())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cors_parser_trims_and_discards_empty_entries() {
        assert_eq!(
            parse_cors_origins(Some(" https://one.example, ,https://two.example  ")),
            vec!["https://one.example", "https://two.example"]
        );
    }

    #[test]
    fn effective_policy_accepts_only_exact_http_origins() {
        let origins = vec![
            "https://one.example".to_string(),
            "http://127.0.0.1:3000".to_string(),
            "custom://one.example".to_string(),
            "https://one.example/path".to_string(),
        ];
        let policy = effective_cors_policy(&origins);
        assert_eq!(policy.configured_origin_count, 4);
        assert_eq!(policy.header_values.len(), 2);
        assert_eq!(policy.invalid_origin_count, 2);
        assert!(!policy.uses_wildcard());
    }

    #[test]
    fn wildcard_path_query_fragment_and_userinfo_are_rejected() {
        let policy = effective_cors_policy(&[
            "*".to_string(),
            "https://one.example/".to_string(),
            "https://one.example?mode=register".to_string(),
            "https://one.example#register".to_string(),
            "https://staff@one.example".to_string(),
            "https://one.example:not-a-port".to_string(),
            "https://:443".to_string(),
        ]);
        assert!(policy.uses_wildcard());
        assert_eq!(policy.invalid_origin_count, 7);
    }
}
