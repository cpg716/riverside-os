use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_FACTS_PER_KIND: usize = 12;
const MAX_BULLETS: usize = 3;
const MAX_TEXT_CHARS: usize = 220;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RosieInsightSurface {
    CustomerSnapshot,
    TransactionReadiness,
    InventoryCleanup,
    CapacityOutlook,
    CounterpointStatus,
    DailyOperationalBriefing,
    ReceivingReview,
    ProductCleanupReview,
    FollowUpOpportunities,
    RegisterCloseReview,
    QboStagingReview,
    RmsChargeReview,
    WeddingReadinessReview,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RosieInsightMode {
    Summary,
    Explain,
    NextSteps,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RosieInsightFactBullet {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RosieInsightMetric {
    pub id: String,
    pub label: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RosieInsightFacts {
    pub title: String,
    #[serde(default)]
    pub bullets: Vec<RosieInsightFactBullet>,
    #[serde(default)]
    pub metrics: Vec<RosieInsightMetric>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub disclaimers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RosieInsightAllowedAction {
    pub id: String,
    pub label: String,
    pub target: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RosieInsightSummaryRequest {
    pub surface: RosieInsightSurface,
    pub mode: RosieInsightMode,
    pub facts: RosieInsightFacts,
    #[serde(default)]
    pub allowed_actions: Vec<RosieInsightAllowedAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RosieInsightBullet {
    pub text: String,
    pub source_fact_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RosieInsightSuggestedAction {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RosieInsightStatus {
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RosieInsightSummaryResponse {
    pub status: RosieInsightStatus,
    pub bullets: Vec<RosieInsightBullet>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub suggested_actions: Vec<RosieInsightSuggestedAction>,
}

impl RosieInsightSurface {
    fn label(self) -> &'static str {
        match self {
            Self::CustomerSnapshot => "Customer Snapshot",
            Self::TransactionReadiness => "Transaction Readiness Check",
            Self::InventoryCleanup => "Inventory Cleanup Review",
            Self::CapacityOutlook => "Capacity Outlook",
            Self::CounterpointStatus => "Counterpoint Status",
            Self::DailyOperationalBriefing => "Daily Operational Briefing",
            Self::ReceivingReview => "Receiving Review",
            Self::ProductCleanupReview => "Product Cleanup Review",
            Self::FollowUpOpportunities => "Follow-Up Opportunities",
            Self::RegisterCloseReview => "Register Close Review",
            Self::QboStagingReview => "QBO Staging Review",
            Self::RmsChargeReview => "RMS Charge Review",
            Self::WeddingReadinessReview => "Wedding Readiness Review",
        }
    }
}

impl RosieInsightMode {
    fn instruction(self) -> &'static str {
        match self {
            Self::Summary => "Summarize the provided facts.",
            Self::Explain => "Explain what the visible deterministic facts mean.",
            Self::NextSteps => {
                "Suggest next steps only when they are directly supported by provided allowed actions."
            }
        }
    }
}

pub fn unavailable_response() -> RosieInsightSummaryResponse {
    RosieInsightSummaryResponse {
        status: RosieInsightStatus::Unavailable,
        bullets: vec![],
        suggested_actions: vec![],
    }
}

pub fn validate_request(request: &RosieInsightSummaryRequest) -> Result<(), String> {
    if request.facts.title.trim().is_empty() {
        return Err("facts.title is required".to_string());
    }
    let has_facts = request
        .facts
        .bullets
        .iter()
        .any(|fact| !fact.label.trim().is_empty())
        || request
            .facts
            .metrics
            .iter()
            .any(|metric| !metric.label.trim().is_empty() && !metric.value.trim().is_empty())
        || request
            .facts
            .warnings
            .iter()
            .any(|warning| !warning.trim().is_empty());
    if !has_facts {
        return Err("at least one structured fact is required".to_string());
    }
    Ok(())
}

pub fn build_completion_payload(request: &RosieInsightSummaryRequest) -> Value {
    let system_prompt = [
        "You are ROSIE inside Riverside OS.",
        "Summarize only the provided structured facts.",
        "Do not invent customer, product, transaction, inventory, fulfillment, accounting, scheduling, or reconciliation facts.",
        "Do not make business decisions or calculate truth.",
        "Do not request SQL, raw tables, hidden tools, navigation, or mutations.",
        "Keep wording short and staff-facing.",
        "Return JSON only with bullets and optional suggested_actions.",
        "Return at most 3 bullets. Each bullet must be one short sentence.",
        "Every bullet must cite source_fact_ids from the provided fact ids when possible.",
    ]
    .join(" ");
    let facts = json!({
        "title": trim_text(&request.facts.title, 120),
        "bullets": request.facts.bullets.iter().take(MAX_FACTS_PER_KIND).map(|fact| {
            json!({
                "id": trim_text(&fact.id, 80),
                "label": trim_text(&fact.label, MAX_TEXT_CHARS),
                "severity": fact.severity.as_ref().map(|value| trim_text(value, 40)),
            })
        }).collect::<Vec<_>>(),
        "metrics": request.facts.metrics.iter().take(MAX_FACTS_PER_KIND).map(|metric| {
            json!({
                "id": trim_text(&metric.id, 80),
                "label": trim_text(&metric.label, 100),
                "value": trim_text(&metric.value, 100),
                "tone": metric.tone.as_ref().map(|value| trim_text(value, 40)),
            })
        }).collect::<Vec<_>>(),
        "warnings": request.facts.warnings.iter().take(MAX_FACTS_PER_KIND).map(|value| {
            trim_text(value, MAX_TEXT_CHARS)
        }).collect::<Vec<_>>(),
        "disclaimers": request.facts.disclaimers.iter().take(4).map(|value| {
            trim_text(value, MAX_TEXT_CHARS)
        }).collect::<Vec<_>>(),
    });
    let allowed_actions = request
        .allowed_actions
        .iter()
        .take(6)
        .map(|action| {
            json!({
                "id": trim_text(&action.id, 80),
                "label": trim_text(&action.label, 100),
            })
        })
        .collect::<Vec<_>>();

    json!({
        "model": "local",
        "temperature": 0.1,
        "max_tokens": 260,
        "stream": false,
        "messages": [
            {
                "role": "system",
                "content": system_prompt
            },
            {
                "role": "user",
                "content": format!(
                    "Surface: {}\nMode instruction: {}\nFacts JSON: {}\nAllowed actions JSON: {}\nReturn shape: {{\"bullets\":[{{\"text\":\"short sentence\",\"source_fact_ids\":[\"fact-id\"],\"tone\":\"info\"}}],\"suggested_actions\":[{{\"id\":\"allowed-action-id\",\"label\":\"allowed action label\"}}]}}",
                    request.surface.label(),
                    request.mode.instruction(),
                    facts,
                    Value::Array(allowed_actions)
                )
            }
        ]
    })
}

pub fn parse_completion_response(
    request: &RosieInsightSummaryRequest,
    completion: &Value,
) -> RosieInsightSummaryResponse {
    let Some(text) = extract_completion_text(completion) else {
        return unavailable_response();
    };
    let Some(payload) = extract_json_object(&text) else {
        return unavailable_response();
    };

    let valid_fact_ids = valid_fact_ids(request);
    let bullets = payload
        .get("bullets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| parse_bullet(value, &valid_fact_ids))
        .take(MAX_BULLETS)
        .collect::<Vec<_>>();

    if bullets.is_empty() {
        return unavailable_response();
    }

    let allowed_action_ids = request
        .allowed_actions
        .iter()
        .map(|action| (action.id.as_str(), action.label.as_str()))
        .collect::<Vec<_>>();
    let suggested_actions = payload
        .get("suggested_actions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| parse_action(value, &allowed_action_ids))
        .take(3)
        .collect::<Vec<_>>();

    RosieInsightSummaryResponse {
        status: RosieInsightStatus::Available,
        bullets,
        suggested_actions,
    }
}

fn parse_bullet(value: &Value, valid_fact_ids: &HashSet<String>) -> Option<RosieInsightBullet> {
    let text = value.get("text")?.as_str().map(|raw| trim_text(raw, 180))?;
    if text.is_empty() {
        return None;
    }
    let source_fact_ids = value
        .get("source_fact_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|id| id.trim().to_string())
        .filter(|id| valid_fact_ids.contains(id))
        .take(5)
        .collect::<Vec<_>>();
    let tone = value
        .get("tone")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "info" | "warning" | "success" | "neutral"));

    Some(RosieInsightBullet {
        text,
        source_fact_ids,
        tone,
    })
}

fn parse_action(
    value: &Value,
    allowed_action_ids: &[(&str, &str)],
) -> Option<RosieInsightSuggestedAction> {
    let id = value.get("id")?.as_str()?.trim();
    let (_, label) = allowed_action_ids
        .iter()
        .find(|(allowed_id, _)| *allowed_id == id)?;
    Some(RosieInsightSuggestedAction {
        id: id.to_string(),
        label: (*label).to_string(),
    })
}

fn valid_fact_ids(request: &RosieInsightSummaryRequest) -> HashSet<String> {
    let mut ids = HashSet::new();
    for fact in &request.facts.bullets {
        if !fact.id.trim().is_empty() {
            ids.insert(fact.id.trim().to_string());
        }
    }
    for metric in &request.facts.metrics {
        if !metric.id.trim().is_empty() {
            ids.insert(metric.id.trim().to_string());
        }
    }
    for index in 0..request.facts.warnings.len() {
        ids.insert(format!("warning-{index}"));
    }
    ids
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
        if let Some(text) = choice.get("content").and_then(Value::as_str) {
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

    fn request() -> RosieInsightSummaryRequest {
        RosieInsightSummaryRequest {
            surface: RosieInsightSurface::CustomerSnapshot,
            mode: RosieInsightMode::Summary,
            facts: RosieInsightFacts {
                title: "Customer Snapshot".to_string(),
                bullets: vec![
                    RosieInsightFactBullet {
                        id: "open-orders".to_string(),
                        label: "1 open order".to_string(),
                        severity: Some("info".to_string()),
                    },
                    RosieInsightFactBullet {
                        id: "balance".to_string(),
                        label: "Balance due $120.00".to_string(),
                        severity: Some("warning".to_string()),
                    },
                ],
                metrics: vec![],
                warnings: vec![],
                disclaimers: vec![],
            },
            allowed_actions: vec![RosieInsightAllowedAction {
                id: "open-profile".to_string(),
                label: "Open profile".to_string(),
                target: "profile".to_string(),
            }],
        }
    }

    #[test]
    fn help_rosie_insight_accepts_supported_phase_two_surfaces() {
        for surface in [
            "customer_snapshot",
            "transaction_readiness",
            "inventory_cleanup",
            "capacity_outlook",
            "counterpoint_status",
            "daily_operational_briefing",
            "receiving_review",
            "product_cleanup_review",
            "follow_up_opportunities",
        ] {
            let payload = json!({
                "surface": surface,
                "mode": "summary",
                "facts": { "title": "Supported", "bullets": [{ "id": "a", "label": "A" }] }
            });
            assert!(
                serde_json::from_value::<RosieInsightSummaryRequest>(payload).is_ok(),
                "{surface} should deserialize"
            );
        }
    }

    #[test]
    fn help_rosie_insight_validates_structured_facts_are_present() {
        let mut request = request();
        assert!(validate_request(&request).is_ok());
        request.facts.bullets.clear();
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn help_rosie_insight_unavailable_response_is_quiet() {
        let response = unavailable_response();
        assert_eq!(response.status, RosieInsightStatus::Unavailable);
        assert!(response.bullets.is_empty());
        assert!(response.suggested_actions.is_empty());
    }

    #[test]
    fn help_rosie_insight_parses_available_response_with_max_three_bullets_and_allowed_actions() {
        let request = request();
        let completion = json!({
            "choices": [{
                "message": {
                    "content": json!({
                        "bullets": [
                            { "text": "Open order is the main follow-up.", "source_fact_ids": ["open-orders"], "tone": "info" },
                            { "text": "Balance due should stay visible.", "source_fact_ids": ["balance"], "tone": "warning" },
                            { "text": "Use the existing snapshot before outreach.", "source_fact_ids": ["open-orders"], "tone": "neutral" },
                            { "text": "This fourth item should be dropped.", "source_fact_ids": ["balance"], "tone": "info" }
                        ],
                        "suggested_actions": [
                            { "id": "open-profile", "label": "Changed label ignored" },
                            { "id": "unsupported", "label": "Unsupported" }
                        ]
                    }).to_string()
                }
            }]
        });

        let response = parse_completion_response(&request, &completion);

        assert_eq!(response.status, RosieInsightStatus::Available);
        assert_eq!(response.bullets.len(), 3);
        assert_eq!(response.suggested_actions.len(), 1);
        assert_eq!(response.suggested_actions[0].label, "Open profile");
    }

    #[test]
    fn help_rosie_insight_unsupported_surface_or_mode_is_rejected_by_deserialization() {
        let unsupported_surface = json!({
            "surface": "suggested_searches",
            "mode": "summary",
            "facts": { "title": "Nope", "bullets": [{ "id": "a", "label": "A" }] }
        });
        assert!(serde_json::from_value::<RosieInsightSummaryRequest>(unsupported_surface).is_err());

        let unsupported_mode = json!({
            "surface": "customer_snapshot",
            "mode": "chat",
            "facts": { "title": "Nope", "bullets": [{ "id": "a", "label": "A" }] }
        });
        assert!(serde_json::from_value::<RosieInsightSummaryRequest>(unsupported_mode).is_err());
    }
}
