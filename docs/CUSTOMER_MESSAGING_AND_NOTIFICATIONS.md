# Customer Messaging and Notifications Documentation

Status: **Canonical front door** for Podium messaging, reviews, storefront widget guidance, and Riverside notification-center behavior. Shipping remains separate in [SHIPPING_AND_SHIPMENTS_HUB.md](SHIPPING_AND_SHIPMENTS_HUB.md), with the cross-cutting tracker retained for shared rollout history.

Use this page when changing customer messaging, Podium webhooks, review invitations, notification fan-out, inbox read behavior, storefront widget settings, or automated notification generators.

## Start Here

| Need | Document |
|---|---|
| Notification generator operations and code map | [NOTIFICATION_GENERATORS_AND_OPS.md](NOTIFICATION_GENERATORS_AND_OPS.md) |
| Notification architecture and historical implementation checklist | [PLAN_NOTIFICATION_CENTER.md](PLAN_NOTIFICATION_CENTER.md) |
| Podium SMS, email, webhook, receipt, and storefront widget deep spec | [PLAN_PODIUM_SMS_INTEGRATION.md](PLAN_PODIUM_SMS_INTEGRATION.md) |
| Podium review invites and Operations review workflow | [PLAN_PODIUM_REVIEWS.md](PLAN_PODIUM_REVIEWS.md) |
| Storefront widget CSP and privacy checklist | [PODIUM_STOREFRONT_CSP_AND_PRIVACY.md](PODIUM_STOREFRONT_CSP_AND_PRIVACY.md) |
| Shippo / Podium / notifications / reviews completion tracker | [PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md](PLAN_SHIPPO_PODIUM_NOTIFICATIONS_AND_REVIEWS.md) |
| Receipt delivery through Podium | [RECEIPT_BUILDER_AND_DELIVERY.md](RECEIPT_BUILDER_AND_DELIVERY.md) |
| Staff Podium SOP | [staff/podium-integration-staff-manual.md](staff/podium-integration-staff-manual.md) |
| Full staff Podium reference | [staff/Podium_Integration_Manual.md](staff/Podium_Integration_Manual.md) |

## Maintenance Rules

- Keep Podium secrets in server env only; never log OAuth secrets, refresh tokens, phone bodies, or customer message content unnecessarily.
- Customer-originated Podium messages should preserve the notification fan-out and shared read semantics described in the notification docs.
- Receipt email/text behavior should stay aligned with [RECEIPT_BUILDER_AND_DELIVERY.md](RECEIPT_BUILDER_AND_DELIVERY.md).
- Review-invite behavior should update [PLAN_PODIUM_REVIEWS.md](PLAN_PODIUM_REVIEWS.md) until that roadmap is promoted to a non-plan guide.
- Shipping and label behavior belongs in [SHIPPING_AND_SHIPMENTS_HUB.md](SHIPPING_AND_SHIPMENTS_HUB.md), not in the messaging docs, except where a cross-cutting notification or Podium trigger is involved.
