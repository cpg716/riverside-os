/**
 * Curated Back Office Reports library (v1).
 * Each entry maps to a single backing API — see docs/AI_REPORTING_DATA_CATALOG.md § Curated Reports.
 */

import type { StaffRole } from "../context/BackofficeAuthContextLogic";

export type ReportResponseKind =
  | "sales_pivot"
  | "margin_pivot"
  | "rows"
  | "row_object"
  | "best_sellers"
  | "dead_stock"
  | "wedding_health"
  | "register_day_summary"
  | "wedding_saved_views";

export type ReportDef = {
  id: string;
  title: string;
  description: string;
  /** If true, only `staffRole === 'admin'` may run this report (e.g. margin-pivot). */
  adminOnly: boolean;
  /** Every key required to show the tile. */
  permissionsAll: string[];
  /** If set, any one of these is enough (OR). */
  permissionsAny?: string[];
  responseKind: ReportResponseKind;
  usesGlobalDateRange: boolean;
  /** `basis` query for booked vs recognition (sales/margin/dead stock/best sellers / register override / register day). */
  usesBasis: boolean;
  /** Sales / margin pivot only */
  supportsGroupBy?: boolean;
  /** Build path + query (leading `/api/...`) */
  buildPath: (ctx: ReportUrlContext) => string;
};

export type ReportUrlContext = {
  fromYmd: string;
  toYmd: string;
  basis: string;
  groupBy: string;
};

const enc = (s: string) => encodeURIComponent(s);

export const REPORTS_CATALOG: ReportDef[] = [
  {
    id: "sales_pivot",
    title: "Sales pivot",
    description:
      "Pre-tax revenue, tax, units, and order counts by brand, category, salesperson, customer, or day. Uses booked vs completed (recognition) dates.",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "sales_pivot",
    usesGlobalDateRange: true,
    usesBasis: true,
    supportsGroupBy: true,
    buildPath: ({ fromYmd, toYmd, basis, groupBy }) =>
      `/api/insights/sales-pivot?group_by=${enc(groupBy)}&basis=${enc(basis)}&from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "margin_pivot",
    title: "Margin pivot",
    description:
      "Admin only. Pre-tax gross margin by dimension — COGS from line unit_cost × qty at checkout.",
    adminOnly: true,
    permissionsAll: ["insights.view"],
    responseKind: "margin_pivot",
    usesGlobalDateRange: true,
    usesBasis: true,
    supportsGroupBy: true,
    buildPath: ({ fromYmd, toYmd, basis, groupBy }) =>
      `/api/insights/margin-pivot?group_by=${enc(groupBy)}&basis=${enc(basis)}&from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "best_sellers",
    title: "Best sellers",
    description: "Top SKUs by units sold in range (booked vs recognition).",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "best_sellers",
    usesGlobalDateRange: true,
    usesBasis: true,
    buildPath: ({ fromYmd, toYmd, basis }) =>
      `/api/insights/best-sellers?basis=${enc(basis)}&from=${enc(fromYmd)}&to=${enc(toYmd)}&limit=100`,
  },
  {
    id: "dead_stock",
    title: "Dead stock",
    description: "On-hand SKUs with low units sold in range; optional max-units threshold (default 0).",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "dead_stock",
    usesGlobalDateRange: true,
    usesBasis: true,
    buildPath: ({ fromYmd, toYmd, basis }) =>
      `/api/insights/dead-stock?basis=${enc(basis)}&from=${enc(fromYmd)}&to=${enc(toYmd)}&max_units_sold=0&limit=100`,
  },
  {
    id: "wedding_health",
    title: "Wedding pipeline health",
    description: "Parties with event in 30 days, members without orders, open balances.",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "wedding_health",
    usesGlobalDateRange: false,
    usesBasis: false,
    buildPath: () => `/api/insights/wedding-health`,
  },
  {
    id: "commission_ledger",
    title: "Commission ledger",
    description: "Read-only snapshot: unpaid, realized pending, and paid-out commission by staff.",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/insights/commission-ledger?from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "nys_tax_audit",
    title: "NYS tax audit",
    description: "Clothing/footwear vs standard-path buckets on recognition-dated lines.",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "row_object",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/insights/nys-tax-audit?from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "staff_performance",
    title: "Staff performance",
    description:
      "High-ticket line stats (over $500 net) and 7-day revenue momentum; basis affects momentum only.",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: false,
    usesBasis: true,
    buildPath: ({ basis }) => `/api/insights/staff-performance?basis=${enc(basis)}`,
  },
  {
    id: "rms_charges",
    title: "RMS charges export",
    description: "Register RMS/R2S charge and payment rows (up to 500) for the date window.",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/insights/rms-charges?from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "rms_charge_crm",
    title: "RMS charge records (CRM)",
    description: "Searchable list from Customers → RMS charge (charge vs payment, paging).",
    adminOnly: false,
    permissionsAll: ["customers.rms_charge"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/customers/rms-charge/records?from=${enc(fromYmd)}&to=${enc(toYmd)}&limit=500&offset=0`,
  },
  {
    id: "register_sessions",
    title: "Closed register sessions",
    description: "Recent closed drawers: cash variance, totals (store-local close dates).",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/insights/register-sessions?from=${enc(fromYmd)}&to=${enc(toYmd)}&limit=200`,
  },
  {
    id: "register_override_mix",
    title: "Price override mix",
    description: "Counts of price override reasons on lines in range.",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: true,
    buildPath: ({ fromYmd, toYmd, basis }) =>
      `/api/insights/register-override-mix?basis=${enc(basis)}&from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "register_day_activity",
    title: "Register day activity",
    description: "Store-wide register day summary — requires register.reports (or open lane scope from POS).",
    adminOnly: false,
    permissionsAll: ["register.reports"],
    responseKind: "register_day_summary",
    usesGlobalDateRange: true,
    usesBasis: true,
    buildPath: ({ fromYmd, toYmd, basis }) =>
      `/api/insights/register-day-activity?basis=${enc(basis)}&from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "wedding_saved_views",
    title: "Saved wedding views",
    description: "Your saved Metabase/wedding filter bundles (per staff).",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "wedding_saved_views",
    usesGlobalDateRange: false,
    usesBasis: false,
    buildPath: () => `/api/insights/wedding-saved-views`,
  },
];

export function reportVisible(
  r: ReportDef,
  hasPermission: (k: string) => boolean,
  staffRole: StaffRole | null,
): boolean {
  if (r.adminOnly && staffRole !== "admin") return false;
  const any = r.permissionsAny;
  if (any?.length) {
    if (!any.some((k) => hasPermission(k))) return false;
  }
  return r.permissionsAll.every((k) => hasPermission(k));
}

export const PIVOT_GROUP_OPTIONS = [
  { id: "brand", label: "Brand" },
  { id: "category", label: "Category" },
  { id: "salesperson", label: "Salesperson" },
  { id: "customer", label: "Customer" },
  { id: "date", label: "Day" },
] as const;
