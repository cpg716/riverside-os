---
id: loyalty-workspace
title: "Loyalty & Gift Cards"
order: 1080
summary: "Manage gift card liability, issue donative cards, oversee point economics, and configure reward program tiers."
source: client/src/components/loyalty/LoyaltyWorkspace.tsx
last_scanned: 2026-04-17
tags: loyalty, gift-cards, rewards, points, liability, issuance
---

# Gift Cards and Loyalty (Back Office)

_Audience: Managers and leads._

**Where in ROS:** Back Office → **Gift Cards** and **Loyalty** tabs. 

---

## How to use these tabs

Use **Gift Cards** for **liability management** (issuance, voids, balance tracking). Use **Loyalty** for **points economics** (adjustments, tier settings, and eligibility).

## Gift Cards Management

### Card Inventory
**Purpose**: Confirm card status and remaining balance.
1. **Gift Cards** → **Card Inventory**.
2. Search by **full code** or **last four**.
3. View **issue date**, **initial value**, and the active/void status.
4. **Voiding**: Only void cards following your store’s written SOP as it affects financial liability.

### Issuance
- **Issue Purchased**: Used after customer payment is collected. Verify the new card appears in inventory with the correct balance.
- **Issue Donated**: Marketing or charity issuance (typically **manager-only**). Always record the reason for donation in the notes.

## Loyalty Program Management

### Monthly Eligibility
**Purpose**: Review who qualifies for periodic rewards.
1. **Loyalty** → **Monthly Eligible**.
2. Scan the list for qualified customers. Export only on secure machines due to PII.
3. Coordinate outreach via email or SMS based on program rules.

### Adjusting Points
**Purpose**: Correct mistakes or apply goodwill points with an audit trail.
1. **Loyalty** → **Adjust Points**.
2. Search for the customer and enter the **delta** (+/-) and a clearly stated **reason**.
3. Save and advise the customer that the update will be reflected on their next POS visit.

### Program Settings
**Purpose**: High-impact configuration of **earn rates**, tiers, and caps.
1. **Loyalty** → **Program Settings**.
2. Change only one variable at a time and document broad changes before saving.
3. Test tier changes with an internal test account first.

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| **Card not found at POS** | Check for spaces or activation timing in Card Inventory. |
| **Loyalty points incorrect** | Customer may need to re-sign in at the POS to refresh cached point totals. |
| **Adjustment rejected** | Usually means the adjustment exceeds a program-defined rule or cap. |

**Last reviewed:** 2026-04-17
