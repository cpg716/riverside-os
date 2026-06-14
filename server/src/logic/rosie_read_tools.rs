use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool, Row};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct RosieReadToolDefinition {
    pub tool_name: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub required_permission: &'static str,
    pub basis: &'static str,
    pub max_rows: i64,
    pub read_only: bool,
    pub mutates_data: bool,
    pub sensitive_fields: &'static [&'static str],
}

impl Serialize for RosieReadToolDefinition {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct("RosieReadToolDefinition", 26)?;
        state.serialize_field("tool_name", self.tool_name)?;
        state.serialize_field("description", self.description)?;
        state.serialize_field("category", self.category)?;
        state.serialize_field("domain", planner_domain_for_tool(self))?;
        state.serialize_field("intent_examples", intent_examples_for_tool(self.tool_name))?;
        state.serialize_field(
            "negative_intent_examples",
            negative_intent_examples_for_tool(self.tool_name),
        )?;
        state.serialize_field("required_permission", self.required_permission)?;
        state.serialize_field("input_schema", input_schema_for_tool(self.tool_name))?;
        state.serialize_field(
            "required_arguments",
            required_arguments_for_tool(self.tool_name),
        )?;
        state.serialize_field(
            "optional_arguments",
            optional_arguments_for_tool(self.tool_name),
        )?;
        state.serialize_field("default_arguments", &default_arguments_for_tool(self))?;
        state.serialize_field("date_basis", date_basis_for_tool(self.tool_name))?;
        state.serialize_field("output_basis", self.basis)?;
        state.serialize_field("basis", self.basis)?;
        state.serialize_field("max_rows", &self.max_rows)?;
        state.serialize_field("default_limit", &DEFAULT_LIMIT.min(self.max_rows))?;
        state.serialize_field("sensitivity", sensitivity_for_tool(self))?;
        state.serialize_field("audit_policy", &"fail_closed")?;
        state.serialize_field("read_only", &self.read_only)?;
        state.serialize_field("mutation_allowed", &false)?;
        state.serialize_field("mutates_data", &self.mutates_data)?;
        state.serialize_field("sensitive_fields", self.sensitive_fields)?;
        state.serialize_field(
            "can_answer_questions",
            can_answer_questions_for_tool(self.tool_name),
        )?;
        state.serialize_field(
            "cannot_answer_questions",
            cannot_answer_questions_for_tool(self.tool_name),
        )?;
        state.serialize_field("ambiguity_rules", ambiguity_rules_for_tool(self.tool_name))?;
        state.serialize_field("clarification_prompt", clarification_prompt_for_tool(self))?;
        state.serialize_field(
            "wrong_domain_guards",
            wrong_domain_guards_for_tool(self.tool_name),
        )?;
        state.end()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosieReadToolResponse {
    pub tool_name: String,
    pub basis: String,
    pub filters_applied: Value,
    pub row_count: usize,
    pub limited: bool,
    pub warnings: Vec<String>,
    pub data_freshness: String,
    pub generated_at: DateTime<Utc>,
    pub data: Value,
}

#[derive(Debug)]
pub enum RosieReadToolError {
    UnknownTool,
    MutationToolRejected,
    InvalidInput(String),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for RosieReadToolError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

const DEFAULT_LIMIT: i64 = 25;
const MAX_LIMIT: i64 = 100;
const MAX_RANGE_DAYS: i64 = 366;

pub const ROSIE_READ_TOOLS: &[RosieReadToolDefinition] = &[
    RosieReadToolDefinition {
        tool_name: "search_customers_for_rosie",
        description: "Find customer records by name, customer code, email, or phone with minimized contact fields.",
        category: "customer",
        required_permission: crate::auth::permissions::CUSTOMERS_HUB_VIEW,
        basis: "customer_search",
        max_rows: 25,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["email", "phone"],
    },
    RosieReadToolDefinition {
        tool_name: "get_customer_loyalty_balance",
        description: "Read a customer's current loyalty point balance.",
        category: "customer",
        required_permission: crate::auth::permissions::CUSTOMERS_HUB_VIEW,
        basis: "loyalty_balance",
        max_rows: 1,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_customers_with_open_balances",
        description: "List customers with open order balances.",
        category: "customer",
        required_permission: crate::auth::permissions::CUSTOMERS_HUB_VIEW,
        basis: "open_balance",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_customers_needing_follow_up",
        description: "List customers with operational follow-up reasons such as stale ready pickups, open balances, upcoming appointments, or missing contact information.",
        category: "customer",
        required_permission: crate::auth::permissions::CUSTOMERS_HUB_VIEW,
        basis: "follow_up_reasons",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["open_balance_due"],
    },
    RosieReadToolDefinition {
        tool_name: "get_customer_purchase_history_summary",
        description: "Summarize a customer's non-cancelled transaction history without payment metadata.",
        category: "customer",
        required_permission: crate::auth::permissions::ORDERS_VIEW,
        basis: "customer_purchase_history",
        max_rows: 1,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_customer_size_profile_summary",
        description: "Read a customer's latest size profile summary.",
        category: "customer",
        required_permission: crate::auth::permissions::CUSTOMERS_MEASUREMENTS,
        basis: "customer_measurements",
        max_rows: 1,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["measurements"],
    },
    RosieReadToolDefinition {
        tool_name: "get_inventory_availability",
        description: "Search active inventory availability by product, SKU, barcode, size, color, or variation text.",
        category: "inventory",
        required_permission: crate::auth::permissions::CATALOG_VIEW,
        basis: "available_inventory",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_inventory_reorder_candidates",
        description: "Return inventory reorder and markdown candidates based on recent sales velocity and stock.",
        category: "inventory",
        required_permission: crate::auth::permissions::CATALOG_VIEW,
        basis: "sales_velocity_45_days",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_product_sales_by_query",
        description: "Answer how many matching products or SKUs sold in a bounded date range without exposing margin or payment metadata.",
        category: "sales",
        required_permission: crate::auth::permissions::INSIGHTS_VIEW,
        basis: "booked_at_sales_quantity",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_open_orders_ready_for_pickup",
        description: "List open transaction lines marked ready for pickup.",
        category: "orders",
        required_permission: crate::auth::permissions::ORDERS_VIEW,
        basis: "ready_for_pickup",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_open_orders",
        description: "List open transaction lines that have not been picked up or cancelled.",
        category: "orders",
        required_permission: crate::auth::permissions::ORDERS_VIEW,
        basis: "open_order_lines",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_appointments_by_date",
        description: "List scheduled appointments in a bounded date range.",
        category: "appointments",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "appointment_date",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["phone"],
    },
    RosieReadToolDefinition {
        tool_name: "get_alterations_due",
        description: "List alteration orders due in a bounded date range.",
        category: "alterations",
        required_permission: crate::auth::permissions::ALTERATIONS_MANAGE,
        basis: "alteration_due_at",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_wedding_readiness",
        description: "Read the existing Wedding Manager readiness detail for one wedding party.",
        category: "weddings",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "wedding_readiness",
        max_rows: 1,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["balance_due"],
    },
    RosieReadToolDefinition {
        tool_name: "search_weddings_for_rosie",
        description: "Find wedding parties by party, groom, bride, venue, or salesperson with minimized fields.",
        category: "weddings",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "wedding_party_search",
        max_rows: 25,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_weddings_by_event_date_range",
        description: "List wedding readiness summaries for parties in a bounded event-date range.",
        category: "weddings",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "event_date",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["balance_due"],
    },
    RosieReadToolDefinition {
        tool_name: "get_wedding_members_missing_measurements",
        description: "List wedding members still missing measurements for upcoming events.",
        category: "weddings",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "missing_measurements",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_upcoming_wedding_risk_report",
        description: "List upcoming wedding parties with watch, at-risk, or critical readiness status.",
        category: "weddings",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "wedding_readiness_event_date",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["balance_due"],
    },
    RosieReadToolDefinition {
        tool_name: "get_wedding_members_missing_fittings",
        description: "List wedding members still missing fittings for upcoming events.",
        category: "weddings",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "missing_fittings",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_wedding_members_with_open_balances",
        description: "List wedding members with open transaction balances.",
        category: "weddings",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "wedding_member_open_balance",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["balance_due"],
    },
    RosieReadToolDefinition {
        tool_name: "get_wedding_orders_ready_for_pickup",
        description: "List wedding transaction lines marked ready for pickup.",
        category: "weddings",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "wedding_ready_for_pickup",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_wedding_unfulfilled_items",
        description: "Summarize wedding transaction lines that are not fulfilled before upcoming events.",
        category: "weddings",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "wedding_unfulfilled_lines",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_wedding_follow_up_list",
        description: "List wedding parties that need operational follow-up based on readiness, missing measurements, fittings, balances, or pickup state.",
        category: "weddings",
        required_permission: crate::auth::permissions::WEDDINGS_VIEW,
        basis: "wedding_follow_up_signals",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["balance_due"],
    },
    RosieReadToolDefinition {
        tool_name: "get_open_purchase_orders",
        description: "List open purchase orders and remaining units by vendor.",
        category: "purchasing",
        required_permission: crate::auth::permissions::PROCUREMENT_VIEW,
        basis: "open_purchase_orders",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "search_vendors_for_rosie",
        description: "Find vendors by name, code, or account number with minimized contact fields.",
        category: "vendors",
        required_permission: crate::auth::permissions::PROCUREMENT_VIEW,
        basis: "vendor_search",
        max_rows: 25,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["email", "phone"],
    },
    RosieReadToolDefinition {
        tool_name: "get_customers_with_stale_pickups",
        description: "List customers with ready-for-pickup lines older than the stale pickup threshold.",
        category: "customer",
        required_permission: crate::auth::permissions::CUSTOMERS_HUB_VIEW,
        basis: "stale_ready_pickup",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_customers_with_missing_contact_info",
        description: "List customers missing both phone and email using presence flags only.",
        category: "customer",
        required_permission: crate::auth::permissions::CUSTOMERS_HUB_VIEW,
        basis: "missing_contact_info",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["email", "phone"],
    },
    RosieReadToolDefinition {
        tool_name: "get_recent_receipts",
        description: "List recent receiving events by vendor, invoice, units, and line cost.",
        category: "purchasing",
        required_permission: crate::auth::permissions::PROCUREMENT_VIEW,
        basis: "receiving_events",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["total_line_cost"],
    },
    RosieReadToolDefinition {
        tool_name: "get_unmatched_vendor_items",
        description: "List vendor item cross-references that are not mapped to a Riverside OS product variant.",
        category: "purchasing",
        required_permission: crate::auth::permissions::PROCUREMENT_VIEW,
        basis: "unmatched_vendor_items",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["vend_cost"],
    },
    RosieReadToolDefinition {
        tool_name: "get_items_on_order",
        description: "List active purchase order lines that still have units remaining.",
        category: "purchasing",
        required_permission: crate::auth::permissions::PROCUREMENT_VIEW,
        basis: "purchase_order_remaining_units",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["unit_cost"],
    },
    RosieReadToolDefinition {
        tool_name: "get_po_invoice_exception_report",
        description: "Summarize purchase orders and receiving events with invoice or freight review signals.",
        category: "purchasing",
        required_permission: crate::auth::permissions::PROCUREMENT_VIEW,
        basis: "po_invoice_review",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["freight_total"],
    },
    RosieReadToolDefinition {
        tool_name: "get_customer_credit_summary",
        description: "Summarize a selected customer's store credit, loyalty points, open balance, and gift card presence without changing balances.",
        category: "customer_credit",
        required_permission: crate::auth::permissions::STORE_CREDIT_MANAGE,
        basis: "customer_credit_summary",
        max_rows: 1,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["store_credit_balance", "gift_card_balance", "open_balance_due"],
    },
    RosieReadToolDefinition {
        tool_name: "get_store_credit_summary",
        description: "Summarize active store credit balances without changing balances.",
        category: "store_credit",
        required_permission: crate::auth::permissions::STORE_CREDIT_MANAGE,
        basis: "store_credit_balance",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["balance"],
    },
    RosieReadToolDefinition {
        tool_name: "get_gift_card_summary",
        description: "Summarize outstanding gift card counts and balances without exposing full card numbers.",
        category: "gift_cards",
        required_permission: crate::auth::permissions::GIFT_CARDS_MANAGE,
        basis: "gift_card_liability_summary",
        max_rows: 20,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["current_balance"],
    },
    RosieReadToolDefinition {
        tool_name: "get_outstanding_credit_liability_summary",
        description: "Summarize outstanding store credit and gift card balances separately.",
        category: "accounting",
        required_permission: crate::auth::permissions::QBO_VIEW,
        basis: "credit_liability_summary",
        max_rows: 1,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["store_credit_balance", "gift_card_balance"],
    },
    RosieReadToolDefinition {
        tool_name: "get_gift_card_exception_report",
        description: "Summarize gift card records needing review without exposing full card numbers.",
        category: "gift_cards",
        required_permission: crate::auth::permissions::GIFT_CARDS_MANAGE,
        basis: "gift_card_review",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["current_balance"],
    },
    RosieReadToolDefinition {
        tool_name: "get_qbo_exception_summary",
        description: "Summarize QBO staging rows that are pending, failed, or otherwise need accounting review.",
        category: "accounting",
        required_permission: crate::auth::permissions::QBO_VIEW,
        basis: "qbo_staging_status",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["error_message"],
    },
    RosieReadToolDefinition {
        tool_name: "get_qbo_sync_summary",
        description: "Summarize QBO sync status counts by journal date without posting or retrying anything.",
        category: "accounting",
        required_permission: crate::auth::permissions::QBO_VIEW,
        basis: "qbo_sync_date",
        max_rows: 20,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["error_message"],
    },
    RosieReadToolDefinition {
        tool_name: "get_register_exception_summary",
        description: "Summarize register sessions needing review, including stale open drawers and cash variance.",
        category: "register",
        required_permission: crate::auth::permissions::REGISTER_REPORTS,
        basis: "register_close_date",
        max_rows: 50,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["cash_over_short"],
    },
    RosieReadToolDefinition {
        tool_name: "get_daily_manager_brief",
        description: "Return a cross-system read-only manager brief for today's operational workload and exceptions.",
        category: "operations",
        required_permission: crate::auth::permissions::INSIGHTS_VIEW,
        basis: "store_local_today",
        max_rows: 1,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["open_balance_due", "store_credit_balance"],
    },
    RosieReadToolDefinition {
        tool_name: "get_data_quality_summary",
        description: "Summarize common data quality issues that need review without dumping raw records.",
        category: "operations",
        required_permission: crate::auth::permissions::INSIGHTS_VIEW,
        basis: "data_quality_counts",
        max_rows: 1,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_data_cleanup_tasks",
        description: "Return prioritized data cleanup counts grouped by owning Riverside OS workspace.",
        category: "operations",
        required_permission: crate::auth::permissions::INSIGHTS_VIEW,
        basis: "data_cleanup_counts",
        max_rows: 20,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_manager_attention_queue",
        description: "Return prioritized read-only manager attention items for today across weddings, customers, inventory, purchasing, register, and QBO.",
        category: "operations",
        required_permission: crate::auth::permissions::INSIGHTS_VIEW,
        basis: "manager_attention_queue",
        max_rows: 20,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &["cash_over_short", "store_credit_balance"],
    },
    RosieReadToolDefinition {
        tool_name: "get_best_sellers",
        description: "Run the approved best sellers report for a bounded date range.",
        category: "reporting",
        required_permission: crate::auth::permissions::INSIGHTS_VIEW,
        basis: "approved_best_sellers_report",
        max_rows: 100,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_sales_summary",
        description: "Run the approved sales pivot report for a bounded date range.",
        category: "reporting",
        required_permission: crate::auth::permissions::INSIGHTS_VIEW,
        basis: "approved_sales_pivot_report",
        max_rows: 100,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
    RosieReadToolDefinition {
        tool_name: "get_stale_inventory",
        description: "Run the approved dead stock report for a bounded date range.",
        category: "reporting",
        required_permission: crate::auth::permissions::INSIGHTS_VIEW,
        basis: "approved_dead_stock_report",
        max_rows: 100,
        read_only: true,
        mutates_data: false,
        sensitive_fields: &[],
    },
];

pub fn list_rosie_read_tools() -> &'static [RosieReadToolDefinition] {
    ROSIE_READ_TOOLS
}

pub fn tool_definition(tool_name: &str) -> Option<&'static RosieReadToolDefinition> {
    ROSIE_READ_TOOLS
        .iter()
        .find(|tool| tool.tool_name == tool_name)
}

pub fn mutation_like_tool_name(tool_name: &str) -> bool {
    let lower = tool_name
        .to_ascii_lowercase()
        .replace("unfulfilled", "unfilled");
    [
        "write",
        "update",
        "delete",
        "adjust",
        "post",
        "refund",
        "reconcile",
        "receive",
        "fulfill",
        "discount",
        "import",
        "merge",
        "archive",
        "sql",
        "query_database",
        "ask_postgres",
        "raw_table",
    ]
    .iter()
    .any(|blocked| lower.contains(blocked))
}

pub fn tool_requires_audit_fail_closed(tool_name: &str) -> bool {
    tool_definition(tool_name).is_some()
}

fn sensitivity_for_tool(def: &RosieReadToolDefinition) -> &'static str {
    match def.category {
        "accounting" => "accounting_sensitive",
        "gift_cards" | "store_credit" | "customer_credit" => "financial_sensitive",
        "customer" if !def.sensitive_fields.is_empty() => "customer_sensitive",
        "weddings" if !def.sensitive_fields.is_empty() => "customer_sensitive",
        "register" | "purchasing" | "operations" => "operational",
        _ => "low",
    }
}

