# Audit Report: Staff Workspace & Scheduling (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-25
**Version Audited:** v0.85.5 (commit `e8edc0f4`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of staff scheduling — weekly availability templates, per-week published schedules, day-level exceptions (absence/override), working-day resolution via PostgreSQL function, floor staff listing with shift labels, absence management with appointment reassignment, and eligibility queries.

---

## 1. Executive Summary

The Staff Workspace provides a **multi-layer scheduling system**: base weekly availability templates, per-week published schedules (with draft/published status), and day-level exceptions for absences, days off, or shift overrides. The **authoritative working-day determination** is the PostgreSQL function `staff_effective_working_day(staff_id, date)`, called by both the task materialization and appointment booking systems. The system supports **bulk schedule publishing** for manager-level workflow.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Schedule Layer Hierarchy
```
Layer 1: staff_weekly_availability  (base template — recurring defaults)
Layer 2: staff_weekly_schedule      (per-week instance — draft/published)
         staff_weekly_schedule_day  (per-day override within a week instance)
Layer 3: staff_day_exception        (single-day override — absence, shift change)

Resolution: Exception > Weekly Schedule Day > Weekly Availability > Default
```

### 2.2 Working Day Resolution
```sql
staff_effective_working_day(staff_id, date) → boolean
```
This PostgreSQL function is the **single source of truth** consumed by:
- Task materialization (skip tasks on days off)
- Appointment booking (prevent booking absent staff)
- Floor staff dashboard (who's working today)

### 2.3 Floor Staff Query
```sql
SELECT s.id, s.full_name, s.role, s.avatar_key,
       CASE 
         WHEN e.id IS NULL THEN COALESCE(swd.shift_label, swa.shift_label)
         ELSE e.shift_label
       END as shift_label
FROM staff s
LEFT JOIN staff_weekly_availability swa ON ...
LEFT JOIN staff_weekly_schedule sws ON ... (published only)
LEFT JOIN staff_weekly_schedule_day swd ON ...
LEFT JOIN staff_day_exception e ON ...
WHERE s.is_active = TRUE
  AND s.role IN ('admin', 'salesperson', 'sales_support', 'staff_support', 'alterations')
  AND staff_effective_working_day(s.id, date)
ORDER BY role priority, full_name
```

### 2.4 API Endpoints
| Route | Method | Permission | Purpose |
|:---|:---|:---|:---|
| `/schedule/range` | GET | `staff.view` | Schedule grid for date range |
| `/schedule/weekly` | PUT | `staff.manage_access` | Set weekly availability |
| `/schedule/weekly/bulk` | PUT | `staff.manage_access` | Bulk publish weekly schedules |
| `/schedule/exception` | POST | `staff.manage_access` | Add day exception |
| `/schedule/exception` | DELETE | `staff.manage_access` | Remove day exception |
| `/schedule/mark-absence` | POST | `staff.manage_access` | Mark absence + optional appointment reassignment |
| `/schedule/eligible-staff` | GET | `staff.view` | Schedulable staff list |
| `/schedule/floor-today` | GET | `weddings.view` | Who's working today |
| `/schedule/floor-date` | GET | `staff.view` | Who's working on a specific date |

### 2.5 Absence Management
```
mark_absence(pool, staff_id, absence_date, kind, ...)
  → Insert/update staff_day_exception (kind = absence_day/day_off/shift_override)
  → If unassign_appointments: clear salesperson from appointments on that date
  → If reassign_to_staff_id: reassign appointments to another staff member
  → Returns: MarkAbsenceResult (exception_id, appointments_unassigned, appointments_reassigned)
```

### 2.6 Exception Types
| Kind | Purpose |
|:---|:---|
| `absence_day` | Staff is absent (sick, emergency) |
| `day_off` | Planned day off |
| `shift_override` | Working different shift than scheduled |

### 2.7 Week Start Convention
All schedule calculations use **Sunday as week start** via `force_sunday_start(date)`:
```rust
fn force_sunday_start(d: NaiveDate) -> NaiveDate {
    let weekday = d.weekday().num_days_from_sunday();
    d - Duration::days(weekday)
}
```

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Multi-layer schedule | Documented | Verified: 3-layer with DB function resolution | ✅ No regression |
| Working-day function | Not documented | Verified: single source of truth for tasks + appointments | ✅ New finding |
| Absence management | Not documented | Verified: exception + appointment reassignment | ✅ New finding |
| Bulk schedule publish | Not documented | Verified: bulk PUT with draft/published status | ✅ New finding |
| Floor staff dashboard | Documented | Confirmed: role-prioritized with shift labels | ✅ No regression |
| Sunday week start | Not documented | Verified: force_sunday_start convention | ✅ New finding |

---

## 4. Conclusion

**0 blockers, 0 regressions.** The staff scheduling system is production-ready with a clear layer hierarchy, single-source working-day resolution, and comprehensive absence management.
