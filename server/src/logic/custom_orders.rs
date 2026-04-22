//! Canonical Custom-order subtype helpers.

use serde_json::{json, Value};

pub const HSM_SUIT_ITEM_TYPE: &str = "HSM Suit";
pub const HSM_SPORT_COAT_ITEM_TYPE: &str = "HSM Sport Coat";
pub const HSM_SLACKS_ITEM_TYPE: &str = "HSM Slacks";
pub const INDIVIDUALIZED_SHIRT_ITEM_TYPE: &str = "Individualized Shirt";

pub const HART_SCHAFFNER_MARX_VENDOR_FAMILY: &str = "hart_schaffner_marx";
pub const INDIVIDUALIZED_SHIRTS_VENDOR_FAMILY: &str = "individualized_shirts";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CustomSubtypeCatalog {
    pub sku: &'static str,
    pub item_type: &'static str,
    pub subtype_key: &'static str,
    pub vendor_form_family: &'static str,
}

const CUSTOM_SUBTYPE_CATALOG: [CustomSubtypeCatalog; 4] = [
    CustomSubtypeCatalog {
        sku: "100",
        item_type: HSM_SUIT_ITEM_TYPE,
        subtype_key: "hsm_suit",
        vendor_form_family: HART_SCHAFFNER_MARX_VENDOR_FAMILY,
    },
    CustomSubtypeCatalog {
        sku: "105",
        item_type: HSM_SPORT_COAT_ITEM_TYPE,
        subtype_key: "hsm_sport_coat",
        vendor_form_family: HART_SCHAFFNER_MARX_VENDOR_FAMILY,
    },
    CustomSubtypeCatalog {
        sku: "110",
        item_type: HSM_SLACKS_ITEM_TYPE,
        subtype_key: "hsm_slacks",
        vendor_form_family: HART_SCHAFFNER_MARX_VENDOR_FAMILY,
    },
    CustomSubtypeCatalog {
        sku: "200",
        item_type: INDIVIDUALIZED_SHIRT_ITEM_TYPE,
        subtype_key: "individualized_shirt",
        vendor_form_family: INDIVIDUALIZED_SHIRTS_VENDOR_FAMILY,
    },
];

pub fn known_custom_subtype_for_sku(raw_sku: &str) -> Option<CustomSubtypeCatalog> {
    let normalized = raw_sku.trim().to_ascii_uppercase();
    CUSTOM_SUBTYPE_CATALOG
        .iter()
        .copied()
        .find(|entry| entry.sku == normalized)
}

pub fn known_custom_item_type_for_sku(raw_sku: &str) -> Option<&'static str> {
    known_custom_subtype_for_sku(raw_sku).map(|entry| entry.item_type)
}

pub fn normalize_custom_item_type_key(raw_item_type: &str) -> Option<&'static str> {
    match raw_item_type.trim().to_ascii_lowercase().as_str() {
        "hsm suit" | "suit" | "suits" => Some("hsm_suit"),
        "hsm sport coat" | "sport coat" | "sport coats" => Some("hsm_sport_coat"),
        "hsm slacks" | "slacks" => Some("hsm_slacks"),
        "individualized shirt" | "individualized shirts" => Some("individualized_shirt"),
        _ => None,
    }
}

