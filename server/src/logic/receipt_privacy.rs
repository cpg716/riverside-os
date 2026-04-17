/// Formats a name for customer receipts: First Name + Last Initial (e.g. "Chris G.").
/// Full names remain on API records and reports; this is only for printed / SMS / email receipts.
pub fn mask_name_for_receipt(full_name: Option<&str>) -> Option<String> {
    let raw = full_name?.trim();
    if raw.is_empty() {
        return None;
    }
    let parts: Vec<&str> = raw.split_whitespace().filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    if parts.len() == 1 {
        return Some(parts[0].to_string());
    }
    // Return "First LastInitial." e.g. "Chris G."
    let first = parts[0];
    let last = parts[parts.len() - 1]
        .chars()
        .find(|c| c.is_alphabetic())
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_else(|| "?".to_string());
    Some(format!("{first} {last}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_word_name() {
        assert_eq!(
            mask_name_for_receipt(Some("Chris Green")).as_deref(),
            Some("Chris G.")
        );
    }

    #[test]
    fn three_part_name_uses_first_and_last_initial() {
        assert_eq!(
            mask_name_for_receipt(Some("Mary Jane Watson")).as_deref(),
            Some("Mary W.")
        );
    }

    #[test]
    fn single_token() {
        assert_eq!(
            mask_name_for_receipt(Some("Madonna")).as_deref(),
            Some("Madonna")
        );
    }

    #[test]
    fn none_and_empty() {
        assert_eq!(mask_name_for_receipt(None), None);
        assert_eq!(mask_name_for_receipt(Some("  ")), None);
    }
}
