/** Sidebar nav config (non-React module so `Sidebar.tsx` satisfies Fast Refresh). */

export type SidebarTabId =
  | "home"
  | "register"
  | "customers"
  | "rms-charge"
  | "podium-inbox"
  | "alterations"
  | "orders"
  | "inventory"
  | "online-store"
  | "weddings"
  | "gift-cards"
  | "loyalty"
  | "staff"
  | "qbo"
  | "appointments"
  | "reports"
  | "dashboard"
  | "pos-dashboard"
  | "settings"
  | "shipping"
  | "tasks"
  | "layaways";

export interface SubItem {
  id: string;
  label: string;
  kind?: "item" | "group";
}

export const SIDEBAR_SUB_SECTIONS: Record<SidebarTabId, SubItem[]> = {
  home: [
    { id: "dashboard", label: "Dashboard" },
    { id: "daily-sales", label: "Daily Sales" },
    { id: "fulfillment", label: "Pickup Queue" },
    { id: "inbox", label: "Podium Inbox" },
    { id: "reviews", label: "Reviews" },
  ],
  register: [],
  customers: [
    { id: "all", label: "All Customers" },
    { id: "add", label: "Add Customer" },
    { id: "layaways", label: "Layaways" },
    { id: "ship", label: "Shipments Hub" },
    { id: "rms-charge", label: "RMS Charge" },
    { id: "duplicate-review", label: "Duplicate Review" },
  ],
  "rms-charge": [],
  "podium-inbox": [],
  alterations: [
    { id: "queue", label: "Queue" },
  ],
  orders: [],
  inventory: [
    { id: "list", label: "Find Item" },
    { id: "add", label: "Add/Edit Catalog" },
    { id: "discount_events", label: "Promotions" },
    { id: "purchase_orders", label: "Order Stock" },
    { id: "receiving", label: "Receive Stock" },
    { id: "damaged", label: "Correct Stock" },
    { id: "physical", label: "Count/Reconcile" },
  ],
  "online-store": [
    { id: "dashboard", label: "Dashboard" },
    { id: "storefront", label: "Storefront" },
    { id: "products", label: "Products" },
    { id: "orders", label: "Orders" },
    { id: "customers", label: "Customers" },
    { id: "promotions", label: "Promotions" },
    { id: "shipping", label: "Shipping" },
    { id: "analytics", label: "Analytics" },
  ],
  weddings: [
    { id: "action-board", label: "Action Board" },
    { id: "parties", label: "Parties" },
    { id: "calendar", label: "Calendar" },
  ],
  "gift-cards": [],
  loyalty: [],
  staff: [
    { id: "team", label: "Team" },
    { id: "tasks", label: "Tasks" },
    { id: "schedule", label: "Schedule" },
    { id: "commission", label: "Commissions" },
    { id: "audit", label: "Audit" },
  ],
  qbo: [
    { id: "connection", label: "Connection" },
    { id: "mappings", label: "Mappings" },
    { id: "staging", label: "Staging" },
    { id: "history", label: "History" },
  ],
  appointments: [
    { id: "scheduler", label: "Scheduler" },
    { id: "conflicts", label: "Conflicts" },
  ],
  reports: [],
  dashboard: [],
  "pos-dashboard": [],
  settings: [
    { id: "settings-group-store-setup", label: "Store Setup", kind: "group" },
    { id: "hub", label: "Settings Hub" },
    { id: "profile", label: "Profile" },
    { id: "general", label: "General" },
    { id: "staff-access-defaults", label: "Staff Access Defaults" },
    { id: "online-store", label: "Online Store" },
    { id: "settings-group-register-setup", label: "Register Setup", kind: "group" },
    { id: "printing", label: "Printers & Scanners" },
    { id: "receipt-builder", label: "Receipt Settings" },
    { id: "tag-designer", label: "Tag Designer" },
    { id: "register", label: "Terminal Overrides" },
    { id: "settings-group-maintenance", label: "Maintenance", kind: "group" },
    { id: "backups", label: "Data & Backups" },
    { id: "remote-access", label: "Remote Access" },
    { id: "settings-group-integrations", label: "Integrations", kind: "group" },
    { id: "integrations", label: "Integrations Overview" },
    { id: "podium", label: "Podium" },
    { id: "shippo", label: "Shippo" },
    { id: "stripe", label: "Stripe" },
    { id: "quickbooks", label: "QuickBooks" },
    { id: "counterpoint", label: "Counterpoint" },
    { id: "nuorder", label: "NuORDER" },
    { id: "weather", label: "Weather" },
    { id: "insights", label: "Insights" },
    { id: "meilisearch", label: "Meilisearch" },
    { id: "settings-group-system-support", label: "System & Support", kind: "group" },
    { id: "help-center", label: "Help Center" },
    { id: "rosie", label: "ROSIE" },
    { id: "bug-reports", label: "Bug Reports" },
    { id: "ros-dev-center", label: "ROS Dev Center" },
  ],
  shipping: [],
  tasks: [],
  layaways: [],
};
