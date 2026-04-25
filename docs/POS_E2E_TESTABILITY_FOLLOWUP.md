# POS E2E Testability Follow-up

## Status

Resolved for the quarantined release-blocking POS UI subset.

The POS shell now exposes explicit readiness contracts so browser tests no longer infer register state from transient headings, nav visibility, or cashier-overlay timing:

- `data-testid="pos-shell-root"` with `data-pos-active-tab`, `data-register-open`, and `data-register-session-ready`
- `data-testid="pos-register-panel"` with `data-register-state`
- `data-testid="pos-register-cart-shell"` with `data-sale-hydrated`, `data-cashier-blocked`, and `data-register-ready`
- `data-testid="pos-sale-cashier-overlay"` with `data-roster-ready`, `data-staff-selected`, and `data-pin-entry-ready`

`client/e2e/helpers/openPosRegister.ts` now waits on those contracts before typing PINs, selecting staff, or asserting cart tools. CI no longer sets `ROS_QUARANTINE_UNSTABLE_POS_E2E=1`, so the following specs are release gates again:

- `client/e2e/phase2-tender-ui.spec.ts`
- `client/e2e/pos-golden.spec.ts`
- `client/e2e/tax-exempt-and-stripe-branding.spec.ts`
- `client/e2e/exchange-wizard.spec.ts`
  UI-open test: `opens from cart when register is open`

Latest local evidence:

```bash
E2E_BASE_URL=http://localhost:5173 E2E_API_BASE=http://127.0.0.1:43300 E2E_AUTO_BOOT=0 npm --prefix client run test:e2e -- e2e/pos-golden.spec.ts e2e/phase2-tender-ui.spec.ts e2e/tax-exempt-and-stripe-branding.spec.ts e2e/exchange-wizard.spec.ts --workers=1
```

Result: 6 passed.

The full local release E2E gate also passed after RMS workspace stabilization:

```bash
E2E_BASE_URL=http://localhost:5173 E2E_API_BASE=http://127.0.0.1:43300 E2E_CORECARD_BASE=http://127.0.0.1:43400 E2E_AUTO_BOOT=0 npm run test:e2e:release
```

Result: 154 passed, 16 skipped, 0 failed.

## Residual Guidance

Keep future POS browser specs aligned to the explicit contracts above. Avoid adding new helpers that infer readiness from broad text, transient loading copy, or nav-only visibility.
