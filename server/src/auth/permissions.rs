//! Back Office permission keys (aligned with `migrations/34_staff_contacts_and_permissions.sql`).

use std::collections::HashSet;

use sqlx::PgPool;
use uuid::Uuid;

use crate::models::DbStaffRole;

pub const STAFF_VIEW: &str = "staff.view";
pub const STAFF_EDIT: &str = "staff.edit";
pub const STAFF_MANAGE_PINS: &str = "staff.manage_pins";
pub const STAFF_MANAGE_COMMISSION: &str = "staff.manage_commission";
pub const STAFF_VIEW_AUDIT: &str = "staff.view_audit";
pub const STAFF_MANAGE_ACCESS: &str = "staff.manage_access";

pub const QBO_VIEW: &str = "qbo.view";
pub const QBO_MAPPING_EDIT: &str = "qbo.mapping_edit";
pub const QBO_STAGING_APPROVE: &str = "qbo.staging_approve";
pub const QBO_SYNC: &str = "qbo.sync";

pub const INSIGHTS_VIEW: &str = "insights.view";
pub const INSIGHTS_COMMISSION_FINALIZE: &str = "insights.commission_finalize";

pub const PHYSICAL_INVENTORY_VIEW: &str = "physical_inventory.view";
pub const PHYSICAL_INVENTORY_MUTATE: &str = "physical_inventory.mutate";

pub const ORDERS_EDIT_ATTRIBUTION: &str = "orders.edit_attribution";
/// Browse orders, view detail, audit trail, receipts (Back Office + authenticated POS read paths).
pub const ORDERS_VIEW: &str = "orders.view";
/// Cancel an order (queues refund when payments exist).
pub const ORDERS_CANCEL: &str = "orders.cancel";
/// Cancel an order that has **no** payment allocations (void mistaken / unpaid cart).
pub const ORDERS_VOID_SALE: &str = "orders.void_sale";
/// Replace a line’s variant with inventory-aware suit/component swap (Back Office).
pub const ORDERS_SUIT_COMPONENT_SWAP: &str = "orders.suit_component_swap";
/// View refund queue and post register refunds.
pub const ORDERS_REFUND_PROCESS: &str = "orders.refund_process";
/// Add/change/delete lines, pickup, returns, exchanges (post-checkout mutations).
pub const ORDERS_MODIFY: &str = "orders.modify";
pub const LOYALTY_ADJUST_POINTS: &str = "loyalty.adjust_points";
pub const INVENTORY_VIEW_COST: &str = "inventory.view_cost";

pub const CATALOG_VIEW: &str = "catalog.view";
pub const CATALOG_EDIT: &str = "catalog.edit";
pub const PROCUREMENT_VIEW: &str = "procurement.view";
pub const PROCUREMENT_MUTATE: &str = "procurement.mutate";
pub const SETTINGS_ADMIN: &str = "settings.admin";
/// Online storefront: CMS pages, coupons, and related admin APIs.
pub const ONLINE_STORE_MANAGE: &str = "online_store.manage";
pub const GIFT_CARDS_MANAGE: &str = "gift_cards.manage";
pub const LOYALTY_PROGRAM_SETTINGS: &str = "loyalty.program_settings";
pub const WEDDINGS_VIEW: &str = "weddings.view";
pub const WEDDINGS_MUTATE: &str = "weddings.mutate";
/// Open the full Wedding Manager shell from POS / Back Office navigation.
pub const WEDDING_MANAGER_OPEN: &str = "wedding_manager.open";
/// Back Office: read Z/X reports and reconciliation for a register session without POS token.
pub const REGISTER_REPORTS: &str = "register.reports";
/// Back Office: record paid-in / paid-out drawer adjustments without POS session token.
pub const REGISTER_OPEN_DRAWER: &str = "register.open_drawer";
/// Change register shift primary (who is "on register") without closing the drawer.
pub const REGISTER_SHIFT_HANDOFF: &str = "register.shift_handoff";
/// Join an already-open register session (receive POS API token) when multiple drawers are open.
pub const REGISTER_SESSION_ATTACH: &str = "register.session_attach";

/// Merge duplicate CRM records (re-point orders, weddings, loyalty; delete slave).
pub const CUSTOMERS_MERGE: &str = "customers.merge";
/// Relationship Hub: read **`GET .../hub`**, **`GET .../profile`**, **`GET .../weddings`**, **`GET /customers/{id}`**, **`GET .../store-credit`** summary.
pub const CUSTOMERS_HUB_VIEW: &str = "customers.hub_view";
/// Edit customer profile / marketing / VIP from hub (**`PATCH /customers/{id}`**).
pub const CUSTOMERS_HUB_EDIT: &str = "customers.hub_edit";
/// Timeline read + staff notes (**`GET .../timeline`**, **`POST .../notes`**).
pub const CUSTOMERS_TIMELINE: &str = "customers.timeline";
/// Measurement vault (**`GET`/`PATCH .../measurements`**).
pub const CUSTOMERS_MEASUREMENTS: &str = "customers.measurements";
/// R2S RMS charge/payment admin list under Customers.
pub const CUSTOMERS_RMS_CHARGE: &str = "customers.rms_charge";
/// Create/unlink customer couples (Pillar 6).
pub const CUSTOMERS_COUPLE_MANAGE: &str = "customers.couple_manage";

