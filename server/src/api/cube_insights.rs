//! Native, governed conversational reporting backed by Cube Core.
//!
//! Gemma produces a constrained semantic report specification. ROS validates
//! every member, filter, limit, and visualization before Cube sees a query.
//! Neither the model nor the browser can submit SQL.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{NaiveDate, Utc};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::INSIGHTS_VIEW;
use crate::auth::pins::AuthenticatedStaff;
use crate::logic::insights_config::StoreInsightsConfig;
use crate::logic::rosie_provider_selection::{select_llm_provider, QueryType, RosieProviderConfig};
use crate::middleware::require_staff_with_permission;
use crate::models::DbStaffRole;

const DEFAULT_CUBE_UPSTREAM: &str = "http://127.0.0.1:4000";
const DEFAULT_MAX_ROWS: i64 = 500;
const MAX_QUESTION_BYTES: usize = 2_000;
const DEFAULT_MAX_REPORT_MEASURES: usize = 5;
const SALES_TAX_MAX_REPORT_MEASURES: usize = 6;

#[derive(Debug, Error)]
enum CubeInsightsError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Integrity(String),
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
}

impl IntoResponse for CubeInsightsError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Integrity(_) => StatusCode::CONFLICT,
            Self::Database(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(json!({ "error": self.to_string() }))).into_response()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReportVisualizationKind {
    Table,
    Bar,
    Line,
    Area,
    Pie,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReportVisualization {
    pub kind: ReportVisualizationKind,
    #[serde(default)]
    pub x_member: Option<String>,
    #[serde(default)]
    pub y_members: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReportTimeDimension {
    pub member: String,
    #[serde(default)]
    pub granularity: Option<String>,
    #[serde(default)]
    pub date_range: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReportFilter {
    pub member: String,
    pub operator: String,
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReportOrder {
    pub member: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CubeReportSpec {
    pub title: String,
    pub explanation: String,
    pub dataset: String,
    pub measures: Vec<String>,
    #[serde(default)]
    pub dimensions: Vec<String>,
    #[serde(default)]
    pub time_dimension: Option<ReportTimeDimension>,
    #[serde(default)]
    pub filters: Vec<ReportFilter>,
    #[serde(default)]
    pub order: Vec<ReportOrder>,
    #[serde(default = "default_report_limit")]
    pub limit: i64,
    pub visualization: ReportVisualization,
}

fn default_report_limit() -> i64 {
    100
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AskReportRequest {
    question: String,
    #[serde(default)]
    previous_spec: Option<CubeReportSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RunReportRequest {
    spec: CubeReportSpec,
    #[serde(default)]
    question: String,
    #[serde(default)]
    date_range: Option<Vec<String>>,
    #[serde(default)]
    history_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
struct ReportRunResponse {
    history_id: Uuid,
    question: String,
    spec: CubeReportSpec,
    rows: Vec<Map<String, Value>>,
    row_count: usize,
    member_labels: HashMap<String, String>,
    member_formats: HashMap<String, &'static str>,
    generated_at: String,
    engine: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveFavoriteRequest {
    name: String,
    #[serde(default)]
    question: String,
    spec: CubeReportSpec,
}

#[derive(Debug, Serialize, FromRow)]
struct SavedReportFavorite {
    id: Uuid,
    name: String,
    question: String,
    report_spec: Value,
    created_at: chrono::DateTime<Utc>,
    updated_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
struct ReportHistoryEntry {
    id: Uuid,
    question: String,
    title: String,
    report_spec: Value,
    row_count: i32,
    created_at: chrono::DateTime<Utc>,
    last_accessed_at: chrono::DateTime<Utc>,
    archived_at: Option<chrono::DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct ReportHistoryQuery {
    #[serde(default)]
    archived: bool,
}

#[derive(Debug, Serialize)]
struct CubeHealthResponse {
    status: &'static str,
    message: String,
    latency_ms: u64,
    configured: bool,
    cube_ready: bool,
    planner_ready: bool,
}

#[derive(Debug, Serialize)]
struct SemanticCatalogResponse {
    datasets: Vec<SemanticDatasetResponse>,
    max_rows: i64,
}

#[derive(Debug, Serialize)]
struct SemanticDatasetResponse {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    measures: Vec<SemanticMemberResponse>,
    dimensions: Vec<SemanticMemberResponse>,
    time_dimensions: Vec<SemanticMemberResponse>,
}

#[derive(Debug, Serialize)]
struct SemanticMemberResponse {
    name: &'static str,
    label: &'static str,
    format: &'static str,
}

#[derive(Clone, Copy)]
struct SemanticMember {
    name: &'static str,
    label: &'static str,
    format: &'static str,
    admin_only: bool,
}

#[derive(Clone, Copy)]
struct SemanticDataset {
    name: &'static str,
    title: &'static str,
    description: &'static str,
    measures: &'static [SemanticMember],
    dimensions: &'static [SemanticMember],
    time_dimensions: &'static [SemanticMember],
}

const fn member(name: &'static str, label: &'static str, format: &'static str) -> SemanticMember {
    SemanticMember {
        name,
        label,
        format,
        admin_only: false,
    }
}

const fn admin_member(
    name: &'static str,
    label: &'static str,
    format: &'static str,
) -> SemanticMember {
    SemanticMember {
        name,
        label,
        format,
        admin_only: true,
    }
}

const BOOKED_TRANSACTION_MEASURES: &[SemanticMember] = &[
    member(
        "booked_transactions.transaction_count",
        "Transactions",
        "number",
    ),
    member("booked_transactions.gross_sales", "Booked sales", "money"),
    member("booked_transactions.amount_paid", "Amount paid", "money"),
    member("booked_transactions.balance_due", "Balance due", "money"),
];
const BOOKED_TRANSACTION_DIMENSIONS: &[SemanticMember] = &[
    member("booked_transactions.status", "Transaction status", "text"),
    member("booked_transactions.sale_channel", "Sale channel", "text"),
    member(
        "booked_transactions.fulfillment_method",
        "Fulfillment method",
        "text",
    ),
    member("booked_transactions.customer_name", "Customer", "text"),
    member("booked_transactions.salesperson", "Salesperson", "text"),
    member("booked_transactions.operator", "Operator", "text"),
];
const BOOKED_TRANSACTION_TIMES: &[SemanticMember] = &[member(
    "booked_transactions.business_date",
    "Booked business date",
    "date",
)];

const RECOGNIZED_TRANSACTION_MEASURES: &[SemanticMember] = &[
    member(
        "recognized_transactions.transaction_count",
        "Transactions",
        "number",
    ),
    member(
        "recognized_transactions.recognized_sales",
        "Recognized sales",
        "money",
    ),
    member(
        "recognized_transactions.amount_paid",
        "Amount paid",
        "money",
    ),
    member(
        "recognized_transactions.balance_due",
        "Balance due",
        "money",
    ),
];
const RECOGNIZED_TRANSACTION_DIMENSIONS: &[SemanticMember] = &[
    member(
        "recognized_transactions.status",
        "Transaction status",
        "text",
    ),
    member(
        "recognized_transactions.sale_channel",
        "Sale channel",
        "text",
    ),
    member(
        "recognized_transactions.fulfillment_method",
        "Fulfillment method",
        "text",
    ),
    member("recognized_transactions.customer_name", "Customer", "text"),
    member("recognized_transactions.salesperson", "Salesperson", "text"),
    member("recognized_transactions.operator", "Operator", "text"),
];
const RECOGNIZED_TRANSACTION_TIMES: &[SemanticMember] = &[member(
    "recognized_transactions.business_date",
    "Recognition business date",
    "date",
)];

const BOOKED_ITEM_MEASURES: &[SemanticMember] = &[
    member("booked_items.line_count", "Lines", "number"),
    member("booked_items.units", "Units", "number"),
    member("booked_items.gross_sales", "Booked sales", "money"),
    admin_member("booked_items.cost", "Cost", "money"),
    admin_member("booked_items.gross_margin", "Gross margin", "money"),
];
const RECOGNIZED_ITEM_MEASURES: &[SemanticMember] = &[
    member("recognized_items.line_count", "Lines", "number"),
    member("recognized_items.units", "Units", "number"),
    member(
        "recognized_items.recognized_sales",
        "Recognized sales",
        "money",
    ),
    admin_member("recognized_items.cost", "Cost", "money"),
    admin_member("recognized_items.gross_margin", "Gross margin", "money"),
];
const BOOKED_ITEM_DIMENSIONS: &[SemanticMember] = &[
    member("booked_items.item", "Item", "text"),
    member("booked_items.product", "Product", "text"),
    member("booked_items.variation", "Variation", "text"),
    member("booked_items.sku", "SKU", "text"),
    member("booked_items.category", "Category", "text"),
    member("booked_items.vendor", "Vendor", "text"),
    member("booked_items.salesperson", "Salesperson", "text"),
    member("booked_items.fulfillment_type", "Fulfillment type", "text"),
];
const RECOGNIZED_ITEM_DIMENSIONS: &[SemanticMember] = &[
    member("recognized_items.item", "Item", "text"),
    member("recognized_items.product", "Product", "text"),
    member("recognized_items.variation", "Variation", "text"),
    member("recognized_items.sku", "SKU", "text"),
    member("recognized_items.category", "Category", "text"),
    member("recognized_items.vendor", "Vendor", "text"),
    member("recognized_items.salesperson", "Salesperson", "text"),
    member(
        "recognized_items.fulfillment_type",
        "Fulfillment type",
        "text",
    ),
];
const BOOKED_ITEM_TIMES: &[SemanticMember] = &[member(
    "booked_items.business_date",
    "Booked business date",
    "date",
)];
const RECOGNIZED_ITEM_TIMES: &[SemanticMember] = &[member(
    "recognized_items.business_date",
    "Recognition business date",
    "date",
)];

const SALES_TAX_MEASURES: &[SemanticMember] = &[
    member("sales_tax.gross_sales", "Gross sales", "money"),
    member("sales_tax.taxable_sales", "Taxable sales", "money"),
    member("sales_tax.nontaxable_sales", "Nontaxable sales", "money"),
    member("sales_tax.state_tax", "New York State tax", "money"),
    member("sales_tax.local_tax", "Erie County local tax", "money"),
    member(
        "sales_tax.total_tax_collected",
        "Total tax collected",
        "money",
    ),
];
const SALES_TAX_DIMENSIONS: &[SemanticMember] = &[
    member("sales_tax.event_kind", "Tax event", "text"),
    member("sales_tax.fulfillment_type", "Fulfillment type", "text"),
    member("sales_tax.amount_basis", "Saved amount basis", "text"),
];
const SALES_TAX_TIMES: &[SemanticMember] = &[member(
    "sales_tax.business_date",
    "Tax reporting business date",
    "date",
)];

const FULFILLMENT_MEASURES: &[SemanticMember] = &[member(
    "fulfillment_orders.fulfillment_order_count",
    "Fulfillment Orders",
    "number",
)];
const FULFILLMENT_DIMENSIONS: &[SemanticMember] = &[
    member("fulfillment_orders.status", "Status", "text"),
    member("fulfillment_orders.customer_name", "Customer", "text"),
    member("fulfillment_orders.wedding_party", "Wedding party", "text"),
];
const FULFILLMENT_TIMES: &[SemanticMember] = &[
    member("fulfillment_orders.created_date", "Created date", "date"),
    member(
        "fulfillment_orders.fulfilled_date",
        "Fulfilled date",
        "date",
    ),
];

const WEDDING_MEASURES: &[SemanticMember] = &[
    member("weddings.wedding_count", "Weddings", "number"),
    member("weddings.member_count", "Members", "number"),
    member("weddings.transaction_count", "Transactions", "number"),
    member("weddings.booked_sales", "Booked sales", "money"),
    admin_member("weddings.cost", "Cost", "money"),
    admin_member("weddings.profit", "Profit", "money"),
];
const WEDDING_DIMENSIONS: &[SemanticMember] = &[
    member("weddings.wedding_party", "Wedding party", "text"),
    member("weddings.groom", "Groom", "text"),
    member("weddings.bride", "Bride", "text"),
    member("weddings.salesperson", "Salesperson", "text"),
];
const WEDDING_TIMES: &[SemanticMember] = &[member("weddings.event_date", "Event date", "date")];

const PAYMENT_MEASURES: &[SemanticMember] = &[
    member("payments.payment_count", "Payments", "number"),
    member("payments.gross_amount", "Gross amount", "money"),
    admin_member("payments.merchant_fees", "Merchant fees", "money"),
    member("payments.net_amount", "Net amount", "money"),
];
const PAYMENT_DIMENSIONS: &[SemanticMember] = &[
    member("payments.category", "Category", "text"),
    member("payments.status", "Status", "text"),
    member("payments.payment_method", "Payment method", "text"),
    member("payments.provider", "Provider", "text"),
    member("payments.card_brand", "Card brand", "text"),
    member("payments.payer_name", "Payer", "text"),
];
const PAYMENT_TIMES: &[SemanticMember] =
    &[member("payments.business_date", "Business date", "date")];

const INVENTORY_MEASURES: &[SemanticMember] = &[
    member("inventory.variation_count", "Variations", "number"),
    member("inventory.stock_on_hand", "Stock on hand", "number"),
    member("inventory.reserved_stock", "Reserved stock", "number"),
    member("inventory.on_layaway", "On layaway", "number"),
    member("inventory.available_stock", "Available stock", "number"),
    admin_member(
        "inventory.inventory_cost_value",
        "Inventory cost value",
        "money",
    ),
];
const INVENTORY_DIMENSIONS: &[SemanticMember] = &[
    member("inventory.item", "Item", "text"),
    member("inventory.product", "Product", "text"),
    member("inventory.brand", "Brand", "text"),
    member("inventory.sku", "SKU", "text"),
    member("inventory.category", "Category", "text"),
    member("inventory.vendor", "Vendor", "text"),
    member("inventory.active", "Active", "boolean"),
    member(
        "inventory.low_stock_threshold",
        "Low-stock threshold",
        "number",
    ),
    member("inventory.retail_price", "Retail price", "money"),
    admin_member("inventory.unit_cost", "Unit cost", "money"),
];
const INVENTORY_TIMES: &[SemanticMember] =
    &[member("inventory.created_date", "Created date", "date")];

const LOYALTY_MEASURES: &[SemanticMember] = &[
    member("loyalty_customers.customer_count", "Customers", "number"),
    member(
        "loyalty_customers.current_points",
        "Current points",
        "points",
    ),
    member(
        "loyalty_customers.lifetime_points_earned",
        "Lifetime points earned",
        "points",
    ),
    member(
        "loyalty_customers.lifetime_points_redeemed",
        "Lifetime points redeemed",
        "points",
    ),
    member(
        "loyalty_customers.reward_dollars_issued",
        "Reward dollars issued",
        "money",
    ),
];
const LOYALTY_DIMENSIONS: &[SemanticMember] = &[
    member("loyalty_customers.customer_name", "Customer", "text"),
    member("loyalty_customers.customer_code", "Customer code", "text"),
];

const ALTERATION_MEASURES: &[SemanticMember] = &[member(
    "alterations.alteration_count",
    "Alterations",
    "number",
)];
const ALTERATION_DIMENSIONS: &[SemanticMember] = &[
    member("alterations.status", "Status", "text"),
    member("alterations.overdue", "Overdue", "boolean"),
    member("alterations.customer_name", "Customer", "text"),
];
const ALTERATION_TIMES: &[SemanticMember] = &[
    member("alterations.due_date", "Due date", "date"),
    member("alterations.created_date", "Created date", "date"),
];

const SHIPMENT_MEASURES: &[SemanticMember] = &[
    member("shipments.shipment_count", "Shipments", "number"),
    member("shipments.shipping_charged", "Shipping charged", "money"),
    member("shipments.quoted_amount", "Quoted amount", "money"),
    admin_member("shipments.label_cost", "Label cost", "money"),
];
const SHIPMENT_DIMENSIONS: &[SemanticMember] = &[
    member("shipments.status", "Status", "text"),
    member("shipments.source", "Source", "text"),
    member("shipments.carrier", "Carrier", "text"),
    member("shipments.service", "Service", "text"),
    member("shipments.customer_name", "Customer", "text"),
];
const SHIPMENT_TIMES: &[SemanticMember] =
    &[member("shipments.created_date", "Created date", "date")];

const WEATHER_MEASURES: &[SemanticMember] = &[
    member("daily_sales_weather.sales", "Booked sales", "money"),
    member(
        "daily_sales_weather.tax_collected",
        "Tax collected",
        "money",
    ),
    member(
        "daily_sales_weather.transaction_count",
        "Transactions",
        "number",
    ),
    member("daily_sales_weather.units", "Units", "number"),
    member(
        "daily_sales_weather.precipitation_inches",
        "Precipitation inches",
        "number",
    ),
];
const WEATHER_DIMENSIONS: &[SemanticMember] = &[
    member("daily_sales_weather.condition", "Weather condition", "text"),
    member(
        "daily_sales_weather.weather_source",
        "Weather source",
        "text",
    ),
];
const WEATHER_TIMES: &[SemanticMember] = &[member(
    "daily_sales_weather.business_date",
    "Business date",
    "date",
)];

const DATASETS: &[SemanticDataset] = &[
    SemanticDataset {
        name: "booked_transactions",
        title: "Booked Transactions",
        description:
            "Demand and cash activity by governed booking date. This is not recognized revenue.",
        measures: BOOKED_TRANSACTION_MEASURES,
        dimensions: BOOKED_TRANSACTION_DIMENSIONS,
        time_dimensions: BOOKED_TRANSACTION_TIMES,
    },
    SemanticDataset {
        name: "recognized_transactions",
        title: "Recognized Transactions",
        description: "Revenue grouped by fulfillment or pickup recognition date.",
        measures: RECOGNIZED_TRANSACTION_MEASURES,
        dimensions: RECOGNIZED_TRANSACTION_DIMENSIONS,
        time_dimensions: RECOGNIZED_TRANSACTION_TIMES,
    },
    SemanticDataset {
        name: "booked_items",
        title: "Booked Item Sales",
        description: "Item demand grouped by transaction booking date.",
        measures: BOOKED_ITEM_MEASURES,
        dimensions: BOOKED_ITEM_DIMENSIONS,
        time_dimensions: BOOKED_ITEM_TIMES,
    },
    SemanticDataset {
        name: "recognized_items",
        title: "Recognized Item Sales",
        description: "Item revenue grouped by fulfillment or pickup recognition date.",
        measures: RECOGNIZED_ITEM_MEASURES,
        dimensions: RECOGNIZED_ITEM_DIMENSIONS,
        time_dimensions: RECOGNIZED_ITEM_TIMES,
    },
    SemanticDataset {
        name: "sales_tax",
        title: "New York Sales Tax",
        description: "Reconciled paid Completed/Fulfilled sales-tax data using saved transaction and settled refund or exchange amounts. This dataset never applies a source cutoff, runs the tax engine, reads current catalog classifications, or uses Z-close snapshots.",
        measures: SALES_TAX_MEASURES,
        dimensions: SALES_TAX_DIMENSIONS,
        time_dimensions: SALES_TAX_TIMES,
    },
    SemanticDataset {
        name: "fulfillment_orders",
        title: "Fulfillment Orders",
        description: "Logistical Fulfillment Orders, never the financial Transaction ledger.",
        measures: FULFILLMENT_MEASURES,
        dimensions: FULFILLMENT_DIMENSIONS,
        time_dimensions: FULFILLMENT_TIMES,
    },
    SemanticDataset {
        name: "weddings",
        title: "Wedding Program",
        description: "Wedding party membership, Transactions, and economics.",
        measures: WEDDING_MEASURES,
        dimensions: WEDDING_DIMENSIONS,
        time_dimensions: WEDDING_TIMES,
    },
    SemanticDataset {
        name: "payments",
        title: "Payment Ledger",
        description: "Tender and merchant activity by governed payment business date.",
        measures: PAYMENT_MEASURES,
        dimensions: PAYMENT_DIMENSIONS,
        time_dimensions: PAYMENT_TIMES,
    },
    SemanticDataset {
        name: "inventory",
        title: "Inventory Snapshot",
        description: "Current stock, reservations, layaway units, availability, and value.",
        measures: INVENTORY_MEASURES,
        dimensions: INVENTORY_DIMENSIONS,
        time_dimensions: INVENTORY_TIMES,
    },
    SemanticDataset {
        name: "loyalty_customers",
        title: "Customer Loyalty",
        description: "Current and lifetime loyalty activity by customer.",
        measures: LOYALTY_MEASURES,
        dimensions: LOYALTY_DIMENSIONS,
        time_dimensions: &[],
    },
    SemanticDataset {
        name: "alterations",
        title: "Active Alterations",
        description: "Active alteration workload, due dates, and overdue status.",
        measures: ALTERATION_MEASURES,
        dimensions: ALTERATION_DIMENSIONS,
        time_dimensions: ALTERATION_TIMES,
    },
    SemanticDataset {
        name: "shipments",
        title: "Active Shipments",
        description: "Active shipment volume, carriers, services, and economics.",
        measures: SHIPMENT_MEASURES,
        dimensions: SHIPMENT_DIMENSIONS,
        time_dimensions: SHIPMENT_TIMES,
    },
    SemanticDataset {
        name: "daily_sales_weather",
        title: "Daily Sales and Weather",
        description: "Booked daily sales aligned with captured weather conditions.",
        measures: WEATHER_MEASURES,
        dimensions: WEATHER_DIMENSIONS,
        time_dimensions: WEATHER_TIMES,
    },
];

fn is_admin(staff: &AuthenticatedStaff) -> bool {
    matches!(staff.role, DbStaffRole::Admin)
}

fn dataset_for(name: &str) -> Option<&'static SemanticDataset> {
    DATASETS.iter().find(|dataset| dataset.name == name)
}

fn visible_members(
    members: &'static [SemanticMember],
    admin: bool,
) -> impl Iterator<Item = &'static SemanticMember> {
    members
        .iter()
        .filter(move |member| admin || !member.admin_only)
}

fn member_lookup(admin: bool) -> HashMap<&'static str, &'static SemanticMember> {
    DATASETS
        .iter()
        .flat_map(|dataset| {
            dataset
                .measures
                .iter()
                .chain(dataset.dimensions)
                .chain(dataset.time_dimensions)
        })
        .filter(move |member| admin || !member.admin_only)
        .map(|member| (member.name, member))
        .collect()
}

fn semantic_catalog(admin: bool, max_rows: i64) -> SemanticCatalogResponse {
    SemanticCatalogResponse {
        datasets: DATASETS
            .iter()
            .map(|dataset| SemanticDatasetResponse {
                name: dataset.name,
                title: dataset.title,
                description: dataset.description,
                measures: visible_members(dataset.measures, admin)
                    .map(member_response)
                    .collect(),
                dimensions: visible_members(dataset.dimensions, admin)
                    .map(member_response)
                    .collect(),
                time_dimensions: visible_members(dataset.time_dimensions, admin)
                    .map(member_response)
                    .collect(),
            })
            .collect(),
        max_rows,
    }
}

fn member_response(member: &SemanticMember) -> SemanticMemberResponse {
    SemanticMemberResponse {
        name: member.name,
        label: member.label,
        format: member.format,
    }
}

async fn require_insights_staff(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthenticatedStaff, CubeInsightsError> {
    require_staff_with_permission(state, headers, INSIGHTS_VIEW)
        .await
        .map_err(|(status, _)| {
            if status == StatusCode::FORBIDDEN {
                CubeInsightsError::Forbidden("insights.view permission required".to_string())
            } else {
                CubeInsightsError::Unauthorized("staff authentication required".to_string())
            }
        })
}

async fn load_insights_config(state: &AppState) -> StoreInsightsConfig {
    let raw =
        sqlx::query_scalar::<_, Value>("SELECT insights_config FROM store_settings WHERE id = 1")
            .fetch_optional(&state.db)
            .await;
    match raw {
        Ok(Some(value)) => StoreInsightsConfig::from_json_value(value),
        Ok(None) => StoreInsightsConfig::default(),
        Err(error) => {
            tracing::warn!(error = %error, "could not load Insights policy; using safe defaults");
            StoreInsightsConfig::default()
        }
    }
}

fn validate_date_range(date_range: &[String]) -> Result<(), CubeInsightsError> {
    if date_range.len() != 2 {
        return Err(CubeInsightsError::BadRequest(
            "date_range must contain an inclusive from and to date".to_string(),
        ));
    }
    let from = NaiveDate::parse_from_str(&date_range[0], "%Y-%m-%d")
        .map_err(|_| CubeInsightsError::BadRequest("from date must be YYYY-MM-DD".to_string()))?;
    let to = NaiveDate::parse_from_str(&date_range[1], "%Y-%m-%d")
        .map_err(|_| CubeInsightsError::BadRequest("to date must be YYYY-MM-DD".to_string()))?;
    if from > to {
        return Err(CubeInsightsError::BadRequest(
            "from date must not be after to date".to_string(),
        ));
    }
    Ok(())
}

fn validate_report_spec(
    spec: &mut CubeReportSpec,
    admin: bool,
    max_rows: i64,
) -> Result<(), CubeInsightsError> {
    spec.title = spec.title.trim().to_string();
    spec.explanation = spec.explanation.trim().to_string();
    if spec.title.is_empty() || spec.title.len() > 160 {
        return Err(CubeInsightsError::BadRequest(
            "report title must be 1-160 characters".to_string(),
        ));
    }
    if spec.explanation.is_empty() || spec.explanation.len() > 1_000 {
        return Err(CubeInsightsError::BadRequest(
            "report explanation must be 1-1000 characters".to_string(),
        ));
    }
    let dataset = dataset_for(&spec.dataset).ok_or_else(|| {
        CubeInsightsError::BadRequest("report dataset is not approved".to_string())
    })?;
    let visible_measure_names = visible_members(dataset.measures, admin)
        .map(|member| member.name)
        .collect::<HashSet<_>>();
    let visible_dimension_names = visible_members(dataset.dimensions, admin)
        .map(|member| member.name)
        .collect::<HashSet<_>>();
    let visible_time_names = visible_members(dataset.time_dimensions, admin)
        .map(|member| member.name)
        .collect::<HashSet<_>>();

    let max_measures = if spec.dataset == "sales_tax" {
        SALES_TAX_MAX_REPORT_MEASURES
    } else {
        DEFAULT_MAX_REPORT_MEASURES
    };
    if spec.measures.is_empty() || spec.measures.len() > max_measures {
        return Err(CubeInsightsError::BadRequest(format!(
            "a report must contain 1-{max_measures} approved measures"
        )));
    }
    if spec
        .measures
        .iter()
        .any(|name| !visible_measure_names.contains(name.as_str()))
    {
        return Err(CubeInsightsError::Forbidden(
            "report includes a measure outside this dataset or staff access level".to_string(),
        ));
    }
    if spec.dimensions.len() > 4
        || spec
            .dimensions
            .iter()
            .any(|name| !visible_dimension_names.contains(name.as_str()))
    {
        return Err(CubeInsightsError::BadRequest(
            "report dimensions are not approved for this dataset".to_string(),
        ));
    }
    if let Some(time) = &spec.time_dimension {
        if !visible_time_names.contains(time.member.as_str()) {
            return Err(CubeInsightsError::BadRequest(
                "time dimension is not approved for this dataset".to_string(),
            ));
        }
        if let Some(granularity) = &time.granularity {
            if !matches!(
                granularity.as_str(),
                "day" | "week" | "month" | "quarter" | "year"
            ) {
                return Err(CubeInsightsError::BadRequest(
                    "time granularity must be day, week, month, quarter, or year".to_string(),
                ));
            }
        }
        if let Some(date_range) = &time.date_range {
            validate_date_range(date_range)?;
        }
    }
    if spec.filters.len() > 6 {
        return Err(CubeInsightsError::BadRequest(
            "a report may contain at most 6 filters".to_string(),
        ));
    }
    let filterable = visible_dimension_names
        .iter()
        .copied()
        .chain(visible_time_names.iter().copied())
        .collect::<HashSet<_>>();
    for filter in &spec.filters {
        if !filterable.contains(filter.member.as_str()) {
            return Err(CubeInsightsError::BadRequest(
                "report filter member is not approved for this dataset".to_string(),
            ));
        }
        if !matches!(
            filter.operator.as_str(),
            "equals"
                | "notEquals"
                | "contains"
                | "notContains"
                | "gt"
                | "gte"
                | "lt"
                | "lte"
                | "set"
                | "notSet"
        ) {
            return Err(CubeInsightsError::BadRequest(
                "report filter operator is not approved".to_string(),
            ));
        }
        let no_values = matches!(filter.operator.as_str(), "set" | "notSet");
        if (!no_values && filter.values.is_empty())
            || filter.values.len() > 20
            || filter.values.iter().any(|value| value.len() > 200)
        {
            return Err(CubeInsightsError::BadRequest(
                "report filter values are invalid".to_string(),
            ));
        }
    }

    spec.limit = spec.limit.clamp(1, max_rows.max(1));
    let selected = spec
        .measures
        .iter()
        .chain(spec.dimensions.iter())
        .map(String::as_str)
        .chain(
            spec.time_dimension
                .as_ref()
                .map(|time| time.member.as_str()),
        )
        .collect::<HashSet<_>>();
    if spec.order.len() > 3
        || spec.order.iter().any(|order| {
            !selected.contains(order.member.as_str())
                || !matches!(order.direction.as_str(), "asc" | "desc")
        })
    {
        return Err(CubeInsightsError::BadRequest(
            "report ordering must use selected members and asc or desc".to_string(),
        ));
    }
    if let Some(x_member) = &spec.visualization.x_member {
        if !selected.contains(x_member.as_str()) || spec.measures.contains(x_member) {
            return Err(CubeInsightsError::BadRequest(
                "chart x_member must be a selected dimension".to_string(),
            ));
        }
    }
    if spec
        .visualization
        .y_members
        .iter()
        .any(|member| !spec.measures.contains(member))
    {
        return Err(CubeInsightsError::BadRequest(
            "chart y_members must be selected measures".to_string(),
        ));
    }
    if spec.visualization.kind != ReportVisualizationKind::Table
        && (spec.visualization.x_member.is_none() || spec.visualization.y_members.is_empty())
    {
        spec.visualization.kind = ReportVisualizationKind::Table;
        spec.visualization.x_member = None;
        spec.visualization.y_members.clear();
    }
    Ok(())
}

fn planner_schema(admin: bool, max_rows: i64) -> Value {
    let member_lookup = member_lookup(admin);
    let datasets = DATASETS
        .iter()
        .map(|dataset| dataset.name)
        .collect::<Vec<_>>();
    let measures = DATASETS
        .iter()
        .flat_map(|dataset| visible_members(dataset.measures, admin))
        .map(|member| member.name)
        .collect::<Vec<_>>();
    let dimensions = DATASETS
        .iter()
        .flat_map(|dataset| visible_members(dataset.dimensions, admin))
        .map(|member| member.name)
        .collect::<Vec<_>>();
    let time_dimensions = DATASETS
        .iter()
        .flat_map(|dataset| visible_members(dataset.time_dimensions, admin))
        .map(|member| member.name)
        .collect::<Vec<_>>();
    let chart_dimensions = dimensions
        .iter()
        .chain(time_dimensions.iter())
        .copied()
        .collect::<Vec<_>>();
    let all_members = member_lookup.keys().copied().collect::<Vec<_>>();
    json!({
        "type": "function",
        "function": {
            "name": "build_insights_report",
            "description": "Build one governed Riverside OS semantic report. Never use SQL.",
            "parameters": {
                "type": "object",
                "additionalProperties": false,
                "required": ["title", "explanation", "dataset", "measures", "dimensions", "filters", "order", "limit", "visualization"],
                "properties": {
                    "title": { "type": "string" },
                    "explanation": { "type": "string" },
                    "dataset": { "type": "string", "enum": datasets },
                    "measures": { "type": "array", "minItems": 1, "maxItems": SALES_TAX_MAX_REPORT_MEASURES, "items": { "type": "string", "enum": measures } },
                    "dimensions": { "type": "array", "maxItems": 4, "items": { "type": "string", "enum": dimensions } },
                    "time_dimension": {
                        "anyOf": [
                            { "type": "null" },
                            {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["member"],
                                "properties": {
                                    "member": { "type": "string", "enum": time_dimensions },
                                    "granularity": { "type": ["string", "null"], "enum": ["day", "week", "month", "quarter", "year", null] },
                                    "date_range": { "type": ["array", "null"], "minItems": 2, "maxItems": 2, "items": { "type": "string" } }
                                }
                            }
                        ]
                    },
                    "filters": {
                        "type": "array",
                        "maxItems": 6,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["member", "operator", "values"],
                            "properties": {
                                "member": { "type": "string", "enum": dimensions },
                                "operator": { "type": "string", "enum": ["equals", "notEquals", "contains", "notContains", "gt", "gte", "lt", "lte", "set", "notSet"] },
                                "values": { "type": "array", "maxItems": 20, "items": { "type": "string" } }
                            }
                        }
                    },
                    "order": {
                        "type": "array",
                        "maxItems": 3,
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["member", "direction"],
                            "properties": {
                                "member": { "type": "string", "enum": all_members },
                                "direction": { "type": "string", "enum": ["asc", "desc"] }
                            }
                        }
                    },
                    "limit": { "type": "integer", "minimum": 1, "maximum": max_rows },
                    "visualization": {
                        "type": "object",
                        "additionalProperties": false,
                        "required": ["kind", "x_member", "y_members"],
                        "properties": {
                            "kind": { "type": "string", "enum": ["table", "bar", "line", "area", "pie"] },
                            "x_member": { "type": ["string", "null"], "enum": chart_dimensions.into_iter().map(Value::from).chain(std::iter::once(Value::Null)).collect::<Vec<_>>() },
                            "y_members": { "type": "array", "maxItems": 3, "items": { "type": "string", "enum": measures } }
                        }
                    }
                }
            }
        }
    })
}

fn planner_prompt(previous_spec: Option<&CubeReportSpec>) -> String {
    let previous = previous_spec
        .and_then(|spec| serde_json::to_string(spec).ok())
        .unwrap_or_else(|| "none".to_string());
    format!(
        "You are the Riverside OS report planner. Build exactly one report by calling build_insights_report. The tool schema is the complete approved catalog; never invent datasets or members. Today is {}. Use one dataset and members belonging to it. Booked means checkout demand/activity; recognized means fulfillment or pickup and requires a recognized dataset. Financial Transactions and logistical Fulfillment Orders are distinct. Use ISO YYYY-MM-DD dates. Prefer a chart for trends or comparisons and a table for detailed lists. For a requested change, revise the prior report. Explain the business basis and grouping plainly. Prior report: {}.",
        Utc::now().date_naive(),
        previous
    )
}

fn parse_planner_completion(completion: &Value) -> Result<CubeReportSpec, CubeInsightsError> {
    if let Some(call) = completion
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
        .and_then(|calls| calls.first())
    {
        if call.pointer("/function/name").and_then(Value::as_str) != Some("build_insights_report") {
            return Err(CubeInsightsError::Unavailable(
                "ROSIE returned an unsupported report action".to_string(),
            ));
        }
        let arguments = call
            .pointer("/function/arguments")
            .ok_or_else(|| {
                CubeInsightsError::Unavailable("ROSIE did not return report parameters".to_string())
            })?
            .clone();
        return if let Some(raw) = arguments.as_str() {
            serde_json::from_str(raw).map_err(|error| {
                CubeInsightsError::Unavailable(format!("ROSIE report plan was invalid: {error}"))
            })
        } else {
            serde_json::from_value(arguments).map_err(|error| {
                CubeInsightsError::Unavailable(format!("ROSIE report plan was invalid: {error}"))
            })
        };
    }

    let content = completion
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(content).map_err(|_| {
        CubeInsightsError::Unavailable(
            "ROSIE could not produce a valid governed report specification".to_string(),
        )
    })
}

async fn plan_report(
    question: &str,
    previous_spec: Option<&CubeReportSpec>,
    admin: bool,
    max_rows: i64,
) -> Result<CubeReportSpec, CubeInsightsError> {
    let provider = select_llm_provider(&RosieProviderConfig::default(), QueryType::Sensitive)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "ROSIE report planner unavailable");
            CubeInsightsError::Unavailable(
                "ROSIE reporting is unavailable on this Main Hub".to_string(),
            )
        })?;
    let payload = json!({
        "model": "local",
        "temperature": 0.0,
        "max_tokens": 1400,
        "messages": [
            { "role": "system", "content": planner_prompt(previous_spec) },
            { "role": "user", "content": question }
        ],
        "tools": [planner_schema(admin, max_rows)],
        "tool_choice": { "type": "function", "function": { "name": "build_insights_report" } },
        "parallel_tool_calls": false,
        "stream": false,
        "reasoning": false,
        "chat_template_kwargs": { "enable_thinking": false }
    });
    let completion = provider
        .chat_completion_payload(payload)
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "ROSIE report planning failed");
            CubeInsightsError::Unavailable("ROSIE could not plan this report right now".to_string())
        })?;
    let mut spec = parse_planner_completion(&completion)?;
    validate_report_spec(&mut spec, admin, max_rows)?;
    Ok(spec)
}

fn cube_upstream() -> String {
    std::env::var("RIVERSIDE_CUBE_UPSTREAM")
        .unwrap_or_else(|_| DEFAULT_CUBE_UPSTREAM.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn cube_secret() -> Result<String, CubeInsightsError> {
    let secret = std::env::var("RIVERSIDE_CUBE_API_SECRET")
        .or_else(|_| std::env::var("CUBEJS_API_SECRET"))
        .unwrap_or_default();
    if secret.trim().len() < 32 {
        return Err(CubeInsightsError::Unavailable(
            "Cube Core API secret is not configured on this Main Hub".to_string(),
        ));
    }
    Ok(secret)
}

#[derive(Serialize)]
struct CubeJwtClaims {
    sub: String,
    role: String,
    groups: Vec<String>,
    iat: i64,
    exp: i64,
}

fn cube_token(staff: &AuthenticatedStaff, secret: &str) -> Result<String, CubeInsightsError> {
    let now = Utc::now().timestamp();
    let role = format!("{:?}", staff.role).to_ascii_lowercase();
    encode(
        &Header::new(Algorithm::HS256),
        &CubeJwtClaims {
            sub: staff.id.to_string(),
            role: role.clone(),
            groups: vec![role],
            iat: now,
            exp: now + 300,
        },
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|error| {
        tracing::error!(error = %error, "could not sign Cube Core request");
        CubeInsightsError::Unavailable("Could not authorize the reporting engine".to_string())
    })
}

fn cube_query(spec: &CubeReportSpec) -> Value {
    let time_dimensions = spec
        .time_dimension
        .as_ref()
        .map(|time| {
            vec![json!({
                "dimension": time.member,
                "granularity": time.granularity,
                "dateRange": time.date_range,
            })]
        })
        .unwrap_or_default();
    let filters = spec
        .filters
        .iter()
        .map(|filter| {
            if matches!(filter.operator.as_str(), "set" | "notSet") {
                json!({ "member": filter.member, "operator": filter.operator })
            } else {
                json!({
                    "member": filter.member,
                    "operator": filter.operator,
                    "values": filter.values,
                })
            }
        })
        .collect::<Vec<_>>();
    let order = spec
        .order
        .iter()
        .map(|order| json!([order.member, order.direction]))
        .collect::<Vec<_>>();
    json!({
        "measures": spec.measures,
        "dimensions": spec.dimensions,
        "timeDimensions": time_dimensions,
        "filters": filters,
        "order": order,
        "limit": spec.limit,
        "timezone": "America/New_York",
    })
}

async fn ensure_sales_tax_integrity(
    state: &AppState,
    spec: &CubeReportSpec,
) -> Result<(), CubeInsightsError> {
    if spec.dataset != "sales_tax" {
        return Ok(());
    }

    let parsed_range = spec
        .time_dimension
        .as_ref()
        .and_then(|time| time.date_range.as_ref())
        .map(|range| {
            let [from_raw, to_raw] = range.as_slice() else {
                return Err(CubeInsightsError::BadRequest(
                    "date_range must contain an inclusive from and to date".to_string(),
                ));
            };
            let from = NaiveDate::parse_from_str(from_raw, "%Y-%m-%d").map_err(|_| {
                CubeInsightsError::BadRequest("from date must be YYYY-MM-DD".to_string())
            })?;
            let to = NaiveDate::parse_from_str(to_raw, "%Y-%m-%d").map_err(|_| {
                CubeInsightsError::BadRequest("to date must be YYYY-MM-DD".to_string())
            })?;
            Ok::<_, CubeInsightsError>((from, to))
        })
        .transpose()?;
    let (from, to) = parsed_range
        .map(|(from, to)| (Some(from), Some(to)))
        .unwrap_or((None, None));

    let integrity_errors: i64 = sqlx::query_scalar(
        r#"
        WITH scoped AS (
            SELECT *
            FROM reporting.nys_sales_tax_ledger
            WHERE business_date IS NULL
               OR $1::date IS NULL
               OR business_date BETWEEN $1 AND $2
        )
        SELECT (
            COUNT(*) FILTER (WHERE integrity_error IS NOT NULL)
            + CASE
                WHEN COALESCE(SUM(gross_sales), 0)
                    = COALESCE(SUM(taxable_sales + nontaxable_sales), 0)
                THEN 0 ELSE 1
              END
            + CASE
                WHEN COALESCE(SUM(total_tax_collected), 0)
                    = COALESCE(SUM(total_state_tax + total_local_tax), 0)
                THEN 0 ELSE 1
              END
        )::bigint
        FROM scoped
        "#,
    )
    .bind(from)
    .bind(to)
    .fetch_one(&state.db)
    .await?;

    if integrity_errors > 0 {
        tracing::error!(
            integrity_errors,
            from = ?from,
            through = ?to,
            "governed sales-tax dataset failed closed"
        );
        return Err(CubeInsightsError::Integrity(
            "Sales tax report blocked because its persisted tax ledger did not reconcile. No filing totals were returned."
                .to_string(),
        ));
    }

    Ok(())
}

async fn execute_report(
    state: &AppState,
    staff: &AuthenticatedStaff,
    question: String,
    spec: CubeReportSpec,
    history_id: Option<Uuid>,
) -> Result<ReportRunResponse, CubeInsightsError> {
    ensure_sales_tax_integrity(state, &spec).await?;
    let secret = cube_secret()?;
    let token = cube_token(staff, &secret)?;
    let response = state
        .http_client
        .post(format!("{}/cubejs-api/v1/load", cube_upstream()))
        .header(reqwest::header::AUTHORIZATION, token)
        .json(&json!({ "query": cube_query(&spec) }))
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(error = %error, "Cube Core query request failed");
            CubeInsightsError::Unavailable(
                "The reporting engine is not reachable on this Main Hub".to_string(),
            )
        })?;
    let status = response.status();
    let payload: Value = response.json().await.map_err(|error| {
        tracing::warn!(error = %error, "Cube Core returned invalid JSON");
        CubeInsightsError::Unavailable(
            "The reporting engine returned an invalid response".to_string(),
        )
    })?;
    if !status.is_success() {
        tracing::warn!(status = %status, response = %payload, "Cube Core rejected governed query");
        return Err(CubeInsightsError::Unavailable(
            "The reporting engine could not run this governed report".to_string(),
        ));
    }
    let rows = payload
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row.as_object().cloned())
        .collect::<Vec<_>>();
    let lookup = member_lookup(is_admin(staff));
    let selected = spec
        .dimensions
        .iter()
        .chain(spec.measures.iter())
        .map(String::as_str)
        .chain(
            spec.time_dimension
                .as_ref()
                .map(|time| time.member.as_str()),
        );
    let mut member_labels = HashMap::new();
    let mut member_formats = HashMap::new();
    for name in selected {
        if let Some(member) = lookup.get(name) {
            member_labels.insert(name.to_string(), member.label.to_string());
            member_formats.insert(name.to_string(), member.format);
        }
    }
    let (history_id, question) =
        record_report_history(state, staff.id, history_id, &question, &spec, rows.len()).await?;
    Ok(ReportRunResponse {
        history_id,
        question,
        row_count: rows.len(),
        rows,
        spec,
        member_labels,
        member_formats,
        generated_at: Utc::now().to_rfc3339(),
        engine: "Cube Core",
    })
}

async fn ask_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<AskReportRequest>,
) -> Result<Json<ReportRunResponse>, CubeInsightsError> {
    let staff = require_insights_staff(&state, &headers).await?;
    let question = body.question.trim();
    if question.is_empty() || question.len() > MAX_QUESTION_BYTES {
        return Err(CubeInsightsError::BadRequest(
            "report request must be 1-2000 characters".to_string(),
        ));
    }
    let config = load_insights_config(&state).await;
    let max_rows = config.cube_max_rows.clamp(1, DEFAULT_MAX_ROWS);
    let spec = plan_report(
        question,
        body.previous_spec.as_ref(),
        is_admin(&staff),
        max_rows,
    )
    .await?;
    execute_report(&state, &staff, question.to_string(), spec, None)
        .await
        .map(Json)
}