fn planner_domain_for_tool(def: &RosieReadToolDefinition) -> &'static str {
    match def.category {
        "customer" => "customers",
        "customer_credit" => "store_credit",
        "operations" => match def.tool_name {
            "get_data_quality_summary" | "get_data_cleanup_tasks" => "data_quality",
            "get_daily_manager_brief" | "get_manager_attention_queue" => "manager_brief",
            _ => "operations",
        },
        "register" => "accounting",
        "reporting" => match def.tool_name {
            "get_best_sellers" | "get_sales_summary" => "sales",
            "get_stale_inventory" => "inventory",
            _ => "help_docs",
        },
        other => other,
    }
}

fn intent_examples_for_tool(tool_name: &str) -> &'static [&'static str] {
    match tool_name {
        "get_open_orders" => &[
            "Do we have any open orders?",
            "How many orders are open right now?",
        ],
        "get_open_orders_ready_for_pickup" => &[
            "Do we have orders ready for pickup?",
            "Which orders are ready to pick up?",
        ],
        "get_inventory_availability" => &[
            "Do we have navy suits in 40R?",
            "How many of this SKU are available?",
        ],
        "get_product_sales_by_query" => &[
            "How many tuxes sold in June?",
            "How many Gruppo suits sold last month?",
        ],
        "get_appointments_by_date" => &["What appointments are today?"],
        "get_wedding_members_missing_measurements" => {
            &["Who is missing measurements for upcoming weddings?"]
        }
        "get_upcoming_wedding_risk_report" => &["Which weddings need attention this week?"],
        "get_recent_receipts" => &["What did we receive this week?"],
        "get_open_purchase_orders" => &["What purchase orders are open?"],
        "get_items_on_order" => &["What items are on order?"],
        "get_customer_credit_summary" => &["Does this customer have store credit?"],
        "get_store_credit_summary" => &["How much active store credit is outstanding?"],
        "get_gift_card_summary" => &["What is the gift card balance summary?"],
        "get_qbo_exception_summary" => &["Does QBO have errors?"],
        "get_manager_attention_queue" => &["What needs manager attention today?"],
        _ => &[],
    }
}

fn negative_intent_examples_for_tool(tool_name: &str) -> &'static [&'static str] {
    match tool_name {
        "get_inventory_availability" => &[
            "Do we have open orders?",
            "What purchase orders are open?",
            "Does QBO have errors?",
        ],
        "get_open_orders" => &["What POs are open?", "Do we have navy suits in stock?"],
        "get_customer_loyalty_balance" => &["Does this customer have store credit?"],
        "get_store_credit_summary" => &["How many loyalty points does this customer have?"],
        "get_sales_summary" => &[
            "Does QBO have errors?",
            "What credit liability is outstanding?",
        ],
        _ => &[],
    }
}

fn required_arguments_for_tool(tool_name: &str) -> &'static [&'static str] {
    match tool_name {
        "get_customer_loyalty_balance"
        | "get_customer_purchase_history_summary"
        | "get_customer_size_profile_summary"
        | "get_customer_credit_summary" => &["customer_id"],
        "get_wedding_readiness" => &["wedding_id"],
        "search_customers_for_rosie"
        | "search_weddings_for_rosie"
        | "search_vendors_for_rosie"
        | "get_inventory_availability"
        | "get_product_sales_by_query" => &["query"],
        _ => &[],
    }
}

fn optional_arguments_for_tool(tool_name: &str) -> &'static [&'static str] {
    match tool_name {
        "get_inventory_availability"
        | "get_product_sales_by_query"
        | "get_appointments_by_date"
        | "get_alterations_due"
        | "get_weddings_by_event_date_range"
        | "get_upcoming_wedding_risk_report"
        | "get_wedding_members_missing_measurements"
        | "get_wedding_members_missing_fittings"
        | "get_wedding_members_with_open_balances"
        | "get_wedding_orders_ready_for_pickup"
        | "get_wedding_unfulfilled_items"
        | "get_wedding_follow_up_list"
        | "get_recent_receipts"
        | "get_qbo_sync_summary"
        | "get_register_exception_summary" => &["from", "to", "limit"],
        _ => &["limit"],
    }
}

fn default_arguments_for_tool(def: &RosieReadToolDefinition) -> Value {
    json!({ "limit": DEFAULT_LIMIT.min(def.max_rows) })
}

fn date_basis_for_tool(tool_name: &str) -> &'static str {
    match tool_name {
        "get_product_sales_by_query" | "get_sales_summary" | "get_best_sellers" => "booked_at",
        "get_appointments_by_date" => "appointment_date",
        "get_alterations_due" => "alteration_due_at",
        "get_weddings_by_event_date_range"
        | "get_upcoming_wedding_risk_report"
        | "get_wedding_members_missing_measurements"
        | "get_wedding_members_missing_fittings"
        | "get_wedding_members_with_open_balances"
        | "get_wedding_orders_ready_for_pickup"
        | "get_wedding_unfulfilled_items"
        | "get_wedding_follow_up_list" => "event_date",
        "get_recent_receipts" => "received_at",
        "get_qbo_sync_summary" => "journal_date",
        "get_register_exception_summary" => "business_date",
        _ => "not_date_scoped",
    }
}

fn can_answer_questions_for_tool(tool_name: &str) -> &'static [&'static str] {
    match tool_name {
        "get_inventory_availability" => &["available on-hand/reserved/layaway stock by item query"],
        "get_open_orders" => &["open Riverside OS order lines by lifecycle status"],
        "get_product_sales_by_query" => &["units sold for a product query in a bounded date range"],
        "get_qbo_exception_summary" => &["QBO staging rows that need accounting review"],
        "get_customer_credit_summary" => {
            &["selected customer credit, loyalty, and open balance summary"]
        }
        _ => &["approved read-only summary for this tool's basis"],
    }
}

fn cannot_answer_questions_for_tool(tool_name: &str) -> &'static [&'static str] {
    match tool_name {
        "get_inventory_availability" => &["open orders", "purchase orders", "sales history"],
        "get_open_orders" => &["inventory availability", "purchase orders", "QBO state"],
        "get_customer_loyalty_balance" => &["store credit balance", "gift card liability"],
        "get_sales_summary" => &["QBO errors", "credit liabilities"],
        _ => &["write, post, adjust, reconcile, import, refund, fulfill, or mutate Riverside OS"],
    }
}

fn ambiguity_rules_for_tool(tool_name: &str) -> &'static [&'static str] {
    match tool_name {
        "get_customer_loyalty_balance"
        | "get_customer_purchase_history_summary"
        | "get_customer_size_profile_summary"
        | "get_customer_credit_summary" => {
            &["requires a selected customer_id; do not guess by first name"]
        }
        "get_wedding_readiness" => &["requires a selected wedding_id; do not guess by party name"],
        "get_inventory_availability" => {
            &["requires a concrete product, SKU, barcode, size, or color query"]
        }
        "get_product_sales_by_query" => {
            &["requires a product/category query; date range defaults must be stated"]
        }
        _ => &[],
    }
}

fn clarification_prompt_for_tool(def: &RosieReadToolDefinition) -> &'static str {
    match def.tool_name {
        "get_inventory_availability" => "Which item, SKU, barcode, size, or color should I check?",
        "get_product_sales_by_query" => "Which item/category and date range should I use?",
        "get_customer_loyalty_balance"
        | "get_customer_credit_summary"
        | "get_customer_purchase_history_summary"
        | "get_customer_size_profile_summary" => "Which customer record should I use?",
        "get_wedding_readiness" => "Which wedding party should I use?",
        _ => "Which Riverside OS record or filter should I use?",
    }
}

fn wrong_domain_guards_for_tool(tool_name: &str) -> &'static [&'static str] {
    match tool_name {
        "get_inventory_availability" => &[
            "order/open order questions must not use inventory availability",
            "receiving/PO questions must not use inventory availability only",
        ],
        "get_open_orders" | "get_open_orders_ready_for_pickup" => {
            &["purchase order questions must use purchasing tools"]
        }
        "get_sales_summary" | "get_best_sellers" | "get_product_sales_by_query" => {
            &["accounting/QBO questions must not use sales summary only"]
        }
        "get_customer_loyalty_balance" => {
            &["store credit/gift card questions must not use loyalty balance only"]
        }
        "get_wedding_readiness"
        | "get_wedding_members_missing_measurements"
        | "get_upcoming_wedding_risk_report" => {
            &["wedding readiness questions must not use generic customer search only"]
        }
        _ => &[],
    }
}

fn input_schema_for_tool(tool_name: &str) -> &'static str {
    match tool_name {
        "get_customer_loyalty_balance"
        | "get_customer_purchase_history_summary"
        | "get_customer_size_profile_summary"
        | "get_customer_credit_summary" => r#"{"customer_id":"uuid"}"#,
        "get_wedding_readiness" => r#"{"wedding_id":"uuid"}"#,
        "search_customers_for_rosie"
        | "search_weddings_for_rosie"
        | "search_vendors_for_rosie"
        | "get_inventory_availability"
        | "get_product_sales_by_query" => {
            r#"{"query":"string","from":"YYYY-MM-DD optional","to":"YYYY-MM-DD optional","limit":"number optional"}"#
        }
        "get_appointments_by_date"
        | "get_alterations_due"
        | "get_weddings_by_event_date_range"
        | "get_upcoming_wedding_risk_report"
        | "get_wedding_members_missing_measurements"
        | "get_wedding_members_missing_fittings"
        | "get_wedding_members_with_open_balances"
        | "get_wedding_orders_ready_for_pickup"
        | "get_wedding_unfulfilled_items"
        | "get_wedding_follow_up_list"
        | "get_recent_receipts"
        | "get_qbo_sync_summary"
        | "get_register_exception_summary" => {
            r#"{"from":"YYYY-MM-DD optional","to":"YYYY-MM-DD optional","limit":"number optional"}"#
        }
        _ => r#"{"limit":"number optional"}"#,
    }
}

