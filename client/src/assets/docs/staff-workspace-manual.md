---
id: staff-workspace
title: "Staff Workspace (staff)"
order: 1110
summary: "Auto-generated stub for client/src/components/staff/StaffWorkspace.tsx — replace with staff-facing help."
source: client/src/components/staff/StaffWorkspace.tsx
last_scanned: 2026-04-11
tags: staff-workspace, component, auto-scaffold
---

# Staff Workspace (staff)

<!-- help:component-source -->
_Linked component: `client/src/components/staff/StaffWorkspace.tsx`._
<!-- /help:component-source -->

# Staff Workspace (Team)

The Team workspace is used to manage the staff roster, commission rates, and access permissions.

## Profile Layout
The staff profile is organized into two columns:
- **Left Column**: Identity information (Full Name, Avatar), Employment dates, and **PIN / Code**.
- **Right Column**: Commissions (Base and Category-specific), Staff Role, and detailed Access Permissions.

## Managing PINs
Riverside OS uses a **Unified PIN** system. A staff member's 4-digit code is both their identity badge and their password.
- **Setting a PIN**: Type exactly 4 digits into the PIN/Code field.
- **Syncing PINs**: If a staff member is locked out, re-typing their code and clicking **Save Changes** will force a security hash resubmission.

## Roles & Permissions
- **Admin**: Full system access.
- **Salesperson**: Access to POS, Appointments, and standard Customer CRM.
- **Sales Support**: Access to inventory and operations without financial checkout permissions.

> [!TIP]
> Use the "Apply Role Defaults" button to quickly reset a staff member's permissions to the system standard for their role.

