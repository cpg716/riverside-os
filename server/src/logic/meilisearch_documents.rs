//! Document shapes sent to Meilisearch (`id` is always the primary key).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct VariantDoc {
    pub id: String,
    pub product_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary_vendor_id: Option<String>,
    pub web_published: bool,
    pub is_clothing_footwear: bool,
    /// Concatenated searchable text (SKU, codes, labels).
    pub search_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoreProductDoc {
    pub id: String,
    /// True when product is eligible for public PLP (active, slug, at least one web-published variant).
    pub catalog_ok: bool,
    pub search_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CustomerDoc {
    pub id: String,
    pub search_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub customer_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeddingPartyDoc {
    pub id: String,
    pub is_deleted: bool,
    pub search_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OrderDoc {
    pub id: String,
    /// Open / pending_measurement when true (for default orders list filter).
    pub status_open: bool,
    pub search_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StaffDoc {
    pub id: String,
    pub is_active: bool,
    pub role: String,
    pub search_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VendorDoc {
    pub id: String,
    pub is_active: bool,
    pub search_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CategoryDoc {
    pub id: String,
    pub search_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppointmentDoc {
    pub id: String,
    pub is_cancelled: bool,
    pub search_text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskDoc {
    pub id: String,
    pub status: String,
    pub assignee_id: Option<String>,
    pub search_text: String,
}

pub fn build_variant_search_text(
    sku: &str,
    barcode: Option<&str>,
    vendor_upc: Option<&str>,
    product_name: &str,
    brand: Option<&str>,
    variation_label: Option<&str>,
    catalog_handle: Option<&str>,
) -> String {
    let mut parts: Vec<&str> = Vec::new();
    parts.push(sku.trim());
    if let Some(b) = barcode.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(b);
    }
    if let Some(u) = vendor_upc.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(u);
    }
    parts.push(product_name.trim());
    if let Some(b) = brand.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(b);
    }
    if let Some(v) = variation_label.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(v);
    }
    if let Some(h) = catalog_handle.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(h);
    }
    parts.join(" ")
}

#[allow(clippy::too_many_arguments)]
pub fn build_customer_search_text(
    first_name: Option<&str>,
    last_name: Option<&str>,
    customer_code: Option<&str>,
    company_name: Option<&str>,
    email: Option<&str>,
    phone: Option<&str>,
    city: Option<&str>,
    state: Option<&str>,
    postal_code: Option<&str>,
    address_line1: Option<&str>,
    wedding_party_names: Option<&str>,
) -> String {
    let mut s = String::new();
    let push = |buf: &mut String, x: &str| {
        if !x.is_empty() {
            if !buf.is_empty() {
                buf.push(' ');
            }
            buf.push_str(x);
        }
    };
    push(&mut s, first_name.unwrap_or("").trim());
    push(&mut s, last_name.unwrap_or("").trim());
    push(&mut s, customer_code.unwrap_or("").trim());
    push(&mut s, company_name.unwrap_or("").trim());
    push(&mut s, email.unwrap_or("").trim());
    push(&mut s, phone.unwrap_or("").trim());
    push(&mut s, city.unwrap_or("").trim());
    push(&mut s, state.unwrap_or("").trim());
    push(&mut s, postal_code.unwrap_or("").trim());
    push(&mut s, address_line1.unwrap_or("").trim());
    if let Some(w) = wedding_party_names.filter(|x| !x.trim().is_empty()) {
        push(&mut s, w.trim());
    }
    s
}

pub fn digits_only(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// Embed digit-only phone hints for wedding / customer style matching.
pub fn augment_search_with_phone_digits(base: &str, phones: &[Option<String>]) -> String {
    let mut out = base.to_string();
    for p in phones {
        let d = p.as_deref().map(digits_only).unwrap_or_default();
        if d.len() >= 2 {
            out.push(' ');
            out.push_str(&d);
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
pub fn variant_doc_from_row(
    variant_id: uuid::Uuid,
    product_id: uuid::Uuid,
    category_id: Option<uuid::Uuid>,
    primary_vendor_id: Option<uuid::Uuid>,
    web_published: bool,
    is_clothing_footwear: bool,
    sku: &str,
    barcode: Option<&str>,
    vendor_upc: Option<&str>,
    product_name: &str,
    brand: Option<&str>,
    variation_label: Option<&str>,
    catalog_handle: Option<&str>,
) -> VariantDoc {
    VariantDoc {
        id: variant_id.to_string(),
        product_id: product_id.to_string(),
        category_id: category_id.map(|u| u.to_string()),
        primary_vendor_id: primary_vendor_id.map(|u| u.to_string()),
        web_published,
        is_clothing_footwear,
        search_text: build_variant_search_text(
            sku,
            barcode,
            vendor_upc,
            product_name,
            brand,
            variation_label,
            catalog_handle,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variant_search_text_includes_fields() {
        let t = build_variant_search_text(
            "SKU-1",
            Some("8859"),
            None,
            "Wool Blazer",
            Some("Acme"),
            Some("42L"),
            Some("wool-blazer"),
        );
        assert!(t.contains("SKU-1"));
        assert!(t.contains("8859"));
        assert!(t.contains("Wool Blazer"));
        assert!(t.contains("Acme"));
        assert!(t.contains("42L"));
        assert!(t.contains("wool-blazer"));
    }

    #[test]
    fn customer_search_text_trims() {
        let t = build_customer_search_text(
            Some("  Ann "),
            Some(" Lee"),
            Some("C001"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("Smith Party"),
        );
        assert!(t.contains("Ann"));
        assert!(t.contains("Lee"));
        assert!(t.contains("C001"));
        assert!(t.contains("Smith Party"));
    }
}
