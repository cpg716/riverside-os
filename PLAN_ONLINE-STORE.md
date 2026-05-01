# Online Store Current State

**Last updated:** 2026-05-01

## Summary

Online Store is now a first-class ROS workspace, not a Settings-only tool. The implementation has moved beyond the original Phase 1 plan and now includes the main Online Store operating workspace, storefront CMS, web merchandising, promotions, navigation, media, publish history, analytics, campaigns, account/cart support, and provider-ready web checkout architecture.

The core product rule remains unchanged: **GrapesJS is only for marketing/CMS pages.** Catalog, PDPs, cart, checkout, tax, inventory, orders, fulfillment, refunds, and staff permissions stay ROS-native and auditable.

## Done

### Navigation and workspace

- Added main **Online Store** sidebar tab.
- Gated access with `online_store.manage` or `settings.admin`.
- Added Online Store subsections for daily operation.
- Settings -> Online Store is now configuration/status only and links users back to the main workspace.
- Existing Settings deep links still land safely.

### Storefront CMS and Studio

- Storefront page management lives in Online Store.
- Pages support raw HTML drafts, publish flow, and sanitized public rendering.
- GrapesJS Studio SDK editor is available as a fullscreen ROS overlay, not a small embedded panel.
- Studio project JSON is saved separately from published HTML.
- Studio asset upload path writes through ROS media APIs.
- Exported Studio HTML can be copied into the raw draft and published through the normal ROS flow.
- Studio AI / agent skills are intentionally skipped for now.

### Products and merchandising

- Online Store -> Products is a merchandising view over Inventory truth.
- Staff can manage web visibility, storefront slugs, web price overrides, product copy, SEO fields, gallery order, and public PDP links.
- Product truth remains in ROS inventory and product models.
- GrapesJS does not manage product data, catalog pages, PDPs, cart, or checkout.

### Promotions and growth

- Coupons moved into Online Store operations.
- Promotion/campaign surfaces exist for attribution and landing-page operations.
- Campaign and analytics endpoints report web-facing activity from ROS data.
- SEO/catalog/page health checks are available for operational review.

### Storefront control

- Public `/shop` remains the first-party React storefront.
- Public routes include products, PDPs, cart, account, account order detail, and published CMS pages.
- Online Store includes navigation menu management.
- Online Store includes ROS-native homepage layout blocks.
- Media library supports asset metadata updates, archive protection, and public media serving.
- Publish history captures page snapshots and supports restore.

### Cart, accounts, and checkout architecture

- Guest carts persist server-side and sync with local storefront cart state.
- Storefront customer accounts use the shared `customers` table with online credentials.
- Account login, register, activate, profile, password, order list, and order detail routes exist.
- Web checkout architecture is provider-neutral for **Stripe and Helcim**.
- Checkout session/payment-attempt tables exist.
- Web transactions use `sale_channel = web`.
- Checkout financial logic stays server-side.
- Provider sandbox/live certification is still required before taking real card payments.

### Operations

- Online Store web orders can be reviewed operationally.
- Web transaction actions include ready-for-pickup, shipped/tracking, cancel-review, and refund-needed states.
- Analytics include checkout funnel, web revenue, campaign attribution, carts, and store health signals.
- Settings exposes integration/status configuration instead of day-to-day management.

## Current validation

Release E2E gate is clean after stabilizing the suite:

- `npm run test:e2e:release`: **267 passed, 6 skipped, 0 failed**
- `npm --prefix client run typecheck`: passed
- `npm --prefix client run lint`: passed

The skipped tests are the existing visual baseline skips, not Online Store failures.

## Important boundaries

- Do not use GrapesJS to build or manage the catalog.
- Do not let Studio-authored content mutate products, variants, pricing, stock, cart, tax, checkout, transactions, fulfillment, or refunds.
- Future Studio blocks may read ROS-backed data such as featured products or campaigns, but they must remain read-only presentation blocks over ROS APIs.
- Do not bypass ROS transaction/refund/payment invariants for web checkout.
- Do not treat provider-ready checkout code as live-payment certified until Stripe and Helcim sandbox/live flows are tested in the deployment environment.

## What is still left before real launch

### Credit-card certification

- Complete Stripe sandbox checkout certification.
- Complete Helcim sandbox checkout certification.
- Confirm webhook/finalization behavior for both providers.
- Confirm production credentials and environment variables.
- Run at least one controlled live low-dollar payment/refund test per provider before public use.

### Operational launch checklist

- Confirm public domain / reverse proxy / TLS.
- Set a strong `RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`.
- Confirm storefront CSP and allowed embeds.
- Confirm Shippo live rates and label behavior.
- Confirm tax policy with CPA/counsel before public launch.
- Confirm staff roles that should receive `online_store.manage`.
- Review web order operational playbook with staff.

### Optional later improvements

- Deeper abandoned-cart outreach after marketing consent rules are approved.
- More campaign reporting and SEO scoring.
- More staff-safe Studio presentation blocks backed by ROS APIs.
- Additional publish preview/history UX.

## File and module map

- Back Office workspace: `client/src/components/online-store/OnlineStoreWorkspace.tsx`
- Store settings panel: `client/src/components/settings/OnlineStoreConfigPanel.tsx`
- Studio editor: `client/src/components/online-store/StorePageStudioEditor.tsx`
- Public storefront: `client/src/PublicStorefront.tsx`
- Public/admin store API: `server/src/api/store.rs`
- Store account API: `server/src/api/store_account.rs`
- Store checkout logic: `server/src/logic/store_checkout.rs`
- Store catalog logic: `server/src/logic/store_catalog.rs`
- Store cart logic: `server/src/logic/store_guest_cart.rs`
- Store media logic: `server/src/logic/store_media_asset.rs`
- Store docs: `docs/ONLINE_STORE.md`

## Status

Online Store is implemented enough for internal ROS operation and continued pre-launch validation. The main remaining blocker is **credit-card provider certification for Stripe and Helcim**, not the Online Store workspace itself.
