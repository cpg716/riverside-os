# Store SOP template (fill locally)

**Purpose:** Per-store facts an AI or trainer should **prefer** over generic defaults.

**Canonical in production:** Admins edit the live playbook in **Back Office → Settings → General → Store staff playbook** (saved in `store_settings.staff_sop_markdown`, max ~128 KiB UTF-8). Any signed-in staff can **read** it via `GET /api/staff/store-sop` (for in-app help / integrations). Admins load and save via `GET` / `PUT /api/settings/staff-sop` (requires **settings.admin**).

Use **this Markdown file** as a **starting outline** to paste into that field, or keep a copy outside git if policy must not be committed.

**Do not** put **passwords**, **API keys**, or **full bank details** in the app field or this template.

---

## Store identity

| Field | Value |
|-------|--------|
| Store name | |
| Public phone | |
| After-hours manager | |
| IT / POS support contact | |

---

## Money and approvals

| Policy | Who / when |
|--------|------------|
| Line void before pay (cashier OK?) | |
| Void after pay / refund threshold | |
| Price override / markdown floor | |
| Cash over/short tolerance | |
| House charge / AR allowed? | |

---

## Register

| Policy | Notes |
|--------|--------|
| Opening cash count | |
| Closing / Z time | |
| Mid-shift X-report expectation | |
| Drawer dual control | |

---

## Customer data

| Policy | Notes |
|--------|--------|
| Merge duplicates — who approves | |
| PII escalation contact | |

---

## Seasonal / local

| Topic | Notes |
|--------|--------|
| Promos / blackout dates | |
| Alteration rush cutoff | |

---

**Last reviewed:** 2026-04-04 (template)
