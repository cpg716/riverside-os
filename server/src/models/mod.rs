//! SQLx models: PostgreSQL schema ↔ Rust (type-safe bridge to `logic`).

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::Type;
use uuid::Uuid;

pub mod product;

// --- Enums to match DB types ---

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[sqlx(type_name = "tax_category", rename_all = "lowercase")]
pub enum DbTaxCategory {
    Clothing,
    Footwear,
    Accessory,
    Service,
}

/// PostgreSQL `fulfillment_type`: `takeaway`, `special_order`, `custom`, `wedding_order` — snake_case.
/// `custom` is legacy-only (no new writes). `wedding_order` is for wedding-member orders.
#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "fulfillment_type", rename_all = "snake_case")]
pub enum DbFulfillmentType {
    Takeaway,
    SpecialOrder,
    Custom,
    WeddingOrder,
    Layaway,
}

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[sqlx(type_name = "order_status", rename_all = "snake_case")]
pub enum DbOrderStatus {
    Open,
    Fulfilled,
    Cancelled,
    PendingMeasurement,
}

/// PostgreSQL `order_fulfillment_method`: `pickup`, `ship` — customer delivery mode (Shippo).
#[derive(Debug, Default, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "order_fulfillment_method", rename_all = "snake_case")]
pub enum DbOrderFulfillmentMethod {
    #[default]
    Pickup,
    Ship,
}

/// PostgreSQL `sale_channel`: `register` (POS) vs `web` (first-party storefront).
#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "sale_channel", rename_all = "snake_case")]
pub enum DbSaleChannel {
    Register,
    Web,
}

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "shipment_source", rename_all = "snake_case")]
pub enum DbShipmentSource {
    PosOrder,
    WebOrder,
    ManualHub,
}

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "shipment_status", rename_all = "snake_case")]
pub enum DbShipmentStatus {
    Draft,
    Quoted,
    LabelPurchased,
    InTransit,
    Delivered,
    Cancelled,
    Exception,
}

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[sqlx(type_name = "transaction_category", rename_all = "snake_case")]
pub enum DbTransactionCategory {
    RetailSale,
    RmsAccountPayment,
}

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "staff_role", rename_all = "snake_case")]
pub enum DbStaffRole {
    Admin,
    Salesperson,
    SalesSupport,
    StaffSupport,
    Alterations,
}

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "task_recurrence", rename_all = "snake_case")]
pub enum DbTaskRecurrence {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "task_assignee_kind", rename_all = "snake_case")]
pub enum DbTaskAssigneeKind {
    Staff,
    Role,
}

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "task_instance_status", rename_all = "snake_case")]
pub enum DbTaskInstanceStatus {
    Open,
    Completed,
    Cancelled,
}

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "staff_schedule_exception_kind", rename_all = "snake_case")]
pub enum DbStaffScheduleExceptionKind {
    Sick,
    Pto,
    MissedShift,
    ExtraShift,
}

#[derive(Debug, Serialize, Deserialize, Type, PartialEq, Eq, Clone, Copy)]
#[sqlx(type_name = "inventory_tx_type", rename_all = "snake_case")]
pub enum DbInventoryTxType {
    PoReceipt,
    Sale,
    Adjustment,
    ReturnIn,
    ReturnOut,
    Damaged,
    ReturnToVendor,
    PhysicalInventory,
}

// --- Mapping: granular DB categories → NYS tax engine (accessory & service → full rate) ---

impl From<DbTaxCategory> for crate::logic::tax::TaxCategory {
    fn from(db_cat: DbTaxCategory) -> Self {
        match db_cat {
            DbTaxCategory::Clothing => crate::logic::tax::TaxCategory::Clothing,
            DbTaxCategory::Footwear => crate::logic::tax::TaxCategory::Footwear,
            DbTaxCategory::Accessory | DbTaxCategory::Service => {
                crate::logic::tax::TaxCategory::Other
            }
        }
    }
}

