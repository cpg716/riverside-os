use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct ProductCatalogAnalysisInput {
    pub title: String,
    pub vendor: Option<String>,
    pub vendor_code: Option<String>,
    pub brand: Option<String>,
    pub supplier_code_hint: Option<String>,
    pub category_name: Option<String>,
    pub variation_axes: Vec<String>,
    pub variant_values: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ProductCatalogParsedFields {
    pub vendor: Option<String>,
    pub brand: Option<String>,
    pub supplier_code: Option<String>,
    pub product_type: Option<String>,
    pub color: Option<String>,
    pub size: Option<String>,
    pub fit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProductCatalogAnalysis {
    pub parsed_fields: ProductCatalogParsedFields,
    pub issues_detected: Vec<String>,
    pub confidence_score: f64,
    pub unresolved_parts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ProductCatalogSuggestedVariantFields {
    pub color: Option<String>,
    pub size: Option<String>,
    pub fit: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProductCatalogSuggestion {
    pub suggested_parent_title: Option<String>,
    pub suggested_variant_fields: ProductCatalogSuggestedVariantFields,
    pub suggestion_issues: Vec<String>,
    pub suggestion_confidence: f64,
}

pub fn analyze_product_catalog(input: &ProductCatalogAnalysisInput) -> ProductCatalogAnalysis {
    let normalized_title = normalize_space(&input.title);
    let lower_title = normalized_title.to_ascii_lowercase();

    let vendor = clean_opt(&input.vendor);
    let vendor_code = clean_opt(&input.vendor_code);
    let supplier_code_hint = clean_opt(&input.supplier_code_hint);
    let category_name = clean_opt(&input.category_name);

    let mut issues = Vec::<String>::new();
    let variant_index = build_variant_index(&input.variant_values);

    let brand = clean_opt(&input.brand).filter(|brand_name| {
        vendor
            .as_deref()
            .map(|vendor_name| !eq_ci(vendor_name, brand_name))
            .unwrap_or(true)
    });

    let supplier_code = supplier_code_hint
        .filter(|value| is_supplier_code_like(value))
        .or_else(|| extract_supplier_code(&normalized_title))
        .or_else(|| vendor_code.filter(|value| is_supplier_code_like(value)));

    let product_type = detect_product_type(&normalized_title).or_else(|| category_name.clone());
    let fit = detect_fit(&normalized_title)
        .or_else(|| single_variant_value(&variant_index, &["fit", "cut", "silhouette"]));
    let color = detect_color(&normalized_title)
        .or_else(|| single_variant_value(&variant_index, &["color", "colour"]));
    let size = detect_size(&normalized_title)
        .or_else(|| single_variant_value(&variant_index, &["size", "waist", "inseam"]));

    let varying_axes = find_variant_axes_embedded_in_title(&lower_title, &variant_index);
    if !varying_axes.is_empty() {
        issues.push(format!(
            "Title appears to embed variant details that vary by SKU: {}.",
            varying_axes.join(", ")
        ));
    }

    if input.variation_axes.len() > 1 {
        issues.push(format!(
            "Variation axes are split across multiple fields ({}) while title naming remains inconsistent.",
            input.variation_axes.join(", ")
        ));
    }

    if product_type.is_none() {
        issues.push(
            "Product type could not be parsed confidently from the current catalog data."
                .to_string(),
        );
    }
    if vendor.is_none() {
        issues.push(
            "Primary vendor is missing, which weakens the operational identity anchor.".to_string(),
        );
    }
    if supplier_code.is_none() {
        issues.push(
            "No supplier code could be identified confidently from the current product data."
                .to_string(),
        );
    }

    let ambiguous_segments = unresolved_segments(
        &normalized_title,
        [
            vendor.as_deref(),
            brand.as_deref(),
            supplier_code.as_deref(),
            product_type.as_deref(),
            color.as_deref(),
            size.as_deref(),
            fit.as_deref(),
        ]
        .into_iter()
        .flatten()
        .collect(),
    );

    if !ambiguous_segments.is_empty() {
        issues.push("Some title fragments remain ambiguous and should stay unparsed until a human reviews them.".to_string());
    }

    let ordering_issue = detect_ordering_issue(
        &normalized_title,
        vendor.as_deref(),
        brand.as_deref(),
        supplier_code.as_deref(),
        product_type.as_deref(),
    );
    if let Some(issue) = ordering_issue {
        issues.push(issue);
    }

    let mut confidence = 0.22f64;
    if vendor.is_some() {
        confidence += 0.18;
    }
    if brand.is_some() {
        confidence += 0.08;
    }
    if supplier_code.is_some() {
        confidence += 0.18;
    }
    if product_type.is_some() {
        confidence += 0.16;
    }
    if color.is_some() {
        confidence += 0.08;
    }
    if size.is_some() {
        confidence += 0.08;
    }
    if fit.is_some() {
        confidence += 0.06;
    }
    confidence -= varying_axes.len() as f64 * 0.14;
    confidence -= ambiguous_segments.len() as f64 * 0.06;
    confidence -= issues.len() as f64 * 0.03;
    confidence = confidence.clamp(0.08, 0.97);

    ProductCatalogAnalysis {
        parsed_fields: ProductCatalogParsedFields {
            vendor,
            brand,
            supplier_code,
            product_type,
            color,
            size,
            fit,
        },
        issues_detected: dedupe_preserve_order(issues),
        confidence_score: confidence,
        unresolved_parts: ambiguous_segments,
    }
}

pub fn suggest_product_catalog_normalization(
    input: &ProductCatalogAnalysisInput,
    analysis: &ProductCatalogAnalysis,
) -> ProductCatalogSuggestion {
    let mut issues = analysis.issues_detected.clone();
    let parent_identity = analysis
        .parsed_fields
        .brand
        .clone()
        .or_else(|| analysis.parsed_fields.vendor.clone());
    let product_type = analysis.parsed_fields.product_type.clone();
    let supplier_code = analysis.parsed_fields.supplier_code.clone();
    let title_confident_enough =
        analysis.confidence_score >= 0.62 && analysis.unresolved_parts.len() <= 2;

    let suggested_parent_title = if title_confident_enough
        && parent_identity.is_some()
        && product_type.is_some()
        && supplier_code.is_some()
    {
        Some(
            [
                parent_identity.as_deref(),
                product_type.as_deref(),
                supplier_code.as_deref(),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" "),
        )
    } else {
        None
    };

    if analysis.parsed_fields.brand.is_none() && analysis.parsed_fields.vendor.is_some() {
        issues.push(
            "Brand is absent, so the suggested parent identity stays vendor-first.".to_string(),
        );
    }

    if !title_confident_enough {
        issues.push(
            "Suggestion withheld because the current analysis confidence is too low for safe normalization."
                .to_string(),
        );
    }

    if parent_identity.is_none() {
        issues.push(
            "Suggestion withheld because neither a trustworthy vendor nor an optional brand anchor is available."
                .to_string(),
        );
    }

    if supplier_code.is_none() {
        issues.push(
            "Suggestion withheld because supplier_code is required as a first-class parent identity anchor."
                .to_string(),
        );
    }

    if product_type.is_none() {
        issues.push(
            "Suggestion withheld because product_type is not grounded strongly enough yet."
                .to_string(),
        );
    }

    if let Some(suggested_title) = suggested_parent_title.as_deref() {
        if normalize_space(&input.title).eq_ignore_ascii_case(suggested_title) {
            issues.push(
                "Current parent title already matches the grounded Riverside normalization pattern."
                    .to_string(),
            );
        }
    }

    let mut confidence = analysis.confidence_score;
    if suggested_parent_title.is_some() {
        confidence += 0.06;
    } else {
        confidence -= 0.18;
    }
    confidence -= issues.len() as f64 * 0.015;
    confidence = confidence.clamp(0.05, 0.97);

    ProductCatalogSuggestion {
        suggested_parent_title,
        suggested_variant_fields: ProductCatalogSuggestedVariantFields {
            color: analysis.parsed_fields.color.clone(),
            size: analysis.parsed_fields.size.clone(),
            fit: analysis.parsed_fields.fit.clone(),
        },
        suggestion_issues: dedupe_preserve_order(issues),
        suggestion_confidence: confidence,
    }
}

fn dedupe_preserve_order(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for value in values {
        if seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

fn clean_opt(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|item| normalize_space(item))
        .filter(|item| !item.is_empty())
}

fn normalize_space(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn eq_ci(left: &str, right: &str) -> bool {
    left.trim().eq_ignore_ascii_case(right.trim())
}

fn is_supplier_code_like(value: &str) -> bool {
    let compact = value.trim();
    if compact.len() < 4 || compact.len() > 32 {
        return false;
    }
    if is_size_token(compact) {
        return false;
    }
    let has_alpha = compact.chars().any(|c| c.is_ascii_alphabetic());
    let has_digit = compact.chars().any(|c| c.is_ascii_digit());
    let allowed = compact
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | '.'));
    allowed && (has_digit || compact.contains('-')) && has_alpha
}

fn is_size_token(value: &str) -> bool {
    let upper = value.trim().to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "XS" | "S" | "M" | "L" | "XL" | "XXL" | "XXXL"
    ) || is_numeric_size_token(&upper)
}

fn is_numeric_size_token(value: &str) -> bool {
    let chars = value.chars().collect::<Vec<_>>();
    if chars.len() == 3 && chars[0].is_ascii_digit() && chars[1].is_ascii_digit() {
        return matches!(chars[2], 'R' | 'S' | 'L');
    }
    if chars.len() == 5
        && chars[0].is_ascii_digit()
        && chars[1].is_ascii_digit()
        && chars[2] == 'X'
        && chars[3].is_ascii_digit()
        && chars[4].is_ascii_digit()
    {
        return true;
    }
    false
}

fn extract_supplier_code(title: &str) -> Option<String> {
    title
        .split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | '[' | ']' | ',' | '|'))
        .map(|token| {
            token.trim_matches(|c: char| {
                !c.is_ascii_alphanumeric() && c != '-' && c != '_' && c != '/'
            })
        })
        .find(|token| is_supplier_code_like(token))
        .map(str::to_string)
}

fn detect_product_type(title: &str) -> Option<String> {
    const PRODUCT_TYPES: &[(&str, &str)] = &[
        ("tuxedo jacket", "Tuxedo Jacket"),
        ("dinner jacket", "Dinner Jacket"),
        ("sport coat", "Sport Coat"),
        ("sportcoat", "Sport Coat"),
        ("blazer", "Blazer"),
        ("tuxedo", "Tuxedo"),
        ("suit", "Suit"),
        ("jacket", "Jacket"),
        ("pants", "Pants"),
        ("trouser", "Trousers"),
        ("vest", "Vest"),
        ("waistcoat", "Vest"),
        ("shirt", "Shirt"),
        ("loafer", "Loafer"),
        ("shoe", "Shoes"),
        ("tie", "Tie"),
        ("bow tie", "Bow Tie"),
    ];

    let lower = title.to_ascii_lowercase();
    PRODUCT_TYPES
        .iter()
        .find_map(|(needle, label)| lower.contains(needle).then(|| (*label).to_string()))
}

fn detect_fit(title: &str) -> Option<String> {
    const FITS: &[(&str, &str)] = &[
        ("slim fit", "Slim"),
        ("modern fit", "Modern"),
        ("classic fit", "Classic"),
        ("tailored fit", "Tailored"),
        ("trim fit", "Trim"),
        ("slim", "Slim"),
        ("modern", "Modern"),
        ("classic", "Classic"),
        ("tailored", "Tailored"),
        ("trim", "Trim"),
    ];

    let lower = title.to_ascii_lowercase();
    FITS.iter()
        .find_map(|(needle, label)| lower.contains(needle).then(|| (*label).to_string()))
}

fn detect_color(title: &str) -> Option<String> {
    const COLORS: &[(&str, &str)] = &[
        ("hunter green", "Hunter Green"),
        ("charcoal", "Charcoal"),
        ("burgundy", "Burgundy"),
        ("navy", "Navy"),
        ("midnight", "Midnight"),
        ("black", "Black"),
        ("grey", "Grey"),
        ("gray", "Gray"),
        ("tan", "Tan"),
        ("brown", "Brown"),
        ("ivory", "Ivory"),
        ("white", "White"),
        ("silver", "Silver"),
        ("gold", "Gold"),
        ("olive", "Olive"),
        ("blue", "Blue"),
        ("green", "Green"),
        ("pink", "Pink"),
        ("purple", "Purple"),
        ("red", "Red"),
    ];

    let lower = title.to_ascii_lowercase();
    COLORS
        .iter()
        .find_map(|(needle, label)| lower.contains(needle).then(|| (*label).to_string()))
}

fn detect_size(title: &str) -> Option<String> {
    for token in title.split_whitespace() {
        let cleaned =
            token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != 'x' && c != 'X');
        if cleaned.is_empty() {
            continue;
        }
        let upper = cleaned.to_ascii_uppercase();
        if is_size_token(&upper) {
            return Some(upper);
        }
    }
    None
}

