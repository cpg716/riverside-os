# Audit Report: Staff Tasks (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-25
**Version Audited:** v0.85.5 (commit `e8edc0f4`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of recurring staff task system — template-driven checklist management, lazy materialization (no penalty on days off), period-based deduplication, working-day guard integration, team-wide instance view, history tracking, and notification sweep materialization.

---

## 1. Executive Summary

The Staff Tasks system implements **recurring checklists** with a **lazy materialization** pattern: task instances are only created when a staff member opens their task view (or when the notification sweep runs). This ensures salesperson/sales_support staff are **not penalized for days off** — tasks only materialize on working days. The system supports daily, weekly, monthly, and yearly recurrence with template-driven item checklists.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Data Model
```
task_checklist_template        -- Admin-created template
  → task_checklist_template_item  -- Checklist items (ordered)
  → task_assignment              -- Who gets this template (staff or role)
    → task_instance              -- Materialized for a specific period
      → task_instance_item       -- Checklist items for this instance
```

### 2.2 Recurrence Model
| Recurrence | Period Key | Due Date |
|:---|:---|:---|
| Daily | `2026-05-29` | Same day |
| Weekly | `2026-W22` | End of week (Saturday) |
| Monthly | `2026-05` | Last day of month |
| Yearly | `2026` | December 31 |

### 2.3 Lazy Materialization
```
ensure_task_instances(pool, staff_id)
  → Load store timezone → compute local today
  → Resolve staff role
  → If salesperson/sales_support: check is_working_day()
    → If not working today: return early (no tasks created)
  → Query active assignments for this staff (by staff_id or role)
    → Filter: starts_on <= today, ends_on >= today
  → For each assignment:
    → Compute period_key for today
    → Check if instance already exists (dedup)
    → If not: INSERT task_instance + copy template items
  → All within a transaction
```

### 2.4 Notification Sweep Materialization
```
materialize_due_task_instances_between(pool, from_d, to_d)
  → For each day in range:
    → Query all active assignments × eligible staff
    → Working-day guard (skip non-working salesperson/sales_support)
    → Idempotent insertion: ON CONFLICT DO NOTHING
    → Copy template items to new instances
  → All within a transaction
```

### 2.5 API Endpoints
| Route | Method | Permission | Purpose |
|:---|:---|:---|:---|
| `/tasks/me` | GET | — | My open + recent completed tasks |
| `/tasks/team` | GET | `tasks.view_team` | All staff open tasks |
| `/tasks/history` | GET | `tasks.view_team` | Historical completed tasks |
| `/tasks/{id}` | GET | — | Task detail with checklist items |
| `/tasks/{id}/items/{item_id}` | PATCH | `tasks.complete` | Toggle checklist item done/undone |
| `/tasks/templates` | GET | `tasks.manage` | List templates |
| `/tasks/templates` | POST | `tasks.manage` | Create template |
| `/tasks/assignments` | GET | `tasks.manage` | List assignments |
| `/tasks/assignments` | POST | `tasks.manage` | Create assignment |
| `/tasks/assignments/{id}` | PATCH | `tasks.manage` | Update assignment |
| `/tasks/assignments/{id}/active` | PATCH | `tasks.manage` | Toggle active/inactive |

### 2.6 Task Instance States
| Status | Meaning |
|:---|:---|
| `open` | Active, items pending |
| `completed` | All required items checked |

### 2.7 Permission Model
- `TASKS_VIEW_TEAM`: see team tasks and history
- `TASKS_COMPLETE`: toggle checklist items
- `TASKS_MANAGE`: create/modify templates and assignments

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Lazy materialization | Documented | Verified: working-day guard + dedup | ✅ No regression |
| Recurrence model | Documented | Confirmed: 4 recurrence types with period keys | ✅ No regression |
| Notification sweep | Not documented | Verified: materialize_due_task_instances_between | ✅ New finding |
| Idempotent creation | Not documented | Verified: ON CONFLICT DO NOTHING | ✅ New finding |
| Permission model | Documented | Confirmed: 3-tier (view/complete/manage) | ✅ No regression |

---

## 4. Conclusion

**0 blockers, 0 regressions.** The Staff Tasks system is production-ready with intelligent lazy materialization and proper working-day integration.
