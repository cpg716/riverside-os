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
    { id: "inbox", label: "Inbox" },
    { id: "reviews", label: "Reviews" },
    { id: "daily-sales", label: "Daily Sales" },
  ],
  register: [{ id: "floor", label: "Register" }],
  customers: [
    { id: "all", label: "All Customers" },
    { id: "add", label: "Add Customer" },
    { id: "ship", label: "Shipments" },
    { id: "rms-charge", label: "RMS charge" },
    { id: "duplicate-review", label: "Duplicate review" },
  ],
  alterations: [{ id: "queue", label: "Work queue" }],
  orders: [
    { id: "open", label: "Open Orders" },
    { id: "all", label: "All Orders" },
  ],
  inventory: [
    { id: "list", label: "Inventory List" },
    { id: "add", label: "Add Inventory" },
    { id: "receiving", label: "Receiving" },
    { id: "categories", label: "Categories" },
    { id: "discount_events", label: "Promotions & sales" },
    { id: "import", label: "Import" },
    { id: "vendors", label: "Vendors" },
    { id: "physical", label: "Physical count" },
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
    { id: "commission-manager", label: "Commission Manager" },
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
    { id: "staff-access-defaults", label: "Staff access defaults" },
    { id: "counterpoint", label: "Counterpoint" },
    { id: "remote-access", label: "Remote Access" },
    { id: "online-store", label: "Online store" },
    { id: "nuorder", label: "NuORDER" },
    { id: "help-center", label: "Help center" },
    { id: "bug-reports", label: "Bug reports" },
    { id: "meilisearch", label: "Meilisearch" },
  ],
};