fn build_variant_index(values: &[Value]) -> BTreeMap<String, BTreeSet<String>> {
    let mut out = BTreeMap::<String, BTreeSet<String>>::new();
    for value in values {
        let Some(map) = value.as_object() else {
            continue;
        };
        for (key, raw) in map {
            let normalized = raw
                .as_str()
                .map(normalize_space)
                .filter(|item| !item.is_empty());
            if let Some(entry) = normalized {
                out.entry(key.to_ascii_lowercase())
                    .or_default()
                    .insert(entry);
            }
        }
    }
    out
}

fn single_variant_value(
    index: &BTreeMap<String, BTreeSet<String>>,
    keys: &[&str],
) -> Option<String> {
    keys.iter().find_map(|key| {
        index.get(*key).and_then(|values| {
            (values.len() == 1)
                .then(|| values.iter().next().cloned())
                .flatten()
        })
    })
}

fn find_variant_axes_embedded_in_title(
    lower_title: &str,
    index: &BTreeMap<String, BTreeSet<String>>,
) -> Vec<String> {
    let mut axes = Vec::new();
    for (axis, values) in index {
        if values.len() <= 1 {
            continue;
        }
        if values
            .iter()
            .any(|value| lower_title.contains(&value.to_ascii_lowercase()))
        {
            axes.push(axis.replace('_', " "));
        }
    }
    axes
}

