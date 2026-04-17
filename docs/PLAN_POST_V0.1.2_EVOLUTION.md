# Plan: Post-v0.1.2 Strategic Evolution

This document outlines high-impact operational opportunities identified after the v0.1.2 release. These features are designed to move Riverside OS from a "Back Office Admin Tool" to a "Strategic Operational Platform," specifically for high-end wedding retail and custom tailoring.

---

## 1. Made-to-Measure (MTM) Command Center
**Status:** Concept / Opportunity
**Impact:** Custom Order Precision & Communication

### The Problem
Custom and Made-to-Measure (MTM) orders are "High-Value / High-Complexity." Currently, tracking the gap between "Ordering from Manufacturer" and "Arriving for Tailoring" is often handled in spreadsheets or external portals (NuORDER), making it difficult for floor staff to give customers instant updates.

### The Solution: "Custom Lifecycle" Tracker
A dedicated workspace for MTM and Custom orders:
- **Manufacturer Sync:** Track custom orders through specific stages: (Order Placed -> Fabric Sourced -> Shipped from Factory -> Received in Shop).
- **Fitting Milestones:** Automatically generate "Task" reminders for the 1st, 2nd, and Final fittings based on arrival dates.
- **Customer Transparency:** Proactive Podium nudges at each milestone ("Your fabric has arrived at the factory," "Your suit has arrived in-shop for your first fitting").

---

## 2. Proactive “Wedding Health” Scorecard
**Status:** Shipped (v0.2.0)
**Impact:** Risk Mitigation & Proactive Management

### The Problem
Managers often don't know a wedding is "in trouble" (missing measures/payments) until the week of the event, leading to emergency alterations and overtime.

### The Solution: Visual Heatmap
A top-level dashboard that scores every upcoming wedding party based on "Readiness":
- **Red:** Wedding < 14 days away; < 30% measured; 0% paid.
- **Amber:** Wedding < 30 days away; < 50% measured.
- **Green:** On track.
**Staff Action:** One-click "Nudge All" via Podium for specific sub-groups (e.g., "Nudge un-measured").

---

## 3. Alteration Manager & Capacity Scheduler (Legacy List Replacement)
**Status:** Concept / Opportunity
**Impact:** Revenue Protection / Operational Precision

### The Problem
Traditional "Alterations Lists" are passive; they show what is done but don't prevent over-scheduling. Furthermore, disconnected alterations can lead to "missing revenue" where tailor time is spent on items not correctly billed in the POS.

### The Solution: Integrated Manager & Scheduler
A comprehensive workspace that replaces the static "Alterations List" with a real-time capacity engine:
- **Sale-Linked Workflow (Mandatory):** Alterations can **only** be scheduled if they are first added as service lines to a **Customer Sale (Order)**. This enforces revenue capture and ensures a 1:1 link between tailor labor and a financial transaction.
- **The Manager Workspace:** A high-level view for admins to monitor the entire shop's alteration health, identifying bottlenecks and managing the **Alteration Task Dictionary** (Name/Type/Time).
- **The Capacity Scheduler:** A visual calendar-style interface that manages daily "Tailor Hour" blocks (e.g., 16h limit):
    - **Automated Time Scaling:** Total time for an alteration is computed by summing the "Task Dictionary" weights selected during the checkout fitting.
    - **Real-Time Date Booking:** POS prompts for a fitting/delivery date based on remaining scheduler capacity.
    - **The "Catch-Up" Constraint:** Ability to flag specific days as **"NO ALTERATIONS"** for mandatory catch-ups or emergency wedding overflows.
- **Tailor Workflow (Physical):** Digital status board (Pins Pending -> In Work -> QC -> Bagged) to drive the physical garment journey.

---

## 4. “The Wedding Closet” (Group Purchase Tracking)
**Status:** Concept / Opportunity
**Impact:** Group Sales Coordination

### The Problem
When a wedding party is buying (not renting) their suits, managers need to track who has actually "Committed" (Paid and Fitted) versus who is still outstanding.

### The Solution: Party Purchase Tracker
A visual grid for the wedding party "Uniform":
- **Product Linking:** Link specific retail variants (Suit, Shirt, Tie) into the "Wedding Uniform."
- **Member Status:** Instantly see who has purchased their kit and who has had their fitting.
- **Bulk Action:** "Nudge Unpaid" via Podium to ensure the entire party is ready for their tailoring window.

---

## 5. Hardware “Sentinel” & Proactive Pulse
**Status:** Concept / Opportunity
**Impact:** Operational Resilience

### The Problem
If the receipt printer runs out of paper or the Star/Epson bridge goes offline mid-sale, the POS experience stalls, creating queues and staff frustration.

### The Solution: Bridge Heartbeat
Leverage the Tauri hardware bridge (`src-tauri/src/hardware.rs`) to maintain a background heartbeat.
- **Dashboard Status:** A "Heartbeat" indicator in the app header (Printers, Scanners, Terminals).
- **Proactive Alerts:** "Thermal Printer [Station 1] is offline" — toast alert before a transaction begins.

---

## Future / Parking Lot (Post-v0.1.5)
- **Groomsman Self-Service Magic Link:** Offloading measurement intake to the customer via SMS tokens via a public portal.

---

## Strategic Priority Ranking

| Opportunity | Complexity | Impact | Priority |
| :--- | :--- | :--- | :--- |
| **Wedding Health Scorecard** | Low | **High** | **P1** |
| **MTM Command Center** | Medium | High | P1 |
| **Alteration Load Forecasting**| Medium | Medium | P1/P2 |
| **Wedding Closet (Group Buy)**| Low/Medium | Medium | P2 |
| **Hardware Sentinel** | Low | Medium | P2 |

---

## Related Documents
- [`PLAN_PODIUM_SMS_INTEGRATION.md`](./PLAN_PODIUM_SMS_INTEGRATION.md) (Carrier for Magic Links)
- [`PLAN_MORNING_COMPASS_PREDICTIVE.md`](./PLAN_MORNING_COMPASS_PREDICTIVE.md) (Aggregator for Health Scores)
- [`ONLINE_STORE.md`](./ONLINE_STORE.md) (Host for public Portal routes)
- [`AGENTS.md`](../AGENTS.md) (Referenced foundations)
