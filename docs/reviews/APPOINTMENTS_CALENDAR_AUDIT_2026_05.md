# Audit Report: Appointments & Calendar (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-25
**Version Audited:** v0.85.5 (commit `cac08918`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of the wedding appointment subsystem — CRUD lifecycle, staff scheduling guard (working-day validation), appointment confirmation emails, Meilisearch indexing, SSE event broadcast, and filtered listing.

---

## 1. Executive Summary

Appointments are managed within the Wedding Manager module (`wedding_appointments` table). The system enforces **salesperson schedule validation** on create — if a named salesperson is matched to a roster staff member, the system verifies they are scheduled to work on the appointment date before allowing booking. Appointment creation triggers async confirmation email, Meilisearch upsert, and SSE broadcast to all connected clients.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Endpoints
| Route | Method | Purpose |
|:---|:---|:---|
| `/appointments` | GET | List appointments (filtered by date range) |
| `/appointments` | POST | Create appointment |
| `/appointments/search` | GET | Search appointments |
| `/appointments/{id}` | GET | Get single appointment |
| `/appointments/{id}` | PATCH | Update appointment |
| `/appointments/{id}` | DELETE | Delete appointment |

All mutations require `WEDDINGS_MUTATE` permission.

### 2.2 Create Appointment Flow
```
POST /appointments
  → require_weddings_mutate
  → Resolve wedding member (if wedding_member_id provided)
  → Validate: must have wedding member OR customer_display_name OR phone
  → Default appointment_type = "Measurement", status = "Scheduled"
  → ensure_salesperson_booking_allowed(salesperson, starts_at)
    → Resolve staff by case-insensitive name match
    → Check staff_effective_working_day(staff_id, date)
    → Reject if staff not scheduled (with descriptive error)
  → INSERT INTO wedding_appointments
  → Async: trigger_appointment_confirmation (email)
  → Async: SSE broadcast (appointments_updated)
  → Async: Meilisearch upsert_appointment_document
```

### 2.3 Salesperson Schedule Guard
```rust
ensure_salesperson_booking_allowed(pool, salesperson, starts_at)
  → If salesperson name empty → allow (unassigned)
  → resolve_floor_staff_id_by_name (case-insensitive, trimmed)
    → If no match → allow (legacy free-text salesperson)
    → If match → check is_working_day(pool, staff_id, date)
      → Calls PostgreSQL function: staff_effective_working_day(staff_id, date)
      → If not working → reject with message:
        "{name} is not scheduled to work on {date} (store calendar). Choose another..."
```

### 2.4 Absence Management Integration
When marking a staff absence, the schedule API supports:
- `unassign_appointments`: clear salesperson from same-day appointments
- `reassign_to_staff_id`: reassign appointments to another staff member

### 2.5 Side Effects on Create/Update
1. **Email confirmation**: `MessagingService::trigger_appointment_confirmation` (async, failure logged but doesn't block response)
2. **SSE broadcast**: `wedding_events.appointments_updated()` pushes to all connected clients
3. **Meilisearch indexing**: `spawn_meilisearch_appointment_upsert()` for fuzzy search

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| CRUD lifecycle | Documented | Verified: full CRUD with permission gate | ✅ No regression |
| Schedule guard | Not documented | Verified: working-day validation via DB function | ✅ New finding |
| Email confirmation | Not documented | Verified: async trigger on create | ✅ New finding |
| Absence reassignment | Not documented | Verified: unassign/reassign on staff absence | ✅ New finding |
| SSE broadcast | Documented | Confirmed: appointments_updated event | ✅ No regression |

---

## 4. Conclusion

**0 blockers, 0 regressions.** The appointment system is production-ready with proper schedule validation and multi-channel side effects.
