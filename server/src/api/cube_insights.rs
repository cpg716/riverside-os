//! Native, governed conversational reporting backed by Riverside reporting views.
//!
//! Gemma produces a constrained semantic report specification. ROS validates
//! every member, filter, limit, and visualization before the server builds a
//! bounded read-only query from static member mappings. Neither the model nor
//! the browser can submit SQL.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{FromRow, Postgres, Row};
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::INSIGHTS_VIEW;
use crate::auth::pins::AuthenticatedStaff;
use crate::logic::insights_config::StoreInsightsConfig;
use crate::logic::rosie_provider_selection::{select_llm_provider, QueryType, RosieProviderConfig};
use crate::middleware::require_staff_with_permission;
use crate::models::DbStaffRole;

const DEFAULT_MAX_ROWS: i64 = 500;
const MAX_QUESTION_BYTES: usize = 2_000;

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
struct ReportingHealthResponse {
    status: &'static str,
    message: String,
    latency_ms: u64,
    configured: bool,
    staff_guidance: String,
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum QueryValueKind {
    Text,
    Number,
    Boolean,
    Date,
}

#[derive(Clone, Copy)]
enum QueryAggregate {
    Count,
    Sum,
    Average,
}

#[derive(Clone, Copy)]
struct QueryMember {
    column: &'static str,
    kind: QueryValueKind,
    aggregate: Option<QueryAggregate>,
    round_scale: Option<u32>,
}

const fn query_dimension(column: &'static str, kind: QueryValueKind) -> QueryMember {
    QueryMember {
        column,
        kind,
        aggregate: None,
        round_scale: None,
    }
}

const fn query_count() -> QueryMember {
    QueryMember {
        column: "*",
        kind: QueryValueKind::Number,
        aggregate: Some(QueryAggregate::Count),
        round_scale: None,
    }
}

const fn query_sum(column: &'static str, round_scale: Option<u32>) -> QueryMember {
    QueryMember {
        column,
        kind: QueryValueKind::Number,
        aggregate: Some(QueryAggregate::Sum),
        round_scale,
    }
}

const fn query_average(column: &'static str, round_scale: Option<u32>) -> QueryMember {
    QueryMember {
        column,
        kind: QueryValueKind::Number,
        aggregate: Some(QueryAggregate::Average),
        round_scale,
    }
}

fn query_member(name: &str) -> Option<QueryMember> {
    let (dataset, member) = name.split_once('.')?;
    match (dataset, member) {
        ("booked_transactions" | "recognized_transactions", "transaction_count") => {
            Some(query_count())
        }
        ("booked_transactions", "gross_sales")
        | ("recognized_transactions", "recognized_sales") => {
            Some(query_sum("total_price", Some(2)))
        }
        ("booked_transactions" | "recognized_transactions", "amount_paid") => {
            Some(query_sum("amount_paid", Some(2)))
        }
        ("booked_transactions" | "recognized_transactions", "balance_due") => {
            Some(query_sum("balance_due", Some(2)))
        }
        ("booked_transactions", "business_date") => Some(query_dimension(
            "booked_business_date",
            QueryValueKind::Date,
        )),
        ("recognized_transactions", "business_date") => Some(query_dimension(
            "recognition_business_date",
            QueryValueKind::Date,
        )),
        ("booked_transactions" | "recognized_transactions", "status") => {
            Some(query_dimension("status", QueryValueKind::Text))
        }
        ("booked_transactions" | "recognized_transactions", "sale_channel") => {
            Some(query_dimension("sale_channel", QueryValueKind::Text))
        }
        ("booked_transactions" | "recognized_transactions", "fulfillment_method") => {
            Some(query_dimension("fulfillment_method", QueryValueKind::Text))
        }
        ("booked_transactions" | "recognized_transactions", "customer_name") => Some(
            query_dimension("customer_display_name", QueryValueKind::Text),
        ),
        ("booked_transactions" | "recognized_transactions", "salesperson") => Some(
            query_dimension("primary_salesperson_display_name", QueryValueKind::Text),
        ),
        ("booked_transactions" | "recognized_transactions", "operator") => Some(query_dimension(
            "operator_display_name",
            QueryValueKind::Text,
        )),
        ("booked_items" | "recognized_items", "line_count") => Some(query_count()),
        ("booked_items" | "recognized_items", "units") => Some(query_sum("quantity", None)),
        ("booked_items", "gross_sales") | ("recognized_items", "recognized_sales") => {
            Some(query_sum("line_extended_price", Some(2)))
        }
        ("booked_items" | "recognized_items", "cost") => {
            Some(query_sum("line_extended_cost", Some(2)))
        }
        ("booked_items" | "recognized_items", "gross_margin") => {
            Some(query_sum("line_gross_margin_pre_tax", Some(2)))
        }
        ("booked_items", "business_date") => {
            Some(query_dimension("order_business_date", QueryValueKind::Date))
        }
        ("recognized_items", "business_date") => Some(query_dimension(
            "order_recognition_business_date",
            QueryValueKind::Date,
        )),
        ("booked_items" | "recognized_items", "item") => {
            Some(query_dimension("item_display_name", QueryValueKind::Text))
        }
        ("booked_items" | "recognized_items", "product") => Some(query_dimension(
            "product_display_name",
            QueryValueKind::Text,
        )),
        ("booked_items" | "recognized_items", "variation") => Some(query_dimension(
            "variant_display_name",
            QueryValueKind::Text,
        )),
        ("booked_items" | "recognized_items", "sku") => {
            Some(query_dimension("sku", QueryValueKind::Text))
        }
        ("booked_items" | "recognized_items", "category") => {
            Some(query_dimension("category_name", QueryValueKind::Text))
        }
        ("booked_items" | "recognized_items", "vendor") => {
            Some(query_dimension("vendor_display_name", QueryValueKind::Text))
        }
        ("booked_items" | "recognized_items", "salesperson") => Some(query_dimension(
            "line_salesperson_display_name",
            QueryValueKind::Text,
        )),
        ("booked_items" | "recognized_items", "fulfillment_type") => {
            Some(query_dimension("fulfillment", QueryValueKind::Text))
        }
        ("fulfillment_orders", "fulfillment_order_count") => Some(query_count()),
        ("fulfillment_orders", "created_date") => {
            Some(query_dimension("created_at", QueryValueKind::Date))
        }
        ("fulfillment_orders", "fulfilled_date") => {
            Some(query_dimension("fulfilled_at", QueryValueKind::Date))
        }
        ("fulfillment_orders", "status") => {
            Some(query_dimension("fulfillment_status", QueryValueKind::Text))
        }
        ("fulfillment_orders", "customer_name") => Some(query_dimension(
            "customer_display_name",
            QueryValueKind::Text,
        )),
        ("fulfillment_orders", "wedding_party") => {
            Some(query_dimension("wedding_party_name", QueryValueKind::Text))
        }
        ("weddings", "wedding_count") => Some(query_count()),
        ("weddings", "member_count") => Some(query_sum("member_count", None)),
        ("weddings", "transaction_count") => Some(query_sum("order_count", None)),
        ("weddings", "booked_sales") => Some(query_sum("total_revenue", Some(2))),
        ("weddings", "cost") => Some(query_sum("total_cost", Some(2))),
        ("weddings", "profit") => Some(query_sum("total_profit", Some(2))),
        ("weddings", "event_date") => Some(query_dimension("event_date", QueryValueKind::Date)),
        ("weddings", "wedding_party") => {
            Some(query_dimension("wedding_party_name", QueryValueKind::Text))
        }
        ("weddings", "groom") => Some(query_dimension("groom_name", QueryValueKind::Text)),
        ("weddings", "bride") => Some(query_dimension("bride_name", QueryValueKind::Text)),
        ("weddings", "salesperson") => Some(query_dimension(
            "wedding_salesperson_name",
            QueryValueKind::Text,
        )),
        ("payments", "payment_count") => Some(query_count()),
        ("payments", "gross_amount") => Some(query_sum("gross_amount", Some(2))),
        ("payments", "merchant_fees") => Some(query_sum("merchant_fee", Some(2))),
        ("payments", "net_amount") => Some(query_sum("net_amount", Some(2))),
        ("payments", "business_date") => {
            Some(query_dimension("business_date", QueryValueKind::Date))
        }
        ("payments", "category") => Some(query_dimension("category", QueryValueKind::Text)),
        ("payments", "status") => Some(query_dimension("status", QueryValueKind::Text)),
        ("payments", "payment_method") => {
            Some(query_dimension("payment_method", QueryValueKind::Text))
        }
        ("payments", "provider") => Some(query_dimension("payment_provider", QueryValueKind::Text)),
        ("payments", "card_brand") => Some(query_dimension("card_brand", QueryValueKind::Text)),
        ("payments", "payer_name") => Some(query_dimension("payer_name", QueryValueKind::Text)),
        ("inventory", "variation_count") => Some(query_count()),
        ("inventory", "stock_on_hand") => Some(query_sum("stock_on_hand", None)),
        ("inventory", "reserved_stock") => Some(query_sum("reserved_stock", None)),
        ("inventory", "on_layaway") => Some(query_sum("on_layaway", None)),
        ("inventory", "available_stock") => Some(query_sum("available_stock", None)),
        ("inventory", "inventory_cost_value") => Some(query_sum("inventory_cost_value", Some(2))),
        ("inventory", "created_date") => Some(query_dimension("created_at", QueryValueKind::Date)),
        ("inventory", "item") => Some(query_dimension("item_display_name", QueryValueKind::Text)),
        ("inventory", "product") => Some(query_dimension("product_name", QueryValueKind::Text)),
        ("inventory", "brand") => Some(query_dimension("brand", QueryValueKind::Text)),
        ("inventory", "sku") => Some(query_dimension("sku", QueryValueKind::Text)),
        ("inventory", "category") => Some(query_dimension("category_name", QueryValueKind::Text)),
        ("inventory", "vendor") => Some(query_dimension("vendor_name", QueryValueKind::Text)),
        ("inventory", "active") => Some(query_dimension("is_active", QueryValueKind::Boolean)),
        ("inventory", "low_stock_threshold") => {
            Some(query_dimension("reorder_point", QueryValueKind::Number))
        }
        ("inventory", "retail_price") => {
            Some(query_dimension("retail_price", QueryValueKind::Number))
        }
        ("inventory", "unit_cost") => Some(query_dimension("unit_cost", QueryValueKind::Number)),
        ("loyalty_customers", "customer_count") => Some(query_count()),
        ("loyalty_customers", "current_points") => Some(query_sum("current_balance", None)),
        ("loyalty_customers", "lifetime_points_earned") => {
            Some(query_sum("lifetime_earned_from_orders", None))
        }
        ("loyalty_customers", "lifetime_points_redeemed") => {
            Some(query_sum("lifetime_points_redeemed", None))
        }
        ("loyalty_customers", "reward_dollars_issued") => {
            Some(query_sum("total_reward_dollars_issued", Some(2)))
        }
        ("loyalty_customers", "customer_name") => Some(query_dimension(
            "customer_display_name",
            QueryValueKind::Text,
        )),
        ("loyalty_customers", "customer_code") => {
            Some(query_dimension("customer_code", QueryValueKind::Text))
        }
        ("alterations", "alteration_count") => Some(query_count()),
        ("alterations", "due_date") => Some(query_dimension("due_at", QueryValueKind::Date)),
        ("alterations", "created_date") => {
            Some(query_dimension("created_at", QueryValueKind::Date))
        }
        ("alterations", "status") => Some(query_dimension("status", QueryValueKind::Text)),
        ("alterations", "overdue") => Some(query_dimension("is_overdue", QueryValueKind::Boolean)),
        ("alterations", "customer_name") => {
            Some(query_dimension("customer_name", QueryValueKind::Text))
        }
        ("shipments", "shipment_count") => Some(query_count()),
        ("shipments", "shipping_charged") => Some(query_sum("shipping_charged_usd", Some(2))),
        ("shipments", "quoted_amount") => Some(query_sum("quoted_amount_usd", Some(2))),
        ("shipments", "label_cost") => Some(query_sum("label_cost_usd", Some(2))),
        ("shipments", "created_date") => Some(query_dimension("created_at", QueryValueKind::Date)),
        ("shipments", "status") => Some(query_dimension("status", QueryValueKind::Text)),
        ("shipments", "source") => Some(query_dimension("source", QueryValueKind::Text)),
        ("shipments", "carrier") => Some(query_dimension("carrier", QueryValueKind::Text)),
        ("shipments", "service") => Some(query_dimension("service_name", QueryValueKind::Text)),
        ("shipments", "customer_name") => {
            Some(query_dimension("customer_name", QueryValueKind::Text))
        }
        ("daily_sales_weather", "sales") => Some(query_sum("sales", Some(2))),
        ("daily_sales_weather", "tax_collected") => Some(query_sum("tax_collected", Some(2))),
        ("daily_sales_weather", "transaction_count") => Some(query_sum("transaction_count", None)),
        ("daily_sales_weather", "units") => Some(query_sum("line_units", None)),
        ("daily_sales_weather", "precipitation_inches") => {
            Some(query_average("precipitation_inches", Some(4)))
        }
        ("daily_sales_weather", "business_date") => {
            Some(query_dimension("business_date", QueryValueKind::Date))
        }
        ("daily_sales_weather", "condition") => {
            Some(query_dimension("weather_condition", QueryValueKind::Text))
        }
        ("daily_sales_weather", "weather_source") => {
            Some(query_dimension("weather_source", QueryValueKind::Text))
        }
        _ => None,
    }
}

fn dataset_source(dataset: &str) -> Option<&'static str> {
    match dataset {
        "booked_transactions" => Some(
            "(SELECT * FROM reporting.transactions_core WHERE status <> 'cancelled') AS report_source",
        ),
        "recognized_transactions" => Some(
            "(SELECT * FROM reporting.transactions_core WHERE status <> 'cancelled' AND recognition_at IS NOT NULL) AS report_source",
        ),
        "booked_items" => Some(
            "(SELECT * FROM reporting.order_lines WHERE order_status <> 'cancelled') AS report_source",
        ),
        "recognized_items" => Some(
            "(SELECT * FROM reporting.order_lines WHERE order_status <> 'cancelled' AND order_recognition_at IS NOT NULL) AS report_source",
        ),
        "fulfillment_orders" => Some("reporting.fulfillment_orders_core AS report_source"),
        "weddings" => Some("reporting.wedding_party_economics AS report_source"),
        "payments" => Some("reporting.payment_ledger AS report_source"),
        "inventory" => Some("reporting.inventory_snapshot AS report_source"),
        "loyalty_customers" => Some("reporting.loyalty_customer_snapshot AS report_source"),
        "alterations" => Some("reporting.alterations_active AS report_source"),
        "shipments" => Some("reporting.shipments_active AS report_source"),
        "daily_sales_weather" => Some("reporting.daily_sales_weather AS report_source"),
        _ => None,
    }
}

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

    if spec.measures.is_empty() || spec.measures.len() > 5 {
        return Err(CubeInsightsError::BadRequest(
            "a report must contain 1-5 approved measures".to_string(),
        ));
    }
    if spec.measures.iter().collect::<HashSet<_>>().len() != spec.measures.len()
        || spec.dimensions.iter().collect::<HashSet<_>>().len() != spec.dimensions.len()
    {
        return Err(CubeInsightsError::BadRequest(
            "report members must not be duplicated".to_string(),
        ));
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
        if spec.dimensions.contains(&time.member) {
            return Err(CubeInsightsError::BadRequest(
                "the report date field must not also be a grouping field".to_string(),
            ));
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
            || (no_values && !filter.values.is_empty())
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
                    "measures": { "type": "array", "minItems": 1, "maxItems": 5, "items": { "type": "string", "enum": measures } },
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

fn planner_prompt(previous_spec: Option<&CubeReportSpec>, admin: bool) -> String {
    let catalog = semantic_catalog(admin, DEFAULT_MAX_ROWS);
    let catalog_json = serde_json::to_string(&catalog).unwrap_or_else(|_| "{}".to_string());
    let previous = previous_spec
        .and_then(|spec| serde_json::to_string(spec).ok())
        .unwrap_or_else(|| "none".to_string());
    format!(
        "You are the Riverside OS report planner. Build exactly one report by calling build_insights_report. Today is {}. Use one dataset only and only members from that dataset. Booked means demand/activity at checkout; recognized revenue means fulfillment or pickup and must use a recognized dataset. Financial Transaction and logistical Fulfillment Order are distinct. Use ISO YYYY-MM-DD dates. Prefer a useful chart for trends or comparisons and a table for detailed lists. If the operator asks to change, fix, update, or add to the prior report, revise the prior spec instead of starting over. Explain the chosen basis and grouping in plain language. Prior report: {}. Approved catalog: {}",
        Utc::now().date_naive(),
        previous,
        catalog_json
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
            { "role": "system", "content": planner_prompt(previous_spec, admin) },
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

enum ReportBind {
    Text(String),
    Number(Decimal),
    Date(NaiveDate),
    Boolean(bool),
    Integer(i64),
}

fn push_bind_marker(sql: &mut String, binds: &mut Vec<ReportBind>, value: ReportBind) {
    binds.push(value);
    write!(sql, "${}", binds.len()).expect("writing to a String cannot fail");
}

fn parse_filter_value(kind: QueryValueKind, value: &str) -> Result<ReportBind, CubeInsightsError> {
    match kind {
        QueryValueKind::Text => Ok(ReportBind::Text(value.trim().to_ascii_lowercase())),
        QueryValueKind::Number => value
            .trim()
            .parse::<Decimal>()
            .map(ReportBind::Number)
            .map_err(|_| {
                CubeInsightsError::BadRequest(
                    "a numeric report filter contains an invalid value".to_string(),
                )
            }),
        QueryValueKind::Boolean => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" => Ok(ReportBind::Boolean(true)),
            "false" | "no" | "0" => Ok(ReportBind::Boolean(false)),
            _ => Err(CubeInsightsError::BadRequest(
                "a yes/no report filter contains an invalid value".to_string(),
            )),
        },
        QueryValueKind::Date => NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d")
            .map(ReportBind::Date)
            .map_err(|_| {
                CubeInsightsError::BadRequest(
                    "a date report filter must use YYYY-MM-DD".to_string(),
                )
            }),
    }
}

fn grouped_member_expression(
    name: &str,
    member: QueryMember,
    time_dimension: Option<&ReportTimeDimension>,
) -> Result<String, CubeInsightsError> {
    if member.aggregate.is_some() {
        return Err(CubeInsightsError::BadRequest(
            "a report grouping member cannot be an aggregate".to_string(),
        ));
    }
    let column = format!("report_source.{}", member.column);
    if time_dimension.is_some_and(|time| time.member == name) {
        if let Some(granularity) = time_dimension.and_then(|time| time.granularity.as_deref()) {
            return Ok(format!("date_trunc('{granularity}', {column})"));
        }
    }
    Ok(column)
}

fn measure_expression(member: QueryMember) -> Result<String, CubeInsightsError> {
    let expression = match member.aggregate {
        Some(QueryAggregate::Count) => "COUNT(*)::bigint".to_string(),
        Some(QueryAggregate::Sum) => {
            format!("COALESCE(SUM(report_source.{}), 0)::numeric", member.column)
        }
        Some(QueryAggregate::Average) => {
            format!("COALESCE(AVG(report_source.{}), 0)::numeric", member.column)
        }
        None => {
            return Err(CubeInsightsError::BadRequest(
                "a report measure must be an approved aggregate".to_string(),
            ));
        }
    };
    Ok(match member.round_scale {
        Some(scale) => format!("ROUND({expression}, {scale})"),
        None => expression,
    })
}

fn append_filter_sql(
    sql: &mut String,
    binds: &mut Vec<ReportBind>,
    filter: &ReportFilter,
) -> Result<(), CubeInsightsError> {
    let member = query_member(&filter.member).ok_or_else(|| {
        CubeInsightsError::BadRequest("report filter member is not approved".to_string())
    })?;
    if member.aggregate.is_some() {
        return Err(CubeInsightsError::BadRequest(
            "aggregate measures cannot be used as report filters".to_string(),
        ));
    }
    let column = format!("report_source.{}", member.column);
    match filter.operator.as_str() {
        "set" => write!(sql, "{column} IS NOT NULL").expect("writing to a String cannot fail"),
        "notSet" => write!(sql, "{column} IS NULL").expect("writing to a String cannot fail"),
        "contains" | "notContains" => {
            if member.kind != QueryValueKind::Text {
                return Err(CubeInsightsError::BadRequest(
                    "contains filters require a text field".to_string(),
                ));
            }
            let joiner = if filter.operator == "contains" {
                " OR "
            } else {
                " AND "
            };
            sql.push('(');
            for (index, value) in filter.values.iter().enumerate() {
                if index > 0 {
                    sql.push_str(joiner);
                }
                write!(
                    sql,
                    "COALESCE({column}::text, '') {} ",
                    if filter.operator == "contains" {
                        "ILIKE"
                    } else {
                        "NOT ILIKE"
                    }
                )
                .expect("writing to a String cannot fail");
                push_bind_marker(sql, binds, ReportBind::Text(format!("%{}%", value.trim())));
            }
            sql.push(')');
        }
        "equals" | "notEquals" => {
            let comparable = if member.kind == QueryValueKind::Text {
                format!("LOWER(COALESCE({column}::text, ''))")
            } else {
                column
            };
            write!(
                sql,
                "{comparable} {} (",
                if filter.operator == "equals" {
                    "IN"
                } else {
                    "NOT IN"
                }
            )
            .expect("writing to a String cannot fail");
            for (index, value) in filter.values.iter().enumerate() {
                if index > 0 {
                    sql.push_str(", ");
                }
                let bind = parse_filter_value(member.kind, value)?;
                push_bind_marker(sql, binds, bind);
            }
            sql.push(')');
        }
        "gt" | "gte" | "lt" | "lte" => {
            if matches!(member.kind, QueryValueKind::Text | QueryValueKind::Boolean) {
                return Err(CubeInsightsError::BadRequest(
                    "comparison filters require a date or number field".to_string(),
                ));
            }
            if filter.values.len() != 1 {
                return Err(CubeInsightsError::BadRequest(
                    "comparison filters require exactly one value".to_string(),
                ));
            }
            let operator = match filter.operator.as_str() {
                "gt" => ">",
                "gte" => ">=",
                "lt" => "<",
                "lte" => "<=",
                _ => unreachable!(),
            };
            write!(sql, "{column} {operator} ").expect("writing to a String cannot fail");
            push_bind_marker(
                sql,
                binds,
                parse_filter_value(member.kind, &filter.values[0])?,
            );
        }
        _ => {
            return Err(CubeInsightsError::BadRequest(
                "report filter operator is not approved".to_string(),
            ));
        }
    }
    Ok(())
}

fn build_report_query(
    spec: &CubeReportSpec,
) -> Result<(String, Vec<ReportBind>, Vec<String>), CubeInsightsError> {
    let source = dataset_source(&spec.dataset).ok_or_else(|| {
        CubeInsightsError::BadRequest("report dataset is not approved".to_string())
    })?;
    let mut grouped = spec.dimensions.clone();
    if let Some(time) = &spec.time_dimension {
        grouped.push(time.member.clone());
    }
    let output_members = grouped
        .iter()
        .chain(spec.measures.iter())
        .cloned()
        .collect::<Vec<_>>();
    let mut group_expressions = Vec::with_capacity(grouped.len());
    let mut sql = String::from("SELECT ");
    for (index, name) in grouped.iter().enumerate() {
        if index > 0 {
            sql.push_str(", ");
        }
        let member = query_member(name).ok_or_else(|| {
            CubeInsightsError::BadRequest("report grouping member is not approved".to_string())
        })?;
        let expression = grouped_member_expression(name, member, spec.time_dimension.as_ref())?;
        group_expressions.push(expression.clone());
        write!(sql, "({expression})::text AS \"{name}\"").expect("writing to a String cannot fail");
    }
    for (index, name) in spec.measures.iter().enumerate() {
        if !grouped.is_empty() || index > 0 {
            sql.push_str(", ");
        }
        let member = query_member(name).ok_or_else(|| {
            CubeInsightsError::BadRequest("report measure is not approved".to_string())
        })?;
        let expression = measure_expression(member)?;
        write!(sql, "({expression})::text AS \"{name}\"").expect("writing to a String cannot fail");
    }
    write!(sql, " FROM {source} WHERE TRUE").expect("writing to a String cannot fail");
    let mut binds = Vec::new();
    if let Some(time) = &spec.time_dimension {
        if let Some(date_range) = &time.date_range {
            let member = query_member(&time.member).ok_or_else(|| {
                CubeInsightsError::BadRequest("report date member is not approved".to_string())
            })?;
            sql.push_str(" AND report_source.");
            sql.push_str(member.column);
            sql.push_str("::date >= ");
            push_bind_marker(
                &mut sql,
                &mut binds,
                ReportBind::Date(
                    NaiveDate::parse_from_str(&date_range[0], "%Y-%m-%d").map_err(|_| {
                        CubeInsightsError::BadRequest("from date must use YYYY-MM-DD".to_string())
                    })?,
                ),
            );
            sql.push_str(" AND report_source.");
            sql.push_str(member.column);
            sql.push_str("::date <= ");
            push_bind_marker(
                &mut sql,
                &mut binds,
                ReportBind::Date(
                    NaiveDate::parse_from_str(&date_range[1], "%Y-%m-%d").map_err(|_| {
                        CubeInsightsError::BadRequest("to date must use YYYY-MM-DD".to_string())
                    })?,
                ),
            );
        }
    }
    for filter in &spec.filters {
        sql.push_str(" AND ");
        append_filter_sql(&mut sql, &mut binds, filter)?;
    }
    if !group_expressions.is_empty() {
        sql.push_str(" GROUP BY ");
        sql.push_str(&group_expressions.join(", "));
    }
    if !spec.order.is_empty() {
        sql.push_str(" ORDER BY ");
        for (index, order) in spec.order.iter().enumerate() {
            if index > 0 {
                sql.push_str(", ");
            }
            write!(sql, "\"{}\" {} NULLS LAST", order.member, order.direction)
                .expect("writing to a String cannot fail");
        }
    }
    sql.push_str(" LIMIT ");
    push_bind_marker(&mut sql, &mut binds, ReportBind::Integer(spec.limit));
    Ok((sql, binds, output_members))
}

async fn execute_report(
    state: &AppState,
    staff: &AuthenticatedStaff,
    question: String,
    spec: CubeReportSpec,
    history_id: Option<Uuid>,
) -> Result<ReportRunResponse, CubeInsightsError> {
    let (sql, binds, output_members) = build_report_query(&spec)?;
    let mut tx = state.db.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '20s'")
        .execute(&mut *tx)
        .await?;
    let mut query = sqlx::query::<Postgres>(&sql);
    for bind in binds {
        query = match bind {
            ReportBind::Text(value) => query.bind(value),
            ReportBind::Number(value) => query.bind(value),
            ReportBind::Date(value) => query.bind(value),
            ReportBind::Boolean(value) => query.bind(value),
            ReportBind::Integer(value) => query.bind(value),
        };
    }
    let db_rows = query.fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let mut rows = Vec::with_capacity(db_rows.len());
    for db_row in db_rows {
        let mut row = Map::new();
        for member in &output_members {
            let value = db_row.try_get::<Option<String>, _>(member.as_str())?;
            row.insert(
                member.clone(),
                value.map(Value::String).unwrap_or(Value::Null),
            );
        }
        rows.push(row);
    }
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
        engine: "Riverside Insights",
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
    let max_rows = config.max_rows.clamp(1, DEFAULT_MAX_ROWS);
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
    let max_rows = config.max_rows.clamp(1, DEFAULT_MAX_ROWS);
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
        config.max_rows.clamp(1, DEFAULT_MAX_ROWS),
    )))
}

