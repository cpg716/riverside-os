# Audit Report: Wedding Party Subsystem
**Date:** 2026-04-08
**Status:** Feature-Complete / Legacy-Parity+
**Auditor:** Antigravity

## 1. Executive Summary
The Wedding Party subsystem is the core operational engine of Riverside OS. It manages the complex lifecycle of group clothing orders (weddings, galas, events) by coordinating member measurements, styles, financials, and logistics within a unified real-time interface.

## 2. Structural Architecture

### 2.1 The Party-Member Hierarchy
- **`wedding_parties`**: Stores event-level data (Wedding Date, Venue, Groom/Bride details, Salesperson).
- **`wedding_members`**: Linked individuals (Best Man, Groomsmen, Father of Bride) with their specific measurements, roles, and order statuses.
- **Meilisearch Integration**: Parties are indexed in real-time, allowing for sub-second searching by groom name, party name, or event date.

### 2.2 The State Machine
Members progress through a strictly tracked lifecycle:
1. **Registered**: Member added to the party.
2. **Measured**: Fitting data captured and tailored specs stored.
3. **Ordered**: Styles assigned and purchase orders generated.
4. **Ready**: Goods received and fittings scheduled.
5. **Picked Up**: Final handoff and checkout completion.

## 3. Operational Features

### 3.1 Action Board (Mission Control)
The `/morning-compass` endpoint aggregates critical tasks for the day:
- **Needs Measurements**: List of members with upcoming weddings who haven't been fitted.
- **Needs Ordering**: Members with measurements but no style/order linked.
- **Overdue Pickups**: Financial risk alert for goods sitting in the store past the event date.

### 3.2 Real-time Sync (SSE)
- **The Wedding Pulse**: The `/events` SSE stream pushes updates to all connected staff terminals. When a member is measured on one iPad, the change appears instantly on the manager's desktop.

### 3.3 The "Battle Sheet" (Printable Logistics)
- **PrintPartyView**: Generates a high-density PDF/print layout containing all party members, their pickup status, and balance due. This is the primary document used on the floor during heavy Saturday pickup windows.

## 4. Financial & Group Ledger
- **Party-Wide Ledger**: Tracks the total financial health of the event.
- **Disbursements**: Allows a "Master Payer" (often the Groom or Father) to pay a bulk amount at checkout and disburse portions to specific members in the group.
- **Balance Proportionality**: Ensures tax and revenue are recognized correctly for each individual member's items during group payouts.

## 5. Tailoring & Logistics
- **Styles & Fit**: Supports assigning styles to the whole group at once or individualizing per member.
- **Appointments**: Fully integrated fitting/measurement calendar (`MemberAppointmentsModal`) ensuring floor staff are never double-booked.

## 6. Recommendations & Findings
1. **High Integrity**: The use of a dedicated `wedding_activity_log` for every minor change is an industry best practice for resolving "Who changed the measurement?" disputes.
2. **SEO/Workflow**: Semantic IDs in the UI (`MemberListDesktop`) allow for automated testing and fast staff training.
3. **Observation**: The system handles "Out-of-Town" (OOT) members with dedicated status flags and shipping fields.

## 7. Conclusion
The Riverside OS Wedding Party subsystem provides a **native-grade management experience** with the flexibility of a modern web app. It successfully handles the unique financial and logistical complexity of group menswear retail.
