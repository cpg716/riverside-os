---
id: scheduler-workspace
title: "Appointments & Store Calendar"
order: 1100
summary: "Manage fittings, pickups, stylist blocks, and walk-ins. Coordinate store resources and resolve scheduling conflicts."
source: client/src/components/scheduler/SchedulerWorkspace.tsx
last_scanned: 2026-04-17
tags: appointments, calendar, scheduler, fittings, rooms, stylists
---

# Appointments (store calendar)

_Audience: Front desk and managers._

**Where in ROS:** Back Office → **Appointments**. Subsections: **Scheduler**, **Conflicts**.

**Related permissions:** Tab visibility uses **weddings.view** (shared calendar infrastructure).

---

## How to use this area

**Appointments** is the **store schedule**: fittings, pickups, stylist blocks, **walk-ins**. A **wedding party** link is **optional** — many stores book **non-wedding** visits here.

## Scheduler

1. **Appointments** → **Scheduler**.
2. Pick **date** and **resource** (room, chair, stylist).
3. **New** → duration, **type**, **title/notes**.
4. **Customer** search.
5. Optionally link **wedding party** or **member** if the visit is party-related.
6. **Save**; confirm on **week** view.

## Conflicts

1. **Appointments** → **Conflicts**.
2. Review **double-booked** resources or overlapping times.
3. **Drag** or **edit** one booking to a free slot — or split **resources** if two staff can run parallel.
4. Add **note** if conflict was **intentional** (e.g. shared fitting suite with stagger).

## Weddings vs Appointments

| Use Weddings Dashboard for... | Use Appointments Workspace for... |
| :--- | :--- |
| Party milestone tracking | General walk-ins / visits |
| Consultant-focused party dates | Multi-department resource allocation |

## Troubleshooting

| Symptom | Action |
| :--- | :--- |
| **Customer not found** | Try broader search; use the Quick-add profile. |
| **Slot won’t save** | Check minimum duration or blackout periods. |
| **Conflict false positive** | Refresh the screen; check resource definitions. |

**Last reviewed:** 2026-04-17
