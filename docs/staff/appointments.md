# Appointments (store calendar)

## Wedding appointment integration

- Select the ROS staff record, not only a typed salesperson name. This preserves schedule validation and attribution.
- If a conflict is shown, enter the operational reason. The server requires Manager Access and records the staff ID, reason, warning, and appointment.
- Marking a linked Measurement or Fitting appointment Attended completes the matching wedding-member milestone in the same transaction.
- Marking a Pickup appointment Attended does **not** mark merchandise picked up. Complete pickup in Orders/Register.

**Audience:** Front desk and managers.

**Where in ROS:** Back Office → **Appointments**. Subsections: **Scheduler**, **Conflicts**.

**Related permissions:** Tab visibility uses **weddings.view** (shared calendar infrastructure).

---

## How to use this area

**Appointments** is the **store schedule**: fittings, pickups, stylist blocks, **walk-ins**. A **wedding party** link is **optional** — many stores book **non-wedding** visits here.

## Scheduler

1. **Appointments** → **Scheduler**.
2. Pick **date** and **resource** (room, chair, stylist) per UI.
3. **New** → duration, **type**, **title/notes**.
4. **Customer** search — use **Load more**; minimum character rules apply on some searches.
5. Optionally link **wedding party** or **member** if the visit is party-related.
6. **Save**; confirm on **week** view.

When a selected day has no appointments, the Scheduler says so above the time grid. Select **New Appointment** there or choose any time slot below; an empty grid is not a loading result.

**Privacy:** Do not announce **full** customer names across the lobby if policy restricts it.

## Conflicts

1. **Appointments** → **Conflicts**.
2. Review **double-booked** resources or overlapping times.
3. **Drag** or **edit** one booking to a free slot — or split **resources** if two staff can run parallel.
4. Add **note** if conflict was **intentional** (e.g. shared fitting suite with stagger).

## Weddings vs Appointments

| Use **Weddings → Calendar** for… | Use **Appointments → Scheduler** for… |
|----------------------------------|----------------------------------------|
| Party milestone thinking | Anyone walking in |
| Consultant-focused party dates | Multi-department store calendar |

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Customer not found | Broader search; **Load more** | Quick-add profile first |
| Slot won’t save | **Min duration**; **blackout** | Manager |
| Wrong timezone | **Receipt / store** timezone | Settings → General |
| Conflict false positive | **Refresh** | Check **resource** definition |

## Helping a coworker

- Read **appointment ID** or **time + room** from confirmation email when customer shows phone.

## When to get a manager

- **No-show** fees or **cancellation** policy disputes.
- **Bulk** reschedule (weather, venue change).

---

## See also

- [weddings-back-office.md](weddings-back-office.md)
- [../APPOINTMENTS_AND_CALENDAR.md](../APPOINTMENTS_AND_CALENDAR.md)

**Last reviewed:** 2026-07-26
