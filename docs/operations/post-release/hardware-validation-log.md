# Post-Release Hardware Validation Log

Use this log to validate each store device after install, update, or release rollout. Complete one row per device/workstation test. Attach or reference supporting evidence whenever available.

## Helcim Terminal

| Workstation | Device Model | Firmware/Software Version | Test Scenario | Expected Result | Pass/Fail | Evidence Captured | Operator Notes | Escalation Required |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  | Pair terminal and run approved card sale | Terminal connects, approves one payment, and Riverside records the same payment amount once. |  |  |  |  |  |
|  |  |  | Cancel or decline card payment | Sale remains unpaid or returns to payment safely without duplicated payment. |  |  |  |  |  |
|  |  |  | Refund card payment | Refund evidence is retained and Riverside shows the correct refunded amount. |  |  |  |  |  |

## Thermal Receipt Printer

| Workstation | Device Model | Firmware/Software Version | Test Scenario | Expected Result | Pass/Fail | Evidence Captured | Operator Notes | Escalation Required |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  | Print sale receipt | Receipt prints clearly with correct transaction, tender, tax, and balance information. |  |  |  |  |  |
|  |  |  | Reprint receipt | Reprint matches the selected transaction and does not print another customer's receipt. |  |  |  |  |  |
|  |  |  | Print after printer reconnect | Printer resumes normal output without corrupted or partial receipt content. |  |  |  |  |  |

## Reports Printer

| Workstation | Device Model | Firmware/Software Version | Test Scenario | Expected Result | Pass/Fail | Evidence Captured | Operator Notes | Escalation Required |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  | Print register close/report page | Report is readable, complete, and matches the on-screen totals. |  |  |  |  |  |
|  |  |  | Print Help page | Help content prints with readable headings and body text. |  |  |  |  |  |

## Cash Drawer

| Workstation | Device Model | Firmware/Software Version | Test Scenario | Expected Result | Pass/Fail | Evidence Captured | Operator Notes | Escalation Required |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  | Open drawer from cash sale | Drawer opens once at the correct point in the cash sale workflow. |  |  |  |  |  |
|  |  |  | No-sale or manager-approved open | Drawer opens only through the approved store workflow and action is reviewable. |  |  |  |  |  |

## Barcode Scanner

| Workstation | Device Model | Firmware/Software Version | Test Scenario | Expected Result | Pass/Fail | Evidence Captured | Operator Notes | Escalation Required |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  | Scan item barcode in POS | Correct item or lookup value appears once with no extra characters. |  |  |  |  |  |
|  |  |  | Scan receiving barcode | Correct receiving item or search value appears and can be processed by staff. |  |  |  |  |  |

## Windows Workstation/Install/Update

| Workstation | Device Model | Firmware/Software Version | Test Scenario | Expected Result | Pass/Fail | Evidence Captured | Operator Notes | Escalation Required |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  | Launch RiversideOS after install | App opens to the expected staff entry point and reaches the correct store environment. |  |  |  |  |  |
|  |  |  | Apply available update | Update completes, app restarts cleanly, and version evidence is captured. |  |  |  |  |  |
|  |  |  | Restart workstation and reopen app | RiversideOS opens normally and staff can sign in without implementation help. |  |  |  |  |  |

## Counterpoint Bridge Workstation

| Workstation | Device Model | Firmware/Software Version | Test Scenario | Expected Result | Pass/Fail | Evidence Captured | Operator Notes | Escalation Required |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
|  |  |  | Confirm bridge workstation is running | Bridge workstation is available for the expected store sync workflow. |  |  |  |  |  |
|  |  |  | Review latest bridge status | Latest status is understandable and any sync issue has a clear owner. |  |  |  |  |  |
|  |  |  | Capture bridge support evidence | Support evidence includes time, workstation, and current bridge status. |  |  |  |  |  |