// --- Core structs ---

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Product {
    pub id: Uuid,
    pub name: String,
    pub brand: Option<String>,
    pub tax_category: DbTaxCategory,
    pub base_retail_price: Decimal,
    pub base_unit_cost: Decimal,
    pub spiff_amount: Decimal,
    pub has_variations: bool,
    pub is_active: bool,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct ProductVariant {
    pub id: Uuid,
    pub product_id: Uuid,
    pub sku: String,
    pub variation_label: Option<String>,
    pub stock_on_hand: i32,
    pub reorder_point: i32,
    pub on_layaway: i32,
    pub override_retail_price: Option<Decimal>,
    pub override_unit_cost: Option<Decimal>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Staff {
    pub id: Uuid,
    pub full_name: String,
    pub cashier_code: String,
    pub pin: Option<String>,
    pub pin_hash: Option<String>,
    pub role: Option<String>,
    pub avatar_key: Option<String>,
    pub base_commission_rate: Decimal,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct WeddingParty {
    pub id: Uuid,
    pub groom_name: String,
    pub suit_variant_id: Option<Uuid>,
    pub event_date: NaiveDate,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Customer {
    pub id: Uuid,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub loyalty_points: i32,
    pub wedding_id: Option<Uuid>,
    pub stripe_customer_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Measurement {
    pub id: Uuid,
    pub customer_id: Uuid,
    pub neck: Option<Decimal>,
    pub sleeve: Option<Decimal>,
    pub chest: Option<Decimal>,
    pub waist: Option<Decimal>,
    pub seat: Option<Decimal>,
    pub inseam: Option<Decimal>,
    pub outseam: Option<Decimal>,
    pub shoulder: Option<Decimal>,
    pub measured_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct RegisterSession {
    pub id: Uuid,
    pub opened_by: Option<Uuid>,
    pub closed_by: Option<Uuid>,
    pub opening_float: Decimal,
    pub expected_cash: Option<Decimal>,
    pub actual_cash: Option<Decimal>,
    pub cash_over_short: Option<Decimal>,
    pub is_open: bool,
    pub opened_at: DateTime<Utc>,
    pub closed_at: Option<DateTime<Utc>>,
    #[sqlx(json)]
    pub weather_snapshot: Option<serde_json::Value>,
    pub closing_comments: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Transaction {
    pub id: Uuid,
    pub display_id: Option<String>,
    pub customer_id: Option<Uuid>,
    pub wedding_id: Option<Uuid>,
    pub operator_id: Option<Uuid>,
    pub primary_salesperson_id: Option<Uuid>,
    pub is_employee_purchase: bool,
    pub fulfillment_method: Option<String>,
    pub booked_at: DateTime<Utc>,
    pub total_price: Decimal,
    pub amount_paid: Decimal,
    pub balance_due: Decimal,
    pub rounding_adjustment: Decimal,
    pub final_cash_due: Option<Decimal>,
    pub is_forfeited: bool,
    pub forfeited_at: Option<DateTime<Utc>>,
    #[sqlx(json)]
    pub metadata: Option<serde_json::Value>,
    #[sqlx(json)]
    pub weather_snapshot: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct TransactionLine {
    pub id: Uuid,
    pub transaction_id: Uuid,
    pub fulfillment_order_id: Option<Uuid>,
    pub line_display_id: Option<String>,
    pub product_id: Uuid,
    pub variant_id: Option<Uuid>,
    pub salesperson_id: Option<Uuid>,
    pub fulfillment: DbFulfillmentType,
    pub quantity: i32,
    pub unit_price: Decimal,
    pub unit_cost: Decimal,
    pub state_tax: Decimal,
    pub local_tax: Decimal,
    pub applied_spiff: Decimal,
    pub calculated_commission: Decimal,
    #[sqlx(json)]
    pub size_specs: Option<serde_json::Value>,
    pub is_fulfilled: bool,
    pub fulfilled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct FulfillmentOrder {
    pub id: Uuid,
    pub display_id: String,
    pub customer_id: Option<Uuid>,
    pub wedding_id: Option<Uuid>,
    pub status: String,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub fulfilled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct PaymentTransaction {
    pub id: Uuid,
    pub session_id: Option<Uuid>,
    pub payer_id: Option<Uuid>,
    pub category: DbTransactionCategory,
    pub payment_method: String,
    pub amount: Decimal,
    pub status: Option<String>,
    #[sqlx(json)]
    pub metadata: Option<serde_json::Value>,
    pub stripe_intent_id: Option<String>,
    pub merchant_fee: Decimal,
    pub net_amount: Decimal,
    pub card_brand: Option<String>,
    pub card_last4: Option<String>,
    pub check_number: Option<String>,
    pub is_posted_to_rms_portal: bool,
    pub occurred_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct PaymentAllocation {
    pub id: Uuid,
    pub transaction_id: Uuid,
    pub target_transaction_id: Uuid,
    pub amount_allocated: Decimal,
    pub check_number: Option<String>,
    #[sqlx(json)]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct GiftCard {
    pub id: Uuid,
    pub code: String,
    pub current_balance: Decimal,
    pub is_liability: bool,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct StoreSettings {
    pub id: i32,
    pub employee_markup_percent: Decimal,
    pub loyalty_point_threshold: i32,
    pub loyalty_reward_amount: Decimal,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommissionRule {
    pub id: Uuid,
    pub match_type: String, // 'category', 'product', 'variant'
    pub match_id: Uuid,
    pub override_rate: Option<Decimal>,
    pub fixed_spiff_amount: Decimal,
    pub label: Option<String>,
    pub is_active: bool,
    pub start_date: Option<DateTime<Utc>>,
    pub end_date: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommissionComboRule {
    pub id: Uuid,
    pub label: String,
    pub reward_amount: Decimal,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct CommissionComboRuleItem {
    pub id: Uuid,
    pub rule_id: Uuid,
    pub match_type: String, // 'category', 'product'
    pub match_id: Uuid,
    pub qty_required: i32,
}