async fn reporting_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ReportingHealthResponse>, CubeInsightsError> {
    require_insights_staff(&state, &headers).await?;
    let start = std::time::Instant::now();
    let config = load_insights_config(&state).await;
    let ready = crate::logic::insights_config::reporting_engine_ready(&state.db).await?;
    Ok(Json(ReportingHealthResponse {
        status: if ready { "connected" } else { "needs_update" },
        message: if ready {
            "Riverside reporting is ready.".to_string()
        } else {
            "The approved reporting data is not installed on this Main Hub. Run the normal Riverside update or repair process."
                .to_string()
        },
        latency_ms: start.elapsed().as_millis() as u64,
        configured: ready,
        staff_guidance: config.staff_note_markdown,
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
        config.max_rows.clamp(1, DEFAULT_MAX_ROWS),
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
    fn clamps_report_row_limit() {
        let mut spec = valid_spec();
        spec.limit = 10_000;
        validate_report_spec(&mut spec, false, 250).expect("valid report spec");
        assert_eq!(spec.limit, 250);
    }

    #[test]
    fn every_catalog_member_has_a_static_query_mapping() {
        for dataset in DATASETS {
            assert!(
                dataset_source(dataset.name).is_some(),
                "missing source for {}",
                dataset.name
            );
            for member in dataset
                .measures
                .iter()
                .chain(dataset.dimensions)
                .chain(dataset.time_dimensions)
            {
                assert!(
                    query_member(member.name).is_some(),
                    "missing query mapping for {}",
                    member.name
                );
            }
        }
    }

    #[test]
    fn report_query_uses_static_sql_and_bound_values() {
        let mut spec = valid_spec();
        spec.filters.push(ReportFilter {
            member: "booked_transactions.customer_name".to_string(),
            operator: "contains".to_string(),
            values: vec!["Riverside' OR TRUE --".to_string()],
        });
        validate_report_spec(&mut spec, false, 500).expect("valid report spec");
        let (sql, binds, output) = build_report_query(&spec).expect("governed query");
        assert!(sql.contains("reporting.transactions_core"));
        assert!(sql.contains("SET") == false);
        assert!(sql.contains("$1"));
        assert!(!sql.contains("Riverside' OR TRUE"));
        assert_eq!(binds.len(), 4);
        assert_eq!(
            output,
            vec![
                "booked_transactions.salesperson",
                "booked_transactions.business_date",
                "booked_transactions.gross_sales"
            ]
        );
    }
}