/// Shipments hub: list/read unified shipments (POS, web, manual) and timeline.
pub const SHIPMENTS_VIEW: &str = "shipments.view";
/// Create manual shipments, fetch rates, apply quotes, notes, status/tracking edits.
pub const SHIPMENTS_MANAGE: &str = "shipments.manage";

pub const ALTERATIONS_MANAGE: &str = "alterations.manage";
pub const CUSTOMER_GROUPS_MANAGE: &str = "customer_groups.manage";
pub const STORE_CREDIT_MANAGE: &str = "store_credit.manage";

pub const NOTIFICATIONS_VIEW: &str = "notifications.view";
pub const NOTIFICATIONS_BROADCAST: &str = "notifications.broadcast";

/// Operations Reviews hub (Podium review invites / triage).
pub const REVIEWS_VIEW: &str = "reviews.view";
pub const REVIEWS_MANAGE: &str = "reviews.manage";

pub const TASKS_MANAGE: &str = "tasks.manage";
pub const TASKS_VIEW_TEAM: &str = "tasks.view_team";
pub const TASKS_COMPLETE: &str = "tasks.complete";

/// Edit Help Center manual policies (visibility, markdown overrides, RBAC gates).
pub const HELP_MANAGE: &str = "help.manage";
pub const OPS_DEV_CENTER_VIEW: &str = "ops.dev_center.view";
pub const OPS_DEV_CENTER_ACTIONS: &str = "ops.dev_center.actions";

pub const NUORDER_MANAGE: &str = "nuorder.manage";
pub const NUORDER_SYNC: &str = "nuorder.sync";

/// Review queued duplicate customer pairs (Pillar 5b).
pub const CUSTOMERS_DUPLICATE_REVIEW: &str = "customers_duplicate_review";

/// All keys in the v1 catalog (admin bypass uses this set).
pub static ALL_PERMISSION_KEYS: &[&str] = &[
    STAFF_VIEW,
    STAFF_EDIT,
    STAFF_MANAGE_PINS,
    STAFF_MANAGE_COMMISSION,
    STAFF_VIEW_AUDIT,
    STAFF_MANAGE_ACCESS,
    QBO_VIEW,
    QBO_MAPPING_EDIT,
    QBO_STAGING_APPROVE,
    QBO_SYNC,
    INSIGHTS_VIEW,
    INSIGHTS_COMMISSION_FINALIZE,
    PHYSICAL_INVENTORY_VIEW,
    PHYSICAL_INVENTORY_MUTATE,
    ORDERS_EDIT_ATTRIBUTION,
    ORDERS_VIEW,
    ORDERS_CANCEL,
    ORDERS_VOID_SALE,
    ORDERS_SUIT_COMPONENT_SWAP,
    ORDERS_REFUND_PROCESS,
    ORDERS_MODIFY,
    LOYALTY_ADJUST_POINTS,
    INVENTORY_VIEW_COST,
    CATALOG_VIEW,
    CATALOG_EDIT,
    PROCUREMENT_VIEW,
    PROCUREMENT_MUTATE,
    SETTINGS_ADMIN,
    ONLINE_STORE_MANAGE,
    GIFT_CARDS_MANAGE,
    LOYALTY_PROGRAM_SETTINGS,
    WEDDINGS_VIEW,
    WEDDINGS_MUTATE,
    WEDDING_MANAGER_OPEN,
    REGISTER_REPORTS,
    REGISTER_OPEN_DRAWER,
    REGISTER_SHIFT_HANDOFF,
    REGISTER_SESSION_ATTACH,
    CUSTOMERS_MERGE,
    CUSTOMERS_HUB_VIEW,
    CUSTOMERS_HUB_EDIT,
    CUSTOMERS_TIMELINE,
    CUSTOMERS_MEASUREMENTS,
    ALTERATIONS_MANAGE,
    CUSTOMER_GROUPS_MANAGE,
    STORE_CREDIT_MANAGE,
    NOTIFICATIONS_VIEW,
    NOTIFICATIONS_BROADCAST,
    REVIEWS_VIEW,
    REVIEWS_MANAGE,
    TASKS_MANAGE,
    TASKS_VIEW_TEAM,
    TASKS_COMPLETE,
    HELP_MANAGE,
    OPS_DEV_CENTER_VIEW,
    OPS_DEV_CENTER_ACTIONS,
    CUSTOMERS_DUPLICATE_REVIEW,
    CUSTOMERS_RMS_CHARGE,
    SHIPMENTS_VIEW,
    SHIPMENTS_MANAGE,
    CUSTOMERS_COUPLE_MANAGE,
    NUORDER_MANAGE,
    NUORDER_SYNC,
];

pub fn all_permissions_set() -> HashSet<String> {
    ALL_PERMISSION_KEYS
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

/// Effective permissions: Admin → full catalog. Else rows in `staff_permission` (per-staff grants).
pub async fn effective_permissions_for_staff(
    pool: &PgPool,
    staff_id: Uuid,
    role: DbStaffRole,
) -> Result<HashSet<String>, sqlx::Error> {
    if role == DbStaffRole::Admin {
        return Ok(all_permissions_set());
    }

    let granted: Vec<(String,)> = sqlx::query_as(
        r#"
        SELECT permission_key
        FROM staff_permission
        WHERE staff_id = $1 AND allowed = true
        "#,
    )
    .bind(staff_id)
    .fetch_all(pool)
    .await?;

    Ok(granted.into_iter().map(|r| r.0).collect())
}

pub fn staff_has_permission(set: &HashSet<String>, key: &str) -> bool {
    set.contains(key)
}
