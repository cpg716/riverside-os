//! Shared wedding API row / list shapes (used by `api/weddings` handlers).

use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::logic::wedding_party_display::wedding_party_tracking_label;

#[derive(Debug, Deserialize)]
pub struct PartyListQuery {
    pub page: Option<i64>,
    pub limit: Option<i64>,
    pub search: Option<String>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub salesperson: Option<String>,
    #[serde(default)]
    pub show_deleted: bool,
}

#[derive(Debug, Serialize)]
pub struct Pagination {
    pub page: i64,
    pub limit: i64,
    pub total: i64,
    pub total_pages: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingPartyRow {
    pub id: Uuid,
    pub party_name: Option<String>,
    pub groom_name: String,
    pub event_date: NaiveDate,
    pub venue: Option<String>,
    pub notes: Option<String>,
    pub party_type: Option<String>,
    pub sign_up_date: Option<NaiveDate>,
    pub salesperson: Option<String>,
    pub style_info: Option<String>,
    pub price_info: Option<String>,
    pub groom_phone: Option<String>,
    pub groom_email: Option<String>,
    pub bride_name: Option<String>,
    pub bride_phone: Option<String>,
    pub bride_email: Option<String>,
    #[sqlx(json)]
    pub accessories: serde_json::Value,
    pub groom_phone_clean: Option<String>,
    pub bride_phone_clean: Option<String>,
    pub is_deleted: Option<bool>,
    pub suit_variant_id: Option<Uuid>,
    /// Whether the suit_variant_id references a valid ROS product
    pub suit_inventory_verified: Option<bool>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingMemberApi {
    pub id: Uuid,
    pub wedding_party_id: Uuid,
    pub customer_id: Uuid,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub customer_email: Option<String>,
    pub customer_phone: Option<String>,
    pub role: String,
    pub status: String,
    pub transaction_id: Option<Uuid>,
    pub notes: Option<String>,
    pub member_index: Option<i32>,
    pub oot: Option<bool>,
    pub suit: Option<String>,
    pub waist: Option<String>,
    pub vest: Option<String>,
    pub shirt: Option<String>,
    pub shoe: Option<String>,
    pub measured: Option<bool>,
    pub suit_ordered: Option<bool>,
    pub received: Option<bool>,
    pub fitting: Option<bool>,
    pub pickup_status: Option<String>,
    pub measure_date: Option<NaiveDate>,
    pub ordered_date: Option<NaiveDate>,
    pub received_date: Option<NaiveDate>,
    pub fitting_date: Option<NaiveDate>,
    pub pickup_date: Option<NaiveDate>,
    #[sqlx(json)]
    pub ordered_items: serde_json::Value,
    #[sqlx(json)]
    pub member_accessories: serde_json::Value,
    #[sqlx(json)]
    pub contact_history: serde_json::Value,
    pub pin_note: Option<bool>,
    pub ordered_po: Option<String>,
    #[sqlx(json)]
    pub stock_info: serde_json::Value,
    pub suit_variant_id: Option<Uuid>,
    pub is_free_suit_promo: bool,
    /// Whether this member has a verified ROS customer link
    pub customer_verified: bool,
    /// Original customer data from import (before verification)
    pub import_customer_name: Option<String>,
    pub import_customer_phone: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WeddingPartyWithMembers {
    #[serde(flatten)]
    pub party: WeddingPartyRow,
    /// Canonical ROS display: `NameNoSpaces-MMDDYY` (same as customer/order lists).
    pub party_tracking_label: String,
    pub members: Vec<WeddingMemberApi>,
}

pub fn build_party_bundle(
    party: WeddingPartyRow,
    members: Vec<WeddingMemberApi>,
) -> WeddingPartyWithMembers {
    let party_tracking_label = wedding_party_tracking_label(
        party.party_name.as_deref(),
        &party.groom_name,
        party.event_date,
    );
    WeddingPartyWithMembers {
        party,
        party_tracking_label,
        members,
    }
}

#[derive(Debug, Serialize)]
pub struct PaginatedParties {
    pub data: Vec<WeddingPartyWithMembers>,
    pub pagination: Pagination,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ActivityFeedRow {
    pub id: Uuid,
    pub actor_name: String,
    pub action_type: String,
    pub description: String,
    pub created_at: DateTime<Utc>,
    pub party_name: String,
    pub member_name: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ActionRow {
    pub wedding_party_id: Uuid,
    pub wedding_member_id: Uuid,
    pub party_name: String,
    pub customer_name: String,
    pub role: String,
    pub status: String,
    pub event_date: NaiveDate,
    /// Sum of `transactions.balance_due` for all members of this party (operational signal on dashboard).
    pub party_balance_due: Decimal,
}

#[derive(Debug, Serialize)]
pub struct WeddingActions {
    pub needs_measure: Vec<ActionRow>,
    pub needs_order: Vec<ActionRow>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingLedgerSummary {
    pub wedding_party_id: Uuid,
    pub total_transaction_value: Decimal,
    pub total_paid: Decimal,
    pub balance_due: Decimal,
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingLedgerLine {
    pub transaction_id: Option<Uuid>,
    pub payment_tx_id: Option<Uuid>,
    pub customer_name: String,
    pub wedding_member_id: Uuid,
    pub kind: String,
    pub amount: Decimal,
    pub created_at: DateTime<Utc>,
    /// For `kind = transaction`: `takeaway`, `wedding_order`, `special_order`, `mixed`, or null when the transaction has no lines.
    pub fulfillment_profile: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WeddingLedgerResponse {
    pub summary: WeddingLedgerSummary,
    pub lines: Vec<WeddingLedgerLine>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingMemberFinancialRow {
    pub wedding_member_id: Uuid,
    pub customer_name: String,
    pub transaction_count: i64,
    pub payment_count: i64,
    pub transaction_total: Decimal,
    pub paid_total: Decimal,
    pub balance_due: Decimal,
    pub is_free_suit_promo: bool,
}

#[derive(Debug, Serialize, FromRow)]
pub struct SuitSelectionStat {
    pub variant_id: Option<Uuid>,
    pub product_name: Option<String>,
    pub variation_label: Option<String>,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct WeddingPartyAnalytics {
    pub total_profit: Decimal,
    pub total_cost: Decimal,
    pub total_revenue: Decimal,
    pub average_margin: Decimal,
    pub free_suits_marked: i32,
    pub qualification_count: i32,
    pub common_suits: Vec<SuitSelectionStat>,
}

#[derive(Debug, Serialize)]
pub struct WeddingPartyFinancialContext {
    pub summary: WeddingLedgerSummary,
    pub lines: Vec<WeddingLedgerLine>,
    pub members: Vec<WeddingMemberFinancialRow>,
    pub analytics: WeddingPartyAnalytics,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AppointmentRow {
    pub id: Uuid,
    pub wedding_party_id: Option<Uuid>,
    pub wedding_member_id: Option<Uuid>,
    pub customer_id: Option<Uuid>,
    pub customer_display_name: Option<String>,
    pub phone: Option<String>,
    pub appointment_type: String,
    pub starts_at: DateTime<Utc>,
    pub notes: Option<String>,
    pub status: String,
    pub salesperson: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct WeddingNonInventoryItem {
    pub id: Uuid,
    pub wedding_party_id: Uuid,
    pub wedding_member_id: Option<Uuid>,
    pub description: String,
    pub quantity: i32,
    pub status: String,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
