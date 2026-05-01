/** Must match `server/src/auth/permissions.rs` and migration 34 seeds. */
export const STAFF_PERMISSION_CATALOG: {
  key: string;
  label: string;
  group: string;
}[] = [
  { key: "staff.view", label: "View roster", group: "Staff" },
  { key: "staff.edit", label: "Edit staff profiles", group: "Staff" },
  { key: "staff.manage_pins", label: "Set staff PINs", group: "Staff" },
  { key: "staff.manage_commission", label: "Commission & category rates", group: "Staff" },
  { key: "staff.view_audit", label: "View access audit log", group: "Staff" },
  { key: "staff.manage_access", label: "Manage staff access", group: "Staff" },
  { key: "qbo.view", label: "View QuickBooks data", group: "QuickBooks" },
  { key: "qbo.mapping_edit", label: "Manage QuickBooks setup", group: "QuickBooks" },
  { key: "qbo.staging_approve", label: "Approve QuickBooks entries", group: "QuickBooks" },
  { key: "qbo.sync", label: "Send updates to QuickBooks", group: "QuickBooks" },
  { key: "insights.view", label: "View insights & reports", group: "Insights" },
  {
    key: "insights.commission_finalize",
    label: "Finalize commission payouts",
    group: "Insights",
  },
  { key: "physical_inventory.view", label: "View physical inventory", group: "Inventory" },
  {
    key: "physical_inventory.mutate",
    label: "Run / publish physical inventory",
    group: "Inventory",
  },
  { key: "orders.view", label: "View transactions & transaction history", group: "Transactions" },
  { key: "orders.modify", label: "Edit transaction lines & pickup (Manager PIN required after 60 days)", group: "Transactions" },
  { key: "orders.cancel", label: "Cancel transactions and review refunds", group: "Transactions" },
  {
    key: "orders.void_sale",
    label: "Void unpaid transactions",
    group: "Transactions",
  },
  {
    key: "orders.suit_component_swap",
    label: "Swap suit or item SKUs on transactions",
    group: "Transactions",
  },
  { key: "orders.refund_process", label: "Process refunds", group: "Transactions" },
  { key: "orders.edit_attribution", label: "Edit transaction attribution", group: "Transactions" },
  { key: "pos.rms_charge.use", label: "Use RMS Charge tender in POS", group: "POS RMS Charge" },
  {
    key: "pos.rms_charge.lookup",
    label: "Lookup / disambiguate RMS Charge accounts in POS",
    group: "POS RMS Charge",
  },
  {
    key: "pos.rms_charge.history_basic",
    label: "View recent RMS Charge history in POS",
    group: "POS RMS Charge",
  },
  {
    key: "pos.rms_charge.payment_collect",
    label: "Collect RMS Charge payments in POS",
    group: "POS RMS Charge",
  },
  { key: "loyalty.adjust_points", label: "Adjust loyalty points", group: "Loyalty" },
  {
    key: "loyalty.program_settings",
    label: "Loyalty program settings & eligible list",
    group: "Loyalty",
  },
  { key: "catalog.view", label: "View catalog & vendors", group: "Catalog" },
  { key: "catalog.edit", label: "Edit catalog and imports", group: "Catalog" },
  { key: "procurement.view", label: "View purchase orders", group: "Vendor ordering" },
  { key: "procurement.mutate", label: "Create and receive purchase orders", group: "Vendor ordering" },
  { key: "settings.admin", label: "Manage store settings and backups", group: "Settings" },
  {
    key: "help.manage",
    label: "Manage help center articles",
    group: "Settings",
  },
  {
    key: "ops.dev_center.view",
    label: "View support tools",
    group: "Settings",
  },
  {
    key: "ops.dev_center.actions",
    label: "Run support tool actions",
    group: "Settings",
  },
  {
    key: "online_store.manage",
    label: "Manage online store pages and coupons",
    group: "Settings",
  },
  { key: "gift_cards.manage", label: "Gift card issue, void, inventory", group: "Gift cards" },
  { key: "weddings.view", label: "View weddings, compass, appointments", group: "Weddings" },
  { key: "weddings.mutate", label: "Edit wedding parties & appointments", group: "Weddings" },
  { key: "wedding_manager.open", label: "Open full Wedding Manager shell", group: "Weddings" },
  { key: "register.reports", label: "Manage register reports and cash review", group: "Register" },
  {
    key: "register.open_drawer",
    label: "Record drawer paid-in and paid-out from Back Office",
    group: "Register",
  },
  {
    key: "register.shift_handoff",
    label: "Change register shift primary without closing drawer",
    group: "Register",
  },
  {
    key: "tasks.manage",
    label: "Manage task templates, assignments, and team history",
    group: "Tasks",
  },
  {
    key: "tasks.view_team",
    label: "View team open task instances",
    group: "Tasks",
  },
  {
    key: "tasks.complete",
    label: "Complete own recurring task checklists",
    group: "Tasks",
  },
  { key: "inventory.view_cost", label: "View item cost", group: "Inventory" },
  {
    key: "customers.rms_charge",
    label: "Use RMS Charge accounts",
    group: "Customers",
  },
  {
    key: "customers.rms_charge.view",
    label: "View RMS Charge linked accounts & records",
    group: "Customers",
  },
  {
    key: "customers.rms_charge.manage_links",
    label: "Link / unlink RMS Charge accounts",
    group: "Customers",
  },
  {
    key: "customers.rms_charge.resolve_exceptions",
    label: "Resolve RMS Charge exceptions",
    group: "Customers",
  },
  {
    key: "customers.rms_charge.reconcile",
    label: "Review RMS Charge matching",
    group: "Customers",
  },
  {
    key: "customers.rms_charge.reverse",
    label: "Reverse or refund RMS Charge actions",
    group: "Customers",
  },
  {
    key: "customers.rms_charge.reporting",
    label: "View RMS Charge reports and matching",
    group: "Customers",
  },
];

export const STAFF_PERMISSION_KEYS = STAFF_PERMISSION_CATALOG.map((p) => p.key);
