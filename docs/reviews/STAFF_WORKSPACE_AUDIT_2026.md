# Audit Report: Staff Workspace & HR Subsystems (2026)
**Date:** 2026-04-08
**Status:** Highly Robust / Operationally Mature

## 1. Executive Summary
The Staff Workspace is the operational "Control Center" for store human resources. It integrates personnel management, financial incentives (commissions), physical floor scheduling, and recurring operational checklists into a unified, secure interface.

## 2. Component Analysis

### 2.1 Access Control & Security
- **Unlock Gate**: Locked behind a dedicated PIN keypad. Staff must enter their 4-digit cashier code to unlock.
- **Hierarchical RBAC**: Uses Role-Based Access Control supplemented by **Individual Permission Overrides**.
- **Audit Logging**: Every sensitive action (login, override, commission change, payout) is recorded in the `staff_access_log`.

### 2.2 Staff Roster & Performance (`StaffWorkspace.tsx`)
- **Bio & Contact**: Centralized management of staff avatars, phone, email, and employment dates.
- **Financial Performance**: Real-time sales-MTD tracking is surfaced directly in the roster cards.
- **Employee Link**: Staff accounts can be linked to CRM customer profiles (employee discounting).

### 2.3 Commission Engine (`staff.rs`)
- **Dual-Layer Rates**:
  - **Base Rate**: Default percentage assigned to the staff member.
  - **Category Overrides**: Allows store to set higher/lower commissions for specific product categories.
- **Attribution Logic**: sales are attributed to the `primary_salesperson_id` at checkout.

### 2.4 Floor Scheduling & Attendance (`StaffSchedulePanel.tsx`)
- **Absence Management**: Marking a staff member as "Sick" or "PTO" automatically:
  - Updates floor team availability.
  - Optionally **unassigns or reassigns** current-day appointments.
  - Cancels assigned **Daily Tasks** for that day.

### 2.5 Operational Tasks (`StaffTasksPanel.tsx`)
- **Template-Based Checklists**: Managers create reusable templates (e.g., "End of Day Cash Count").
- **Dynamic Assignment**: Tasks can be assigned to individual staff or to a **Role**.
- **Traceability**: The history view provides a clear record of who completed which checklist.

### 2.6 Field Inventory Overview (Bug Reports)
- **Zero-Barrier Reporting**: Staff can trigger a "Bug Report" directly from the POS or Back Office.
- **Contextual Payload**: Reports include a screenshot, client console logs, and a **server-side log snapshot**.

## 3. Findings & Recommendations

### ✅ Strengths
- **Tight Integration**: The link between Scheduling, Appointments, and Tasks is exceptionally well-handled.
- **Audit Detail**: The "Audit" tab provides transparency critical for inventory and financial reconciliation.

### ⚠️ Recommendations
- **Commission Payouts Export**: A CSV export for external payroll providers (ADP/Gusto) would be a valuable addition.
- **Shift Reminders**: Integrate the schedule with the **Notification Center** to alert staff 30 minutes before their shift.

## 4. Final Verdict
The Staff Workspace is a **mature, operationally-aware subsystem**. It goes beyond simple user management by incorporating the "lived reality" of retail (sick days, commissions, and standard operating procedures).
