/** Sidebar tab → minimum permission (omit = always visible in Back Office shell). */
export const SIDEBAR_TAB_PERMISSION: Partial<Record<string, string>> = {
  reports: "insights.view",
  dashboard: "insights.view",
  staff: "staff.view",
  qbo: "qbo.view",
  orders: "orders.view",
  weddings: "weddings.view",
  alterations: "alterations.manage",
  "gift-cards": "gift_cards.manage",
  appointments: "weddings.view",
};

/** Tab is visible if the user has any of these permissions (see Loyalty: program vs adjust). */
export const SIDEBAR_TAB_PERMISSIONS_ANY: Record<string, string[]> = {
  loyalty: ["loyalty.program_settings", "loyalty.adjust_points"],
  settings: ["settings.admin", "staff.manage_access"],
};

/** `${tabId}:${subSectionId}` → extra permission beyond the tab (omit = allowed if tab is allowed). */
export const SIDEBAR_SUB_SECTION_PERMISSION: Record<string, string> = {
  "inventory:physical": "physical_inventory.view",
  "staff:team": "staff.view",
  "staff:schedule": "staff.view",
  "staff:commission": "staff.manage_commission",
  "staff:audit": "staff.view_audit",
  "staff:tasks": "tasks.complete",
  "loyalty:adjust": "loyalty.adjust_points",
  "loyalty:eligible": "loyalty.program_settings",
  "loyalty:settings": "loyalty.program_settings",
  "customers:duplicate-review": "customers_duplicate_review",
  "home:register-reports": "register.reports",
  "home:inbox": "customers.hub_view",
  "customers:rms-charge": "customers.rms_charge",
  "customers:ship": "shipments.view",
  "settings:help-center": "help.manage",
  "settings:bug-reports": "settings.admin",
  "home:reviews": "reviews.view",
};

/** Subsection requires every listed permission (AND). */
export const SIDEBAR_SUB_SECTION_PERMISSIONS_ALL: Record<string, string[]> = {
  "staff:commission-payouts": ["insights.view", "insights.commission_finalize"],
};

/** Subsection visible if any listed permission is held (OR). */
export const SIDEBAR_SUB_SECTION_PERMISSIONS_ANY: Record<string, string[]> = {
  "settings:staff-access-defaults": ["settings.admin", "staff.manage_access"],
};

export function subSectionPermissionKey(
  tabId: string,
  subId: string,
): string | undefined {
  return SIDEBAR_SUB_SECTION_PERMISSION[`${tabId}:${subId}`];
}

/** Sidebar subsection visibility: single extra permission or all of `PERMISSIONS_ALL`. */
export function subSectionVisible(
  tabId: string,
  subId: string,
  hasPermission: (key: string) => boolean,
  permissionsLoaded: boolean,
): boolean {
  if (!permissionsLoaded) return true;
  const anySubs = SIDEBAR_SUB_SECTION_PERMISSIONS_ANY[`${tabId}:${subId}`];
  if (anySubs?.length) return anySubs.some((k) => hasPermission(k));
  const all = SIDEBAR_SUB_SECTION_PERMISSIONS_ALL[`${tabId}:${subId}`];
  if (all?.length) return all.every((k) => hasPermission(k));
  const one = SIDEBAR_SUB_SECTION_PERMISSION[`${tabId}:${subId}`];
  if (one) return hasPermission(one);
  return true;
}
