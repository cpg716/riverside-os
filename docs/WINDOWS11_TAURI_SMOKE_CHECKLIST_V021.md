# Windows 11 Tauri Smoke Checklist (v0.2.1)

**Purpose:** Fast, repeatable release validation for the Windows 11 Register desktop app with explicit coverage of v0.2.1 auth/identity hardening.

**Applies to:** Tauri desktop register workflow on the **MAIN REGISTER** machine only (not the dedicated host machine, and not PWA browser flow).

**Target runtime:** Windows 11 register station with the latest installer artifact from GitHub Actions (`tauri-register-build.yml`).

---

## 1) Pre-flight

- Confirm latest Windows workflow run succeeded and artifact exists:
  - Workflow: **Tauri register (Windows)**
  - Artifact: `tauri-windows-bundle`
- Install/upgrade on a test register PC (or clean VM) using the latest artifact.
- Ensure API is reachable from the register PC and staff test users are available.
- Confirm this station is being validated as the **MAIN REGISTER**, not as the dedicated **HOST machine**.

---

## 1.5) Register-role boundary check (required)

- Verify this Windows station is **not** the machine staff are using for **Shop Host** in Settings → Remote Access.
- Verify any API host override on this station points to the dedicated **HOST machine** (or the store's production API origin), not to itself unless that is the actual deployment design.
- Verify operators understand this checklist covers the cashier/register runtime only. Host smoke is a separate validation path.

---

## 2) v0.2.1 hardening checks (required)

### 2.1 Unified auth guard

- Launch app from a signed-out state.
- Verify entry is always through **BackofficeSignInGate** (no shell chrome before sign-in).
- Sign in with Staff A.
- Trigger **Logout**.
- Verify global return to sign-in gate and persona clearance.
- Sign in with Staff A again.
- Trigger **Change Staff Member**.
- Verify global return to sign-in gate and persona clearance.

### 2.2 Staff identity prioritization

- Open a register session where till opener/cashier context differs from signed-in staff.
- Verify top bar/sidebar identity reflects authenticated staff (`staffDisplayName`) rather than register owner/cashier session name.
- Navigate POS/Back Office/Insights shells and verify identity remains the authenticated staff persona throughout.

### 2.3 POS settings restriction

- Enter POS mode and open Settings navigation.
- Verify only these settings entries are available:
  - **Staff Profile**
  - **Printers & Scanners**
- Verify sensitive admin settings are not exposed in POS mode.

### 2.4 Hardware accessibility in POS

- From POS mode, open **Printers & Scanners**.
- Validate device visibility/config access is available.
- Run one print action (receipt or test print) and confirm successful dispatch.

---

## 3) Core register sanity checks (required)

- Launch app and verify the window opens maximized on Windows 11 (not in a cramped 800x600-style shell).
- Open the Register Access screen and verify **Station Readiness** clearly reports API reachability and receipt-printer status before the terminal opens.
- Open register and attach/start session normally.
- Add at least one line item and confirm search/cart behavior is healthy.
- Return to the register after changing tabs or alt-tabbing away and verify **Focus /**, or the **/** keyboard shortcut, restores product-search readiness for scanner use.
- Open checkout and complete one standard sale.
- Confirm receipt flow completes without runtime errors.
- Simulate or force one receipt-printer failure and verify the UI clearly says the sale succeeded while printing failed, with visible **Retry** and **Check station printer** recovery actions.
- Use **Park Sale** and verify the station shows the in-app Riverside label prompt instead of a browser dialog.
- Verify no browser-native dialogs (`alert/confirm/prompt`) appear.

---

## 4) Evidence capture

- Record:
  - Workflow run URL
  - Installer build/version (and git SHA if shown)
  - Test station identifier (Register #)
  - Tester name/date/time
  - Pass/fail per section
- Capture screenshots for any failure, including visible persona + settings nav state.

---

## 5) Pass criteria

- All checks in sections 2 and 3 pass.
- No auth-gate bypass behavior observed.
- No persona mismatch (`cashierName` shown where `staffDisplayName` is expected).
- POS Settings exposes only allowed entries.

---

## 6) Sign-off template

```md
Windows 11 Tauri Smoke (v0.2.1)
- Run URL: <https://github.com/.../actions/runs/...>
- Build version/SHA: <...>
- Station: Register #<n>
- Tester: <name>
- Date: <YYYY-MM-DD>

Results
- 2.1 Unified auth guard: PASS/FAIL
- 2.2 Staff identity prioritization: PASS/FAIL
- 2.3 POS settings restriction: PASS/FAIL
- 2.4 Hardware accessibility in POS: PASS/FAIL
- 3 Core register sanity: PASS/FAIL

Notes
- <issues / screenshots / follow-ups>
```
