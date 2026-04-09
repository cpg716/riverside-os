# AI integration outlook — Riverside OS

This document captures **product-grounded** ideas for using AI in ROS: benefits to staff and customers, constraints that match how the app is built, and a sensible rollout order. It is **not** a commitment to build any feature; it is a reference for planning and evaluation.

For stack and invariants (money as `Decimal`, thin handlers, RBAC), see **`DEVELOPER.md`**, **`AGENTS.md`**, and **`docs/STAFF_PERMISSIONS.md`**.

---

## Goals

- **Improve UX and reduce friction** at the register, in the back office, and on the floor—not demos for their own sake.
- **Preserve trust**: pricing, tax, ledger, QBO signals, and permissions stay **server-authoritative** and deterministic. AI **suggests** or **drafts**; humans or existing APIs **commit** changes.
- **Fit real operations**: POS must stay fast; intermittent connectivity (PWA / Tailscale) favors **small models, caching, or on-prem inference** where appropriate.

---

## Open models and edge deployment

Google’s **[Gemma 4](https://deepmind.google/models/gemma/gemma-4/)** family emphasizes **efficiency and strong capability per parameter**, including **E2B / E4B** variants aimed at **mobile and edge** (lower latency, offline-friendly footprints) and larger sizes for workstation-class use. That aligns with:

- Keeping **customer and wedding PII** on shop-controlled infrastructure when possible.
- Avoiding a network round-trip for **every** keystroke in POS.

Model choice (Gemma vs others) is an implementation detail; the **patterns** below stay the same: grounded context, human confirmation, no silent financial writes.

---

## Design principles (non-negotiables for ROS)

| Principle | Implication |
|-----------|-------------|
| **Money and tax** | Totals, NYS tax, commissions, QBO staging—**Rust + PostgreSQL** remain source of truth. AI does not override `rust_decimal` outcomes. |
| **Auth and RBAC** | Staff capabilities stay **`require_staff_with_permission`** and headers; AI does not bypass gates. |
| **POS latency** | Hot paths (scan → add line, tender) stay **non-blocking**; AI is optional side panels or async suggestions. |
| **Human in the loop** | High-impact actions (send SMS/email, publish inventory, approve QBO) require **explicit staff confirmation** (existing modal/toast patterns). |
| **Grounding** | Prefer answers **anchored** to ROS docs (`DEVELOPER.md`, runbooks, UI copy) or **structured API/JSON** from the server—not unconstrained web hallucination for operational procedures. |

---

## Meaningful use cases (by area)

### Back Office — onboarding and operations

- **Contextual help / “how do I…?”**  
  Short answers grounded in **this repo’s** documentation and workflows (receiving, physical inventory, QBO mapping, staff permissions). Reduces “where do I click?” time for new managers.

- **Insights narration (read-only)**  
  One-paragraph **explanations** of pivot or commission views (“MTD vs prior period, top movers”) where **numbers come from existing APIs/SQL**; the model only summarizes what is already true.

### POS and floor — speed without replacing resolution logic

- **Assistive search (confirm to apply)**  
  Messy verbal or typed hints (“gray vest from Saturday”) → **candidate SKUs, products, or customers** for the cashier to **tap**. This **augments**—does not replace—the existing multi-step resolution strategy (direct SKU → fuzzy → modal).

### Weddings / CRM

- **Party or order summaries**  
  From **structured data** the server already exposes: balances, open items, key dates, next steps. Shown as a **collapsible panel** for consultants, not a replacement for the pipeline UI.

### Communications (future-friendly)

- **Draft SMS/email**  
  Pickup reminders, appointment follow-ups, polite rewrites—staff **edits and sends** via your existing messaging hooks. No auto-send without confirmation.

### Inventory and receiving

- **Notes and categorization assistance**  
  From text (and later optionally images): suggested **internal notes** or tags for damage/returns—**save only after review**. Fits tablets in receiving; edge-sized models may be enough for text-first v1.

### Multilingual staff experience

- **Inline help or UI gloss**  
  Explain a screen or label in another language for diverse teams; **catalog and legal strings** can stay canonical in English until you intentionally localize product data.

---

## What to avoid (early)

- **Autonomous checkout** or silent discounts without server validation.
- **AI “permissions”** or role inference that bypasses **`staff_role_permission` / overrides**.
- **Heavy inference on every scan** or blocking the emerald primary actions.
- **Training or fine-tuning on raw production exports** without governance, retention policy, and opt-in.

---

## Suggested rollout order

1. **Documentation-grounded assistant** (Back Office only): RAG or similar over curated markdown—high learning ROI, low risk to money paths.
2. **Draft outbound messages** with explicit edit/send and audit logging where you already log sensitive actions.
3. **Structured summaries** (party / order) from API JSON only—no guessing numbers not in the payload.
4. **Multimodal** (e.g. defect photos) only after text paths prove value and latency/privacy targets are clear.

---

## Architecture sketch (when you implement)

- **Inference location**: shop-hosted API, Tauri sidecar, or approved cloud—chosen per privacy and ops policy.
- **Client**: thin UI calling a **dedicated** endpoint (e.g. `/api/ai/suggest`) that never mixes with checkout transaction handlers without review.
- **Server**: validate staff permission for any feature that touches customer data; rate-limit; log feature usage for support, not PII in prompts where avoidable.

---

## References

- [Gemma 4 — Google DeepMind](https://deepmind.google/models/gemma/gemma-4/) — model family, efficiency tiers (including E2B/E4B), and deployment options described by Google.
- **`Riverside_OS_Master_Specification.md`** — domain vocabulary and product scope.
- **`ROS_AI_INTEGRATION_PLAN.md`** (repo root) — implementation-ready phases, `/api/ai` shape, worker topology, and pillar checklist when building (this outlook stays **product intent** only).
- **`docs/staff/CORPUS.manifest.json`** — canonical list of staff-facing Markdown files to index for contextual help (hub: **`docs/staff/README.md`**).
- **`docs/ROS_AI_HELP_CORPUS.md`** — shipped help RAG: reindex API, hybrid lexical + vector retrieval, env and ops (distinct from the **LLM** worker in **`docs/ROS_GEMMA_WORKER.md`**).
- **`docs/AI_CONTEXT_FOR_ASSISTANTS.md`** — single guide for **routing** (staff docs vs reporting catalog vs RBAC vs live `store-sop` API), **chunking** hints, and **refusal** boundaries for any ROS-aware assistant.
- **`docs/AI_REPORTING_DATA_CATALOG.md`** — APIs and domains suitable for **admin natural-language reports** / charts (whitelist-oriented; no raw SQL from models).
- **`REMOTE_ACCESS_GUIDE.md`** — constraints for PWA / Tailscale when adding network-dependent AI services.

---

## Revision

Update this doc when you adopt (or reject) a concrete feature so the team keeps a single narrative of **why** AI is in ROS and **what** it is allowed to do.