fn limit_from_args(args: &Value, max_rows: i64) -> i64 {
    args.get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, max_rows.min(MAX_LIMIT))
}

fn optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn required_uuid(args: &Value, key: &str) -> Result<Uuid, RosieReadToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .ok_or_else(|| RosieReadToolError::InvalidInput(format!("{key} must be a UUID")))
}

fn parse_date_arg(args: &Value, key: &str) -> Result<Option<NaiveDate>, RosieReadToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| RosieReadToolError::InvalidInput(format!("{key} must be YYYY-MM-DD")))
        })
        .transpose()
}

fn bounded_date_range(
    args: &Value,
    default_days: i64,
) -> Result<(NaiveDate, NaiveDate), RosieReadToolError> {
    let today = Utc::now().date_naive();
    let from = parse_date_arg(args, "from")?.unwrap_or(today);
    let to =
        parse_date_arg(args, "to")?.unwrap_or_else(|| today + chrono::Duration::days(default_days));
    if to < from {
        return Err(RosieReadToolError::InvalidInput(
            "to must be on or after from".to_string(),
        ));
    }
    if (to - from).num_days() > MAX_RANGE_DAYS {
        return Err(RosieReadToolError::InvalidInput(format!(
            "date range cannot exceed {MAX_RANGE_DAYS} days"
        )));
    }
    Ok((from, to))
}

fn response(
    tool_name: &str,
    basis: &str,
    filters_applied: Value,
    limit: i64,
    mut rows: Vec<Value>,
    warnings: Vec<String>,
) -> RosieReadToolResponse {
    let limited = rows.len() > limit as usize;
    if limited {
        rows.truncate(limit as usize);
    }
    RosieReadToolResponse {
        tool_name: tool_name.to_string(),
        basis: basis.to_string(),
        filters_applied,
        row_count: rows.len(),
        limited,
        warnings,
        data_freshness: "live_database_read".to_string(),
        generated_at: Utc::now(),
        data: Value::Array(rows),
    }
}

#[derive(Debug, Serialize, FromRow)]
struct CustomerSearchRow {
    id: Uuid,
    customer_code: Option<String>,
    first_name: String,
    last_name: String,
    email_present: bool,
    phone_present: bool,
    loyalty_points: i32,
}

async fn search_customers(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let query = optional_string(args, "query")
        .ok_or_else(|| RosieReadToolError::InvalidInput("query is required".to_string()))?;
    if query.len() < 2 {
        return Err(RosieReadToolError::InvalidInput(
            "query must be at least 2 characters".to_string(),
        ));
    }
    let limit = limit_from_args(args, def.max_rows);
    let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%"));
    let rows: Vec<CustomerSearchRow> = sqlx::query_as(
        r#"
        SELECT id, customer_code, first_name, last_name,
               NULLIF(trim(COALESCE(email, '')), '') IS NOT NULL AS email_present,
               NULLIF(trim(COALESCE(phone, '')), '') IS NOT NULL AS phone_present,
               COALESCE(loyalty_points, 0)::int4 AS loyalty_points
        FROM customers
        WHERE first_name ILIKE $1 ESCAPE '\'
           OR last_name ILIKE $1 ESCAPE '\'
           OR customer_code ILIKE $1 ESCAPE '\'
           OR email ILIKE $1 ESCAPE '\'
           OR phone ILIKE $1 ESCAPE '\'
        ORDER BY last_name ASC, first_name ASC
        LIMIT $2
        "#,
    )
    .bind(&pattern)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "query": query, "limit": limit }),
        limit,
        data,
        vec!["Contact values are minimized to presence flags.".to_string()],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct WeddingSearchRow {
    wedding_id: Uuid,
    wedding_name: String,
    groom_name: String,
    bride_name: Option<String>,
    event_date: NaiveDate,
    party_type: String,
    venue: Option<String>,
    salesperson: Option<String>,
}

async fn search_weddings(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let query = optional_string(args, "query")
        .ok_or_else(|| RosieReadToolError::InvalidInput("query is required".to_string()))?;
    if query.len() < 2 {
        return Err(RosieReadToolError::InvalidInput(
            "query must be at least 2 characters".to_string(),
        ));
    }
    let limit = limit_from_args(args, def.max_rows);
    let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%"));
    let rows: Vec<WeddingSearchRow> = sqlx::query_as(
        r#"
        SELECT id AS wedding_id,
               COALESCE(NULLIF(party_name, ''), groom_name) AS wedding_name,
               groom_name,
               NULLIF(bride_name, '') AS bride_name,
               event_date,
               party_type,
               NULLIF(venue, '') AS venue,
               NULLIF(salesperson, '') AS salesperson
        FROM wedding_parties
        WHERE COALESCE(is_deleted, false) = false
          AND (
              party_name ILIKE $1 ESCAPE '\'
              OR groom_name ILIKE $1 ESCAPE '\'
              OR bride_name ILIKE $1 ESCAPE '\'
              OR venue ILIKE $1 ESCAPE '\'
              OR salesperson ILIKE $1 ESCAPE '\'
          )
        ORDER BY event_date ASC, groom_name ASC
        LIMIT $2
        "#,
    )
    .bind(&pattern)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "query": query, "limit": limit }),
        limit,
        data,
        vec![
            "Wedding search excludes deleted parties and does not expose phone or email."
                .to_string(),
        ],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct VendorSearchRow {
    vendor_id: Uuid,
    vendor_name: String,
    vendor_code: Option<String>,
    account_number: Option<String>,
    email_present: bool,
    phone_present: bool,
    is_active: bool,
}

async fn search_vendors(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let query = optional_string(args, "query")
        .ok_or_else(|| RosieReadToolError::InvalidInput("query is required".to_string()))?;
    if query.len() < 2 {
        return Err(RosieReadToolError::InvalidInput(
            "query must be at least 2 characters".to_string(),
        ));
    }
    let limit = limit_from_args(args, def.max_rows);
    let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%"));
    let rows: Vec<VendorSearchRow> = sqlx::query_as(
        r#"
        SELECT id AS vendor_id,
               name AS vendor_name,
               NULLIF(vendor_code, '') AS vendor_code,
               NULLIF(account_number, '') AS account_number,
               NULLIF(trim(COALESCE(email, '')), '') IS NOT NULL AS email_present,
               NULLIF(trim(COALESCE(phone, '')), '') IS NOT NULL AS phone_present,
               is_active
        FROM vendors
        WHERE name ILIKE $1 ESCAPE '\'
           OR vendor_code ILIKE $1 ESCAPE '\'
           OR account_number ILIKE $1 ESCAPE '\'
        ORDER BY is_active DESC, name ASC
        LIMIT $2
        "#,
    )
    .bind(&pattern)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "query": query, "limit": limit }),
        limit,
        data,
        vec!["Vendor contact values are minimized to presence flags.".to_string()],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct CustomerLoyaltyRow {
    customer_id: Uuid,
    customer_code: Option<String>,
    first_name: String,
    last_name: String,
    loyalty_points: i32,
}

async fn customer_loyalty_balance(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let customer_id = required_uuid(args, "customer_id")?;
    let row: Option<CustomerLoyaltyRow> = sqlx::query_as(
        r#"
        SELECT id AS customer_id, customer_code, first_name, last_name,
               COALESCE(loyalty_points, 0)::int4 AS loyalty_points
        FROM customers
        WHERE id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?;
    let rows = row
        .map(|row| vec![serde_json::to_value(row).unwrap_or_else(|_| json!({}))])
        .unwrap_or_default();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "customer_id": customer_id }),
        1,
        rows,
        Vec::new(),
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct CustomerOpenBalanceRow {
    customer_id: Uuid,
    customer_code: Option<String>,
    first_name: String,
    last_name: String,
    open_balance_due: Decimal,
    open_order_count: i64,
}

async fn customers_with_open_balances(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<CustomerOpenBalanceRow> = sqlx::query_as(
        r#"
        SELECT c.id AS customer_id, c.customer_code, c.first_name, c.last_name,
               COALESCE(SUM(t.balance_due), 0)::numeric(12, 2) AS open_balance_due,
               COUNT(DISTINCT t.id)::bigint AS open_order_count
        FROM customers c
        JOIN transactions t ON t.customer_id = c.id
        WHERE t.status::text = 'open'
          AND COALESCE(t.balance_due, 0) > 0
        GROUP BY c.id, c.customer_code, c.first_name, c.last_name
        ORDER BY open_balance_due DESC, c.last_name ASC
        LIMIT $1
        "#,
    )
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "limit": limit }),
        limit,
        data,
        vec![
            "Open balance is based on transactions.status = open and balance_due > 0.".to_string(),
        ],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct InventoryAvailabilityRow {
    variant_id: Uuid,
    product_id: Uuid,
    sku: String,
    product_name: String,
    variation_label: Option<String>,
    stock_on_hand: i32,
    reserved_stock: i32,
    available_stock: i32,
    reorder_point: Option<i32>,
}

async fn inventory_availability(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let query = optional_string(args, "query")
        .or_else(|| optional_string(args, "sku"))
        .ok_or_else(|| RosieReadToolError::InvalidInput("query or sku is required".to_string()))?;
    if query.len() < 2 {
        return Err(RosieReadToolError::InvalidInput(
            "query must be at least 2 characters".to_string(),
        ));
    }
    let limit = limit_from_args(args, def.max_rows);
    let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%"));
    let rows: Vec<InventoryAvailabilityRow> = sqlx::query_as(
        r#"
        SELECT pv.id AS variant_id, p.id AS product_id, pv.sku, p.name AS product_name,
               pv.variation_label,
               COALESCE(pv.stock_on_hand, 0)::int4 AS stock_on_hand,
               COALESCE(pv.reserved_stock, 0)::int4 AS reserved_stock,
               GREATEST(COALESCE(pv.stock_on_hand, 0) - COALESCE(pv.reserved_stock, 0), 0)::int4 AS available_stock,
               pv.reorder_point
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        WHERE p.is_active = TRUE
          AND (
              p.name ILIKE $1 ESCAPE '\'
              OR pv.sku ILIKE $1 ESCAPE '\'
              OR pv.variation_label ILIKE $1 ESCAPE '\'
              OR pv.vendor_upc ILIKE $1 ESCAPE '\'
              OR pv.variation_values::text ILIKE $1 ESCAPE '\'
          )
        ORDER BY available_stock DESC, p.name ASC, pv.sku ASC
        LIMIT $2
        "#,
    )
    .bind(&pattern)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "query": query, "limit": limit }),
        limit,
        data,
        vec!["Available stock is stock_on_hand minus reserved_stock, floored at zero.".to_string()],
    ))
}

pub async fn inventory_reorder_candidates(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows = crate::logic::inventory_brain::query_inventory_recommendations(pool).await?;
    let data = rows
        .into_iter()
        .take((limit + 1) as usize)
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "lookback_days": 45, "limit": limit }),
        limit,
        data,
        vec!["Suggestions are read-only and based on recent sales velocity; staff must review before purchasing.".to_string()],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct ProductSalesByQueryRow {
    product_id: Option<Uuid>,
    variant_id: Option<Uuid>,
    sku: Option<String>,
    product_name: Option<String>,
    variation_label: Option<String>,
    units_sold: i64,
    transaction_count: i64,
}

async fn product_sales_by_query(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let query = optional_string(args, "query")
        .ok_or_else(|| RosieReadToolError::InvalidInput("query is required".to_string()))?;
    if query.len() < 2 {
        return Err(RosieReadToolError::InvalidInput(
            "query must be at least 2 characters".to_string(),
        ));
    }
    let (from, to) = bounded_date_range(args, 30)?;
    let limit = limit_from_args(args, def.max_rows);
    let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%"));
    let rows: Vec<ProductSalesByQueryRow> = sqlx::query_as(
        r#"
        SELECT tl.product_id,
               tl.variant_id,
               pv.sku,
               p.name AS product_name,
               pv.variation_label,
               COALESCE(SUM(tl.quantity), 0)::bigint AS units_sold,
               COUNT(DISTINCT t.id)::bigint AS transaction_count
        FROM transaction_lines tl
        JOIN transactions t ON t.id = tl.transaction_id
        LEFT JOIN products p ON p.id = tl.product_id
        LEFT JOIN product_variants pv ON pv.id = tl.variant_id
        WHERE t.status::text <> 'cancelled'
          AND tl.quantity > 0
          AND (t.booked_at AT TIME ZONE reporting.effective_store_timezone())::date >= $1
          AND (t.booked_at AT TIME ZONE reporting.effective_store_timezone())::date <= $2
          AND (
              p.name ILIKE $3 ESCAPE '\'
              OR pv.sku ILIKE $3 ESCAPE '\'
              OR pv.variation_label ILIKE $3 ESCAPE '\'
              OR pv.variation_values::text ILIKE $3 ESCAPE '\'
          )
        GROUP BY tl.product_id, tl.variant_id, pv.sku, p.name, pv.variation_label
        ORDER BY units_sold DESC, transaction_count DESC, p.name ASC
        LIMIT $4
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(&pattern)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "query": query, "from": from, "to": to, "limit": limit }),
        limit,
        data,
        vec![
            "Sales quantity uses transaction booked_at in the configured store timezone and excludes cancelled transactions.".to_string(),
            "This tool returns units and transaction counts only; it does not expose margin, cost, or payment metadata.".to_string(),
        ],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct ReadyForPickupRow {
    transaction_id: Uuid,
    transaction_display_id: Option<String>,
    customer_id: Option<Uuid>,
    customer_name: Option<String>,
    line_id: Uuid,
    sku: Option<String>,
    product_name: Option<String>,
    quantity: i32,
    ready_for_pickup_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, FromRow)]
