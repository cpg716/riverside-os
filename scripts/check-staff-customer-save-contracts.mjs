#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const passes = [];

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function pass(message) {
  passes.push(message);
}

function fail(message, file, detail) {
  failures.push({ message, file, detail });
}

function assert(condition, message, file, detail) {
  if (condition) {
    pass(message);
  } else {
    fail(message, file, detail);
  }
}

const staffDrawerFile = "client/src/components/staff/StaffEditDrawer.tsx";
const staffApiFile = "server/src/api/staff.rs";
const customerHubFile = "client/src/components/customers/CustomerRelationshipHubDrawer.tsx";
const customerApiFile = "server/src/api/customers.rs";
const customerMergeFile = "server/src/logic/customer_merge.rs";
const customerWorkspaceFile = "client/src/components/customers/CustomersWorkspace.tsx";
const customerSelectorFile = "client/src/components/pos/CustomerSelector.tsx";
const storefrontFile = "client/src/components/storefront/PublicStorefront.tsx";
const goLiveFile = "scripts/check-go-live-blockers.mjs";

const staffDrawer = read(staffDrawerFile);
const staffApi = read(staffApiFile);
const customerHub = read(customerHubFile);
const customerApi = read(customerApiFile);
const customerMerge = read(customerMergeFile);
const customerWorkspace = read(customerWorkspaceFile);
const customerSelector = read(customerSelectorFile);
const storefront = read(storefrontFile);
const goLive = read(goLiveFile);

assert(
  staffDrawer.includes("const data = (await res.json()) as { granted?: unknown }") &&
    staffDrawer.includes("setGranted(granted)") &&
    !staffDrawer.includes("setGranted(data.permissions"),
  "Staff permission drawer consumes the per-staff granted response field",
  staffDrawerFile,
  "GET /api/staff/admin/{id}/permissions returns { granted }, not { permissions }.",
);

assert(
  staffDrawer.includes("const shouldSaveManualPermissions") &&
    staffDrawer.includes("!roleSelectionChanged") &&
    staffDrawer.includes('staff.id !== "NEW"') &&
    staffDrawer.includes("body: JSON.stringify({ granted: [...granted].sort() })"),
  "Staff drawer does not overwrite role-default permissions with stale checklist state",
  staffDrawerFile,
  "Manual permission PATCH must be skipped when creating staff or changing role.",
);

assert(
  staffDrawer.includes("const shouldUseRoleDefaultDiscount") &&
    staffDrawer.includes("payload.max_discount_percent = disc") &&
    !staffDrawer.includes("max_discount_percent: disc,"),
  "Staff drawer lets role changes use server-owned discount-cap defaults",
  staffDrawerFile,
  "Role default discount caps are applied server-side unless the operator edits the cap.",
);

assert(
  staffApi.includes("Auto-sync permissions and discount limits if role changed") &&
    staffApi.includes("DELETE FROM staff_permission WHERE staff_id = $1") &&
    staffApi.includes("FROM staff_role_permission p") &&
    staffApi.includes("SELECT max_discount_percent FROM staff_role_pricing_limits WHERE role = $1"),
  "Staff role changes remain server-owned for permissions and discount caps",
  staffApiFile,
  "The role update handler must rebuild per-staff permissions from role templates.",
);

const saveProfileStart = customerHub.indexOf("const saveProfileDetails = async () => {");
const saveProfileEnd = customerHub.indexOf("const linkCouple = async", saveProfileStart);
const saveProfileBody =
  saveProfileStart >= 0 && saveProfileEnd > saveProfileStart
    ? customerHub.slice(saveProfileStart, saveProfileEnd)
    : "";

assert(
  customerHub.includes("type CustomerProfileDraft") &&
    customerHub.includes("const profileDraftBaseline = useRef<CustomerProfileDraft | null>(null)") &&
    customerHub.includes("function buildCustomerProfilePatch(") &&
    customerHub.includes("buildCustomerProfilePatch(profileDraft, baseline)"),
  "Customer Hub profile saves are based on a loaded baseline",
  customerHubFile,
  "Saving one customer field must not submit unrelated stale draft fields.",
);

