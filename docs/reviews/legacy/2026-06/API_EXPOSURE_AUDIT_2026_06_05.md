# API Exposure Audit — 2026-06-05

Focused review of backend endpoints that existed without clear staff-facing exposure.

## Implemented exposure

- **Customer Notifications**
  - Backend: `GET /api/notifications/queue`, `POST /api/notifications/queue/{id}/send-now`, `POST /api/notifications/queue/{id}/skip`, `POST /api/notifications/queue/{id}/review`, `POST /api/notifications/queue/schedule-batch`
  - App exposure: Back Office → Operations → Customer Notifications and POS → Customer Notifications.
  - Rationale: Automated customer messages need delivery visibility, staff review/archive, immediate-send, and skip controls without mixing in regular staff-written Podium texts or staff-written emails.

- **QBO Health**
  - Backend: `/api/qbo/token-health`, `/api/qbo/health`, `/api/qbo/company-info`, `/api/qbo/tokens/refresh`
  - App exposure: Settings → QuickBooks Online → QBO Health card.
  - Rationale: QBO can fail because of token, company, environment, or API reachability problems before staging visibly fails.

- **Inventory Batch Scan**
  - Backend: `POST /api/inventory/batch-scan`
  - App exposure: Back Office → Inventory → Batch Scan.
  - Rationale: The endpoint is useful as a staff scan-resolution tool, but it must remain resolution-only.

## Retained as API helpers

- **Product matrix generation**
  - Backend: `POST /api/products/matrix/generate`
  - Decision: Retain. Product creation already has a staffed matrix builder in `ProductMasterForm`; adding a second staff control would duplicate the workflow.

- **Product bulk update**
  - Backend: `POST /api/products/bulk-update`
  - Decision: Retain. Staff-facing bulk controls already use newer, narrower endpoints for model assignment, web publish, archive, and tag printing. Keeping this route avoids breaking API clients while avoiding a broad UI action that could change price/cost/category too casually.

## Guardrails

- Inventory stock changes must continue through receiving, stock adjustment, physical inventory, or approved domain logic.
- Batch Scan must not mutate stock, costs, catalog, or physical inventory sessions.
- Product bulk endpoints should not be promoted to staff UI unless the action is narrowed, confirmed, and permission-gated.
