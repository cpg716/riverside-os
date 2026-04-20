# POS E2E Testability Follow-up

## Temporary CI containment

The GitHub Actions Playwright workflow currently sets:

```bash
ROS_QUARANTINE_UNSTABLE_POS_E2E=1
```

That flag temporarily quarantines the order-dependent POS UI specs that still rely on unstable shared helper behavior in `client/e2e/helpers/openPosRegister.ts`.

Quarantined in CI:

- `client/e2e/phase2-tender-ui.spec.ts`
- `client/e2e/pos-golden.spec.ts`
- `client/e2e/tax-exempt-and-stripe-branding.spec.ts`
- `client/e2e/exchange-wizard.spec.ts`
  UI-only test: `opens from cart when register is open`

Still required in CI:

- `client/e2e/exchange-wizard.spec.ts`
  API parity test: `returned quantity stays in sync across totals, refund queue, and receipt output`
- all non-quarantined Playwright/API suites

## Why the quarantine exists

The unstable subset shares one problem family:

- `openPosRegister.ts` still has to guess at register readiness from multiple transient UI states
- the POS sale cashier overlay is a real blocking state, but the helper still has to infer when it is fully actionable
- dashboard/register navigation can expose visible POS chrome before the mounted register body is durably interactive

The result is repeated-run and order-dependent failures that do not cleanly distinguish:

- real product bugs
- cashier overlay blocking
- register body mounting
- helper re-entry drift

## Required redesign for deterministic POS testability

### 1. Explicit register-ready contract

Expose a durable register-ready signal that means all of the following are true:

- POS shell is active
- Register is the committed active POS tab
- Register body is mounted
- cart/customer pane is mounted
- register actions are interactive

The helper should wait on that signal instead of composing ad hoc visibility guesses.

### 2. Explicit cashier-overlay blocking contract

Expose a durable blocking signal for the POS sale cashier overlay:

- overlay mounted
- staff roster ready
- selection committed
- PIN entry enabled

The helper should treat this as the primary blocking state until it is explicitly cleared.

### 3. Explicit dashboard/register mounted-body contract

Make the mounted POS body independently observable from nav state:

- dashboard mounted
- register mounted
- overlay-only register state

This should remove ambiguity where POS nav shows `Register` but the mounted body is dashboard, launchpad, or absent.

### 4. Reduced helper guesswork in `openPosRegister.ts`

After the product/testability contracts exist, simplify the helper so it only:

- enters POS
- waits for the explicit mounted-body contract
- resolves the explicit cashier-overlay contract when present
- proceeds once the explicit register-ready contract is true

The helper should stop:

- inferring readiness from mixed text/heading/button combinations
- bouncing back into broad POS re-entry while a blocking overlay is already present
- relying on transient selector labels or dropdown text to infer selection state
