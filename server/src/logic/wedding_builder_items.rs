use serde_json::Value;

fn normalized_wedding_role(role: &str) -> String {
    role.trim().to_ascii_lowercase()
}

pub fn audience(item: &Value) -> &str {
    match item
        .get("audience")
        .and_then(Value::as_str)
        .unwrap_or("all")
    {
        "groom_only" => "groom_only",
        "groomsmen_only" => "groomsmen_only",
        "any" => "any",
        "other" => "other",
        _ => "all",
    }
}

pub fn applies_to_role(item: &Value, member_role: &str) -> bool {
    let role = normalized_wedding_role(member_role);
    match audience(item) {
        "groom_only" => role == "groom",
        "groomsmen_only" => matches!(role.as_str(), "groomsman" | "best man" | "usher"),
        "other" => item
            .get("other_role")
            .and_then(Value::as_str)
            .map(normalized_wedding_role)
            .is_some_and(|other_role| !other_role.is_empty() && other_role == role),
        "all" | "any" => true,
        _ => false,
    }
}

pub fn audience_label(item: &Value) -> String {
    match audience(item) {
        "groom_only" => "Groom Only".to_string(),
        "groomsmen_only" => "Groomsmen Only".to_string(),
        "any" => "Any".to_string(),
        "other" => item
            .get("other_role")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|role| !role.is_empty())
            .map(|role| format!("Other: {role}"))
            .unwrap_or_else(|| "Other".to_string()),
        _ => "All".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{applies_to_role, audience_label};
    use serde_json::json;

    #[test]
    fn filters_builder_items_by_wedding_member_role() {
        assert!(applies_to_role(&json!({}), "Father"));
        assert!(applies_to_role(
            &json!({ "audience": "groom_only" }),
            "Groom"
        ));
        assert!(!applies_to_role(
            &json!({ "audience": "groom_only" }),
            "Groomsman"
        ));
        assert!(applies_to_role(
            &json!({ "audience": "groomsmen_only" }),
            "Best Man"
        ));
        assert!(!applies_to_role(
            &json!({ "audience": "groomsmen_only" }),
            "Father"
        ));
        assert!(applies_to_role(
            &json!({ "audience": "any" }),
            "Ring Bearer"
        ));
        assert!(applies_to_role(
            &json!({ "audience": "other", "other_role": "Father" }),
            "father"
        ));
        assert!(!applies_to_role(
            &json!({ "audience": "other", "other_role": "Father" }),
            "Usher"
        ));
    }

    #[test]
    fn labels_custom_role_scope_for_register_review() {
        assert_eq!(
            audience_label(&json!({
                "audience": "other",
                "other_role": "Ring Bearer"
            })),
            "Other: Ring Bearer"
        );
    }
}
