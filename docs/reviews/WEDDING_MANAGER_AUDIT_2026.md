# Audit Report: Wedding Manager Subsystem (2026)
## 2026-08-02 closure review

The POS Wedding Hub now treats `transaction_lines.lifecycle_status` as the authority for Ordered, Received, Ready for Pickup, and Picked Up. Legacy member flags remain compatibility fields but are no longer writable from the party grid and no longer satisfy readiness completion.

Appointment create/update/delete activity is attributed to authenticated ROS staff. Linked Measurement/Fitting attendance and its member milestone are committed atomically; Pickup attendance deliberately leaves fulfillment unchanged. Schedule overrides carry the selected `salesperson_staff_id`, require Manager Access and a reason, and retain the existing override audit record.

Party/member updates now use authenticated staff attribution and commit their activity log with the business update. Core wedding modal surfaces use the shared `#drawer-root` modal tier; non-modal full-screen workspaces retain their workspace layout.

Financial behavior remains unchanged: deposits are payer-owned liabilities, beneficiary allocations consume exact source ledger funds, and member builds create separate Transactions/Fulfillment Orders through checkout.

The 2026-08-03 follow-up adds a Manager Access closeout for weddings that passed, were cancelled, did not proceed, were completed outside ROS, or predate complete ROS tracking. Closeout records structured outcome/reason/notes and an open-work snapshot, requires explicit acknowledgment when linked work remains, archives the party, and writes the audit event atomically. It never mutates linked financial or operational records and supports an audited manager reopen path.

**Date:** 2026-04-08
**Status:** Feature Complete / Event-Driven

## 1. Executive Summary
The Wedding Manager (WM) is a specialized "CRM within a CRM," focusing on the complex, multi-party lifecycle of a wedding event. It manages Leads, Parties, and Members through an event-driven architecture (SSE) and is deeply integrated with the ROS `customers` and `orders` subsystems.

## 2. Technical Architecture

### 2.1 Unified Party Model
- **Relationship**: `wedding_parties` -> `wedding_members` (linked to `customers` ID).
- **Financial Context**: A dedicated `WeddingPartyFinancialContext` provides a real-time summary of balance dues and recognition levels across all members of a party.
- **Workflow Fields**: Members track granular status flags (`measured`, `suit_ordered`, `received`, `fitting`, `pickup_status`).

### 2.2 Event-Driven Sync (SSE)
- **Live Updates**: The system uses **Server-Sent Events (SSE)** via `wedding_events_stream` to broadcast `parties_updated` and `appointments_updated` events.
- **Client Cache**: The Wedding Manager UI responds to these events by triggering `refresh()` on its local data providers, ensuring that multiple staff members working a large bridal party always see the same state.

## 3. The Action Dashboard (Mission Control)
- **Categorization Engine**: A core architectural component is the `ActionDashboard.jsx`, which segments work into:
    * **Upcoming Appts** (Timed arrival)
    * **Missed Appts** (Flagged for follow-up)
    * **Needs Measure / Order / Fitting / Pickup** (Workflow-driven)
- **Urgency Pulses**: Items within 14 days of an event (or overdue) are marked as **Urgent** with red pulsing badges to prioritize staff attention.
- **Quick Action Completion**: Features standardized "Done" buttons across the dashboard using the **Emerald Terminal** aesthetic (`bg-emerald-600` + `border-b-4`). These actions prompt for salesperson attribution and perform atomic updates to the member record.

## 4. Workflows & Lifecycle
- **Unified Profile**: A wedding member is just a specialized view of a CRM `customer`. Deleting a customer correctly prompts to handle active wedding member links.
- **Appointment Continuity**: Appointments created in the general Scheduler can be "linked" to a wedding member, surfacing those appointments directly within the party profile and Action Dashboard.
- **Activity Log**: Every member change (e.g., status flip or note) is recorded in a persistent `wedding_activity_log`, providing a detailed "Who did what and when" for every party.

## 5. UI/UX Analysis
- **Premium Design**: The Wedding Manager uses a distinct "Gold/Navy" luxury palette to differentiate the wedding experience from the green "Emerald/Retail" terminal look.

## 6. Security & RBAC
- **`WEDDINGS_VIEW`**: Gates access to the dash and party lists.
- **`WEDDINGS_MUTATE`**: Required for editing member statuses or creating parties.

## 7. Conclusion
The Wedding Manager is a mature, robust subsystem that effectively bridges the gap between customer relationship management and specialized bridal retail operations. Its Action Dashboard serves as the true "brain" of the floor operations.
