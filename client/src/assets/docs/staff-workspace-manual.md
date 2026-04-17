---
id: staff-workspace
title: "Staff & Team Administration"
order: 1110
summary: "Manage the store roster, set access permissions, configure PINs and discount caps, and oversee commission payouts."
source: client/src/components/staff/StaffWorkspace.tsx
last_scanned: 2026-04-17
tags: staff, team, permissions, pins, commission, scheduling, tasks, audit
---

# Staff & Team (Back Office)

_Audience: Store admins and leads._

**Where in ROS:** Back Office → **Staff**. Sidebar subsections: **Team**, **Tasks**, **Schedule**, **Commission**, **Commission payouts**, **Audit**. 

---

## How to use this area

Use the **Staff** workspace for **people management** (roster, PINs, per-person access, linked employee profiles, and employment status). **Store-wide templates** for roles and discount caps are configured under **Settings → Staff access defaults**.

## Team Roster

1. **Staff** → **Team**.
2. **Add Staff**: Requires `staff.manage`. Provide a **Full Name** and a **4-digit Staff Code**.
3. **Initial PIN**: Automatically defaults to the **Staff Code**.
4. **Role Defaults**: Selecting a role (e.g., Salesperson) applies the default permissions and discount caps defined in Settings.
5. **Edit Profile**: Modify commission %, discount caps, and linked CRM profiles.
6. **PIN Management**: Use the PIN modal (`staff.manage_pins`) to reset or change security codes.
7. **Deactivate**: Always deactivate leavers instead of deleting into order to preserve **audit** history.

## Task Management

**Purpose**: Configure **checklist templates** and assignments for POS staff.
1. **Staff** → **Tasks**. 
2. **Templates**: Define recurring opening, closing, and compliance steps.
3. **Assignments**: Map templates to specific roles or people.
4. **Team Board**: Monitor the real-time completion status of assigned tasks.

## Schedule & Attendance

1. **Staff** → **Schedule**.
2. Edit the **weekly recurring grid** for the team.
3. Add **exception rows** for single-day changes like call-offs or extra coverage.
4. Verify the **Operations Dashboard** reflects the correct "Floor Team" for today.

## Commission Manager

1. **Staff** → **Commission**.
2. **Category Overrides**: Set base commission percentages for specific inventory categories.
3. **SPIFF Engine**: Assign dollar-amount rewards for high-priority SKUs.
4. **Combo Matching**: Configure multi-item rewards (e.g., Suit + Shirt + Tie).
5. **Payouts**: Review the unpaid ledger and use **Finalize Payout** to mark earnings as paid.

## Audit Logs

1. **Staff** → **Audit**.
2. Access point-in-time logs for sensitive actions (price overrides, voids, permission changes).
3. Filter by **staff**, **action**, or **date**. Exporting logs requires authorized administrative access.

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| **Cannot sign in** | Verify the Staff Code + PIN combination; check if the profile is "Active". |
| **Permissions not updating** | Staff must refresh their browser or sign out/in for changes to take effect. |
| **Tasks not generating** | Ensure the **Staff → Tasks** template is assigned to the correct role. |

**Last reviewed:** 2026-04-17
