export type PosTabId =
  | "pos-dashboard"
  | "register"
  | "tasks"
  | "customers"
  | "rms-charge"
  | "podium-inbox"
  | "inventory"
  | "orders"
  | "weddings"
  | "alterations"
  | "reports"
  | "gift-cards"
  | "loyalty"
  | "layaways"
  | "shipping"
  | "settings";

interface PosSubItem {
  id: string;
  label: string;
}

export const POS_SIDEBAR_SUB_SECTIONS: Record<PosTabId, PosSubItem[]> = {
  "pos-dashboard": [],
  register: [],
  tasks: [],
  customers: [
    { id: "all", label: "All" },
    { id: "add", label: "Add" },
    { id: "duplicate-review", label: "Duplicate Review" },
  ],
  "rms-charge": [],
  "podium-inbox": [],
  inventory: [],
  orders: [],
  weddings: [],
  alterations: [],
  reports: [],
  "gift-cards": [],
  loyalty: [],
  layaways: [],
  shipping: [],
  settings: [
    { id: "profile", label: "Profile" },
    { id: "printing", label: "Printers & Scanners" },
  ],
};
