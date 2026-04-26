# Staff (Back Office)

**Audience:** Store admins and leads.

**Where in ROS:** Back Office → **Staff**. Sidebar subsections: **Team**, **Tasks**, **Schedule**, **Commissions**, **Audit**. **Store-wide defaults** for role permissions and role discount caps: **Settings → Staff access defaults** (`settings.admin` **or** `staff.manage_access`).

**Related permissions:** **staff.view** opens the tab. Subsections add **tasks.complete** / **tasks.manage**, **staff.manage_access**, **staff.manage_pins**, **staff.manage_commission**, **staff.view_audit**, etc. (see [../STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md)).

---

## How to use this area

Use **Staff** for **people** (roster, PIN on profile, per-person access, per-person discount cap, linked employee customer, employment dates). Use **Settings → Staff access defaults** when changing **template** matrices or **template** discount caps — those templates power **Apply role defaults** on each person’s profile.

---

## Team

**Purpose:** People records tied to sign-in and the register.

1. **Staff** → **Team**.
2. **Add Staff:** Click **+ Add Staff** in the header (requires **staff.manage**).
3. **Initial Setup:** Provide a **Full Name** and a **4-digit Staff Code**.
4. **Initial PIN:** The system defaults the person's initial PIN to match their **Staff Code**. They can change it later via the **Edit profile** sidebar or via an admin reset.
5. **Role Defaults:** Selecting a role (e.g., Salesperson) automatically applies the default permissions and discount caps defined in **Settings**.
6. **Edit profile:** Open **Edit** on a person to modify **name**, **role**, active flag, **commission %**, **discount caps**, **linked CRM profile**, etc.
7. **Access (this person):** with **staff.manage_access**, toggle keys; **Apply role defaults** copies **Settings** templates for that person’s **role**. **Save** persists profile and permission changes.
8. **PIN:** with **staff.manage_pins**, enter a new PIN in the modal (**must match** that person’s four-digit cashier code).
9. **Deactivate** leavers instead of deleting — preserves **audit** history.

## Tasks

**Purpose:** Recurring **checklist templates** and **assignments** (not the same screen as POS **My tasks**, but it configures what appears there).

1. **Staff** → **Tasks** (sidebar subsection requires **tasks.complete**; inside the panel, **tasks.manage** is required to edit **templates** and assignments).
2. **Templates:** define recurring steps (open, close, compliance).
3. **Assignments:** map templates to roles or people.
4. **Team board:** monitor open instances (**tasks.view_team** where applicable).

Floor staff complete items in **POS → Tasks** or Operations widgets — see [pos-tasks.md](pos-tasks.md).

## Schedule

**Purpose:** Weekly pattern + **exceptions** (call-offs, extra coverage).

1. **Staff** → **Schedule**.
2. Edit **weekly** grid per person.
3. Add **exception** rows for single days.
4. Confirm **Operations → Dashboard** shows **today’s floor team** when your build wires it (see [../STAFF_SCHEDULE_AND_CALENDAR.md](../STAFF_SCHEDULE_AND_CALENDAR.md)).

## Store defaults (Settings)

**Purpose:** **Template** permission matrix and **template** discount caps per **role**.

1. **Settings** → **Staff access defaults** (requires **`settings.admin`** **or** **`staff.manage_access`**).
2. Edit **Role permissions** and **Role discount caps** deliberately; document broad changes in the store log.
3. **Admin** accounts still receive the **full** permission catalog in software — template rows do not restrict admins.

## Commissions

**Purpose:** One hub for commission reporting and fixed incentives.

1. **Staff** → **Commissions**.
2. **Reports** (**insights.view**): review fulfillment-based earned commission and prior-month windows.
3. **SPIFFs & Combos** (**staff.manage_commission**): configure fixed-dollar SPIFF incentives and combo rewards.
4. Staff base commission rates are edited on the Staff Profile with an effective start date.
5. SPIFF and combo reward lines remain filtered from customer receipts for privacy.

## Audit

**Purpose:** **Access** and sensitive action logs (**staff.view_audit**).

1. **Staff** → **Audit**.
2. Filter by **staff**, **action**, **date** if available.
3. Export only on **approved** machines for **HR** or **legal** requests.

---

## Register shift primary / handoff

**Shift handoff** updates who is “on” the register for tasks and notifications **without** closing the drawer. See [../STAFF_TASKS_AND_REGISTER_SHIFT.md](../STAFF_TASKS_AND_REGISTER_SHIFT.md).

## Helping a coworker

- **“I lost my permissions”** → **Staff → Team** → edit their profile → **Access** checklist (or **Apply role defaults** then add keys). Confirm **Settings** templates if many people are wrong at once.
- **“Tasks disappeared”** → Lazy materialization: open **My tasks** once; verify **assignments** on **Staff → Tasks**.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Cannot sign in | **Code** + **PIN** | **Edit staff** → PIN (**staff.manage_pins**) |
| Change no effect | User **refresh** / re-sign-in | Re-check **Access** on their profile |
| Schedule wrong day | **Timezone** in **Settings → General** | [STAFF_SCHEDULE_AND_CALENDAR.md](../STAFF_SCHEDULE_AND_CALENDAR.md) |
| Tasks not generating | Open **My tasks** once | **Staff → Tasks** templates |

## When to get a manager / owner

- **HR**, harassment, or **termination** access removal.
- **Legal hold** on **audit** exports.

---

## See also

- [../STAFF_PERMISSIONS.md](../STAFF_PERMISSIONS.md)
- [../STAFF_TASKS_AND_REGISTER_SHIFT.md](../STAFF_TASKS_AND_REGISTER_SHIFT.md)
- [../STAFF_SCHEDULE_AND_CALENDAR.md](../STAFF_SCHEDULE_AND_CALENDAR.md)
- [pos-tasks.md](pos-tasks.md)

**Last reviewed:** 2026-04-07