async fn run_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut body): Json<RunReportRequest>,
) -> Result<Json<ReportRunResponse>, CubeInsightsError> {
    let staff = require_insights_staff(&state, &headers).await?;
    if let Some(date_range) = body.date_range.take() {
        validate_date_range(&date_range)?;
        let Some(time) = body.spec.time_dimension.as_mut() else {
            return Err(CubeInsightsError::BadRequest(
                "this saved report has no date dimension to change".to_string(),
            ));
        };
        time.date_range = Some(date_range);
    }
    let config = load_insights_config(&state).await;
    let max_rows = config.cube_max_rows.clamp(1, DEFAULT_MAX_ROWS);
    validate_report_spec(&mut body.spec, is_admin(&staff), max_rows)?;
    execute_report(&state, &staff, body.question, body.spec, body.history_id)
        .await
        .map(Json)
}

async fn record_report_history(
    state: &AppState,
    staff_id: Uuid,
    history_id: Option<Uuid>,
    question: &str,
    spec: &CubeReportSpec,
    row_count: usize,
) -> Result<(Uuid, String), CubeInsightsError> {
    let spec_json = serde_json::to_value(spec).map_err(|error| {
        CubeInsightsError::BadRequest(format!("could not record report specification: {error}"))
    })?;
    let row_count = i32::try_from(row_count).unwrap_or(i32::MAX);
    if let Some(id) = history_id {
        let mut tx = state.db.begin().await?;
        let source_question = sqlx::query_scalar::<_, String>(
            r#"
            UPDATE insight_report_history
            SET last_accessed_at = CURRENT_TIMESTAMP,
                archived_at = NULL
            WHERE id = $1 AND staff_id = $2
            RETURNING question
            "#,
        )
        .bind(id)
        .bind(staff_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            CubeInsightsError::BadRequest("report history entry was not found".to_string())
        })?;
        let effective_question = if question.trim().is_empty() {
            source_question
        } else {
            question.to_string()
        };
        let new_id = sqlx::query_scalar::<_, Uuid>(
            r#"
            INSERT INTO insight_report_history
                (staff_id, question, title, report_spec, row_count)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            "#,
        )
        .bind(staff_id)
        .bind(&effective_question)
        .bind(&spec.title)
        .bind(&spec_json)
        .bind(row_count)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok((new_id, effective_question));
    }

    let id = sqlx::query_scalar::<_, Uuid>(
        r#"
        INSERT INTO insight_report_history
            (staff_id, question, title, report_spec, row_count)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        "#,
    )
    .bind(staff_id)
    .bind(question)
    .bind(&spec.title)
    .bind(spec_json)
    .bind(row_count)
    .fetch_one(&state.db)
    .await
    .map_err(CubeInsightsError::from)?;
    Ok((id, question.to_string()))
}

