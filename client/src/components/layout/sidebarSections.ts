/** Sidebar nav config (non-React module so `Sidebar.tsx` satisfies Fast Refresh). */

export type SidebarTabId =
  | "home"
  | "register"
  | "customers"
  | "rms-charge"
  | "alterations"
  | "orders"
  | "inventory"
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
}

export const SIDEBAR_SUB_SECTIONS: Record<SidebarTabId, SubItem[]> = {
  home: [
    { id: "dashboard", label: "Dashboard" },
    { id: "fulfillment", label: "Fulfillment" },
    { id: "inbox", label: "Inbox" },
    { id: "reviews", label: "Reviews" },
    { id: "daily-sales", label: "Daily Sales" },
    { id: "payouts", label: "Payouts" },
    { id: "morning_digest", label: "Morning Digest" },
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
  alterations: [
    { id: "queue", label: "Queue" },
  ],
  orders: [
    { id: "open", label: "Open Orders" },
    { id: "all", label: "Order History" },
    { id: "returns", label: "Returns" },
    { id: "pickups", label: "Pending Pickups" },
  ],
  inventory: [
    { id: "list", label: "List" },
    { id: "purchase_orders", label: "Purchase Orders" },
    { id: "receiving", label: "Receiving" },
    { id: "vendors", label: "Vendors" },
    { id: "add", label: "Add Item" },
    { id: "categories", label: "Categories" },
    { id: "discount_events", label: "Discount Events" },
    { id: "import", label: "Import" },
    { id: "physical", label: "Physical Counts" },
    { id: "damaged", label: "Damaged" },
    { id: "rtv", label: "RTV" },
    { id: "intelligence", label: "Intelligence" },
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
    { id: "commission", label: "Commission" },
    { id: "commission-payouts", label: "Commission Payouts" },
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
    { id: "profile", label: "Profile" },
    { id: "general", label: "General" },
    { id: "backups", label: "Data & Backups" },
    { id: "printing", label: "Printers & Scanners" },
    { id: "register", label: "Terminal Overrides" },
    { id: "receipt-builder", label: "Receipt Builder" },
    { id: "tag-designer", label: "Tag Designer" },
    { id: "integrations", label: "Integrations" },
    { id: "staff-access-defaults", label: "Staff Access Defaults" },
    { id: "counterpoint", label: "Counterpoint" },
    { id: "remote-access", label: "Remote Access" },
    { id: "ros-dev-center", label: "ROS Dev Center" },
    { id: "online-store", label: "Online Store" },
    { id: "nuorder", label: "NuORDER" },
    { id: "help-center", label: "Help Center" },
    { id: "bug-reports", label: "Bug Reports" },
    { id: "meilisearch", label: "Meilisearch" },
    { id: "stripe", label: "Stripe" },
    { id: "quickbooks", label: "QuickBooks" },
    { id: "weather", label: "Weather" },
    { id: "podium", label: "Podium" },
    { id: "insights", label: "Insights" },
  ],
  shipping: [],
  tasks: [],
  layaways: [],
};
