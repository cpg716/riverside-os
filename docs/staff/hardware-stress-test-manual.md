# Phase 1 — Hardware Stress Test (Multi-Lane Print Drill)

**Goal:** Verify that the Riverside OS Hardware Bridge can handle simultaneous requests from multiple registers without losing jobs or crashing the bridge.

## 1. Preparation
1. Ensure the **Hardware Bridge** is running on the primary Register #1 PC (Tauri station).
2. Ensure you have at least **two registers** (e.g., Register #1 and a PWA tablet or Register #2) ready to perform transactions.
3. Ensure the printer has a **full roll of paper**.

## 2. The Drill (10-Minute Stress)

### Step A: Simultaneous Queueing
1. **Station 1**: Build a cart with 3 items. Go to checkout, but do not click "Complete" yet.
2. **Station 2**: Build a cart with 3 items. Go to checkout.
3. **Action**: On the count of three, both operators click **"Complete Sale"** simultaneously.
4. **Verification**: 
   - Both receipts should print sequentially.
   - The Hardware Bridge icon should remain green/stable.
   - The receipt content must be correct (no interleaving or garbled text).

### Step B: The "Reprint Flood"
1. Open the **Orders Workspace** on Register #1.
2. Open the **Orders Workspace** on Register #2.
3. Rapidly click **"Print Receipt"** on five different historical orders from each station at the same time.
4. **Verification**:
   - The physical printer should spool all 10 receipts without error.
   - The Tauri app on Register #1 (where the bridge lives) should not freeze.

## 3. Post-Drill Audit
- [ ] Were any print jobs lost?
- [ ] Did the bridge require a restart?
- [ ] Is there any "double printing" visible on the register logs?

## 4. Failure Protocol
If the bridge crashes or jobs are lost:
1. Log the exact time of the crash.
2. Record the number of registers active.
3. Check the **Server Log Ring** (Header -> Settings -> Logs) for "Hardware Bridge" error strings.
4. Report to IT with the correlation ID if a Bug Report is filed.
