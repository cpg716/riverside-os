# POS Tasks

**Audience:** Floor staff with checklist tasks.

**Where in ROS:** POS mode → left rail **Tasks**.

**Related permissions:** **tasks.complete** for your own checklist. Template editing is **Staff → Tasks** with **tasks.manage**.

---

## How to use this screen

**Tasks** lists **open checklist instances** assigned to **you** (from recurring templates). It is not a general memo pad — each row should map to a **defined** SOP step.

## Common tasks

### Start of shift

1. POS → **Tasks**.
2. Open the first **due** item.
3. Check boxes **in order**; add **notes** if the template asks (e.g. “rack temp logged”).
4. **Complete** the instance; confirm toast.

### If you cannot finish today

1. Leave item **open** and add a **note** with **why** and **who** you told.
2. Do not **complete** falsely — managers use history for compliance.

### Find what a vague task means

1. Read the **template title** and **description** in the drawer.
2. Ask a lead — task text is configured by admin; you cannot edit it here.

## Helping a coworker

- You **cannot** complete **their** list unless your role allows **complete on behalf** — if you do it anyway under shared login, **audit** blurs. Prefer **handoff** on register instead.

## Common issues and fixes

| Symptom | What to try first | If that fails |
|--------|-------------------|---------------|
| Empty list but manager says you have tasks | **Lazy** materialization — wait until day starts | Open **Staff → Tasks** (manager) |
| Checkbox won’t stick | Slow network; wait | Retry; if 403, permission |
| Duplicate tasks | Manager fixes **assignment** rules | [STAFF_TASKS_AND_REGISTER_SHIFT.md](../STAFF_TASKS_AND_REGISTER_SHIFT.md) |
| Wrong tasks after cover shift | **Shift primary** identity | Handoff doc |

## When to get a manager

- Tasks that ask you to **move money** or **open safe** without dual control.
- **Safety** hazards (wet floor, broken glass) — task note + verbal escalation.

---

## See also

- [staff-administration.md](staff-administration.md)
- [../STAFF_TASKS_AND_REGISTER_SHIFT.md](../STAFF_TASKS_AND_REGISTER_SHIFT.md)

**Last reviewed:** 2026-04-04