async fn list_report_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ReportHistoryQuery>,
) -> Result<Json<Vec<ReportHistoryEntry>>, CubeInsightsError> {
    let staff = require_insights_staff(&state, &headers).await?;
    let config = load_insights_config(&state).await;
    sqlx::query(
        r#"
        UPDATE insight_report_history
        SET archived_at = CURRENT_TIMESTAMP
        WHERE staff_id = $1
          AND archived_at IS NULL
          AND last_accessed_at < CURRENT_TIMESTAMP - make_interval(days => $2)
        "#,
    )
    .bind(staff.id)
    .bind(config.history_archive_days)
    .execute(&state.db)
    .await?;

    let rows = sqlx::query_as::<_, ReportHistoryEntry>(
        r#"
        SELECT id, question, title, report_spec, row_count,
               created_at, last_accessed_at, archived_at
        FROM insight_report_history
        WHERE staff_id = $1
          AND (($2 = TRUE AND archived_at IS NOT NULL)
            OR ($2 = FALSE AND archived_at IS NULL))
        ORDER BY last_accessed_at DESC
        LIMIT 250
        "#,
    )
    .bind(staff.id)
    .bind(query.archived)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn set_history_archived(
    state: &AppState,
    staff_id: Uuid,
    id: Uuid,
    archived: bool,
) -> Result<(), CubeInsightsError> {
    let result = sqlx::query(
        r#"
        UPDATE insight_report_history
        SET archived_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END,
            last_accessed_at = CASE WHEN $3 THEN last_accessed_at ELSE CURRENT_TIMESTAMP END
        WHERE id = $1 AND staff_id = $2
        "#,
    )
    .bind(id)
    .bind(staff_id)
    .bind(archived)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(CubeInsightsError::BadRequest(
            "report history entry was not found".to_string(),
        ));
    }
    Ok(())
}