struct OpenOrderRow {
    transaction_id: Uuid,
    transaction_display_id: Option<String>,
    customer_id: Option<Uuid>,
    customer_name: Option<String>,
    line_id: Uuid,
    sku: Option<String>,
    product_name: Option<String>,
    quantity: i32,
    fulfillment: String,
    order_lifecycle_status: String,
    need_by_date: Option<NaiveDate>,
    ready_for_pickup_at: Option<DateTime<Utc>>,
}

async fn open_orders(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<OpenOrderRow> = sqlx::query_as(
        r#"
        SELECT t.id AS transaction_id, t.display_id AS transaction_display_id,
               c.id AS customer_id,
               NULLIF(trim(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
               tl.id AS line_id, pv.sku, p.name AS product_name, tl.quantity,
               tl.fulfillment::text AS fulfillment,
               tl.order_lifecycle_status::text AS order_lifecycle_status,
               tl.need_by_date,
               tl.ready_for_pickup_at
        FROM transaction_lines tl
        JOIN transactions t ON t.id = tl.transaction_id
        LEFT JOIN customers c ON c.id = t.customer_id
        LEFT JOIN product_variants pv ON pv.id = tl.variant_id
        LEFT JOIN products p ON p.id = tl.product_id
        WHERE t.status::text <> 'cancelled'
          AND COALESCE(tl.quantity, 0) > 0
          AND COALESCE(tl.is_internal, false) = false
          AND tl.order_lifecycle_status <> 'picked_up'
          AND tl.fulfillment::text <> 'takeaway'
        ORDER BY t.booked_at ASC, tl.line_display_id ASC NULLS LAST, tl.id ASC
        LIMIT $1
        "#,
    )
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "limit": limit }),
        limit,
        data,
        vec![
            "Open orders are non-cancelled, non-internal, non-takeaway transaction lines whose order lifecycle status is not picked_up.".to_string(),
        ],
    ))
}

async fn open_orders_ready_for_pickup(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<ReadyForPickupRow> = sqlx::query_as(
        r#"
        SELECT t.id AS transaction_id, t.display_id AS transaction_display_id,
               c.id AS customer_id,
               NULLIF(trim(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
               tl.id AS line_id, pv.sku, p.name AS product_name, tl.quantity,
               tl.ready_for_pickup_at
        FROM transaction_lines tl
        JOIN transactions t ON t.id = tl.transaction_id
        LEFT JOIN customers c ON c.id = t.customer_id
        LEFT JOIN product_variants pv ON pv.id = tl.variant_id
        LEFT JOIN products p ON p.id = tl.product_id
        WHERE tl.order_lifecycle_status = 'ready_for_pickup'
          AND t.status::text <> 'cancelled'
          AND COALESCE(tl.quantity, 0) > 0
        ORDER BY tl.ready_for_pickup_at NULLS LAST, t.booked_at ASC
        LIMIT $1
        "#,
    )
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "limit": limit }),
        limit,
        data,
        vec![
            "Ready for pickup is line-level order_lifecycle_status = ready_for_pickup.".to_string(),
        ],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct AppointmentRow {
    appointment_id: Uuid,
    appointment_type: String,
    starts_at: DateTime<Utc>,
    status: String,
    customer_display_name: Option<String>,
    salesperson: Option<String>,
}

async fn appointments_by_date(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 0)?;
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<AppointmentRow> = sqlx::query_as(
        r#"
        SELECT id AS appointment_id, appointment_type, starts_at, status::text AS status,
               customer_display_name, salesperson
        FROM wedding_appointments
        WHERE (starts_at AT TIME ZONE reporting.effective_store_timezone())::date >= $1
          AND (starts_at AT TIME ZONE reporting.effective_store_timezone())::date <= $2
          AND status::text NOT IN ('cancelled', 'canceled')
        ORDER BY starts_at ASC
        LIMIT $3
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit }),
        limit,
        data,
        vec!["Appointment dates use the configured store timezone.".to_string()],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct AlterationDueRow {
    alteration_id: Uuid,
    ticket_number: Option<String>,
    status: String,
    due_at: Option<DateTime<Utc>>,
    customer_id: Option<Uuid>,
    customer_name: Option<String>,
    item_description: Option<String>,
    total_units_jacket: i32,
    total_units_pant: i32,
}

async fn alterations_due(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 7)?;
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<AlterationDueRow> = sqlx::query_as(
        r#"
        SELECT a.id AS alteration_id, a.ticket_number, a.status::text AS status, a.due_at,
               c.id AS customer_id,
               NULLIF(trim(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
               a.item_description,
               COALESCE(a.total_units_jacket, 0)::int4 AS total_units_jacket,
               COALESCE(a.total_units_pant, 0)::int4 AS total_units_pant
        FROM alteration_orders a
        LEFT JOIN customers c ON c.id = a.customer_id
        WHERE a.due_at IS NOT NULL
          AND (a.due_at AT TIME ZONE reporting.effective_store_timezone())::date >= $1
          AND (a.due_at AT TIME ZONE reporting.effective_store_timezone())::date <= $2
          AND a.status::text NOT IN ('completed', 'complete', 'cancelled', 'canceled', 'picked_up')
        ORDER BY a.due_at ASC
        LIMIT $3
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit }),
        limit,
        data,
        vec!["Alteration due dates use the configured store timezone.".to_string()],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct CustomerFollowUpRow {
    customer_id: Uuid,
    customer_code: Option<String>,
    first_name: String,
    last_name: String,
    email_present: bool,
    phone_present: bool,
    open_balance_due: Decimal,
    ready_for_pickup_count: i64,
    upcoming_appointment_count: i64,
    stale_ready_pickup_count: i64,
    missing_contact: bool,
    follow_up_reasons: Vec<String>,
}

async fn customers_needing_follow_up(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<CustomerFollowUpRow> = sqlx::query_as(
        r#"
        WITH balances AS (
            SELECT customer_id, COALESCE(SUM(balance_due), 0)::numeric(12, 2) AS open_balance_due
            FROM transactions
            WHERE customer_id IS NOT NULL
              AND status::text = 'open'
              AND COALESCE(balance_due, 0) > 0
            GROUP BY customer_id
        ),
        ready AS (
            SELECT t.customer_id,
                   COUNT(*) FILTER (WHERE tl.order_lifecycle_status = 'ready_for_pickup')::bigint AS ready_count,
                   COUNT(*) FILTER (
                       WHERE tl.order_lifecycle_status = 'ready_for_pickup'
                         AND COALESCE(tl.ready_for_pickup_at, t.booked_at) <= now() - INTERVAL '7 days'
                   )::bigint AS stale_ready_count
            FROM transactions t
            JOIN transaction_lines tl ON tl.transaction_id = t.id
            WHERE t.customer_id IS NOT NULL
              AND t.status::text <> 'cancelled'
            GROUP BY t.customer_id
        ),
        appts AS (
            SELECT customer_id, COUNT(*)::bigint AS appointment_count
            FROM wedding_appointments
            WHERE customer_id IS NOT NULL
              AND status::text NOT IN ('cancelled', 'canceled')
              AND starts_at >= now()
              AND starts_at < now() + INTERVAL '7 days'
            GROUP BY customer_id
        )
        SELECT c.id AS customer_id, c.customer_code, c.first_name, c.last_name,
               NULLIF(trim(COALESCE(c.email, '')), '') IS NOT NULL AS email_present,
               NULLIF(trim(COALESCE(c.phone, '')), '') IS NOT NULL AS phone_present,
               COALESCE(b.open_balance_due, 0)::numeric(12, 2) AS open_balance_due,
               COALESCE(r.ready_count, 0)::bigint AS ready_for_pickup_count,
               COALESCE(a.appointment_count, 0)::bigint AS upcoming_appointment_count,
               COALESCE(r.stale_ready_count, 0)::bigint AS stale_ready_pickup_count,
               (NULLIF(trim(COALESCE(c.email, '')), '') IS NULL
                 AND NULLIF(trim(COALESCE(c.phone, '')), '') IS NULL) AS missing_contact,
               ARRAY_REMOVE(ARRAY[
                   CASE WHEN COALESCE(b.open_balance_due, 0) > 0 THEN 'open_balance' END,
                   CASE WHEN COALESCE(r.ready_count, 0) > 0 THEN 'ready_for_pickup' END,
                   CASE WHEN COALESCE(r.stale_ready_count, 0) > 0 THEN 'stale_ready_pickup' END,
                   CASE WHEN COALESCE(a.appointment_count, 0) > 0 THEN 'upcoming_appointment' END,
                   CASE WHEN NULLIF(trim(COALESCE(c.email, '')), '') IS NULL
                         AND NULLIF(trim(COALESCE(c.phone, '')), '') IS NULL THEN 'missing_contact' END
               ]::text[], NULL) AS follow_up_reasons
        FROM customers c
        LEFT JOIN balances b ON b.customer_id = c.id
        LEFT JOIN ready r ON r.customer_id = c.id
        LEFT JOIN appts a ON a.customer_id = c.id
        WHERE COALESCE(b.open_balance_due, 0) > 0
           OR COALESCE(r.ready_count, 0) > 0
           OR COALESCE(a.appointment_count, 0) > 0
           OR (NULLIF(trim(COALESCE(c.email, '')), '') IS NULL
               AND NULLIF(trim(COALESCE(c.phone, '')), '') IS NULL)
        ORDER BY COALESCE(r.stale_ready_count, 0) DESC,
                 COALESCE(b.open_balance_due, 0) DESC,
                 c.last_name ASC
        LIMIT $1
        "#,
    )
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "limit": limit, "upcoming_appointment_days": 7, "stale_pickup_days": 7 }),
        limit,
        data,
        vec!["Follow-up reasons are read-only signals; staff must use normal customer/order workflows to act.".to_string()],
    ))
}

async fn customers_with_stale_pickups(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let stale_days = args
        .get("stale_days")
        .and_then(Value::as_i64)
        .unwrap_or(7)
        .clamp(1, 90);
    let rows = sqlx::query(
        r#"
        SELECT c.id AS customer_id,
               c.customer_code,
               c.first_name,
               c.last_name,
               NULLIF(trim(COALESCE(c.email, '')), '') IS NOT NULL AS email_present,
               NULLIF(trim(COALESCE(c.phone, '')), '') IS NOT NULL AS phone_present,
               COUNT(tl.id)::bigint AS stale_pickup_line_count,
               MIN(COALESCE(tl.ready_for_pickup_at, t.booked_at)) AS oldest_ready_at
        FROM transaction_lines tl
        JOIN transactions t ON t.id = tl.transaction_id
        JOIN customers c ON c.id = t.customer_id
        WHERE tl.order_lifecycle_status = 'ready_for_pickup'
          AND t.status::text <> 'cancelled'
          AND COALESCE(tl.ready_for_pickup_at, t.booked_at) <= now() - ($1::int * INTERVAL '1 day')
        GROUP BY c.id, c.customer_code, c.first_name, c.last_name, c.email, c.phone
        ORDER BY oldest_ready_at ASC, c.last_name ASC
        LIMIT $2
        "#,
    )
    .bind(stale_days as i32)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "customer_id": row.get::<Uuid, _>("customer_id"),
                "customer_code": row.get::<Option<String>, _>("customer_code"),
                "first_name": row.get::<String, _>("first_name"),
                "last_name": row.get::<String, _>("last_name"),
                "email_present": row.get::<bool, _>("email_present"),
                "phone_present": row.get::<bool, _>("phone_present"),
                "stale_pickup_line_count": row.get::<i64, _>("stale_pickup_line_count"),
                "oldest_ready_at": row.get::<Option<DateTime<Utc>>, _>("oldest_ready_at"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "stale_days": stale_days, "limit": limit }),
        limit,
        data,
        vec!["Contact values are minimized to presence flags.".to_string()],
    ))
}