fn unresolved_segments(title: &str, recognized: Vec<&str>) -> Vec<String> {
    let mut scrubbed = title.to_string();
    for token in recognized {
        if token.trim().is_empty() {
            continue;
        }
        scrubbed = scrubbed.replace(token, " ");
        scrubbed = scrubbed.replace(&token.to_ascii_uppercase(), " ");
        scrubbed = scrubbed.replace(&token.to_ascii_lowercase(), " ");
    }

    scrubbed
        .split(['-', '/', '|', ',', '(', ')', '[', ']'])
        .map(normalize_space)
        .filter(|segment| segment.len() >= 3)
        .filter(|segment| {
            let lower = segment.to_ascii_lowercase();
            !matches!(
                lower.as_str(),
                "by" | "the" | "and" | "with" | "for" | "mens" | "men's"
            )
        })
        .collect()
}

fn detect_ordering_issue(
    title: &str,
    vendor: Option<&str>,
    brand: Option<&str>,
    supplier_code: Option<&str>,
    product_type: Option<&str>,
) -> Option<String> {
    let title_lower = title.to_ascii_lowercase();
    let mut positions = Vec::<usize>::new();
    for token in [vendor, brand, supplier_code, product_type]
        .into_iter()
        .flatten()
    {
        if let Some(idx) = title_lower.find(&token.to_ascii_lowercase()) {
            positions.push(idx);
        }
    }
    if positions.len() >= 3 && positions.windows(2).any(|window| window[0] > window[1]) {
        Some("Title token order is inconsistent with the likely vendor / brand / code / product-type pattern.".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_representative_supplier_first_title() {
        let analysis = analyze_product_catalog(&ProductCatalogAnalysisInput {
            title: "Peerless MK-238 Navy Suit 40R Slim".to_string(),
            vendor: Some("Peerless".to_string()),
            vendor_code: Some("PEER".to_string()),
            brand: Some("Michael Kors".to_string()),
            supplier_code_hint: Some("MK-238".to_string()),
            category_name: Some("Suits".to_string()),
            variation_axes: vec!["size".to_string()],
            variant_values: vec![json!({ "size": "40R" }), json!({ "size": "42R" })],
        });

        assert_eq!(analysis.parsed_fields.vendor.as_deref(), Some("Peerless"));
        assert_eq!(
            analysis.parsed_fields.brand.as_deref(),
            Some("Michael Kors")
        );
        assert_eq!(
            analysis.parsed_fields.supplier_code.as_deref(),
            Some("MK-238")
        );
        assert_eq!(analysis.parsed_fields.product_type.as_deref(), Some("Suit"));
        assert_eq!(analysis.parsed_fields.color.as_deref(), Some("Navy"));
        assert_eq!(analysis.parsed_fields.size.as_deref(), Some("40R"));
        assert_eq!(analysis.parsed_fields.fit.as_deref(), Some("Slim"));
        assert!(analysis.confidence_score > 0.6);
    }

    #[test]
    fn preserves_vendor_vs_optional_brand_distinction() {
        let analysis = analyze_product_catalog(&ProductCatalogAnalysisInput {
            title: "Ike Behar IB-442 Midnight Tuxedo".to_string(),
            vendor: Some("Formalwear International".to_string()),
            vendor_code: Some("FI-01".to_string()),
            brand: Some("Ike Behar".to_string()),
            supplier_code_hint: Some("IB-442".to_string()),
            category_name: Some("Tuxedos".to_string()),
            variation_axes: vec![],
            variant_values: vec![],
        });

        assert_eq!(
            analysis.parsed_fields.vendor.as_deref(),
            Some("Formalwear International")
        );
        assert_eq!(analysis.parsed_fields.brand.as_deref(), Some("Ike Behar"));
        assert_eq!(
            analysis.parsed_fields.supplier_code.as_deref(),
            Some("IB-442")
        );
    }

    #[test]
    fn marks_ambiguous_titles_low_confidence() {
        let analysis = analyze_product_catalog(&ProductCatalogAnalysisInput {
            title: "Wedding Navy / Black Statement Collection".to_string(),
            vendor: Some("Peerless".to_string()),
            vendor_code: None,
            brand: None,
            supplier_code_hint: None,
            category_name: None,
            variation_axes: vec!["color".to_string(), "size".to_string()],
            variant_values: vec![
                json!({ "color": "Navy", "size": "40R" }),
                json!({ "color": "Black", "size": "42R" }),
            ],
        });

        assert!(analysis.confidence_score < 0.55);
        assert!(!analysis.unresolved_parts.is_empty());
        assert!(analysis
            .issues_detected
            .iter()
            .any(|issue| issue.contains("vary by SKU")));
    }

    #[test]
    fn suggests_normalized_parent_title_for_confident_products() {
        let input = ProductCatalogAnalysisInput {
            title: "Peerless MK-238 Navy Suit 40R Slim".to_string(),
            vendor: Some("Peerless".to_string()),
            vendor_code: Some("PEER".to_string()),
            brand: Some("Michael Kors".to_string()),
            supplier_code_hint: Some("MK-238".to_string()),
            category_name: Some("Suits".to_string()),
            variation_axes: vec!["size".to_string()],
            variant_values: vec![json!({ "size": "40R" }), json!({ "size": "42R" })],
        };
        let analysis = analyze_product_catalog(&input);
        let suggestion = suggest_product_catalog_normalization(&input, &analysis);

        assert_eq!(
            suggestion.suggested_parent_title.as_deref(),
            Some("Michael Kors Suit MK-238")
        );
        assert_eq!(
            suggestion.suggested_variant_fields.size.as_deref(),
            Some("40R")
        );
        assert!(suggestion.suggestion_confidence > 0.6);
    }

    #[test]
    fn suggestion_preserves_vendor_when_brand_absent() {
        let input = ProductCatalogAnalysisInput {
            title: "Peerless MK-238 Navy Suit 40R Slim".to_string(),
            vendor: Some("Peerless".to_string()),
            vendor_code: Some("PEER".to_string()),
            brand: None,
            supplier_code_hint: Some("MK-238".to_string()),
            category_name: Some("Suits".to_string()),
            variation_axes: vec!["size".to_string()],
            variant_values: vec![json!({ "size": "40R" })],
        };
        let analysis = analyze_product_catalog(&input);
        let suggestion = suggest_product_catalog_normalization(&input, &analysis);

        assert_eq!(
            suggestion.suggested_parent_title.as_deref(),
            Some("Peerless Suit MK-238")
        );
        assert!(suggestion
            .suggestion_issues
            .iter()
            .any(|issue| issue.contains("vendor-first")));
    }

    #[test]
    fn withholds_suggestion_when_analysis_is_low_confidence() {
        let input = ProductCatalogAnalysisInput {
            title: "Wedding Navy / Black Statement Collection".to_string(),
            vendor: Some("Peerless".to_string()),
            vendor_code: None,
            brand: None,
            supplier_code_hint: None,
            category_name: None,
            variation_axes: vec!["color".to_string(), "size".to_string()],
            variant_values: vec![
                json!({ "color": "Navy", "size": "40R" }),
                json!({ "color": "Black", "size": "42R" }),
            ],
        };
        let analysis = analyze_product_catalog(&input);
        let suggestion = suggest_product_catalog_normalization(&input, &analysis);

        assert!(suggestion.suggested_parent_title.is_none());
        assert!(suggestion
            .suggestion_issues
            .iter()
            .any(|issue| issue.contains("withheld")));
    }
}
