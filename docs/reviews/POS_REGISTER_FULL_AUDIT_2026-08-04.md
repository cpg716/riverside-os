# POS / Register full audit — 2026-08-04

## Executive result

The Register is broad and financially defensive. Its strongest differentiator is the explicit separation of financial Transactions from Fulfillment Orders, combined with formalwear-specific deposits, wedding-member ownership, layaway, pickup, return/exchange, register reconciliation, and recoverable Helcim workflows.

No failed financial invariant was found. The full blocking browser run completed with 197 passes, three failures, and three serially skipped tests. The failures were test-contract defects: the register helper waited for sale hydration before allowing the cashier overlay to be completed, navigation expected an intentionally collapsed rail to remain open, and a receipt assertion used the retired `Taxes` label instead of `Sales Tax`. These contracts were corrected and require the targeted rerun recorded below before release use.

This is source and local-test evidence, not production hardware or Main Hub certification.

## Scope traced

- Staff entry, lane selection, register-session creation, cashier identity, idle locking, and Manager Access.
- Product scan/search, variation selection, customer attachment, pricing/discount/tax, cart persistence, parked work, and recovery.
- Cash, check, gift card, store credit, RMS/staff account, split tender, Helcim card, deposits, payment in full, cash rounding, and idempotent checkout.
- Special, Custom, Wedding, Layaway, pickup, return, exchange, refund, receipt, drawer reconciliation, linked-lane close, Daily Sales, and Z reporting.
- Printer/scanner integration, offline queue/replay, receipt retry, permissions, keyboard/touch contracts, and operational metrics.

## Confirmed strengths

| Area | Evidence-backed assessment |
| --- | --- |
| Financial integrity | Decimal server math, server revalidation, payment allocations, cash-rounding ledger separation, idempotency, and 128 automated financial invariant gates. |
| Formalwear operations | Special/Custom/Wedding Fulfillment Orders, member-scoped wedding activity, payer-held deposits, alterations, pickup, layaway, and reservations are first-class rather than generic notes. |
| Payment resilience | Provider attempt retention, stale-terminal recovery, approved-payment reconciliation, receipt retry, and a deliberately narrow offline continuation path avoid duplicate charges. |
| Register control | Lane sessions, authenticated cashier identity, Manager Access, drawer floats/counts, linked-lane close, and report tender parity are explicit. |
| Recovery | Persisted active sale, parked sales, blocked offline-item recovery, checkout identity reuse, and operational evidence preserve unfinished work. |
| Staff usability | Scanner/Enter paths are immediate, input semantics have dedicated coverage, and POS keeps administrative settings constrained. |

## Findings and actions

### Fixed in this audit

1. **Typed product search felt slower than its API.** Normal authenticated local product searches returned in about 8 ms in the sampled environment, while the UI deliberately waited 400 ms. The Register delay is now 250 ms; Enter and barcode scans remain immediate, superseded requests are aborted, and stale responses remain rejected.
2. **The shared register E2E helper could deadlock at cashier entry.** It required `data-sale-hydrated=true` before the cashier overlay helper could run. Register-open now means the cart is mounted; cashier readiness remains asserted by the dedicated sign-in helper.
3. **Two stale UI contracts obscured real behavior.** The navigation test now reopens the rail after cart actions intentionally collapse it, and the receipt contract expects the actual `Sales Tax` output.
4. **POS journey telemetry is now implemented.** Register records privacy-safe search-to-result, scan-to-line, Payment-open, tender-confirmed, receipt-ready, and close-complete timings through a strict active-session endpoint. The Operations & Support Center presents 24-hour sample count, median, p95, maximum, and failure totals; existing cleanup removes samples after 30 days.

### High-value next work

1. **Customer-facing display.** Add a read-only second-screen route showing items, discounts, tax, total, payment progress, and receipt choice. Never expose staff controls, internal notes, cost, or customer-private fields.
2. **Configurable action grid.** Extend the existing quick-action pattern into per-station and permission-filtered tiles for frequent products and workflows. Keep every action routed through existing pricing, permission, and audit logic.
3. **Training mode.** Provide an unmistakable, isolated practice register that cannot authorize payments, move inventory, create financial records, or contaminate reports. Training receipts and screens must be permanently watermarked.
4. **Formal quote workflow.** Add draft/reopen/version/email/expiry and customer deposit-request behavior while preserving the boundary between a non-financial quote, a posted Transaction, and a Fulfillment Order.

### Strategic opportunities