async fn customers_with_missing_contact_info(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows = sqlx::query(
        r#"
        SELECT id AS customer_id, customer_code, first_name, last_name,
               false AS email_present,
               false AS phone_present,
               created_at
        FROM customers
        WHERE NULLIF(trim(COALESCE(email, '')), '') IS NULL
          AND NULLIF(trim(COALESCE(phone, '')), '') IS NULL
        ORDER BY created_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "customer_id": row.get::<Uuid, _>("customer_id"),
                "customer_code": row.get::<Option<String>, _>("customer_code"),
                "first_name": row.get::<String, _>("first_name"),
                "last_name": row.get::<String, _>("last_name"),
                "email_present": row.get::<bool, _>("email_present"),
                "phone_present": row.get::<bool, _>("phone_present"),
                "created_at": row.get::<DateTime<Utc>, _>("created_at"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "limit": limit }),
        limit,
        data,
        vec![
            "This tool returns contact presence flags only, not email or phone values.".to_string(),
        ],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct CustomerPurchaseHistoryRow {
    customer_id: Uuid,
    transaction_count: i64,
    booked_transaction_count: i64,
    fulfilled_transaction_count: i64,
    lifetime_sales: Decimal,
    open_balance_due: Decimal,
    last_transaction_at: Option<DateTime<Utc>>,
}

async fn customer_purchase_history_summary(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let customer_id = required_uuid(args, "customer_id")?;
    let row: CustomerPurchaseHistoryRow = sqlx::query_as(
        r#"
        SELECT $1::uuid AS customer_id,
               COUNT(*) FILTER (WHERE status::text <> 'cancelled')::bigint AS transaction_count,
               COUNT(*) FILTER (WHERE status::text = 'open')::bigint AS booked_transaction_count,
               COUNT(*) FILTER (WHERE status::text IN ('completed', 'fulfilled', 'picked_up'))::bigint AS fulfilled_transaction_count,
               COALESCE(SUM(total_price) FILTER (WHERE status::text <> 'cancelled'), 0)::numeric(12, 2) AS lifetime_sales,
               COALESCE(SUM(balance_due) FILTER (WHERE status::text = 'open'), 0)::numeric(12, 2) AS open_balance_due,
               MAX(booked_at) FILTER (WHERE status::text <> 'cancelled') AS last_transaction_at
        FROM transactions
        WHERE customer_id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_one(pool)
    .await?;
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "customer_id": customer_id }),
        1,
        vec![serde_json::to_value(row).unwrap_or_else(|_| json!({}))],
        vec![
            "Summary excludes cancelled transactions and does not include payment metadata."
                .to_string(),
        ],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct CustomerSizeProfileRow {
    customer_id: Uuid,
    measured_at: Option<DateTime<Utc>>,
    retail_suit: Option<String>,
    retail_waist: Option<String>,
    retail_vest: Option<String>,
    retail_shirt: Option<String>,
    retail_shoe: Option<String>,
    neck: Option<Decimal>,
    sleeve: Option<Decimal>,
    chest: Option<Decimal>,
    waist: Option<Decimal>,
    inseam: Option<Decimal>,
}

async fn customer_size_profile_summary(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let customer_id = required_uuid(args, "customer_id")?;
    let row: Option<CustomerSizeProfileRow> = sqlx::query_as(
        r#"
        SELECT customer_id, measured_at, retail_suit, retail_waist, retail_vest,
               retail_shirt, retail_shoe, neck, sleeve, chest, waist, inseam
        FROM customer_measurements
        WHERE customer_id = $1
        ORDER BY measured_at DESC NULLS LAST
        LIMIT 1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?;
    let rows = row
        .map(|row| vec![serde_json::to_value(row).unwrap_or_else(|_| json!({}))])
        .unwrap_or_default();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "customer_id": customer_id }),
        1,
        rows,
        vec!["Size profile is read-only and excludes measurement notes.".to_string()],
    ))
}

async fn wedding_readiness(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let wedding_id = required_uuid(args, "wedding_id")?;
    let detail =
        crate::logic::wedding_health::calculate_wedding_readiness(pool, wedding_id).await?;
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "wedding_id": wedding_id }),
        1,
        vec![serde_json::to_value(detail).unwrap_or_else(|_| json!({}))],
        vec!["Uses the existing Wedding Manager readiness service.".to_string()],
    ))
}

async fn weddings_by_event_date_range(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 30)?;
    let limit = limit_from_args(args, def.max_rows);
    let dashboard = crate::logic::wedding_health::list_wedding_readiness_dashboard(
        pool,
        crate::logic::wedding_health::WeddingReadinessDashboardFilter {
            start_date: Some(from),
            end_date: Some(to),
            salesperson: optional_string(args, "salesperson"),
            status: None,
            limit,
        },
    )
    .await?;
    let mut rows = dashboard
        .parties
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect::<Vec<_>>();
    let mut warnings = vec!["Uses existing Wedding Manager readiness summaries.".to_string()];
    warnings.push(format!(
        "Dashboard totals: safe {}, watch {}, at_risk {}, critical {}, complete {}.",
        dashboard.safe_count,
        dashboard.watch_count,
        dashboard.at_risk_count,
        dashboard.critical_count,
        dashboard.complete_count
    ));
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit }),
        limit,
        {
            rows.truncate((limit + 1) as usize);
            rows
        },
        warnings,
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct WeddingMissingMeasurementRow {
    wedding_party_id: Uuid,
    wedding_name: String,
    event_date: NaiveDate,
    wedding_member_id: Uuid,
    customer_id: Uuid,
    customer_name: String,
    role: String,
}

async fn wedding_members_missing_measurements(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 30)?;
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<WeddingMissingMeasurementRow> = sqlx::query_as(
        r#"
        SELECT wp.id AS wedding_party_id,
               COALESCE(NULLIF(wp.party_name, ''), wp.groom_name) AS wedding_name,
               wp.event_date,
               wm.id AS wedding_member_id,
               c.id AS customer_id,
               NULLIF(trim(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
               wm.role
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        JOIN customers c ON c.id = wm.customer_id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND wp.event_date >= $1
          AND wp.event_date <= $2
          AND COALESCE(wm.measured, false) = false
        ORDER BY wp.event_date ASC, wedding_name ASC, wm.member_index ASC
        LIMIT $3
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit }),
        limit,
        data,
        vec!["Missing measurements are based on wedding member measured=false.".to_string()],
    ))
}

async fn upcoming_wedding_risk_report(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 14)?;
    let limit = limit_from_args(args, def.max_rows);
    let dashboard = crate::logic::wedding_health::list_wedding_readiness_dashboard(
        pool,
        crate::logic::wedding_health::WeddingReadinessDashboardFilter {
            start_date: Some(from),
            end_date: Some(to),
            salesperson: optional_string(args, "salesperson"),
            status: None,
            limit,
        },
    )
    .await?;
    let rows = dashboard
        .parties
        .into_iter()
        .filter(|party| {
            matches!(
                party.status,
                crate::logic::wedding_health::WeddingReadinessStatus::Watch
                    | crate::logic::wedding_health::WeddingReadinessStatus::AtRisk
                    | crate::logic::wedding_health::WeddingReadinessStatus::Critical
            )
        })
        .take((limit + 1) as usize)
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit, "statuses": ["watch", "at_risk", "critical"] }),
        limit,
        rows,
        vec![
            "Uses the existing Wedding Manager readiness service and returns summaries only."
                .to_string(),
        ],
    ))
}

async fn wedding_members_missing_fittings(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 30)?;
    let limit = limit_from_args(args, def.max_rows);
    let rows = sqlx::query(
        r#"
        SELECT wp.id AS wedding_party_id,
               COALESCE(NULLIF(wp.party_name, ''), wp.groom_name) AS wedding_name,
               wp.event_date,
               wm.id AS wedding_member_id,
               c.id AS customer_id,
               NULLIF(trim(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
               wm.role,
               wm.fitting_date
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        JOIN customers c ON c.id = wm.customer_id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND wp.event_date >= $1
          AND wp.event_date <= $2
          AND COALESCE(wm.fitting, false) = false
        ORDER BY wp.event_date ASC, wedding_name ASC, wm.member_index ASC
        LIMIT $3
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "wedding_party_id": row.get::<Uuid, _>("wedding_party_id"),
                "wedding_name": row.get::<String, _>("wedding_name"),
                "event_date": row.get::<NaiveDate, _>("event_date"),
                "wedding_member_id": row.get::<Uuid, _>("wedding_member_id"),
                "customer_id": row.get::<Uuid, _>("customer_id"),
                "customer_name": row.get::<String, _>("customer_name"),
                "role": row.get::<String, _>("role"),
                "fitting_date": row.get::<Option<NaiveDate>, _>("fitting_date"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit }),
        limit,
        data,
        vec!["Missing fittings are based on wedding member fitting=false.".to_string()],
    ))
}

async fn wedding_members_with_open_balances(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 60)?;
    let limit = limit_from_args(args, def.max_rows);
    let rows = sqlx::query(
        r#"
        SELECT wp.id AS wedding_party_id,
               COALESCE(NULLIF(wp.party_name, ''), wp.groom_name) AS wedding_name,
               wp.event_date,
               wm.id AS wedding_member_id,
               c.id AS customer_id,
               NULLIF(trim(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
               COALESCE(SUM(t.balance_due), 0)::numeric(12, 2) AS balance_due,
               COUNT(DISTINCT t.id)::bigint AS open_transaction_count
        FROM wedding_members wm
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        JOIN customers c ON c.id = wm.customer_id
        JOIN transactions t ON t.wedding_member_id = wm.id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND wp.event_date >= $1
          AND wp.event_date <= $2
          AND t.status::text = 'open'
          AND COALESCE(t.balance_due, 0) > 0
        GROUP BY wp.id, wedding_name, wp.event_date, wm.id, c.id, customer_name
        ORDER BY wp.event_date ASC, balance_due DESC
        LIMIT $3
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "wedding_party_id": row.get::<Uuid, _>("wedding_party_id"),
                "wedding_name": row.get::<String, _>("wedding_name"),
                "event_date": row.get::<NaiveDate, _>("event_date"),
                "wedding_member_id": row.get::<Uuid, _>("wedding_member_id"),
                "customer_id": row.get::<Uuid, _>("customer_id"),
                "customer_name": row.get::<String, _>("customer_name"),
                "balance_due": row.get::<Decimal, _>("balance_due"),
                "open_transaction_count": row.get::<i64, _>("open_transaction_count"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit }),
        limit,
        data,
        vec!["Open balance is scoped to wedding_member_id and open transactions only.".to_string()],
    ))
}

async fn wedding_orders_ready_for_pickup(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 60)?;
    let limit = limit_from_args(args, def.max_rows);
    let rows = sqlx::query(
        r#"
        SELECT wp.id AS wedding_party_id,
               COALESCE(NULLIF(wp.party_name, ''), wp.groom_name) AS wedding_name,
               wp.event_date,
               wm.id AS wedding_member_id,
               NULLIF(trim(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
               t.id AS transaction_id,
               t.display_id AS transaction_display_id,
               tl.id AS line_id,
               pv.sku,
               p.name AS product_name,
               tl.quantity,
               tl.ready_for_pickup_at
        FROM transaction_lines tl
        JOIN transactions t ON t.id = tl.transaction_id
        JOIN wedding_members wm ON wm.id = t.wedding_member_id
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN customers c ON c.id = wm.customer_id
        LEFT JOIN product_variants pv ON pv.id = tl.variant_id
        LEFT JOIN products p ON p.id = tl.product_id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND wp.event_date >= $1
          AND wp.event_date <= $2
          AND tl.order_lifecycle_status = 'ready_for_pickup'
          AND t.status::text <> 'cancelled'
        ORDER BY wp.event_date ASC, tl.ready_for_pickup_at NULLS LAST
        LIMIT $3
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "wedding_party_id": row.get::<Uuid, _>("wedding_party_id"),
                "wedding_name": row.get::<String, _>("wedding_name"),
                "event_date": row.get::<NaiveDate, _>("event_date"),
                "wedding_member_id": row.get::<Uuid, _>("wedding_member_id"),
                "customer_name": row.get::<Option<String>, _>("customer_name"),
                "transaction_id": row.get::<Uuid, _>("transaction_id"),
                "transaction_display_id": row.get::<String, _>("transaction_display_id"),
                "line_id": row.get::<Uuid, _>("line_id"),
                "sku": row.get::<Option<String>, _>("sku"),
                "product_name": row.get::<Option<String>, _>("product_name"),
                "quantity": row.get::<i32, _>("quantity"),
                "ready_for_pickup_at": row.get::<Option<DateTime<Utc>>, _>("ready_for_pickup_at"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit }),
        limit,
        data,
        vec!["Wedding pickup rows are scoped through wedding_member_id.".to_string()],
    ))
}

async fn wedding_unfulfilled_items(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 60)?;
    let limit = limit_from_args(args, def.max_rows);
    let rows = sqlx::query(
        r#"
        SELECT wp.id AS wedding_party_id,
               COALESCE(NULLIF(wp.party_name, ''), wp.groom_name) AS wedding_name,
               wp.event_date,
               wm.id AS wedding_member_id,
               NULLIF(trim(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
               COUNT(tl.id)::bigint AS unfulfilled_line_count,
               COALESCE(SUM(tl.quantity), 0)::bigint AS unfulfilled_units
        FROM transaction_lines tl
        JOIN transactions t ON t.id = tl.transaction_id
        JOIN wedding_members wm ON wm.id = t.wedding_member_id
        JOIN wedding_parties wp ON wp.id = wm.wedding_party_id
        LEFT JOIN customers c ON c.id = wm.customer_id
        WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
          AND wp.event_date >= $1
          AND wp.event_date <= $2
          AND t.status::text <> 'cancelled'
          AND COALESCE(tl.is_fulfilled, false) = false
        GROUP BY wp.id, wedding_name, wp.event_date, wm.id, customer_name
        ORDER BY wp.event_date ASC, unfulfilled_units DESC
        LIMIT $3
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "wedding_party_id": row.get::<Uuid, _>("wedding_party_id"),
                "wedding_name": row.get::<String, _>("wedding_name"),
                "event_date": row.get::<NaiveDate, _>("event_date"),
                "wedding_member_id": row.get::<Uuid, _>("wedding_member_id"),
                "customer_name": row.get::<Option<String>, _>("customer_name"),
                "unfulfilled_line_count": row.get::<i64, _>("unfulfilled_line_count"),
                "unfulfilled_units": row.get::<i64, _>("unfulfilled_units"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit }),
        limit,
        data,
        vec![
            "Unfulfilled items are read-only transaction line summaries scoped to wedding members."
                .to_string(),
        ],
    ))
}

