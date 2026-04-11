# Custom Work Orders & Rush Orders

This manual covers the workflow for handling tailored services and time-sensitive wedding fulfillment in Riverside OS.

## 1. Custom Work Orders
Custom Work Orders are used for services that don't correspond to a specific physical SKU (e.g., tailoring, specialized cleaning, or custom adjustments).

### How to Book:
1.  **Open the Cart**: In the POS, add a "Custom Item" using the Quick Key or the Search injection.
2.  **Prompt Entry**: A modal will appear asking for the **Service Type** (e.g., "Suit Taper"), **Price**, and **Need-By Date**.
3.  **Revenue Recognition**: Custom work is recognized as revenue immediately upon payment, as it represents a service rather than a physical inventory release.
4.  **Tracking**: Custom items appear in the order history and the staff task list for the designated tailor.

## 2. Rush Orders
Rush Orders are wedding-linked fulfillments that require expedited shipping or prioritized floor handling.

### Identification & Priority:
*   **Urgency Levels**: In the **Morning Compass**, any wedding party member with a "Rush" flag or a "Need-By Date" within 7 days is automatically tiered as **URGENT**.
*   **Cart Flagging**: When adding wedding items to the cart, toggle the **RUSH** indicator. This will:
    *   Inject a priority record into the `rush_orders` ledger.
    *   Notify the procurement manager to prioritize ordering from the vendor.
    *   Highlight the order in the **Orders Workspace** with a high-intensity red badge.

### Operational Procedure:
1.  Check the **Morning Compass** daily for the "Suggested Next" queue.
2.  Rush orders will always appear at the top of the "FYI" or "Soon" bands.
3.  Ensure the customer's **Need-By Date** is clearly communicated and verified against the current vendor lead times.
