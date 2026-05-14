# Phase 4 Wedding Readiness Walkthrough

Use this harness to create repeatable local certification weddings for the Wedding Manager Readiness dashboard.

Run:

```bash
cd client
npx playwright test e2e/wedding-readiness-walkthrough.spec.ts --project=chromium --workers=1
```

The run creates six parties named `Phase 4 Walkthrough ...`:

- Safe wedding: paid, all open garments ready for pickup.
- Critical NTBO wedding: event is inside the risk window with items still needing vendor order.
- Delayed vendor wedding: ordered item has a past ETA.
- Partial-ready wedding: one item is ready and another remains blocked.
- Balance-blocked pickup wedding: garment is ready, but pickup is blocked by balance due.
- Fully complete wedding: garment has been picked up and no action remains.

After the run, open Wedding Manager -> Readiness and search for `Phase 4 Walkthrough`. Use the status, event-window, and salesperson filters for operator walkthroughs before adding automated wedding-risk alerts.

Expected interpretation:

- Safe should show as safe and ready for pickup.
- Critical NTBO should show the `Needs vendor order` blocker.
- Delayed vendor should show `Vendor delay risk`.
- Partial-ready should show `Partial party readiness`.
- Balance-blocked should show `Pickup blocked until balance is cleared`.
- Fully complete should show complete with no blockers.