async fn archive_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, CubeInsightsError> {
    let staff = require_insights_staff(&state, &headers).await?;
    set_history_archived(&state, staff.id, id, true).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, CubeInsightsError> {
    let staff = require_insights_staff(&state, &headers).await?;
    set_history_archived(&state, staff.id, id, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_semantic_catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<SemanticCatalogResponse>, CubeInsightsError> {
    let staff = require_insights_staff(&state, &headers).await?;
    let config = load_insights_config(&state).await;
    Ok(Json(semantic_catalog(
        is_admin(&staff),
        config.cube_max_rows.clamp(1, DEFAULT_MAX_ROWS),
    )))
}

fn reporting_health_status(
    cube_configured: bool,
    cube_ready: bool,
    planner_configured: bool,
    planner_ready: bool,
) -> &'static str {
    if !cube_configured || !planner_configured {
        "needs_configuration"
    } else if cube_ready && planner_ready {
        "connected"
    } else if !cube_ready && !planner_ready {
        "unreachable"
    } else {
        "degraded"
    }
}

async fn reporting_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CubeHealthResponse>, CubeInsightsError> {
    require_insights_staff(&state, &headers).await?;
    let cube_configured = cube_secret().is_ok();
    let start = std::time::Instant::now();
    let cube_probe = state
        .http_client
        .get(format!("{}/readyz", cube_upstream()))
        .timeout(std::time::Duration::from_secs(5))
        .send();
    let planner_probe = crate::logic::rosie_intelligence::health_check(&state.http_client);
    let (cube_response, planner) = tokio::join!(cube_probe, planner_probe);
    let cube_ready = cube_response
        .as_ref()
        .is_ok_and(|response| response.status().is_success());
    let planner_ready = planner.configured && planner.reachable;
    let status = reporting_health_status(
        cube_configured,
        cube_ready,
        planner.configured,
        planner_ready,
    );
    let message = match status {
        "connected" => "Cube Core and the ROSIE report planner are ready.".to_string(),
        "needs_configuration" => {
            let mut missing = Vec::new();
            if !cube_configured {
                missing.push("Cube Core credentials");
            }
            if !planner.configured {
                missing.push("ROSIE report planner");
            }
            format!("Reporting setup is incomplete: {}.", missing.join(" and "))
        }
        _ => format!(
            "Cube Core is {}; the ROSIE report planner is {}.",
            if cube_ready { "ready" } else { "unavailable" },
            if planner_ready {
                "ready"
            } else {
                "unavailable"
            }
        ),
    };
    Ok(Json(CubeHealthResponse {
        status,
        message,
        latency_ms: start.elapsed().as_millis() as u64,
        configured: cube_configured && planner.configured,
        cube_ready,
        planner_ready,
    }))
}

async fn list_favorites(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<SavedReportFavorite>>, CubeInsightsError> {
    let staff = require_insights_staff(&state, &headers).await?;
    let rows = sqlx::query_as::<_, SavedReportFavorite>(
        r#"
        SELECT id, name, question, report_spec, created_at, updated_at
        FROM insight_report_favorites
        WHERE staff_id = $1
        ORDER BY updated_at DESC, name ASC
        "#,
    )
    .bind(staff.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(rows))
}

async fn save_favorite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut body): Json<SaveFavoriteRequest>,
) -> Result<Json<SavedReportFavorite>, CubeInsightsError> {
    let staff = require_insights_staff(&state, &headers).await?;
    body.name = body.name.trim().to_string();
    body.question = body.question.trim().to_string();
    if body.name.is_empty() || body.name.len() > 120 {
        return Err(CubeInsightsError::BadRequest(
            "favorite name must be 1-120 characters".to_string(),
        ));
    }
    if body.question.len() > MAX_QUESTION_BYTES {
        return Err(CubeInsightsError::BadRequest(
            "favorite question exceeds 2000 characters".to_string(),
        ));
    }
    let config = load_insights_config(&state).await;
    validate_report_spec(
        &mut body.spec,
        is_admin(&staff),
        config.cube_max_rows.clamp(1, DEFAULT_MAX_ROWS),
    )?;
    let spec_json = serde_json::to_value(&body.spec).map_err(|error| {
        CubeInsightsError::BadRequest(format!("could not save report specification: {error}"))
    })?;
    let row = sqlx::query_as::<_, SavedReportFavorite>(
        r#"
        INSERT INTO insight_report_favorites (staff_id, name, question, report_spec)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (staff_id, name) DO NOTHING
        RETURNING id, name, question, report_spec, created_at, updated_at
        "#,
    )
    .bind(staff.id)
    .bind(&body.name)
    .bind(&body.question)
    .bind(spec_json)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        CubeInsightsError::BadRequest(
            "a favorite with that name already exists; choose a new name or remove the existing favorite"
                .to_string(),
        )
    })?;
    Ok(Json(row))
}