fn clean_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn canonical_custom_order_details(
    subtype: Option<CustomSubtypeCatalog>,
    details: Option<&Value>,
) -> Option<Value> {
    let subtype = subtype?;
    let object = details?.as_object()?;

    let garment_description = clean_text(
        object
            .get("garment_description")
            .and_then(Value::as_str)
            .or_else(|| object.get("shirt_description").and_then(Value::as_str)),
    );
    let fabric_reference = clean_text(object.get("fabric_reference").and_then(Value::as_str));
    let style_reference = clean_text(object.get("style_reference").and_then(Value::as_str));
    let reference_number = clean_text(object.get("reference_number").and_then(Value::as_str));
    let custom_notes = clean_text(object.get("custom_notes").and_then(Value::as_str));
    let hsm_garment_type = clean_text(object.get("hsm_garment_type").and_then(Value::as_str));
    let hsm_model_code = clean_text(object.get("hsm_model_code").and_then(Value::as_str));
    let hsm_trim_reference =
        clean_text(object.get("hsm_trim_reference").and_then(Value::as_str));
    let hsm_coat_size = clean_text(object.get("hsm_coat_size").and_then(Value::as_str));
    let hsm_pant_size = clean_text(object.get("hsm_pant_size").and_then(Value::as_str));
    let hsm_vest_size = clean_text(object.get("hsm_vest_size").and_then(Value::as_str));
    let hsm_coat_length = clean_text(object.get("hsm_coat_length").and_then(Value::as_str));
    let hsm_pant_inseam = clean_text(object.get("hsm_pant_inseam").and_then(Value::as_str));
    let hsm_left_sleeve = clean_text(object.get("hsm_left_sleeve").and_then(Value::as_str));
    let hsm_right_sleeve = clean_text(object.get("hsm_right_sleeve").and_then(Value::as_str));
    let hsm_left_out = clean_text(object.get("hsm_left_out").and_then(Value::as_str));
    let hsm_right_out = clean_text(object.get("hsm_right_out").and_then(Value::as_str));
    let hsm_vent_style = clean_text(object.get("hsm_vent_style").and_then(Value::as_str));
    let hsm_lapel_style = clean_text(object.get("hsm_lapel_style").and_then(Value::as_str));
    let hsm_button_stance =
        clean_text(object.get("hsm_button_stance").and_then(Value::as_str));
    let hsm_fabric_reservation_number = clean_text(
        object
            .get("hsm_fabric_reservation_number")
            .and_then(Value::as_str),
    );
    let shirt_fit_notes = clean_text(object.get("shirt_fit_notes").and_then(Value::as_str));
    let shirt_collar_style =
        clean_text(object.get("shirt_collar_style").and_then(Value::as_str));
    let shirt_cuff_style = clean_text(object.get("shirt_cuff_style").and_then(Value::as_str));
    let shirt_previous_order_number = clean_text(
        object
            .get("shirt_previous_order_number")
            .and_then(Value::as_str),
    );
    let shirt_try_on_size = clean_text(object.get("shirt_try_on_size").and_then(Value::as_str));
    let shirt_shaping = clean_text(object.get("shirt_shaping").and_then(Value::as_str));
    let shirt_collar_size = clean_text(object.get("shirt_collar_size").and_then(Value::as_str));
    let shirt_tail_length = clean_text(object.get("shirt_tail_length").and_then(Value::as_str));
    let shirt_yoke = clean_text(object.get("shirt_yoke").and_then(Value::as_str));
    let shirt_right_sleeve_length = clean_text(
        object
            .get("shirt_right_sleeve_length")
            .and_then(Value::as_str),
    );
    let shirt_left_sleeve_length = clean_text(
        object
            .get("shirt_left_sleeve_length")
            .and_then(Value::as_str),
    );
    let shirt_right_cuff_size = clean_text(
        object
            .get("shirt_right_cuff_size")
            .and_then(Value::as_str),
    );
    let shirt_left_cuff_size = clean_text(
        object
            .get("shirt_left_cuff_size")
            .and_then(Value::as_str),
    );
    let shirt_shoulder_line =
        clean_text(object.get("shirt_shoulder_line").and_then(Value::as_str));
    let shirt_front_style = clean_text(object.get("shirt_front_style").and_then(Value::as_str));
    let shirt_back_style = clean_text(object.get("shirt_back_style").and_then(Value::as_str));
    let shirt_tail_style = clean_text(object.get("shirt_tail_style").and_then(Value::as_str));
    let shirt_button_choice =
        clean_text(object.get("shirt_button_choice").and_then(Value::as_str));
    let shirt_pocket_style =
        clean_text(object.get("shirt_pocket_style").and_then(Value::as_str));

    let mut payload = json!({
        "subtype_key": subtype.subtype_key,
        "vendor_form_family": subtype.vendor_form_family,
    });

    if let Value::Object(ref mut map) = payload {
        if let Some(value) = garment_description {
            map.insert("garment_description".to_string(), Value::String(value));
        }
        if let Some(value) = fabric_reference {
            map.insert("fabric_reference".to_string(), Value::String(value));
        }
        if let Some(value) = style_reference {
            map.insert("style_reference".to_string(), Value::String(value));
        }
        if let Some(value) = reference_number {
            map.insert("reference_number".to_string(), Value::String(value));
        }
        if let Some(value) = custom_notes {
            map.insert("custom_notes".to_string(), Value::String(value));
        }
        if subtype.vendor_form_family == HART_SCHAFFNER_MARX_VENDOR_FAMILY {
            if let Some(value) = hsm_garment_type {
                map.insert("hsm_garment_type".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_model_code {
                map.insert("hsm_model_code".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_trim_reference {
                map.insert("hsm_trim_reference".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_coat_size {
                map.insert("hsm_coat_size".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_pant_size {
                map.insert("hsm_pant_size".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_vest_size {
                map.insert("hsm_vest_size".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_coat_length {
                map.insert("hsm_coat_length".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_pant_inseam {
                map.insert("hsm_pant_inseam".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_left_sleeve {
                map.insert("hsm_left_sleeve".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_right_sleeve {
                map.insert("hsm_right_sleeve".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_left_out {
                map.insert("hsm_left_out".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_right_out {
                map.insert("hsm_right_out".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_vent_style {
                map.insert("hsm_vent_style".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_lapel_style {
                map.insert("hsm_lapel_style".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_button_stance {
                map.insert("hsm_button_stance".to_string(), Value::String(value));
            }
            if let Some(value) = hsm_fabric_reservation_number {
                map.insert(
                    "hsm_fabric_reservation_number".to_string(),
                    Value::String(value),
                );
            }
        }
        if subtype.vendor_form_family == INDIVIDUALIZED_SHIRTS_VENDOR_FAMILY {
            if let Some(value) = shirt_fit_notes {
                map.insert("shirt_fit_notes".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_collar_style {
                map.insert("shirt_collar_style".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_cuff_style {
                map.insert("shirt_cuff_style".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_previous_order_number {
                map.insert(
                    "shirt_previous_order_number".to_string(),
                    Value::String(value),
                );
            }
            if let Some(value) = shirt_try_on_size {
                map.insert("shirt_try_on_size".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_shaping {
                map.insert("shirt_shaping".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_collar_size {
                map.insert("shirt_collar_size".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_tail_length {
                map.insert("shirt_tail_length".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_yoke {
                map.insert("shirt_yoke".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_right_sleeve_length {
                map.insert(
                    "shirt_right_sleeve_length".to_string(),
                    Value::String(value),
                );
            }
            if let Some(value) = shirt_left_sleeve_length {
                map.insert(
                    "shirt_left_sleeve_length".to_string(),
                    Value::String(value),
                );
            }
            if let Some(value) = shirt_right_cuff_size {
                map.insert("shirt_right_cuff_size".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_left_cuff_size {
                map.insert("shirt_left_cuff_size".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_shoulder_line {
                map.insert("shirt_shoulder_line".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_front_style {
                map.insert("shirt_front_style".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_back_style {
                map.insert("shirt_back_style".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_tail_style {
                map.insert("shirt_tail_style".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_button_choice {
                map.insert("shirt_button_choice".to_string(), Value::String(value));
            }
            if let Some(value) = shirt_pocket_style {
                map.insert("shirt_pocket_style".to_string(), Value::String(value));
            }
        }
    }

    Some(payload)
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_custom_order_details, known_custom_item_type_for_sku,
        known_custom_subtype_for_sku, normalize_custom_item_type_key,
    };
    use serde_json::json;

    #[test]
    fn known_custom_skus_resolve_to_canonical_item_types() {
        assert_eq!(known_custom_item_type_for_sku("100"), Some("HSM Suit"));
        assert_eq!(known_custom_item_type_for_sku("105"), Some("HSM Sport Coat"));
        assert_eq!(known_custom_item_type_for_sku("110"), Some("HSM Slacks"));
        assert_eq!(
            known_custom_item_type_for_sku("200"),
            Some("Individualized Shirt")
        );
    }

    #[test]
    fn custom_item_type_keys_normalize_legacy_and_canonical_labels() {
        assert_eq!(normalize_custom_item_type_key("SUITS"), Some("hsm_suit"));
        assert_eq!(
            normalize_custom_item_type_key("HSM Sport Coat"),
            Some("hsm_sport_coat")
        );
        assert_eq!(
            normalize_custom_item_type_key("Individualized Shirts"),
            Some("individualized_shirt")
        );
    }

    #[test]
    fn canonical_hsm_details_keep_only_structured_fields() {
        let details = canonical_custom_order_details(
            known_custom_subtype_for_sku("100"),
            Some(&json!({
                "garment_description": "Navy suit",
                "fabric_reference": "6318N2448",
                "style_reference": "302L0140",
                "reference_number": "FAB-123",
                "custom_notes": "Peak lapel",
                "hsm_garment_type": "CP",
                "hsm_model_code": "302L0140",
                "hsm_trim_reference": "PL14",
                "hsm_coat_size": "40R",
                "hsm_pant_size": "34",
                "hsm_left_sleeve": "16 3/4",
                "hsm_lapel_style": "Peak",
            })),
        )
        .expect("expected details");

        assert_eq!(details["subtype_key"], "hsm_suit");
        assert_eq!(details["vendor_form_family"], "hart_schaffner_marx");
        assert_eq!(details["hsm_model_code"], "302L0140");
        assert_eq!(details["fabric_reference"], "6318N2448");
        assert_eq!(details["hsm_coat_size"], "40R");
        assert_eq!(details["hsm_lapel_style"], "Peak");
    }

    #[test]
    fn canonical_individualized_details_keep_shirt_specific_fields() {
        let details = canonical_custom_order_details(
            known_custom_subtype_for_sku("200"),
            Some(&json!({
                "shirt_description": "White contest winner shirt",
                "fabric_reference": "M32PBCM",
                "style_reference": "BD",
                "reference_number": "171835",
                "shirt_fit_notes": "Shaping minus 6",
                "shirt_collar_style": "BD",
                "shirt_cuff_style": "P",
                "shirt_try_on_size": "40",
                "shirt_collar_size": "16 1/2",
                "shirt_right_sleeve_length": "34 3/4",
                "shirt_shoulder_line": "Regular Shoulder",
                "custom_notes": "Contest winner",
            })),
        )
        .expect("expected details");

        assert_eq!(details["subtype_key"], "individualized_shirt");
        assert_eq!(details["vendor_form_family"], "individualized_shirts");
        assert_eq!(details["shirt_collar_style"], "BD");
        assert_eq!(details["shirt_cuff_style"], "P");
        assert_eq!(details["shirt_try_on_size"], "40");
        assert_eq!(details["shirt_shoulder_line"], "Regular Shoulder");
    }
}
