# Staff Access / Manager Access API Audit

## Scope

Inspected `/api/staff`, `/api/auth`, `server/src/middleware/mod.rs`, `server/src/auth/pins.rs`, `server/src/auth/permissions.rs`, and staff-facing consumers in sign-in, POS register, Staff workspace, Settings, Operations, and Help.

## Endpoint Inventory

| Method | Route | Backend Location | Frontend Consumers | Auth | Staff/Manager Access | Mutates State | DB Tables | Tests | Risk | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/staff/store-sop` | `server/src/api/staff.rs` | Help/ROSIE context | authenticated staff | Staff Access | No | `store_settings` | Not traced | Low | SOP read. |
| GET | `/api/staff/list-for-pos` | `staff.rs` | Sign-in gate, PIN dropdown, selectors | public-ish staff roster path | None or light gate | No | `staff` | Not traced | Medium | Exposes active staff names/avatar metadata for sign-in. |
| POST | `/api/staff/verify-cashier-code` | `staff.rs`, `auth/pins.rs` | Sign-in/POS | Access PIN | Staff Access | No; may log failure elsewhere | `staff`, auth failure logs | Not traced | Critical | Validates 4-digit Access PIN. |
| GET | `/api/staff/effective-permissions` | `staff.rs`, `auth/permissions.rs` | Backoffice auth context | authenticated staff | Staff Access | No | `staff_permission`, role/catalog | Not traced | Critical | Client permission source; server still enforces. |
| POST | `/api/staff/verify-pin`, `/api/auth/verify-pin` | `staff.rs` | Manager approval modals | Access PIN/role/action metadata | Manager Access when role/action requires | Yes audit log | `staff_access_log` | Not traced | Critical | Manager approval/audit path. |
| GET | `/api/staff/avatar/{id}` | `staff.rs` | Staff selectors/profile | none or staff context | None | No | avatar assets/staff photo | Not traced | Low | Media path. |
| GET/PATCH | `/api/staff/self` | `staff.rs` | Staff profile panel | authenticated staff | Staff Access | PATCH yes | `staff` | Not traced | High | Self profile/preferences. |
| PATCH | `/api/staff/self/avatar` | `staff.rs` | Staff profile | authenticated staff | Staff Access | Yes | `staff` | Not traced | Medium | Avatar change. |
| POST | `/api/staff/self/set-pin` | `staff.rs` | Staff profile | authenticated staff/current PIN pattern | Staff Access | Yes | `staff.pin_hash` | Not traced | Critical | PIN credential mutation. |
| GET | `/api/staff/self/pricing-limits` | `staff.rs` | POS discount logic | authenticated staff | Staff Access | No | `staff.max_discount_percent` | Not traced | High | Discount cap source. |
| GET | `/api/staff/self/register-metrics` | `staff.rs` | POS dashboard | authenticated staff | Staff Access | No; logs access | transactions/staff metrics | Not traced | Medium | Staff-visible metrics. |
| GET | `/api/staff/admin/access-log` | `staff.rs` | Staff admin | `staff.view_audit` | Manager/Admin | No | `staff_access_log` | Not traced | High | Audit log visibility. |
| GET | `/api/staff/admin/roster` | `staff.rs` | Staff workspace | `staff.view` | Staff Access | No | `staff` | Not traced | Medium | Full roster/profile. |
| GET | `/api/staff/admin/podium-users` | `staff.rs` | Staff edit drawer | relevant staff/settings permission | Staff Access | External/read | Podium config/cache | Not traced | Medium | Integration identity mapping. |
| GET/PATCH | `/api/staff/admin/category-commissions/{category_id?}` | `staff.rs` | Commission admin | `staff.manage_commission` | Manager/Admin | PATCH yes | category commission tables | Not traced | High | Commission financial metadata. |
| GET/PATCH | `/api/staff/admin/role-permissions` | `staff.rs` | Settings access defaults | `staff.manage_access`/settings | Manager/Admin | PATCH yes | `staff_role_permission` | Not traced | Critical | Role permission template mutation. |
| GET/PATCH | `/api/staff/admin/pricing-limits` | `staff.rs` | Settings access defaults | `staff.manage_access`/staff edit | Manager/Admin | PATCH yes | `staff_role_pricing_limits` | Not traced | Critical | Discount cap template mutation. |
| POST | `/api/staff/admin/{staff_id}/apply-role-defaults` | `staff.rs` | Staff edit drawer | `staff.manage_access` | Manager/Admin | Yes | `staff_permission`, `staff.max_discount_percent` | Not traced | Critical | Rewrites staff effective access baseline. |
| GET/PATCH | `/api/staff/admin/{staff_id}/permissions` | `staff.rs` | Staff edit drawer | `staff.manage_access` | Manager/Admin | PATCH yes | `staff_permission`, audit log | Not traced | Critical | Per-person RBAC mutation. |
| GET/PUT | `/api/staff/admin/{staff_id}/permission-overrides` | `staff.rs` | Legacy/compat | `staff.manage_access` | Manager/Admin | PUT yes | legacy override table | Not traced | High | Legacy table not runtime source per docs. |
| POST | `/api/staff/admin/{staff_id}/set-pin` | `staff.rs` | Staff admin | `staff.manage_pins` | Manager/Admin | Yes | `staff.pin_hash`, audit log | Not traced | Critical | Credential reset. |
| POST/DELETE | `/api/staff/admin/{staff_id}/avatar-photo` | `staff.rs` | Staff edit drawer | `staff.edit` or avatar permission | Manager/Admin | Yes | staff photo path | Not traced | Medium | Profile media. |
| PATCH | `/api/staff/admin/{staff_id}` | `staff.rs` | Staff edit drawer | `staff.edit` | Manager/Admin | Yes | `staff`, permissions sync on role change | Not traced | Critical | Role, active, economics, linked customer. |
| POST | `/api/staff/admin` | `staff.rs` | Staff workspace | `staff.edit` | Manager/Admin | Yes | `staff`, permissions defaults | Not traced | Critical | Staff creation and access baseline. |
| GET/POST/DELETE | `/api/staff/commissions/*` | `staff.rs` | Commission manager | `staff.manage_commission` | Manager/Admin | Writes yes | commission rule tables | Not traced | High | Commission payout logic inputs. |

## Contract Notes

- Staff sign-in uses one 4-digit Access PIN; internal tracking IDs are not user-facing login credentials.
- `effective_permissions_for_staff` grants Admin the full permission catalog; non-admin enforcement uses per-staff `staff_permission`.
- Role permission templates are onboarding/default templates, not the runtime source for non-admin access.

## Permission Notes

- Backend permission enforcement is required even when frontend hides controls.
- Sensitive staff APIs split `staff.view`, `staff.edit`, `staff.manage_pins`, `staff.manage_access`, `staff.view_audit`, and `staff.manage_commission`.
- Manager approval uses PIN verification plus action metadata and should write `staff_access_log`.

## Mutation / Side Effect Notes

- Staff role changes can synchronize permissions and discount caps.
- PIN reset/set paths mutate credential hashes.
- Permission and pricing-limit changes can indirectly authorize financial, inventory, QBO, payment, and staff operations.

## Transaction / Idempotency Notes

- Several staff admin handlers use explicit transactions around multi-table updates.
- Follow-up should verify role-default application is idempotent and preserves intended manual overrides.

## Audit Trail Notes

- `log_staff_access` writes to `staff_access_log`.
- Manager approvals include `authorize_action` and metadata where supplied.
- Follow-up should verify every permission/PIN/admin mutation logs staff id, target staff id, action, timestamp, and before/after where practical.

## Test Coverage

- Direct staff endpoint tests were not fully traced in this pass.
- Permission behavior has indirect tests in products, insights, help/ROSIE, and other modules.
- Missing: central staff RBAC matrix tests, PIN mutation tests, manager approval audit tests.

## Risks

- Critical: effective permissions, PIN verify/reset, role/default permissions, per-staff permissions, staff create/edit role/active fields.
- High: discount caps, commission rules, access log visibility.

## Recommended Follow-Up

- Add endpoint-level tests for every `staff.*` permission boundary.
- Add regression tests for role-change RBAC auto-sync and manual override preservation.
- Add audit-log assertions for manager approval, PIN reset, permission edit, staff deactivate, and role change.

