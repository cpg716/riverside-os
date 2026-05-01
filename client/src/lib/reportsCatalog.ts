/**
 * Curated Back Office Reports library (v1).
 * Available reports map to one backing API. Planned reports are visible catalog
 * entries only and must not invent server routes.
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

export type ReportCategory =
  | "Sales"
  | "Inventory"
  | "Register"
  | "Weddings"
  | "Customers"
  | "Finance"
  | "Staff"
  | "Operations";

export type ReportAudience = "Staff" | "Manager" | "Owner" | "Admin";

export type ReportSensitivity = "Staff-safe" | "Manager" | "Admin-only";

type ReportBaseDef = {
  id: string;
  title: string;
  description: string;
  category: ReportCategory;
  keywords: string[];
  questions: string[];
  audience: ReportAudience;
  sensitivity: ReportSensitivity;
  /** If true, only `staffRole === 'admin'` may run this report (e.g. margin-pivot). */
  adminOnly: boolean;
  /** Every key required to show the tile. */
  permissionsAll: string[];
  /** If set, any one of these is enough (OR). */
  permissionsAny?: string[];
};

export type AvailableReportDef = ReportBaseDef & {
  status?: "available";
  responseKind: ReportResponseKind;
  usesGlobalDateRange: boolean;
  /** `basis` query for booked vs recognition (sales/margin/dead stock/best sellers / register override / register day). */
  usesBasis: boolean;
  /** Sales / margin pivot only */
  supportsGroupBy?: boolean;
  /** Build path + query (leading `/api/...`) */
  buildPath: (ctx: ReportUrlContext) => string;
};

export type PlannedReportDef = ReportBaseDef & {
  status: "planned";
  plannedReason: string;
};

export type ReportDef = AvailableReportDef | PlannedReportDef;

export type ReportUrlContext = {
  fromYmd: string;
  toYmd: string;
  basis: string;
  groupBy: string;
};

const enc = (s: string) => encodeURIComponent(s);

const normalizeSearchText = (value: string) =>
  value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const weightedIncludes = (needle: string, haystack: string, weight: number) =>
  haystack.includes(needle) ? weight : 0;

export function isAvailableReport(r: ReportDef): r is AvailableReportDef {
  return r.status !== "planned";
}

export function reportSearchScore(r: ReportDef, rawQuery: string): number {
  const query = normalizeSearchText(rawQuery);
  if (!query) return 1;

  const title = normalizeSearchText(r.title);
  const description = normalizeSearchText(r.description);
  const category = normalizeSearchText(r.category);
  const keywords = normalizeSearchText(r.keywords.join(" "));
  const questions = normalizeSearchText(r.questions.join(" "));
  const audience = normalizeSearchText(r.audience);
  const sensitivity = normalizeSearchText(r.sensitivity);
  const tokens = query.split(" ").filter(Boolean);

  let score = 0;
  score += weightedIncludes(query, title, 60);
  score += weightedIncludes(query, category, 45);
  score += weightedIncludes(query, keywords, 40);
  score += weightedIncludes(query, questions, 32);
  score += weightedIncludes(query, audience, 20);
  score += weightedIncludes(query, description, 16);
  score += weightedIncludes(query, sensitivity, 10);

  for (const token of tokens) {
    score += weightedIncludes(token, title, 12);
    score += weightedIncludes(token, category, 9);
    score += weightedIncludes(token, keywords, 8);
    score += weightedIncludes(token, questions, 6);
    score += weightedIncludes(token, audience, 4);
    score += weightedIncludes(token, description, 3);
    score += weightedIncludes(token, sensitivity, 2);
  }

  return score;
}

