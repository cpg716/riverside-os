/** Sidebar nav config (non-React module so `Sidebar.tsx` satisfies Fast Refresh). */

export type SidebarTabId =
  | "home"
  | "register"
  | "customers"
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
  | "settings";

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
  ],
  register: [
    { id: "dashboard", label: "Dashboard" },
    { id: "register", label: "Register" },
    { id: "tasks", label: "Tasks" },
    { id: "weddings", label: "Weddings" },
    { id: "alterations", label: "Alterations" },
    { id: "inventory", label: "Inventory" },
    { id: "reports", label: "Reports" },
    { id: "gift-cards", label: "Gift Cards" },
    { id: "loyalty", label: "Loyalty" },
    { id: "layaways", label: "Layaways" },
    { id: "settings", label: "Settings" },
  ],
  customers: [
    { id: "all", label: "All Customers" },
    { id: "add", label: "Add Customer" },
    { id: "layaways", label: "Layaway Manager" },
    { id: "ship", label: "Shipments" },
    { id: "rms-charge", label: "RMS Charge" },
    { id: "duplicate-review", label: "Duplicate Review" },
  ],
  alterations: [{ id: "queue", label: "Work Queue" }],
  orders: [
    { id: "open", label: "Order Management" },
    { id: "all", label: "Sales History" },
  ],
  inventory: [
    { id: "list", label: "Inventory List" },
    { id: "add", label: "Add Inventory" },
    { id: "receiving", label: "Receiving" },
    { id: "categories", label: "Categories" },
    { id: "discount_events", label: "Promotions & Sales" },
    { id: "import", label: "Import" },
    { id: "vendors", label: "Vendors" },
    { id: "physical", label: "Physical Count" },
    { id: "damaged", label: "Damaged Inventory" },
    { id: "rtv", label: "Return to Vendor" },
  ],
  weddings: [
    { id: "action-board", label: "Action Board" },
    { id: "parties", label: "Parties" },
    { id: "calendar", label: "Calendar" },
  ],
  "gift-cards": [
    { id: "inventory", label: "Card Inventory" },
    { id: "issue-purchased", label: "Issue Purchased" },
    { id: "issue-donated", label: "Issue Donated" },
  ],
  loyalty: [
    { id: "eligible", label: "Monthly Eligible" },
    { id: "history", label: "History" },
    { id: "adjust", label: "Adjust Points" },
    { id: "settings", label: "Program Settings" },
  ],
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
  settings: [
    { id: "profile", label: "Profile" },
    { id: "general", label: "General" },
    { id: "backups", label: "Data & Backups" },
    { id: "printing", label: "Printing Hub" },
    { id: "receipt-builder", label: "Receipt Builder" },
    { id: "integrations", label: "Integrations" },
    { id: "staff-access-defaults", label: "Staff Access Defaults" },
    { id: "counterpoint", label: "Counterpoint" },
    { id: "remote-access", label: "Remote Access" },
    { id: "online-store", label: "Online Store" },
    { id: "nuorder", label: "NuORDER" },
    { id: "help-center", label: "Help Center" },
    { id: "bug-reports", label: "Bug Reports" },
    { id: "meilisearch", label: "Meilisearch" },
  ],
};
