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
2. Pick the **date**, then choose a 15-minute time slot or **New Appt**.
3. Set the duration, type, optional room/resource, staff member, and notes.
4. Search for a Customer, or type a name or phone for a one-off visit. Use a Customer record when messages and Customer history are needed.
5. Optionally link **wedding party** or **member** if the visit is party-related.
6. **Save** and confirm the booking appears in Day or Week view.

When a selected day has no appointments, the Scheduler says so above the time grid. Select **New Appointment** there or choose any time slot below; an empty grid is not a loading result.

**Privacy:** Do not announce **full** customer names across the lobby if policy restricts it.

## Conflicts

1. **Appointments** → **Conflicts**.
2. Review **double-booked** resources or overlapping times.
3. Open a conflict and edit one booking to a free slot, change the assigned resource, or increase a real shared resource's capacity when operationally correct.
4. An intentional overlap requires Manager Access and a written reason. ROS keeps that override in the audit history.
5. Managers can add or edit rooms/resources in this subsection. Capacity is the number of simultaneous Scheduled appointments allowed to reserve that resource.

## Weddings vs Appointments

| Use **Weddings → Calendar** for… | Use **Appointments → Scheduler** for… |
|----------------------------------|----------------------------------------|
| Party milestone thinking | Anyone walking in |
| Consultant-focused party dates | Multi-department store calendar |

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Customer not found | Search name, phone, or Customer # | Create the Customer first, or use a one-off name/phone when no Customer history or messages are needed |
| Slot won’t save | Check the staff schedule, duration, and resource overlap message | Choose another slot; use Manager Access only for an intentional, documented exception |
| Wrong timezone | **Receipt / store** timezone | Settings → General |
| Conflict looks wrong | Open the conflicting appointment and compare its full start/end time | Check the resource capacity and assigned staff before escalating |

## Helping a coworker

- Confirm the Customer name, appointment type, and local date/time from the confirmation before opening the exact booking in Search.

## When to get a manager

- **No-show** fees or **cancellation** policy disputes.
- **Bulk** reschedule (weather, venue change).

---

## See also

- [weddings-back-office.md](weddings-back-office.md)
- [../APPOINTMENTS_AND_CALENDAR.md](../APPOINTMENTS_AND_CALENDAR.md)

**Last reviewed:** 2026-08-10
