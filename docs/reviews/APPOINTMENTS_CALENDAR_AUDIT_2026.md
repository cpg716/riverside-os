# Audit Report: Appointments & Scheduler Subsystem (2026)
**Date:** 2026-04-08
**Status:** Highly Robust / Unified

## 1. Executive Summary
The Appointments system in Riverside OS is a unified scheduling engine that bridges the Back Office store calendar with the specialized wedding party workflows. It leverages a single source of truth in PostgreSQL (`wedding_appointments`) and features deep integration with the Staff Roster and the Customer Relationship Hub.

## 2. Technical Architecture

### 2.1 Unified Data Store
- **Table**: `wedding_appointments` serves both general retail customers and wedding party members.
- **Linkage Logic**: Supports three levels of customer identification:
    1. **Anonymous / One-off**: Name and phone only.
    2. **CRM Customer**: `customer_id` link for timeline history.
    3. **Wedding Member**: `wedding_member_id` link for workflow status automation.

### 2.2 Unification of Rosters
- **Staff Logic**: Appointments are tied to a `salesperson` string. The system resolves this against active `staff` records with roles `salesperson` or `sales_support`.
- **Availability Validation**: `ensure_salesperson_booking_allowed` checks the staff’s weekly schedule and day exceptions (PTO/Sick) before allowing a booking or edit.

## 3. Key Features & Workflows

### 3.1 Smart Status Synchronization
- **Workflow Awareness**: When an appointment of type `Measurement`, `Fitting`, or `Pickup` is marked as **Attended**, the UI prompts staff to automatically sync the corresponding flag on the wedding member’s record.

### 3.2 Staff Absences & Reassignment
- **Absence Impact**: Includes a sophisticated engine (`mark_absence_and_handle_appointments`).
- **Automation**: When a staff member records sick leave or PTO, the system can:
    1. **Cancel** unfulfilled daily tasks for that day.
    2. **Unassign** or **Reassign** all scheduled appointments to another working teammate.

### 3.3 Live Refresh & Performance
- **SSE Integration**: The Wedding Manager uses Server-Sent Events (SSE) for instantaneous UI updates across clients.
- **Polling**: The Back Office scheduler uses a 60-second poll fallback.

## 4. UI/UX Analysis
- **Back Office Scheduler**: A premium, high-density day/week grid with localized date picking and print-ready CSS.
- **Wedding Manager Modal**: Embedded React component that handles wedding-centric copies and conflict-checking pulses.

## 5. Security & RBAC
- **`WEDDINGS_VIEW`**: Required for reading appointment lists.
- **`WEDDINGS_MANAGE`**: Required for creating/editing bookings.

## 6. Conclusion
The Appointments system is a mature, highly integrated subsystem that successfully handles the complexity of store-wide scheduling while maintaining specialized hooks for the wedding retail lifecycle.