async fn delete_favorite(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, CubeInsightsError> {
    let staff = require_insights_staff(&state, &headers).await?;
    let result =
        sqlx::query("DELETE FROM insight_report_favorites WHERE id = $1 AND staff_id = $2")
            .bind(id)
            .bind(staff.id)
            .execute(&state.db)
            .await?;
    if result.rows_affected() == 0 {
        return Err(CubeInsightsError::BadRequest(
            "saved report was not found".to_string(),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/reports/ask", post(ask_report))
        .route("/reports/run", post(run_report))
        .route(
            "/reports/favorites",
            get(list_favorites).post(save_favorite),
        )
        .route("/reports/favorites/{id}", delete(delete_favorite))
        .route("/reports/history", get(list_report_history))
        .route("/reports/history/{id}/archive", post(archive_history))
        .route("/reports/history/{id}/restore", post(restore_history))
        .route("/semantic-catalog", get(get_semantic_catalog))
        .route("/health", get(reporting_health))
        .route("/cube-health", get(reporting_health))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_spec() -> CubeReportSpec {
        CubeReportSpec {
            title: "Booked sales by salesperson".to_string(),
            explanation: "Booked demand grouped by salesperson.".to_string(),
            dataset: "booked_transactions".to_string(),
            measures: vec!["booked_transactions.gross_sales".to_string()],
            dimensions: vec!["booked_transactions.salesperson".to_string()],
            time_dimension: Some(ReportTimeDimension {
                member: "booked_transactions.business_date".to_string(),
                granularity: None,
                date_range: Some(vec!["2026-07-01".to_string(), "2026-07-31".to_string()]),
            }),
            filters: Vec::new(),
            order: vec![ReportOrder {
                member: "booked_transactions.gross_sales".to_string(),
                direction: "desc".to_string(),
            }],
            limit: 100,
            visualization: ReportVisualization {
                kind: ReportVisualizationKind::Bar,
                x_member: Some("booked_transactions.salesperson".to_string()),
                y_members: vec!["booked_transactions.gross_sales".to_string()],
            },
        }
    }

    #[test]
    fn accepts_single_dataset_governed_spec() {
        let mut spec = valid_spec();
        validate_report_spec(&mut spec, false, 500).expect("valid report spec");
        assert_eq!(spec.limit, 100);
    }

    #[test]
    fn rejects_cross_dataset_member() {
        let mut spec = valid_spec();
        spec.measures = vec!["payments.gross_amount".to_string()];
        assert!(validate_report_spec(&mut spec, false, 500).is_err());
    }

    #[test]
    fn protects_cost_and_margin_members() {
        let mut spec = valid_spec();
        spec.dataset = "booked_items".to_string();
        spec.measures = vec!["booked_items.gross_margin".to_string()];
        spec.dimensions = vec!["booked_items.category".to_string()];
        spec.time_dimension = Some(ReportTimeDimension {
            member: "booked_items.business_date".to_string(),
            granularity: Some("month".to_string()),
            date_range: None,
        });
        spec.order.clear();
        spec.visualization = ReportVisualization {
            kind: ReportVisualizationKind::Bar,
            x_member: Some("booked_items.category".to_string()),
            y_members: vec!["booked_items.gross_margin".to_string()],
        };
        assert!(validate_report_spec(&mut spec, false, 500).is_err());
        validate_report_spec(&mut spec, true, 500).expect("admin margin report");
    }

    #[test]
    fn accepts_complete_governed_sales_tax_report() {
        let mut spec = CubeReportSpec {
            title: "July New York sales tax".to_string(),
            explanation: "Paid fulfilled sales and settled refund or exchange events from the reconciled tax dataset."
                .to_string(),
            dataset: "sales_tax".to_string(),
            measures: SALES_TAX_MEASURES
                .iter()
                .map(|measure| measure.name.to_string())
                .collect(),
            dimensions: Vec::new(),
            time_dimension: Some(ReportTimeDimension {
                member: "sales_tax.business_date".to_string(),
                granularity: None,
                date_range: Some(vec!["2026-07-01".to_string(), "2026-07-31".to_string()]),
            }),
            filters: Vec::new(),
            order: Vec::new(),
            limit: 100,
            visualization: ReportVisualization {
                kind: ReportVisualizationKind::Table,
                x_member: None,
                y_members: Vec::new(),
            },
        };

        validate_report_spec(&mut spec, false, 500).expect("governed tax report");
        assert_eq!(spec.measures.len(), SALES_TAX_MAX_REPORT_MEASURES);
    }

    #[test]
    fn clamps_report_row_limit() {
        let mut spec = valid_spec();
        spec.limit = 10_000;
        validate_report_spec(&mut spec, false, 250).expect("valid report spec");
        assert_eq!(spec.limit, 250);
    }

    #[test]
    fn planner_prompt_does_not_duplicate_the_semantic_catalog() {
        let prompt = planner_prompt(None);
        assert!(prompt.len() < 1_500);
        assert!(!prompt.contains("Approved catalog:"));
        assert!(!prompt.contains("booked_transactions.gross_sales"));
    }

    #[test]
    fn reporting_readiness_requires_cube_and_planner() {
        assert_eq!(reporting_health_status(true, true, true, true), "connected");
        assert_eq!(reporting_health_status(true, true, true, false), "degraded");
        assert_eq!(
            reporting_health_status(true, false, true, false),
            "unreachable"
        );
        assert_eq!(
            reporting_health_status(true, true, false, false),
            "needs_configuration"
        );
    }
}