async fn wedding_follow_up_list(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 30)?;
    let limit = limit_from_args(args, def.max_rows);
    let dashboard = crate::logic::wedding_health::list_wedding_readiness_dashboard(
        pool,
        crate::logic::wedding_health::WeddingReadinessDashboardFilter {
            start_date: Some(from),
            end_date: Some(to),
            salesperson: optional_string(args, "salesperson"),
            status: None,
            limit,
        },
    )
    .await?;
    let rows = dashboard
        .parties
        .into_iter()
        .filter(|party| {
            !matches!(
                party.status,
                crate::logic::wedding_health::WeddingReadinessStatus::Safe
                    | crate::logic::wedding_health::WeddingReadinessStatus::Complete
            )
        })
        .take((limit + 1) as usize)
        .map(|party| {
            let mut value = serde_json::to_value(&party).unwrap_or_else(|_| json!({}));
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "follow_up_reasons".to_string(),
                    json!(party
                        .blockers
                        .iter()
                        .map(|blocker| blocker.label.clone())
                        .collect::<Vec<_>>()),
                );
            }
            value
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit }),
        limit,
        rows,
        vec![
            "Follow-up reasons come from Wedding Manager readiness blockers and warnings."
                .to_string(),
        ],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct OpenPurchaseOrderRow {
    purchase_order_id: Uuid,
    po_number: String,
    vendor_id: Uuid,
    vendor_name: String,
    status: String,
    expected_at: Option<DateTime<Utc>>,
    line_count: i64,
    units_ordered: i64,
    units_received: i64,
    units_remaining: i64,
}

async fn open_purchase_orders(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<OpenPurchaseOrderRow> = sqlx::query_as(
        r#"
        SELECT po.id AS purchase_order_id, po.po_number, po.vendor_id, v.name AS vendor_name,
               po.status::text AS status, po.expected_at,
               COUNT(pol.id)::bigint AS line_count,
               COALESCE(SUM(pol.quantity_ordered), 0)::bigint AS units_ordered,
               COALESCE(SUM(pol.quantity_received), 0)::bigint AS units_received,
               COALESCE(SUM(pol.quantity_ordered - pol.quantity_received), 0)::bigint AS units_remaining
        FROM purchase_orders po
        JOIN vendors v ON v.id = po.vendor_id
        LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
        WHERE po.status::text IN ('draft', 'submitted', 'partially_received')
        GROUP BY po.id, po.po_number, po.vendor_id, v.name, po.status, po.expected_at
        ORDER BY po.expected_at NULLS LAST, po.ordered_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "limit": limit }),
        limit,
        data,
        Vec::new(),
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct RecentReceiptRow {
    receiving_event_id: Uuid,
    purchase_order_id: Uuid,
    po_number: String,
    vendor_name: String,
    invoice_number_present: bool,
    freight_total: Decimal,
    received_at: Option<DateTime<Utc>>,
    total_units_received: i64,
    total_line_cost: Decimal,
}

async fn recent_receipts(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 7)?;
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<RecentReceiptRow> = sqlx::query_as(
        r#"
        SELECT re.id AS receiving_event_id, re.purchase_order_id, po.po_number,
               v.name AS vendor_name,
               NULLIF(trim(COALESCE(re.invoice_number, '')), '') IS NOT NULL AS invoice_number_present,
               COALESCE(re.freight_total, 0)::numeric(12, 2) AS freight_total,
               re.received_at,
               COALESCE(SUM(it.quantity_delta), 0)::bigint AS total_units_received,
               COALESCE(SUM(it.unit_cost * it.quantity_delta), 0)::numeric(14, 2) AS total_line_cost
        FROM receiving_events re
        JOIN purchase_orders po ON po.id = re.purchase_order_id
        JOIN vendors v ON v.id = po.vendor_id
        LEFT JOIN inventory_transactions it
          ON it.reference_table = 'receiving_events'
         AND it.reference_id = re.id
        WHERE (re.received_at AT TIME ZONE reporting.effective_store_timezone())::date >= $1
          AND (re.received_at AT TIME ZONE reporting.effective_store_timezone())::date <= $2
        GROUP BY re.id, re.purchase_order_id, po.po_number, v.name, re.invoice_number, re.freight_total, re.received_at
        ORDER BY re.received_at DESC
        LIMIT $3
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "limit": limit }),
        limit,
        data,
        vec!["Invoice number is minimized to a presence flag.".to_string()],
    ))
}

async fn unmatched_vendor_items(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows = sqlx::query(
        r#"
        SELECT vsi.id AS vendor_item_id,
               v.id AS vendor_id,
               v.name AS vendor_name,
               vsi.cp_item_no,
               vsi.vendor_item_no,
               vsi.vend_cost,
               vsi.updated_at
        FROM vendor_supplier_item vsi
        JOIN vendors v ON v.id = vsi.vendor_id
        WHERE vsi.variant_id IS NULL
        ORDER BY vsi.updated_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "vendor_item_id": row.get::<Uuid, _>("vendor_item_id"),
                "vendor_id": row.get::<Uuid, _>("vendor_id"),
                "vendor_name": row.get::<String, _>("vendor_name"),
                "counterpoint_item_present": !row.get::<String, _>("cp_item_no").trim().is_empty(),
                "vendor_item_no": row.get::<String, _>("vendor_item_no"),
                "vend_cost": row.get::<Option<Decimal>, _>("vend_cost"),
                "updated_at": row.get::<DateTime<Utc>, _>("updated_at"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "limit": limit }),
        limit,
        data,
        vec!["Counterpoint item numbers are minimized to presence flags; mapping must be done in procurement/import workflows.".to_string()],
    ))
}

async fn items_on_order(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let vendor_id = args
        .get("vendor_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok());
    let rows = sqlx::query(
        r#"
        SELECT po.id AS purchase_order_id,
               po.po_number,
               po.status::text AS status,
               po.expected_at,
               v.id AS vendor_id,
               v.name AS vendor_name,
               pol.id AS purchase_order_line_id,
               pv.sku,
               p.name AS product_name,
               pol.quantity_ordered,
               pol.quantity_received,
               (pol.quantity_ordered - pol.quantity_received)::int4 AS units_remaining,
               pol.unit_cost
        FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id = pol.purchase_order_id
        JOIN vendors v ON v.id = po.vendor_id
        JOIN product_variants pv ON pv.id = pol.variant_id
        JOIN products p ON p.id = pv.product_id
        WHERE po.status::text IN ('draft', 'submitted', 'partially_received')
          AND pol.quantity_received < pol.quantity_ordered
          AND ($1::uuid IS NULL OR v.id = $1)
        ORDER BY po.expected_at NULLS LAST, po.ordered_at DESC, p.name ASC
        LIMIT $2
        "#,
    )
    .bind(vendor_id)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "purchase_order_id": row.get::<Uuid, _>("purchase_order_id"),
                "po_number": row.get::<String, _>("po_number"),
                "status": row.get::<String, _>("status"),
                "expected_at": row.get::<Option<DateTime<Utc>>, _>("expected_at"),
                "vendor_id": row.get::<Uuid, _>("vendor_id"),
                "vendor_name": row.get::<String, _>("vendor_name"),
                "purchase_order_line_id": row.get::<Uuid, _>("purchase_order_line_id"),
                "sku": row.get::<String, _>("sku"),
                "product_name": row.get::<String, _>("product_name"),
                "quantity_ordered": row.get::<i32, _>("quantity_ordered"),
                "quantity_received": row.get::<i32, _>("quantity_received"),
                "units_remaining": row.get::<i32, _>("units_remaining"),
                "unit_cost": row.get::<Decimal, _>("unit_cost"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "vendor_id": vendor_id, "limit": limit }),
        limit,
        data,
        vec!["Open order quantities are read-only and must be changed through procurement workflows.".to_string()],
    ))
}

async fn po_invoice_exception_report(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows = sqlx::query(
        r#"
        SELECT po.id AS purchase_order_id,
               po.po_number,
               v.name AS vendor_name,
               po.status::text AS status,
               po.fully_received_at,
               NULLIF(trim(COALESCE(po.invoice_number, '')), '') IS NOT NULL AS po_invoice_present,
               COALESCE(po.freight_total, 0)::numeric(12, 2) AS po_freight_total,
               COUNT(re.id)::bigint AS receiving_event_count,
               COUNT(re.id) FILTER (WHERE NULLIF(trim(COALESCE(re.invoice_number, '')), '') IS NULL)::bigint AS receipts_missing_invoice,
               COALESCE(SUM(re.freight_total), 0)::numeric(12, 2) AS receipt_freight_total
        FROM purchase_orders po
        JOIN vendors v ON v.id = po.vendor_id
        LEFT JOIN receiving_events re ON re.purchase_order_id = po.id
        WHERE po.status::text IN ('partially_received', 'received', 'closed')
           OR po.fully_received_at IS NOT NULL
           OR re.id IS NOT NULL
        GROUP BY po.id, po.po_number, v.name, po.status, po.fully_received_at, po.invoice_number, po.freight_total
        HAVING NULLIF(trim(COALESCE(po.invoice_number, '')), '') IS NULL
            OR COUNT(re.id) FILTER (WHERE NULLIF(trim(COALESCE(re.invoice_number, '')), '') IS NULL) > 0
        ORDER BY po.fully_received_at DESC NULLS LAST, po.ordered_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "purchase_order_id": row.get::<Uuid, _>("purchase_order_id"),
                "po_number": row.get::<String, _>("po_number"),
                "vendor_name": row.get::<String, _>("vendor_name"),
                "status": row.get::<String, _>("status"),
                "fully_received_at": row.get::<Option<DateTime<Utc>>, _>("fully_received_at"),
                "po_invoice_present": row.get::<bool, _>("po_invoice_present"),
                "po_freight_total": row.get::<Decimal, _>("po_freight_total"),
                "receiving_event_count": row.get::<i64, _>("receiving_event_count"),
                "receipts_missing_invoice": row.get::<i64, _>("receipts_missing_invoice"),
                "receipt_freight_total": row.get::<Decimal, _>("receipt_freight_total"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "limit": limit }),
        limit,
        data,
        vec!["Invoice values are summarized; invoice posting and cost changes remain in procurement/accounting workflows.".to_string()],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct StoreCreditSummaryRow {
    customer_id: Uuid,
    customer_code: Option<String>,
    customer_name: String,
    balance: Decimal,
    updated_at: DateTime<Utc>,
}

async fn store_credit_summary(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let customer_id = args
        .get("customer_id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok());
    let rows: Vec<StoreCreditSummaryRow> = sqlx::query_as(
        r#"
        SELECT c.id AS customer_id, c.customer_code,
               NULLIF(trim(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name,
               sca.balance, sca.updated_at
        FROM store_credit_accounts sca
        JOIN customers c ON c.id = sca.customer_id
        WHERE sca.balance <> 0
          AND ($1::uuid IS NULL OR c.id = $1)
        ORDER BY ABS(sca.balance) DESC, sca.updated_at DESC
        LIMIT $2
        "#,
    )
    .bind(customer_id)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "customer_id": customer_id, "limit": limit }),
        limit,
        data,
        vec![
            "Store credit balances are read-only; adjustments must use the Store Credit workflow."
                .to_string(),
        ],
    ))
}

async fn customer_credit_summary(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let customer_id = required_uuid(args, "customer_id")?;
    let row = sqlx::query(
        r#"
        SELECT c.id AS customer_id,
               c.customer_code,
               c.first_name,
               c.last_name,
               COALESCE(c.loyalty_points, 0)::int4 AS loyalty_points,
               COALESCE(sca.balance, 0)::numeric(14, 2) AS store_credit_balance,
               COALESCE(open_balances.open_balance_due, 0)::numeric(12, 2) AS open_balance_due,
               COALESCE(cards.active_gift_card_count, 0)::bigint AS active_gift_card_count,
               COALESCE(cards.active_gift_card_balance, 0)::numeric(14, 2) AS active_gift_card_balance
        FROM customers c
        LEFT JOIN store_credit_accounts sca ON sca.customer_id = c.id
        LEFT JOIN (
            SELECT customer_id, SUM(balance_due)::numeric(12, 2) AS open_balance_due
            FROM transactions
            WHERE status::text = 'open'
              AND COALESCE(balance_due, 0) > 0
            GROUP BY customer_id
        ) open_balances ON open_balances.customer_id = c.id
        LEFT JOIN (
            SELECT customer_id,
                   COUNT(*)::bigint AS active_gift_card_count,
                   SUM(current_balance)::numeric(14, 2) AS active_gift_card_balance
            FROM gift_cards
            WHERE customer_id IS NOT NULL
              AND card_status::text = 'active'
              AND current_balance > 0
            GROUP BY customer_id
        ) cards ON cards.customer_id = c.id
        WHERE c.id = $1
        "#,
    )
    .bind(customer_id)
    .fetch_optional(pool)
    .await?;
    let rows = row
        .map(|row| {
            vec![json!({
                "customer_id": row.get::<Uuid, _>("customer_id"),
                "customer_code": row.get::<Option<String>, _>("customer_code"),
                "first_name": row.get::<String, _>("first_name"),
                "last_name": row.get::<String, _>("last_name"),
                "loyalty_points": row.get::<i32, _>("loyalty_points"),
                "store_credit_balance": row.get::<Decimal, _>("store_credit_balance"),
                "open_balance_due": row.get::<Decimal, _>("open_balance_due"),
                "active_gift_card_count": row.get::<i64, _>("active_gift_card_count"),
                "active_gift_card_balance": row.get::<Decimal, _>("active_gift_card_balance"),
            })]
        })
        .unwrap_or_default();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "customer_id": customer_id }),
        1,
        rows,
        vec![
            "Gift card, store credit, loyalty, and open balance values are kept separate."
                .to_string(),
        ],
    ))
}