1. **Wedding/customer self-service portal:** party registration, measurements, appointments, approved documents/signatures, balances, and payment requests, backed by the same ROS records and permission rules.
2. **Handheld line busting:** responsive selling and camera barcode scan for assisted selling, with the same station/session ownership and no parallel checkout rules.
3. **Governed offline selling:** begin with cached catalog plus permission-gated cash/manual tender, explicit device/transaction limits, pending badges, activity logs, and conflict-safe replay. Do not treat an offline Helcim authorization as supported unless the processor and hardware contract prove it.
4. **Incremental hot-path decomposition:** `Cart`, checkout drawer, close modal, and server checkout are very large. Extract only measured rerender or ownership seams behind current tests; avoid a rewrite.

## Competitive lessons

| Capability | Market lesson | ROS position / recommendation |
| --- | --- | --- |
| Omnichannel inventory and mobile selling | Square Retail and Shopify POS emphasize synchronized inventory, portable hardware, staff permissions, and customizable POS layouts. | ROS has deeper store workflows, but should add customer display, handheld selling, and configurable station actions. |
| Governed offline operation | Shopify exposes permissions, optional manager approval, device/transaction limits, pending state, and an activity log for offline checkout. | Preserve ROS's conservative payment posture and adopt the governance model before widening offline scope. |
| Special orders, layaway, quotes | Lightspeed exposes clear reservation/status pipelines, customer-linked special orders/layaways, and reopenable quotes with emailed deposit requests. | ROS is stronger in fulfillment accounting; a real quote/deposit-request lifecycle is the missing commercial step. |
| Bridal/formalwear client journey | BridalLive exposes party registration, measurements, order history, payments, appointments, quotes, and digital signatures through a client portal. | ROS has richer authoritative operational data but lacks the self-service surface that reduces staff re-entry. |
| Enterprise operating modes | Oracle Xstore documents desktop/tablet/handheld operation, training mode, inventory operations, multiple tenders, serialized items, and device/offline administration. | Add an isolated training mode and handheld layout; retain ROS's domain-specific financial rules. |

Primary comparison sources: [Square Retail capabilities](https://squareup.com/us/en/retail/capabilities), [Shopify POS](https://help.shopify.com/en/manual/sell-in-person/shopify-pos) and [offline checkout](https://help.shopify.com/en/manual/sell-in-person/shopify-pos/selling-offline/offline-checkout), Lightspeed Retail [special orders](https://retail-support.lightspeedhq.com/hc/en-us/articles/229130588-Creating-a-special-order), [layaway](https://retail-support.lightspeedhq.com/hc/en-us/articles/228842087-Creating-a-layaway), and [quotes](https://retail-support.lightspeedhq.com/hc/en-us/articles/229130568-Creating-a-quote), BridalLive [software](https://help.bridallive.com/hc/en-us/categories/360001416712-BridalLive-Software) and [client portal](https://help.bridallive.com/hc/en-us/articles/360022655952-Client-Portal-Features-Setup), and [Oracle Xstore 25.0](https://docs.oracle.com/en/industries/retail/retail-xstore-point-of-service/25.0/rpxmo/introduction-oracle-retail-xstore-pos.htm).

## Validation record

- `npm run check:financial-invariants` — passed, 128 gates.
- `npm run typecheck` — passed before the audit edits.
- `npm run check:server` — passed before and after the audit edits.
- `npm --prefix client run test:e2e:blocking` — 197 passed, 3 failed, 3 skipped; the three failed contracts are described above and were corrected afterward.
- Targeted post-fix E2E (`exchange-wizard`, POS navigation, tax audit, and search fluidity) — 29 passed.
- POS journey telemetry contracts — 4 passed, including authenticated ingestion, privacy-field rejection, six-stage wiring, and Ops summary aggregation.
- Phase 2 tender UI smoke — 2 passed after aligning the gift-card setup path with **More Actions**.
- `npm run typecheck` — passed after edits.
- `npm run lint` — passed after edits.
- `cargo fmt --all -- --check` — passed after edits.
- `npm run check:help-impact` — passed; substantive staff/Help updates detected.
- `git diff --check` — passed.

## Remaining certification risk

- Run the normal release gates against the exact commit selected for release.
- Perform a store-hardware acceptance drill for scanner wedge behavior, each receipt/tag printer, drawer kick, cash count/close, Helcim approve/decline/cancel/stale recovery, network loss/reconnect, and duplicate-submit prevention.
- Capture representative Main Hub and register workstation p50/p95 values. Local developer timings and E2E durations are not production performance proof.
- Do not release, deploy, or change production configuration from this audit without separate authorization.
