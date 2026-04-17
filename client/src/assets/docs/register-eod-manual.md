# Register Session Management (Open & Close)

## Role: Cashier / Lead
### Purpose: Daily ledger management and financial reconciliation.

Riverside OS uses a unified session model where opening the primary drawer creates a shift state shared across all lanes (Register #1, #2, and #3).

---

## Opening the Day

1. **Sign In**: Access the Back Office using your **Access PIN**.
2. **Dashboard Check**: Review the **Action Board** for weather, staff roster, and urgent notifications.
3. **Open Register**:
   - Navigate to **POS** > **Register**.
   - Select **Open Register**.
   - Enter the **Opening Float** (the cash amount in the drawer) using the keypad.
   - Verify that the status bar changes to **Register Active**.

---

## Daily Operations

- **Sales**: Process through the **Register** tab.
- **Lookup**: Use the **Inventory Overview** for product availability.
- **Overrides**: Manager PIN is required for discounts exceeding staff caps.
- **Errors**: Refer to the system status indicator if a "500" error persists.

---

## Closing the Register (End of Day)

1. **Finalize Transactions**: Ensure all carts are either checked out or cleared. Abandoned tenders will block some closing reports.
2. **Reconciliation**:
   - Navigate to **POS** > **Register** > **Close Register**.
   - Input the **Closing Cash Count**. The system will compare this against the expected total (Float + Cash Sales).
3. **Z-Report Generation**:
   - Running the **Close / Z** on Register #1 will close all satellite lanes.
   - The **Professional Z-Report** (Audit Document) will automatically generate for your records.
4. **Discrepancies**: If the cash count is "Over" or "Short" beyond store tolerance, a manager approval may be required before the session can close.

---

## Troubleshooting

- **Stuck Session**: If the register appears "Open" but no transactions can be processed, try a browser refresh or check the **Sync Health** in Settings.
- **Network Failure**: Riverside OS supports **Offline Mode** for basic sales if the server connection drops.

> [!IMPORTANT]
> Always verify that the Z-Report has been successfully saved to the audit log before walking away from the terminal.