async fn gift_card_summary(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    _args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let rows = sqlx::query(
        r#"
        SELECT card_kind::text AS card_kind,
               card_status::text AS card_status,
               COUNT(*)::bigint AS card_count,
               COALESCE(SUM(current_balance), 0)::numeric(14, 2) AS current_balance_total,
               MIN(expires_at) AS next_expires_at
        FROM gift_cards
        GROUP BY card_kind::text, card_status::text
        ORDER BY card_kind::text ASC, card_status::text ASC
        LIMIT 21
        "#,
    )
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "card_kind": row.get::<String, _>("card_kind"),
                "card_status": row.get::<String, _>("card_status"),
                "card_count": row.get::<i64, _>("card_count"),
                "current_balance_total": row.get::<Decimal, _>("current_balance_total"),
                "next_expires_at": row.get::<Option<DateTime<Utc>>, _>("next_expires_at"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "group_by": ["card_kind", "card_status"] }),
        def.max_rows,
        data,
        vec!["This summary does not expose gift card numbers.".to_string()],
    ))
}

async fn outstanding_credit_liability_summary(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    _args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let row = sqlx::query(
        r#"
        SELECT
            (SELECT COALESCE(SUM(balance), 0)::numeric(14, 2)
             FROM store_credit_accounts
             WHERE balance > 0) AS store_credit_positive_balance,
            (SELECT COUNT(*)::bigint
             FROM store_credit_accounts
             WHERE balance > 0) AS store_credit_account_count,
            (SELECT COALESCE(SUM(current_balance), 0)::numeric(14, 2)
             FROM gift_cards
             WHERE card_status::text = 'active'
               AND current_balance > 0
               AND is_liability = true) AS gift_card_liability_balance,
            (SELECT COUNT(*)::bigint
             FROM gift_cards
             WHERE card_status::text = 'active'
               AND current_balance > 0
               AND is_liability = true) AS gift_card_liability_count
        "#,
    )
    .fetch_one(pool)
    .await?;
    let data = json!({
        "store_credit_positive_balance": row.get::<Decimal, _>("store_credit_positive_balance"),
        "store_credit_account_count": row.get::<i64, _>("store_credit_account_count"),
        "gift_card_liability_balance": row.get::<Decimal, _>("gift_card_liability_balance"),
        "gift_card_liability_count": row.get::<i64, _>("gift_card_liability_count"),
    });
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "scope": "positive_balances_only" }),
        1,
        vec![data],
        vec!["Store credit and gift card balances are separate; this does not post or reconcile liabilities.".to_string()],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct GiftCardExceptionRow {
    gift_card_id: Uuid,
    masked_code: String,
    card_kind: String,
    card_status: String,
    current_balance: Decimal,
    expires_at: DateTime<Utc>,
    customer_id: Option<Uuid>,
    review_reason: String,
}

async fn gift_card_exception_report(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<GiftCardExceptionRow> = sqlx::query_as(
        r#"
        SELECT id AS gift_card_id,
               CASE
                   WHEN length(code) <= 4 THEN '****'
                   ELSE repeat('*', GREATEST(length(code) - 4, 0)) || right(code, 4)
               END AS masked_code,
               card_kind::text AS card_kind,
               card_status::text AS card_status,
               current_balance,
               expires_at,
               customer_id,
               CASE
                   WHEN current_balance < 0 THEN 'negative_balance'
                   WHEN card_status::text = 'active' AND expires_at < now() THEN 'expired_active'
                   WHEN current_balance > 0 AND card_status::text IN ('depleted', 'void') THEN 'positive_balance_inactive'
                   WHEN is_liability = false AND card_kind::text = 'purchased' THEN 'purchased_not_liability'
                   ELSE 'review'
               END AS review_reason
        FROM gift_cards
        WHERE current_balance < 0
           OR (card_status::text = 'active' AND expires_at < now())
           OR (current_balance > 0 AND card_status::text IN ('depleted', 'void'))
           OR (is_liability = false AND card_kind::text = 'purchased')
        ORDER BY expires_at ASC, current_balance DESC
        LIMIT $1
        "#,
    )
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "limit": limit }),
        limit,
        data,
        vec![
            "Gift card codes are masked; balance changes must use the Gift Card workflow."
                .to_string(),
        ],
    ))
}

#[derive(Debug, Serialize, FromRow)]
struct QboExceptionRow {
    qbo_sync_log_id: Uuid,
    sync_date: NaiveDate,
    status: String,
    journal_entry_id_present: bool,
    error_message_summary: Option<String>,
    updated_at: DateTime<Utc>,
}

async fn qbo_exception_summary(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let limit = limit_from_args(args, def.max_rows);
    let rows: Vec<QboExceptionRow> = sqlx::query_as(
        r#"
        SELECT id AS qbo_sync_log_id,
               sync_date,
               status,
               NULLIF(trim(COALESCE(journal_entry_id, '')), '') IS NOT NULL AS journal_entry_id_present,
               LEFT(NULLIF(trim(COALESCE(error_message, '')), ''), 240) AS error_message_summary,
               updated_at
        FROM qbo_sync_logs
        WHERE status IN ('pending', 'failed', 'error', 'needs_review')
           OR error_message IS NOT NULL
        ORDER BY sync_date DESC, updated_at DESC
        LIMIT $1
        "#,
    )
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| serde_json::to_value(row).unwrap_or_else(|_| json!({})))
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "limit": limit }),
        limit,
        data,
        vec![
            "QBO summary is read-only and does not post, approve, retry, or void entries."
                .to_string(),
        ],
    ))
}

async fn qbo_sync_summary(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 30)?;
    let rows = sqlx::query(
        r#"
        SELECT status,
               COUNT(*)::bigint AS row_count,
               MIN(sync_date) AS first_sync_date,
               MAX(sync_date) AS last_sync_date,
               COUNT(*) FILTER (WHERE error_message IS NOT NULL)::bigint AS rows_with_error_message
        FROM qbo_sync_logs
        WHERE sync_date >= $1
          AND sync_date <= $2
        GROUP BY status
        ORDER BY status ASC
        LIMIT 21
        "#,
    )
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "status": row.get::<String, _>("status"),
                "row_count": row.get::<i64, _>("row_count"),
                "first_sync_date": row.get::<NaiveDate, _>("first_sync_date"),
                "last_sync_date": row.get::<NaiveDate, _>("last_sync_date"),
                "rows_with_error_message": row.get::<i64, _>("rows_with_error_message"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "date_basis": "sync_date" }),
        def.max_rows,
        data,
        vec![
            "QBO summary is read-only and does not post, approve, retry, void, or change mappings."
                .to_string(),
        ],
    ))
}

async fn register_exception_summary(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let (from, to) = bounded_date_range(args, 7)?;
    let limit = limit_from_args(args, def.max_rows);
    let rows = sqlx::query(
        r#"
        SELECT id AS register_session_id,
               session_ordinal,
               register_lane,
               lifecycle_status,
               opened_at,
               closed_at,
               cash_over_short,
               expected_cash,
               actual_cash,
               CASE
                   WHEN is_open = true AND opened_at < now() - INTERVAL '16 hours' THEN 'stale_open_session'
                   WHEN lifecycle_status = 'reconciling' THEN 'reconciling_session'
                   WHEN COALESCE(cash_over_short, 0) <> 0 THEN 'cash_variance'
                   ELSE 'review'
               END AS review_reason
        FROM register_sessions
        WHERE (
            closed_at IS NOT NULL
            AND (closed_at AT TIME ZONE reporting.effective_store_timezone())::date >= $1
            AND (closed_at AT TIME ZONE reporting.effective_store_timezone())::date <= $2
            AND COALESCE(cash_over_short, 0) <> 0
        )
           OR (is_open = true AND opened_at < now() - INTERVAL '16 hours')
           OR lifecycle_status = 'reconciling'
        ORDER BY closed_at DESC NULLS LAST, opened_at ASC
        LIMIT $3
        "#,
    )
    .bind(from)
    .bind(to)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;
    let data = rows
        .into_iter()
        .map(|row| {
            json!({
                "register_session_id": row.get::<Uuid, _>("register_session_id"),
                "session_ordinal": row.get::<i64, _>("session_ordinal"),
                "register_lane": row.get::<i16, _>("register_lane"),
                "lifecycle_status": row.get::<String, _>("lifecycle_status"),
                "opened_at": row.get::<DateTime<Utc>, _>("opened_at"),
                "closed_at": row.get::<Option<DateTime<Utc>>, _>("closed_at"),
                "cash_over_short": row.get::<Option<Decimal>, _>("cash_over_short"),
                "expected_cash_present": row.get::<Option<Decimal>, _>("expected_cash").is_some(),
                "actual_cash_present": row.get::<Option<Decimal>, _>("actual_cash").is_some(),
                "review_reason": row.get::<String, _>("review_reason"),
            })
        })
        .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "from": from, "to": to, "date_basis": "closed_at", "stale_open_hours": 16, "limit": limit }),
        limit,
        data,
        vec!["Register summary is read-only and does not reconcile drawers.".to_string()],
    ))
}

async fn daily_manager_brief(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    _args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let row = sqlx::query(
        r#"
        SELECT
            (SELECT COUNT(*)::bigint FROM wedding_appointments
             WHERE (starts_at AT TIME ZONE reporting.effective_store_timezone())::date =
                   (now() AT TIME ZONE reporting.effective_store_timezone())::date
               AND status::text NOT IN ('cancelled', 'canceled')) AS appointments_today,
            (SELECT COUNT(*)::bigint FROM alteration_orders
             WHERE due_at IS NOT NULL
               AND (due_at AT TIME ZONE reporting.effective_store_timezone())::date =
                   (now() AT TIME ZONE reporting.effective_store_timezone())::date
               AND status::text NOT IN ('completed', 'complete', 'cancelled', 'canceled', 'picked_up')) AS alterations_due_today,
            (SELECT COUNT(*)::bigint FROM alteration_orders
             WHERE due_at IS NOT NULL
               AND due_at < now()
               AND status::text NOT IN ('completed', 'complete', 'cancelled', 'canceled', 'picked_up')) AS overdue_alterations,
            (SELECT COUNT(*)::bigint FROM transaction_lines tl
             JOIN transactions t ON t.id = tl.transaction_id
             WHERE tl.order_lifecycle_status = 'ready_for_pickup'
               AND t.status::text <> 'cancelled') AS ready_for_pickup_lines,
            (SELECT COUNT(*)::bigint FROM customers c
             WHERE NULLIF(trim(COALESCE(c.email, '')), '') IS NULL
               AND NULLIF(trim(COALESCE(c.phone, '')), '') IS NULL) AS customers_missing_contact,
            (SELECT COUNT(*)::bigint FROM purchase_orders
             WHERE status::text IN ('draft', 'submitted', 'partially_received')) AS open_purchase_orders,
            (SELECT COUNT(*)::bigint FROM qbo_sync_logs
             WHERE status IN ('pending', 'failed', 'error', 'needs_review')
                OR error_message IS NOT NULL) AS qbo_rows_needing_review,
            (SELECT COALESCE(SUM(balance), 0)::numeric(14, 2)
             FROM store_credit_accounts
             WHERE balance <> 0) AS store_credit_balance_total
        "#,
    )
    .fetch_one(pool)
    .await?;
    let data = json!({
        "appointments_today": row.get::<i64, _>("appointments_today"),
        "alterations_due_today": row.get::<i64, _>("alterations_due_today"),
        "overdue_alterations": row.get::<i64, _>("overdue_alterations"),
        "ready_for_pickup_lines": row.get::<i64, _>("ready_for_pickup_lines"),
        "customers_missing_contact": row.get::<i64, _>("customers_missing_contact"),
        "open_purchase_orders": row.get::<i64, _>("open_purchase_orders"),
        "qbo_rows_needing_review": row.get::<i64, _>("qbo_rows_needing_review"),
        "store_credit_balance_total": row.get::<Decimal, _>("store_credit_balance_total"),
    });
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "date": Utc::now().date_naive() }),
        1,
        vec![data],
        vec![
            "Manager brief is read-only and uses store-local today where date-scoped.".to_string(),
        ],
    ))
}

