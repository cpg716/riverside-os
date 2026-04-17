# Riverside OS (ROS): Comprehensive Master Specification

**Maintenance:** This document is **product and domain narrative**. For **schema version**, **migration numbers**, **RBAC keys**, and **API routes**, treat **`DEVELOPER.md`** and the **`README.md`** documentation catalog (including **`docs/PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md`** for Shippo + Podium + notifications + reviews) as **implementation ground truth** when they differ.

## 1. Strategic Vision & Architectural Philosophy

Riverside OS (ROS) is a custom-engineered, local-first retail Operating System built specifically for the high-complexity environment of Riverside Men's Shop. Unlike generic POS systems (Shopify, Lightspeed) that force businesses into rigid workflows, ROS is built around the specific multi-week lifecycle of bespoke tailoring and wedding events.

### Key Strategic Pillars

- **Rust-Native Backend:** High performance, memory safety, and 100% ownership of business logic.
- **Tauri 2 Frontend:** Native OS-level performance with a modern React UI.
- **Local-First Reliability:** Primary data stays on-site in PostgreSQL. The POS integrates an IndexedDB/localforage offline checkout queue that allows transactions to complete even if the internet drops, gracefully flushing async payloads to the backend once connectivity returns.
- **Tauri Native Hardware Bridging:** Rust tcp streams broadcast raw ESC/POS byte queues directly over the LAN to thermal printers (e.g. Epson TM-M30III) bypassing high-friction browser print dialogs.
- **Tailscale & PWA Mesh:** Secure, zero-config remote management and home-office reporting without exposing the store to the public internet. The system functions as a **Progressive Web App (PWA)** allowing full-screen, native-feel access on iOS/Android via the store's private network.

---

## 2. The "Two-Truths" Reporting Framework

ROS reconciles the conflict between Sales Performance and Financial Accountability by tracking two distinct timestamps for every transaction.

### 2.1 Performance Timeline (`booked_at`)

Captures the moment of customer commitment (e.g., when a deposit is paid). This is used for historical comparisons (e.g., May 2026 vs. May 2025). It answers: *How much business did we write today?*

### 2.2 Accounting Timeline (`fulfilled_at`)

Captures the moment the item is physically picked up. This is the legal realization of revenue. This date triggers Sales Tax liability, Commission eligibility, and final fulfillment ledger entries.

---

## 3. Specialized Functional Modules

### 3.1 The Hybrid Transaction Engine

Supports **Hybrid Carts** where items have mixed fulfillment needs:

- **Takeaway:** 100% price + 100% tax collected. Status: Fulfilled.
- **Special Order/Custom:** 50% deposit + 100% total item tax collected. Status: Pending Procurement.
- **Placeholder Support:** Wedding items can be added without a size (`NULL` size). These can be updated or swapped globally (different suit/style) for the whole party later.

### 3.2 The Wedding & Project Manager

A project-based view where multiple customers are linked to a single `WeddingID`.

- **Master Payer (The Groom):** Delivered. POS features a "Group Pay" multi-select mode that aggregates party member balances and automatically disperses a single transaction as `payment_allocation` credits across beneficiary accounts.
- **Fitting Pipeline Tracking:** Real-time visual status for each member: Measured → Paid → Ordered → Arrived → Alterations → Ready for Pickup.
- **Measurement Vault:** Secure storage of body specs (Neck, Sleeve, Chest, Waist, etc.) with timestamped history. Old measurements are archived, ensuring an audit trail of changes over time.

### 3.3 NYS Publication 718-C Tax Engine

Hard-coded logic for Erie County/NYS Clothing Tax Exemptions ($110 threshold):

- **Criteria:** (Category: Clothing **OR** Footwear) **AND** (Net Price < $110.00).
- **Result:** 4.00% State Tax = 0; 4.75% Local Tax = Active.
- **Logic:** Real-time recalculation if a discount drops an item from $115 to $105, shifting the tax rate from 8.75% to 4.75% instantly.

### 3.4 Appointments & shared calendar (store + wedding)

**Single source of truth:** All scheduled time slots are stored in **`wedding_appointments`** and exposed via **`/api/weddings/appointments`**. Day and week grids in different parts of the app read and write the same rows.

**Two entry points (same data, different intent):**

| Surface | Primary use |
|---------|-------------|
| **Back Office → Appointments** (sidebar) | **Store calendar** — measurements, fittings, consultations, events, and general customer visits. Bookings are **customer-centric** by default: the record ties to **`customers`** when known (`customer_id`). Linking to a **wedding party / member** is **optional** and explicit in the UI (for shops that want Wedding Manager workflow sync on that slot). |
| **Wedding Manager** (embedded) | **Party-centric** scheduling; same API and table, copy and flows oriented to wedding parties and members. |

**Customer discovery when booking:** Staff search the ROS customer directory (**`GET /api/customers/search`**) — name, phone, email, code, address, and active party context. Search results can include **`wedding_member_id`** when the customer is on an **active upcoming** party so optional linking does not require leaving the appointment flow.