assert(
  saveProfileBody.includes("buildCustomerProfilePatch(profileDraft, baseline)") &&
    !saveProfileBody.includes("first_name: profileDraft.first_name.trim()") &&
    !saveProfileBody.includes("marketing_email_opt_in: profileDraft.marketing_email_opt_in") &&
    !saveProfileBody.includes("review_requests_opt_out: profileDraft.review_requests_opt_out"),
  "Customer Hub profile save no longer sends the entire profile draft",
  customerHubFile,
  "The profile save handler should submit only changed normalized fields.",
);

assert(
  customerApi.includes('sqlx::QueryBuilder::new("UPDATE customers SET ")') &&
    customerApi.includes("if let Some(ref v) = body.first_name") &&
    customerApi.includes("if let Some(v) = body.marketing_email_opt_in") &&
    customerApi.includes("if n == 0"),
  "Customer profile PATCH remains sparse server-side",
  customerApiFile,
  "The server must only update customer fields present in the request.",
);

assert(
  customerMerge.includes("struct MergeRiskRow") &&
    customerMerge.includes("pub blocking_reasons: Vec<String>") &&
    (customerMerge.match(/query_as::<_, MergeRiskRow>\(MERGE_RISK_SQL\)/g) ?? []).length >= 2 &&
    customerMerge.includes("if !blocking_reasons.is_empty()"),
  "Customer merges re-check linked-record blockers inside the write transaction",
  customerMergeFile,
  "Dry-run warnings are not enough; the server must fail closed if linked data could be lost before deleting a duplicate customer.",
);

assert(
  customerWorkspace.includes("mergePreview.blocking_reasons.length > 0") &&
    customerWorkspace.includes("Merge blocked to protect linked records") &&
    customerWorkspace.includes('body.error || "Merge failed. Review both customers and try again."'),
  "Customer merge UI disables unsafe merges and shows the server recovery reason",
  customerWorkspaceFile,
  "Staff must see why a merge is blocked and how to choose the safe master record.",
);

assert(
  customerSelector.includes("const searchRequestIdRef = useRef(0)") &&
    customerSelector.includes("const controller = new AbortController()") &&
    customerSelector.includes("signal: controller.signal") &&
    customerSelector.includes("controller.abort()") &&
    customerSelector.includes("searchRequestIdRef.current !== requestId"),
  "Register customer lookup ignores stale search responses",
  customerSelectorFile,
  "A slow older response must not replace the newest query and let staff select the wrong customer.",
);

const storefrontSaveStart = storefront.indexOf('fetch(apiUrl(API_BASE, "/api/store/account/me"), {');
const storefrontSaveEnd = storefront.indexOf('toast("Profile saved.", "success")', storefrontSaveStart);
const storefrontSaveBody =
  storefrontSaveStart >= 0 && storefrontSaveEnd > storefrontSaveStart
    ? storefront.slice(storefrontSaveStart, storefrontSaveEnd)
    : "";

assert(
  storefront.includes("type StoreAccountProfileDraft") &&
    storefront.includes("const profileDraftBaseline = useRef<StoreAccountProfileDraft | null>(null)") &&
    storefront.includes("function buildStoreAccountProfilePatch(") &&
    storefrontSaveBody.includes("buildStoreAccountProfilePatch(profileDraft, baseline)") &&
    storefrontSaveBody.includes("body: JSON.stringify(patch)") &&
    !storefrontSaveBody.includes("first_name: profileDraft.first_name") &&
    !storefrontSaveBody.includes("postal_code: profileDraft.postal_code"),
  "Online Store account profile saves only changed customer profile fields",
  storefrontFile,
  "Public account edits update the same customers row and must not submit stale full-profile drafts.",
);

assert(
  goLive.includes("check-staff-customer-save-contracts.mjs"),
  "Go-live blocker gate includes Staff/Customer save-contract checks",
  goLiveFile,
  "These regressions must be checked before release retag/publish.",
);

if (failures.length > 0) {
  console.error("Staff/Customer save-contract check failed.");
  console.error("");
  for (const failure of failures) {
    console.error(`- ${failure.message}`);
    if (failure.file) console.error(`  file: ${failure.file}`);
    if (failure.detail) console.error(`  detail: ${failure.detail}`);
  }
  process.exit(1);
}

console.log(`Staff/Customer save-contract check passed (${passes.length} gates).`);
for (const message of passes) {
  console.log(`- ${message}`);
}
