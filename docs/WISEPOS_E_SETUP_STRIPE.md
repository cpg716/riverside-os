# WISEPOS_E_SETUP_STRIPE

This plan outlines the process for decommissioning a BBPOS WisePOS E from a third-party POS environment and re-integrating it into a custom, server-driven workflow using the Stripe Terminal API.

Stripe remains the current/default integrated card provider in Riverside OS. The payment ledger now includes additive provider-neutral metadata for future processors, and provider-neutral attempt records exist for future terminal-provider control flow. WisePOS E setup and Stripe vaulting remain Stripe-specific. No Helcim purchase, refund, settings, or webhook behavior exists in this setup path.

Provider attempt records are audit/control rows only. They are intended for future pending/approved/canceled terminal flows and do not replace `payment_transactions`, receipt payment summaries, Stripe PaymentIntents, or refund handling.

The server can also detect Helcim backend configuration through `HELCIM_API_TOKEN`, `HELCIM_DEVICE_CODE`, and optional `HELCIM_API_BASE_URL`. This is status-only groundwork: Stripe remains the active/default provider, the Helcim token stays server-side only, and no Helcim checkout, purchase, refund, or webhook flow is enabled from this WisePOS E setup path.

Settings > Payment Processing includes a read-only Helcim status card for configured/missing backend values, masked device-code visibility, and API host visibility. This does not change WisePOS E setup or Stripe checkout behavior.

### Phase 1: De-provisioning & Device Reset
Before the reader can be added to a new account, it must be cleared of its previous configuration.

1.  **Release from Lightspeed:**
    * Log in to the Lightspeed Back Office.
    * Navigate to **Settings > Payment Processing**.
    * Locate the WisePOS E and select **Unpair** or **Delete**. This ensures the reader is no longer "locked" to the Lightspeed Terminal location.
2.  **Perform Factory Reset:**
    * Ensure the device is powered on.
    * Locate the **two blue buttons** on the sides of the reader.
    * Press and hold both buttons simultaneously for **15 seconds**.
    * When the screen displays a reset prompt, tap **Yes**. The device will reboot and clear all local cache and certificates.

### Phase 2: Stripe Dashboard Configuration
The reader must be logically registered to a physical location within your Stripe account.

1.  **Create a Location:**
    * Navigate to **Payments > Terminal > Locations** in the Stripe Dashboard.
    * Click **+ New** and enter the physical address where the reader will be used.
2.  **Register the Reader:**
    * On the WisePOS E, swipe from the left edge of the screen to open the menu.
    * Tap **Settings** and enter the admin PIN: **`07139`**.
    * Tap **Generate pairing code**.
    * In the Stripe Dashboard, click **+ Register** under your new location and enter the 3-word code shown on the reader screen.

### Phase 3: Backend Implementation (Server-Driven Workflow)
Option B relies on your server to orchestrate the payment rather than the client application talking directly to the reader.

1.  **Initialize the Payment:**
    * Create a `PaymentIntent` on your server with the desired amount and currency. 
    * Set the `capture_method` to `manual` if you want to verify inventory before final capture, or `automatic` for immediate processing.
2.  **Push to Reader:**
    * Use the Stripe Terminal API `process_payment` endpoint.
    * **Parameters:** Include the `reader_id` (found in the Dashboard) and the `payment_intent_id` created in the previous step.
    * **Effect:** This command "pokes" the reader over the internet. The WisePOS E will instantly wake up and display the payment amount.

### Phase 4: Frontend Interaction
Since you are using a server-driven approach, the frontend responsibilities are minimized.

1.  **Status Polling:**
    * Because the backend triggers the reader, your POS UI should poll your backend (or use WebSockets) for the status of the `PaymentIntent`.
2.  **User Guidance:**
    * Display a "Please follow instructions on reader" message once the backend confirms the `process_payment` call was successful.
    * Once the card is tapped/dipped, update the UI based on the response from your server.

### Phase 5: Webhooks & Completion
1.  **Listen for Events:**
    * Configure a webhook endpoint to listen for `terminal.reader.action_succeeded` and `terminal.reader.action_failed`.
    * This is the most reliable way to confirm the customer has completed the transaction on the hardware.
2.  **Capture (If Manual):**
    * If you used `capture_method: manual`, call the `capture` endpoint on the `PaymentIntent` once the webhook confirms success.

### Technical Checklist
* **Networking:** Ensure the reader is on a network that allows traffic on port **443** and port **8080**.
* **Firmware:** After registration, the reader may undergo a mandatory firmware update. Allow 5–10 minutes for this to complete.
* **API Keys:** Use Restricted API Keys for the POS integration, granting only the minimum necessary permissions for Terminal and PaymentIntents.