**Schema note (migration 33):** `wedding_party_id` and `wedding_member_id` may be **null** for general store appointments; **`customer_id`** (nullable FK to `customers`) records CRM linkage without a party row. Customer timelines include appointments matched by `customer_id` or via linked `wedding_members`.

**Technical reference:** **`docs/APPOINTMENTS_AND_CALENDAR.md`** (API payloads, `weddingApi.ts`, WM vs ROS modals).

---

## 4. Operational Speed & Analytics

### 4.1 Intelligent Search & Order Management
The POS utilizes a multi-threaded search strategy that resolves SKU scans and keyword keyword lookups instantly. Staff can also recall historical orders via the **Orders** tool, enabling direct fulfillment, resume-checkout, and metadata updates (Rush/Due Date) for existing customer accounts.

### 4.2 Visual Command Center & Webhooks
- **Insights Dashboard:** Native rendering of `recharts` provides interactive 7-day momentum and revenue graphs for rapid visual analysis.
- **Async Webhook Distribution:** A lightweight `tokio::spawn` dispatcher inside the Rust backend securely POSTs JSON order payloads at successful checkout to any configured external webhook endpoints (Make.com, Zapier, etc) automatically connecting Riverside OS to the outside world.

---

## 5. Staff & Internal Controls

### 5.1 Attribution & Commission Splits

Decouples the **Operator** from the **Salesperson**.

- **Operator ID:** Tracks the cashier code used to start the sale.
- **Primary Salesperson:** The default earner for the order.
- **Line-Item Overrides:** Supports **Split Sales** where different items in one cart are attributed to different reps.
- **Spiff Engine:** Fixed-dollar bonuses assigned to SKUs, either additive to commission or as a standalone incentive.

### 4.2 Employee "Cost-Plus" Pricing

Internal sales logic protects shop margins.

- **Logic:** Unit Cost × (1 + Global Employee Markup Percentage).
- **Safety:** Employee sales are automatically flagged for 0% commission.

---

## 5. Financial Controls & Pass-Through Logistics

### 5.1 RMS Charge & Account Payments

Specialized handling of 3rd-party RMS account finances.

- **RMS Charge/90-Day:** Increases Accounts Receivable without immediate cash flow.
- **RMS Account Payments:** Money collected for a 3rd party. Restricted to Cash or Check only. These are non-revenue pass-throughs.
- **Posting Dashboard:** A queue of RMS payments that must be manually confirmed on the provider's website, preventing missed entries.

### 5.2 Register Sessions (Z-Reporting)

Mandatory Opening/Closing workflow.

- **Opening:** Cash float verification.
- **Closing:** System tallies Cash, Stripe (Credit), Gift Cards, and RMS Charges. It calculates *Expected Cash* vs. *Actual Count* for Over/Short auditing.
- **Detailed Transaction List:** Granular closing report showing every line item, original vs. sold price, discounts, and payment allocations.

---

## 6. Technical Data Schema & Entities

Standardized PostgreSQL entities for Cursor AI development:

| Entity | Fields (representative) |
|--------|-------------------------|
| `staff` | `id`, `cashier_code`, `comm_rate`, `is_active` |
| `products` | `id`, `unit_cost`, `base_price`, `spiff_amount`, `tax_cat` |
| `orders` | `id`, `booked_at`, `fulfilled_at`, `operator_id`, `is_employee` |
| `order_items` | `id`, `product_id`, `sales_rep_id`, `fulfillment_type`, `size_specs` (JSONB), `applied_spiff` |
| `transactions` | `id`, `category` (Retail vs. RMS_Payment), `is_posted_to_rms` |
| `allocations` | `payer_id`, `target_order_id`, `amount` |
| `wedding_appointments` | `id`, `starts_at`, `appointment_type`, `status`, `salesperson`, optional `wedding_party_id`, optional `wedding_member_id`, optional `customer_id`, `customer_display_name`, `phone`, `notes` — shared by **Appointments** workspace and **Wedding Manager** calendar (see §3.4, **`docs/APPOINTMENTS_AND_CALENDAR.md`**) |

---

## 7. Operational Roadmap

| Phase | Scope |
|-------|--------|
| **Phase 1** | Core POS engine, Hybrid Cart, NYS Tax Logic, and Register Sessions. |
| **Phase 2** | Wedding Dashboard, Master Payer Allocation, and Measurement Vault. |
| **Phase 3** | Employee Pricing, Spiff Engine, RMS Pass-through Portal, and Messaging Engine. |
| **Phase 4** | **Modularized POS & Order Recall**, Multi-Surface Access (PWA), and Independent Analytics Suite. |

**Implementation status (delivery phases 2.x / current sprints):** see **`todo.md`** at the repo root — it tracks shipped UX (command grids, inventory barcode ops, Insights Hub API + UI, etc.) independently of the strategic phases above. **Appointments / calendar** implementation detail: **`docs/APPOINTMENTS_AND_CALENDAR.md`**.

---

*Source: `Riverside_OS_Master_Specification.pdf`*
