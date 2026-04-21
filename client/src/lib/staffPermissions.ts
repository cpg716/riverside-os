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
  { key: "staff.manage_access", label: "Role & user permissions", group: "Staff" },
  { key: "qbo.view", label: "View QBO data", group: "QBO" },
  { key: "qbo.mapping_edit", label: "Edit mappings & connection", group: "QBO" },
  { key: "qbo.staging_approve", label: "Approve journal staging", group: "QBO" },
  { key: "qbo.sync", label: "Sync to QuickBooks", group: "QBO" },
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
  { key: "orders.view", label: "View orders & order history", group: "Orders" },
  { key: "orders.modify", label: "Edit order lines & pickup", group: "Orders" },
  { key: "orders.cancel", label: "Cancel orders (including refund queue)", group: "Orders" },
  {
    key: "orders.void_sale",
    label: "Void unpaid orders (no payment allocations)",
    group: "Orders",
  },
  {
    key: "orders.suit_component_swap",
    label: "Suit / component SKU swap on order lines (inventory-aware)",
    group: "Orders",
  },
  { key: "orders.refund_process", label: "Process refunds & view refund queue", group: "Orders" },
  { key: "orders.edit_attribution", label: "Edit order attribution", group: "Orders" },
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
  { key: "catalog.edit", label: "Edit catalog, matrix, import", group: "Catalog" },
  { key: "procurement.view", label: "View purchase orders", group: "Procurement" },
  { key: "procurement.mutate", label: "Create / receive purchase orders", group: "Procurement" },
  { key: "settings.admin", label: "Store settings, backups, database", group: "Settings" },
  {
    key: "help.manage",
    label: "Help center manuals (visibility, overrides, gates)",
    group: "Settings",
  },
  {
    key: "ops.dev_center.view",
    label: "View ROS Dev Center",
    group: "Settings",
  },
  {
    key: "ops.dev_center.actions",
    label: "Run ROS Dev Center guarded actions",
    group: "Settings",
  },
  {
    key: "online_store.manage",
    label: "Online store CMS pages & web coupons",
    group: "Settings",
  },
  { key: "gift_cards.manage", label: "Gift card issue, void, inventory", group: "Gift cards" },
  { key: "weddings.view", label: "View weddings, compass, appointments", group: "Weddings" },
  { key: "weddings.mutate", label: "Edit wedding parties & appointments", group: "Weddings" },
  { key: "wedding_manager.open", label: "Open full Wedding Manager shell", group: "Weddings" },
  { key: "register.reports", label: "Register Z/X reports & reconciliation (BO)", group: "Register" },
  {
    key: "register.open_drawer",
    label: "Drawer paid-in / paid-out from Back Office (without POS token)",
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
  { key: "inventory.view_cost", label: "View unit cost (POS intelligence)", group: "Inventory" },
  {
    key: "customers.rms_charge",
    label: "Legacy RMS charge access (compatibility)",
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
    label: "Run RMS Charge reconciliation",
    group: "Customers",
  },
  {
    key: "customers.rms_charge.reverse",
    label: "Reverse / refund RMS Charge host actions",
    group: "Customers",
  },
  {
    key: "customers.rms_charge.reporting",
    label: "View RMS Charge reporting and reconciliation views",
    group: "Customers",
  },
];

export const STAFF_PERMISSION_KEYS = STAFF_PERMISSION_CATALOG.map((p) => p.key);
