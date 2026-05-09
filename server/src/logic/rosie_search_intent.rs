use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_SHORTCUTS: usize = 3;
const MAX_QUERY_CHARS: usize = 160;
const MAX_SHORTCUTS_IN_PROMPT: usize = 8;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RosieSearchShortcut {
    pub id: String,
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct RosieSearchResultCounts {
    pub customers: Option<usize>,
    pub orders: Option<usize>,
    pub products: Option<usize>,
    pub shipments: Option<usize>,
    pub weddings: Option<usize>,
    pub alterations: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct RosieSearchDeterministicContext {
    pub exact_sku_found: Option<bool>,
    pub result_counts: Option<RosieSearchResultCounts>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RosieSearchIntentRequest {
    pub query: String,
    #[serde(default)]
    pub available_shortcuts: Vec<RosieSearchShortcut>,
    #[serde(default)]
    pub deterministic_context: Option<RosieSearchDeterministicContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RosieSearchIntentStatus {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RosieSearchIntentResponse {
    pub status: RosieSearchIntentStatus,
    pub shortcut_ids: Vec<String>,
}

pub fn unavailable_response() -> RosieSearchIntentResponse {
    RosieSearchIntentResponse {
        status: RosieSearchIntentStatus::Unavailable,
        shortcut_ids: vec![],
    }
}

pub fn validate_request(request: &RosieSearchIntentRequest) -> Result<(), String> {
    if request.query.trim().len() < 2 {
        return Err("query must be at least 2 characters".to_string());
    }
    if request.available_shortcuts.is_empty() {
        return Err("available_shortcuts is required".to_string());
    }
    if request
        .available_shortcuts
        .iter()
        .any(|shortcut| shortcut.id.trim().is_empty() || shortcut.label.trim().is_empty())
    {
        return Err("shortcut id and label are required".to_string());
    }
    Ok(())
}

pub fn build_completion_payload(request: &RosieSearchIntentRequest) -> Value {
    let system_prompt = [
        "You are ROSIE inside Riverside OS.",
        "Interpret the staff search phrase only against the provided allowlisted shortcuts.",
        "Do not generate SQL, filters, routes, query plans, business facts, navigation targets, or actions.",
        "Do not infer customer, product, transaction, inventory, fulfillment, accounting, or scheduling truth.",
        "Return JSON only with shortcut_ids.",
        "Return at most 3 shortcut_ids, and every id must exactly match an available shortcut id.",
        "Return an empty array when no allowlisted shortcut clearly matches.",
    ]
    .join(" ");
    let available_shortcuts = request
        .available_shortcuts
        .iter()
        .take(MAX_SHORTCUTS_IN_PROMPT)
        .map(|shortcut| {
            json!({
                "id": trim_text(&shortcut.id, 80),
                "label": trim_text(&shortcut.label, 80),
                "description": trim_text(&shortcut.description, 160),
            })
        })
        .collect::<Vec<_>>();

    json!({
        "model": "local",
        "temperature": 0.0,
        "max_tokens": 120,
        "stream": false,
        "messages": [
            {
                "role": "system",
                "content": system_prompt
            },
            {
                "role": "user",
                "content": format!(
                    "Search phrase: {}\nAvailable shortcuts JSON: {}\nDeterministic context JSON: {}\nReturn shape: {{\"shortcut_ids\":[\"allowed-shortcut-id\"]}}",
                    trim_text(&request.query, MAX_QUERY_CHARS),
                    Value::Array(available_shortcuts),
                    serde_json::to_value(&request.deterministic_context).unwrap_or(Value::Null)
                )
            }
        ]
    })
}

pub fn parse_completion_response(
    request: &RosieSearchIntentRequest,
    completion: &Value,
) -> RosieSearchIntentResponse {
    let Some(text) = extract_completion_text(completion) else {
        return unavailable_response();
    };
    let Some(payload) = extract_json_object(&text) else {
        return unavailable_response();
    };
    let valid_ids = request
        .available_shortcuts
        .iter()
        .map(|shortcut| shortcut.id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let shortcut_ids = payload
        .get("shortcut_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|id| valid_ids.contains(*id))
        .filter(|id| seen.insert((*id).to_string()))
        .take(MAX_SHORTCUTS)
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    if shortcut_ids.is_empty() {
        return unavailable_response();
    }

    RosieSearchIntentResponse {
        status: RosieSearchIntentStatus::Available,
        shortcut_ids,
    }
}

fn extract_completion_text(completion: &Value) -> Option<String> {
    for key in ["answer", "content", "response"] {
        if let Some(text) = completion.get(key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    let choices = completion.get("choices")?.as_array()?;
    for choice in choices {
        if let Some(text) = choice.get("text").and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
        if let Some(message) = choice.get("message") {
            if let Some(text) = message.get("content").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

fn extract_json_object(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok().or_else(|| {
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        if end <= start {
            return None;
        }
        serde_json::from_str::<Value>(&text[start..=end]).ok()
    })
}

fn trim_text(raw: &str, max_chars: usize) -> String {
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    normalized.chars().take(max_chars).collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> RosieSearchIntentRequest {
        RosieSearchIntentRequest {
            query: "where are open orders".to_string(),
            available_shortcuts: vec![
                RosieSearchShortcut {
                    id: "open_orders".to_string(),
                    label: "Open Orders".to_string(),
                    description: "Go to the open orders workspace.".to_string(),
                },
                RosieSearchShortcut {
                    id: "inventory_cleanup".to_string(),
                    label: "Inventory Cleanup".to_string(),
                    description: "Open inventory cleanup review.".to_string(),
                },
            ],
            deterministic_context: None,
        }
    }

    #[test]
    fn help_rosie_search_intent_validates_structured_allowlist() {
        let mut request = request();
        assert!(validate_request(&request).is_ok());
        request.available_shortcuts.clear();
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn help_rosie_search_intent_drops_unknown_ids_and_enforces_max_three() {
        let request = RosieSearchIntentRequest {
            available_shortcuts: vec![
                RosieSearchShortcut {
                    id: "open_orders".to_string(),
                    label: "Open Orders".to_string(),
                    description: "Go to the open orders workspace.".to_string(),
                },
                RosieSearchShortcut {
                    id: "inventory_cleanup".to_string(),
                    label: "Inventory Cleanup".to_string(),
                    description: "Open inventory cleanup review.".to_string(),
                },
                RosieSearchShortcut {
                    id: "alterations_queue".to_string(),
                    label: "Alterations Queue".to_string(),
                    description: "Open alterations queue.".to_string(),
                },
                RosieSearchShortcut {
                    id: "pickup_queue".to_string(),
                    label: "Pickup Queue".to_string(),
                    description: "Open pickup queue.".to_string(),
                },
            ],
            ..request()
        };
        let completion = json!({
            "choices": [{
                "message": {
                    "content": json!({
                        "shortcut_ids": [
                            "open_orders",
                            "unsupported",
                            "inventory_cleanup",
                            "alterations_queue",
                            "pickup_queue"
                        ]
                    }).to_string()
                }
            }]
        });

        let response = parse_completion_response(&request, &completion);

        assert_eq!(response.status, RosieSearchIntentStatus::Available);
        assert_eq!(
            response.shortcut_ids,
            vec!["open_orders", "inventory_cleanup", "alterations_queue"]
        );
    }

    #[test]
    fn help_rosie_search_intent_unavailable_when_no_allowed_match() {
        let completion = json!({
            "choices": [{
                "message": {
                    "content": json!({ "shortcut_ids": ["not_allowed"] }).to_string()
                }
            }]
        });

        let response = parse_completion_response(&request(), &completion);

        assert_eq!(response, unavailable_response());
    }
}