async fn data_cleanup_tasks(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    _args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let row = sqlx::query(
        r#"
        SELECT
            (SELECT COUNT(*)::bigint FROM customers
             WHERE NULLIF(trim(COALESCE(email, '')), '') IS NULL
               AND NULLIF(trim(COALESCE(phone, '')), '') IS NULL) AS customers_missing_contact,
            (SELECT COUNT(*)::bigint FROM product_variants pv
             JOIN products p ON p.id = pv.product_id
             LEFT JOIN product_variant_barcode_aliases ba ON ba.variant_id = pv.id
             WHERE p.is_active = TRUE
               AND NULLIF(trim(COALESCE(pv.vendor_upc, '')), '') IS NULL
               AND ba.id IS NULL) AS active_variants_missing_barcode,
            (SELECT COUNT(*)::bigint FROM vendor_supplier_item
             WHERE variant_id IS NULL) AS unmatched_vendor_items,
            (SELECT COUNT(*)::bigint FROM gift_cards
             WHERE current_balance < 0
                OR (card_status::text = 'active' AND expires_at < now())
                OR (current_balance > 0 AND card_status::text IN ('depleted', 'void'))) AS gift_cards_needing_review,
            (SELECT COUNT(*)::bigint FROM qbo_sync_logs
             WHERE status IN ('failed', 'error', 'needs_review')
                OR error_message IS NOT NULL) AS qbo_exceptions
        "#,
    )
    .fetch_one(pool)
    .await?;
    let tasks = vec![
        json!({"workspace": "Customers", "priority": "medium", "reason": "missing_contact_info", "count": row.get::<i64, _>("customers_missing_contact")}),
        json!({"workspace": "Catalog", "priority": "medium", "reason": "missing_barcode_or_alias", "count": row.get::<i64, _>("active_variants_missing_barcode")}),
        json!({"workspace": "Procurement", "priority": "medium", "reason": "unmatched_vendor_items", "count": row.get::<i64, _>("unmatched_vendor_items")}),
        json!({"workspace": "Gift Cards", "priority": "high", "reason": "gift_cards_needing_review", "count": row.get::<i64, _>("gift_cards_needing_review")}),
        json!({"workspace": "QBO", "priority": "high", "reason": "qbo_exceptions", "count": row.get::<i64, _>("qbo_exceptions")}),
    ]
    .into_iter()
    .filter(|item| item.get("count").and_then(Value::as_i64).unwrap_or(0) > 0)
    .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "scope": "counts_only" }),
        def.max_rows,
        tasks,
        vec!["Cleanup tasks are counts only; corrections must happen in the owning Riverside OS workspace.".to_string()],
    ))
}

async fn manager_attention_queue(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    _args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let row = sqlx::query(
        r#"
        SELECT
            (SELECT COUNT(*)::bigint
             FROM wedding_parties wp
             JOIN wedding_members wm ON wm.wedding_party_id = wp.id
             WHERE (wp.is_deleted IS NULL OR wp.is_deleted = FALSE)
               AND wp.event_date >= (now() AT TIME ZONE reporting.effective_store_timezone())::date
               AND wp.event_date <= (now() AT TIME ZONE reporting.effective_store_timezone())::date + INTERVAL '14 days'
               AND (COALESCE(wm.measured, false) = false OR COALESCE(wm.fitting, false) = false)) AS wedding_member_readiness_issues,
            (SELECT COUNT(*)::bigint
             FROM transaction_lines tl
             JOIN transactions t ON t.id = tl.transaction_id
             WHERE tl.order_lifecycle_status = 'ready_for_pickup'
               AND t.status::text <> 'cancelled'
               AND COALESCE(tl.ready_for_pickup_at, t.booked_at) <= now() - INTERVAL '7 days') AS stale_pickup_lines,
            (SELECT COUNT(*)::bigint
             FROM register_sessions
             WHERE (is_open = true AND opened_at < now() - INTERVAL '16 hours')
                OR lifecycle_status = 'reconciling'
                OR COALESCE(cash_over_short, 0) <> 0) AS register_exceptions,
            (SELECT COUNT(*)::bigint FROM vendor_supplier_item WHERE variant_id IS NULL) AS unmatched_vendor_items,
            (SELECT COUNT(*)::bigint FROM qbo_sync_logs
             WHERE status IN ('failed', 'error', 'needs_review')
                OR error_message IS NOT NULL) AS qbo_exceptions,
            (SELECT COUNT(*)::bigint FROM gift_cards
             WHERE current_balance < 0
                OR (card_status::text = 'active' AND expires_at < now())
                OR (current_balance > 0 AND card_status::text IN ('depleted', 'void'))) AS gift_card_exceptions
        "#,
    )
    .fetch_one(pool)
    .await?;
    let items = vec![
        json!({"priority": "high", "area": "Wedding Manager", "reason": "upcoming_members_missing_measurements_or_fittings", "count": row.get::<i64, _>("wedding_member_readiness_issues")}),
        json!({"priority": "high", "area": "Orders", "reason": "stale_ready_pickups", "count": row.get::<i64, _>("stale_pickup_lines")}),
        json!({"priority": "high", "area": "Register", "reason": "register_sessions_need_review", "count": row.get::<i64, _>("register_exceptions")}),
        json!({"priority": "medium", "area": "Procurement", "reason": "unmatched_vendor_items", "count": row.get::<i64, _>("unmatched_vendor_items")}),
        json!({"priority": "high", "area": "QBO", "reason": "qbo_exceptions", "count": row.get::<i64, _>("qbo_exceptions")}),
        json!({"priority": "high", "area": "Gift Cards", "reason": "gift_card_exceptions", "count": row.get::<i64, _>("gift_card_exceptions")}),
    ]
    .into_iter()
    .filter(|item| item.get("count").and_then(Value::as_i64).unwrap_or(0) > 0)
    .collect();
    Ok(response(
        def.tool_name,
        def.basis,
        json!({ "date": Utc::now().date_naive(), "scope": "counts_only" }),
        def.max_rows,
        items,
        vec!["Attention queue is read-only and groups counts by owning workspace.".to_string()],
    ))
}

async fn data_quality_summary(
    pool: &PgPool,
    def: &RosieReadToolDefinition,
    _args: &Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    let row = sqlx::query(
        r#"
        SELECT
            (SELECT COUNT(*)::bigint FROM customers
             WHERE NULLIF(trim(COALESCE(email, '')), '') IS NULL
               AND NULLIF(trim(COALESCE(phone, '')), '') IS NULL) AS customers_missing_contact,
            (SELECT COUNT(*)::bigint FROM product_variants pv
             JOIN products p ON p.id = pv.product_id
             LEFT JOIN product_variant_barcode_aliases ba ON ba.variant_id = pv.id
             WHERE p.is_active = TRUE
               AND NULLIF(trim(COALESCE(pv.vendor_upc, '')), '') IS NULL
               AND ba.id IS NULL) AS active_variants_missing_barcode,
            (SELECT COUNT(*)::bigint FROM product_variants pv
             JOIN products p ON p.id = pv.product_id
             WHERE p.is_active = TRUE
               AND COALESCE(pv.stock_on_hand, 0) < 0) AS negative_stock_variants,
            (SELECT COUNT(*)::bigint FROM vendor_supplier_item
             WHERE variant_id IS NULL) AS unmatched_vendor_items,
            (SELECT COUNT(*)::bigint FROM gift_cards
             WHERE current_balance < 0
                OR (card_status::text = 'active' AND expires_at < now())
                OR (current_balance > 0 AND card_status::text IN ('depleted', 'void'))) AS gift_cards_needing_review,
            (SELECT COUNT(*)::bigint FROM qbo_sync_logs
             WHERE status IN ('failed', 'error', 'needs_review')
                OR error_message IS NOT NULL) AS qbo_exceptions
        "#,
    )
    .fetch_one(pool)
    .await?;
    let data = json!({
        "customers_missing_contact": row.get::<i64, _>("customers_missing_contact"),
        "active_variants_missing_barcode": row.get::<i64, _>("active_variants_missing_barcode"),
        "negative_stock_variants": row.get::<i64, _>("negative_stock_variants"),
        "unmatched_vendor_items": row.get::<i64, _>("unmatched_vendor_items"),
        "gift_cards_needing_review": row.get::<i64, _>("gift_cards_needing_review"),
        "qbo_exceptions": row.get::<i64, _>("qbo_exceptions"),
    });
    Ok(response(
        def.tool_name,
        def.basis,
        json!({}),
        1,
        vec![data],
        vec!["Data quality summary returns counts only; open the owning workspace to resolve records.".to_string()],
    ))
}

pub async fn execute_rosie_read_tool(
    pool: &PgPool,
    tool_name: &str,
    args: Value,
) -> Result<RosieReadToolResponse, RosieReadToolError> {
    if mutation_like_tool_name(tool_name) {
        return Err(RosieReadToolError::MutationToolRejected);
    }
    let def = tool_definition(tool_name).ok_or(RosieReadToolError::UnknownTool)?;
    match tool_name {
        "search_customers_for_rosie" => search_customers(pool, def, &args).await,
        "search_weddings_for_rosie" => search_weddings(pool, def, &args).await,
        "search_vendors_for_rosie" => search_vendors(pool, def, &args).await,
        "get_customer_loyalty_balance" => customer_loyalty_balance(pool, def, &args).await,
        "get_customers_with_open_balances" => customers_with_open_balances(pool, def, &args).await,
        "get_customers_needing_follow_up" => customers_needing_follow_up(pool, def, &args).await,
        "get_customers_with_stale_pickups" => customers_with_stale_pickups(pool, def, &args).await,
        "get_customers_with_missing_contact_info" => {
            customers_with_missing_contact_info(pool, def, &args).await
        }
        "get_customer_purchase_history_summary" => {
            customer_purchase_history_summary(pool, def, &args).await
        }
        "get_customer_size_profile_summary" => {
            customer_size_profile_summary(pool, def, &args).await
        }
        "get_inventory_availability" => inventory_availability(pool, def, &args).await,
        "get_inventory_reorder_candidates" => inventory_reorder_candidates(pool, def, &args).await,
        "get_product_sales_by_query" => product_sales_by_query(pool, def, &args).await,
        "get_open_orders" => open_orders(pool, def, &args).await,
        "get_open_orders_ready_for_pickup" => open_orders_ready_for_pickup(pool, def, &args).await,
        "get_appointments_by_date" => appointments_by_date(pool, def, &args).await,
        "get_alterations_due" => alterations_due(pool, def, &args).await,
        "get_wedding_readiness" => wedding_readiness(pool, def, &args).await,
        "get_weddings_by_event_date_range" => weddings_by_event_date_range(pool, def, &args).await,
        "get_wedding_members_missing_measurements" => {
            wedding_members_missing_measurements(pool, def, &args).await
        }
        "get_upcoming_wedding_risk_report" => upcoming_wedding_risk_report(pool, def, &args).await,
        "get_wedding_members_missing_fittings" => {
            wedding_members_missing_fittings(pool, def, &args).await
        }
        "get_wedding_members_with_open_balances" => {
            wedding_members_with_open_balances(pool, def, &args).await
        }
        "get_wedding_orders_ready_for_pickup" => {
            wedding_orders_ready_for_pickup(pool, def, &args).await
        }
        "get_wedding_unfulfilled_items" => wedding_unfulfilled_items(pool, def, &args).await,
        "get_wedding_follow_up_list" => wedding_follow_up_list(pool, def, &args).await,
        "get_open_purchase_orders" => open_purchase_orders(pool, def, &args).await,
        "get_recent_receipts" => recent_receipts(pool, def, &args).await,
        "get_unmatched_vendor_items" => unmatched_vendor_items(pool, def, &args).await,
        "get_items_on_order" => items_on_order(pool, def, &args).await,
        "get_po_invoice_exception_report" => po_invoice_exception_report(pool, def, &args).await,
        "get_customer_credit_summary" => customer_credit_summary(pool, def, &args).await,
        "get_store_credit_summary" => store_credit_summary(pool, def, &args).await,
        "get_gift_card_summary" => gift_card_summary(pool, def, &args).await,
        "get_outstanding_credit_liability_summary" => {
            outstanding_credit_liability_summary(pool, def, &args).await
        }
        "get_gift_card_exception_report" => gift_card_exception_report(pool, def, &args).await,
        "get_qbo_exception_summary" => qbo_exception_summary(pool, def, &args).await,
        "get_qbo_sync_summary" => qbo_sync_summary(pool, def, &args).await,
        "get_register_exception_summary" => register_exception_summary(pool, def, &args).await,
        "get_daily_manager_brief" => daily_manager_brief(pool, def, &args).await,
        "get_data_quality_summary" => data_quality_summary(pool, def, &args).await,
        "get_data_cleanup_tasks" => data_cleanup_tasks(pool, def, &args).await,
        "get_manager_attention_queue" => manager_attention_queue(pool, def, &args).await,
        _ => Err(RosieReadToolError::UnknownTool),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_contains_only_read_only_tools() {
        assert!(!list_rosie_read_tools().is_empty());
        for tool in list_rosie_read_tools() {
            assert!(tool.read_only);
            assert!(!tool.mutates_data);
            assert!(!mutation_like_tool_name(tool.tool_name));
            assert!(!tool.required_permission.trim().is_empty());
            assert!(tool.max_rows > 0 && tool.max_rows <= MAX_LIMIT);
        }
    }

    #[test]
    fn mutation_like_tool_names_are_rejected() {
        for name in [
            "run_sql",
            "query_database",
            "adjust_inventory",
            "post_qbo_entry",
            "refund_transaction",
            "receive_inventory",
        ] {
            assert!(mutation_like_tool_name(name));
        }
    }

    #[test]
    fn limit_is_clamped_to_tool_max() {
        let args = json!({ "limit": 10_000 });
        assert_eq!(limit_from_args(&args, 25), 25);
        let args = json!({ "limit": 0 });
        assert_eq!(limit_from_args(&args, 25), 1);
    }

    #[test]
    fn sensitive_tools_require_fail_closed_audit() {
        for tool in list_rosie_read_tools() {
            assert!(tool_requires_audit_fail_closed(tool.tool_name));
        }
        assert!(!tool_requires_audit_fail_closed("unknown_tool"));
    }

    #[test]
    fn registry_exposes_safety_metadata() {
        let credit_tool = tool_definition("get_customer_credit_summary").expect("credit tool");
        assert_eq!(sensitivity_for_tool(credit_tool), "financial_sensitive");
        assert_eq!(
            input_schema_for_tool(credit_tool.tool_name),
            r#"{"customer_id":"uuid"}"#
        );
        let serialized = serde_json::to_value(credit_tool).expect("serialize tool metadata");
        assert_eq!(serialized["audit_policy"], "fail_closed");
        assert_eq!(serialized["mutation_allowed"], false);
        assert_eq!(serialized["read_only"], true);
    }
}
