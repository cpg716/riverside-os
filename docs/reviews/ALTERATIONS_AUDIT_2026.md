# Audit Report: Alterations Subsystem (2026)
**Date:** 2026-04-08
**Status:** Functional (Decoupled)

## 1. Executive Summary
The Riverside OS Alterations subsystem provides a robust, standalone engine for managing tailoring work orders. It features a dedicated lifecycle, automated customer notifications via Podium, and detailed audit logging of staff actions. However, the system is currently "decoupled" from the Wedding Manager and Customer Relationship Hub, creating manual data-entry friction for floor staff.

## 2. Technical Architecture

### 2.1 Backend Data Model
- **`alteration_orders`**: Primary entity tracking `customer_id`, `status` (`pending`, `in_work`, `ready`, `picked_up`), and `due_at`.
- **`alteration_activity`**: Audit table recording `staff_id`, `action`, and JSON `detail` for every state change.
- **Messaging Integration**: Uses `MessagingService::trigger_alteration_ready` to send automated SMS/Email via Podium when status transitions to `ready`.

### 2.2 API Implementation (`/api/alterations`)
- **`GET /`**: List alterations with filters for `status` and `customer_id`.
- **`POST /`**: Create new work order. Accepts an optional `wedding_member_id` for reference.
- **`PATCH /{id}`**: Updates status/notes. This handler contains the "Side Effect" logic for automated messaging.

## 3. Workflow Analysis

### 3.1 Work Order Lifecycle
| Trigger | Action | Result |
| :--- | :--- | :--- |
| **Intake** | Staff manually creates record in Alterations Workspace. | Row added to `alteration_orders`; optional link to Wedding Member. |
| **In-Work** | Tailor updates status to `in_work`. | Audit log updated; staff visibility improved. |
| **Ready** | Tailor updates status to `ready`. | **Automated Podium SMS/Email sent to customer.** |
| **Pickup** | Staff updates status to `picked_up`. | Work order marked complete; removed from active tailor queue. |

### 3.2 Messaging Logic
The `MessagingService` correctly identifies the customer and sends a "Ready for Pickup" template.
- **File:** `server/src/logic/messaging.rs`
- **Hook:** `trigger_alteration_ready`

## 4. Identified Gaps & Recommendations

### 4.1 Wedding Manager Friction
> [!WARNING]
> Marking a wedding party member as **"Fitted"** in the Wedding Manager (Party Detail) **does not** automatically create an alteration work order.
- **Impact:** Tailors do not see "Fitted" members in their queue unless a separate record is created in the Alterations Workspace.
- **Recommendation:** Add a prompt in `PartyDetail.jsx` when toggling fitting status: *"Create alteration work order for this member?"*

### 4.2 Customer Hub Accessibility
- **Impact:** Staff must exit the customer profile and navigate to the Alterations Workspace to start orders.
- **Recommendation:** Inject a "Create Alteration" action in the Hub's Profile or Timeline tab.

## 5. Security & Audit
- **Permissions:** Gated by `ALTERATIONS_MANAGE`.
- **Traceability:** Every transition records the `staff_id` of the actor. This is superior to older string-based actor names.

## 6. Conclusion
The Alterations engine is technically solid and reliable for its primary purpose (tailoring queue management). The next phase of development should focus on **Workflow Tightening**—bridging the gap between wedding fittings and the tailor's work queue.