export const REPORTS_CATALOG: ReportDef[] = [
  {
    id: "sales_pivot",
    title: "Sales Breakdown",
    description:
      "Sales, tax, units, and transaction counts by brand, category, salesperson, customer, or day.",
    category: "Sales",
    keywords: ["sales", "revenue", "tax", "units", "brand", "category", "salesperson", "customer", "best month"],
    questions: ["What sold best last month?", "How much did each salesperson sell?", "Which category drove sales?"],
    audience: "Manager",
    sensitivity: "Staff-safe",
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
    title: "Margin & Cost Breakdown",
    description:
      "Admin only. Gross margin and cost-loaded performance by brand, category, salesperson, customer, or day.",
    category: "Finance",
    keywords: ["margin", "cost", "profit", "cogs", "admin", "owner", "gross margin"],
    questions: ["Where are we making the best margin?", "Which brands have weak margin?", "How much profit did we make?"],
    audience: "Admin",
    sensitivity: "Admin-only",
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
    title: "Best Sellers",
    description: "Top-selling products by units sold for the selected date range.",
    category: "Sales",
    keywords: ["best sellers", "top items", "top skus", "products", "units", "popular", "what sold"],
    questions: ["What sold best last month?", "Which products are customers buying most?", "What should we reorder?"],
    audience: "Staff",
    sensitivity: "Staff-safe",
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
    title: "Slow Stock",
    description: "On-hand products with little or no sales in the selected date range.",
    category: "Inventory",
    keywords: ["dead stock", "slow stock", "stale", "inventory", "on hand", "not selling", "clearance"],
    questions: ["What inventory is not moving?", "Which items should we review for markdown?", "What slow stock is on hand?"],
    audience: "Manager",
    sensitivity: "Staff-safe",
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
    title: "Wedding Pipeline",
    description: "Upcoming wedding parties, members still needing orders, and open balances.",
    category: "Weddings",
    keywords: ["wedding", "event date", "members", "missing orders", "open balances", "balance", "pickup"],
    questions: ["Who still owes money?", "Which weddings need attention?", "What wedding parties are coming up soon?"],
    audience: "Manager",
    sensitivity: "Staff-safe",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "wedding_health",
    usesGlobalDateRange: false,
    usesBasis: false,
    buildPath: () => `/api/insights/wedding-health`,
  },
  {
    id: "commission_ledger",
    title: "Commission Snapshot",
    description: "Read-only commission amounts by staff for unpaid, pending, and paid-out work.",
    category: "Staff",
    keywords: ["commission", "staff", "salesperson", "payout", "payroll", "earned", "pending"],
    questions: ["What commissions are pending?", "What has been paid out?", "Which staff have unpaid commission?"],
    audience: "Manager",
    sensitivity: "Manager",
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
    title: "New York Tax Audit",
    description: "Tax buckets for clothing, footwear, and standard taxable sales on fulfilled lines.",
    category: "Finance",
    keywords: ["tax", "nys", "new york", "clothing", "footwear", "tax audit", "exempt", "taxable"],
    questions: ["How much tax did we collect?", "What sales were tax exempt?", "What do we need for tax review?"],
    audience: "Manager",
    sensitivity: "Manager",
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
    title: "Staff Sales Performance",
    description:
      "High-ticket sales and recent sales momentum by staff member.",
    category: "Staff",
    keywords: ["staff", "salesperson", "performance", "high ticket", "momentum", "sales"],
    questions: ["How is each salesperson doing?", "Who sold high-ticket items?", "Which staff have sales momentum?"],
    audience: "Manager",
    sensitivity: "Manager",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: false,
    usesBasis: true,
    buildPath: ({ basis }) => `/api/insights/staff-performance?basis=${enc(basis)}`,
  },
  {
    id: "rms_charges",
    title: "RMS Charge Summary",
    description: "RMS/R2S charges and payment rows for the selected date window.",
    category: "Customers",
    keywords: ["rms", "r2s", "charges", "payments", "balance", "customer charge", "stale charges"],
    questions: ["Which RMS charges were created?", "Which RMS payments posted?", "Are there stale RMS charges?"],
    audience: "Manager",
    sensitivity: "Manager",
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
    title: "Customer RMS Charge Records",
    description: "Customer-facing RMS charge and payment records aligned with the Customers workspace.",
    category: "Customers",
    keywords: ["rms", "customer", "charge", "payment", "balance", "crm", "records"],
    questions: ["Which customers have RMS charge records?", "What RMS payments are tied to customers?", "Who has charge activity?"],
    audience: "Manager",
    sensitivity: "Manager",
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
    title: "Closed Register Drawers",
    description: "Closed drawers with cash variance, register totals, and store-local close dates.",
    category: "Register",
    keywords: ["drawer", "cash", "variance", "z report", "register", "closed sessions", "till"],
    questions: ["Which drawers were closed?", "Was cash over or short?", "What were register totals?"],
    audience: "Manager",
    sensitivity: "Manager",
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
    title: "Discount & Override Reasons",
    description: "Counts of price override and discount reasons for the selected date range.",
    category: "Register",
    keywords: ["override", "discount", "price change", "markdown", "reason", "high discounts"],
    questions: ["Why were prices changed?", "How many discounts were used?", "Are override reasons increasing?"],
    audience: "Manager",
    sensitivity: "Manager",
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
    title: "Register Day Summary",
    description: "Store-wide register activity for sales, pickups, payments, and daily close review.",
    category: "Register",
    keywords: ["daily sales", "register", "drawer", "cash", "pickup", "payments", "z close", "lane"],
    questions: ["What happened at the register today?", "What needs pickup today?", "How much cash should be in the drawer?"],
    audience: "Manager",
    sensitivity: "Manager",
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
    title: "Saved Wedding Report Views",
    description: "Saved wedding filter bundles for repeat wedding report review.",
    category: "Weddings",
    keywords: ["wedding", "saved views", "filters", "metabase", "repeat report", "party"],
    questions: ["Where are my saved wedding views?", "Can I reopen a wedding report filter?", "What wedding views did I save?"],
    audience: "Staff",
    sensitivity: "Staff-safe",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "wedding_saved_views",
    usesGlobalDateRange: false,
    usesBasis: false,
    buildPath: () => `/api/insights/wedding-saved-views`,
  },
  {
    id: "merchant_activity",
    title: "Card Processing Summary",
    description: "Daily card volume, processing fees, and net settlement values for bank reconciliation.",
    category: "Finance",
    keywords: ["merchant", "stripe", "card", "fees", "net", "settlement", "bank", "reconciliation"],
    questions: ["What were card processing fees?", "What card volume should settle?", "What net amount should match the bank?"],
    audience: "Owner",
    sensitivity: "Manager",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/insights/merchant-activity?from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "appointments_no_show",
    title: "Appointments & No-Show Report",
    description:
      "Appointment counts, completed visits, cancellations, no-shows, type, salesperson, and wedding-linked activity.",
    category: "Operations",
    keywords: ["appointments", "no-show", "cancellations", "completed appointments", "salesperson", "walk-in", "wedding"],
    questions: ["How many appointments no-showed?", "Which appointment types were completed?", "Which salesperson handled appointments?"],
    audience: "Manager",
    sensitivity: "Manager",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/insights/appointments-no-show?from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "wedding_event_readiness",
    title: "Wedding Event Readiness Report",
    description:
      "Upcoming weddings, missing measurements, unpaid balances, unfulfilled items, alterations, and pickup or shipment risk.",
    category: "Weddings",
    keywords: ["wedding", "readiness", "measurements", "balance", "unpaid", "pickup", "shipment", "alterations", "risk"],
    questions: ["Which weddings are not ready?", "Who still owes money?", "Which wedding members need measurements?"],
    audience: "Manager",
    sensitivity: "Manager",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/insights/wedding-event-readiness?from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "staff_schedule_coverage_sales",
    title: "Staff Schedule Coverage vs Sales Report",
    description:
      "Staffing coverage by day compared against sales volume, appointments, pickups, and register activity.",
    category: "Staff",
    keywords: ["staff schedule", "coverage", "sales", "appointments", "pickups", "register activity", "labor"],
    questions: ["Were we staffed correctly for sales volume?", "Which days were understaffed?", "How did coverage compare to appointments?"],
    audience: "Owner",
    sensitivity: "Manager",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/insights/staff-schedule-coverage-sales?from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "customer_follow_up",
    title: "Customer Follow-Up Report",
    description:
      "Customers with open balances, pending pickups, recent orders, upcoming wedding dates, stale RMS charges, and contact gaps.",
    category: "Customers",
    keywords: ["follow-up", "customer", "balance", "pickup", "quotes", "orders", "wedding date", "rms", "no recent contact"],
    questions: ["Who needs a follow-up call?", "Who still owes money?", "Which customers have pending pickups?"],
    audience: "Staff",
    sensitivity: "Staff-safe",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/insights/customer-follow-up?from=${enc(fromYmd)}&to=${enc(toYmd)}`,
  },
  {
    id: "exception_risk",
    title: "Exception & Risk Report",
    description:
      "Negative stock, stale fulfillment orders, overdue alterations, high discounts, failed payments, open sessions, and unclosed tasks.",
    category: "Operations",
    keywords: ["exception", "risk", "negative stock", "stale orders", "overdue alterations", "high discounts", "failed payments", "open register", "tasks"],
    questions: ["What needs manager attention?", "What operational risks are open?", "Are any registers or tasks still unclosed?"],
    audience: "Manager",
    sensitivity: "Manager",
    adminOnly: false,
    permissionsAll: ["insights.view"],
    responseKind: "rows",
    usesGlobalDateRange: true,
    usesBasis: false,
    buildPath: ({ fromYmd, toYmd }) =>
      `/api/insights/exception-risk?from=${enc(fromYmd)}&to=${enc(toYmd)}`,
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
