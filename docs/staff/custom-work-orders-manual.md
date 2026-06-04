# Staff Manual: Custom Orders & Lifecycle Tracking

This guide covers **Custom orders** for made-to-measure garments like suits, sport coats, slacks, and individualized shirts, plus the rush flags and order lifecycle statuses that help staff follow them.

## 1. When to use a Custom order
Use a **Custom** order when the garment itself is a made-to-measure or custom garment.

* **Custom Order**: Use for custom-tailored garments. These automatically default to the **Custom** fulfillment kind and carry specific custom order measurement forms.
* **Special Order**: Use when we normally carry the item and just need to order it in.
* **Wedding Order**: Tied to a wedding party member.

Use a **Custom** order when the garment is one of these custom SKUs:
- `100` — HSM Custom Suit
- `105` — HSM Custom Sport Coat
- `110` — HSM Custom Slacks
- `200` — Individualized Custom Shirt

These SKUs automatically default to the **Custom** fulfillment bucket and will display a yellow **ORDER (Custom)** badge in the cart.

## 2. Booking a Custom item in POS
1. Add/scan the custom garment SKU to the cart.
2. The POS will automatically set the line fulfillment to **ORDER (Custom)** and display the custom measurement form overlay.
3. Enter the required custom details:
   - **Sale Price** (Retail price is entered at booking)
   - **Need By Date** if the customer has one
   - **Rush** if the order needs extra follow-up
   - Vendor-form references and measurement selections
4. Tap **Add to Cart**.
5. The cart item row will show the yellow **ORDER (Custom)** badge. If you toggle it or apply shipping, the system coerces the line to remain **Custom** rather than reverting to a Special Order.

*Note: Vendor cost is not entered at booking. The actual vendor cost is entered later when the garment is received.*

## 3. Order Lifecycle Status Paths

Order items move through a strict lifecycle path shown on the **Customer Orders** dashboard and the **Transaction Details** drawer:

```
[Needs Measurements] (Optional)
       │
       ▼
[Need to be ordered (NTBO)]
       │
       ▼
[Ordered] (Assigned to PO)
       │
       ▼
[Received] (Physically in store) ──► Is there a linked alteration?
       │                                  │ (Yes: intake)
       │                                  ├──► [Scheduled for Alterations] (Amber Badge)
       │                                  │ (Yes: in-work / verify-completed)
       │                                  └──► [In Alterations] (Amber Badge)
       ▼
[Ready for Pickup] (Staff sets manually after alterations / checks clear)
       │
       ▼
[Picked Up] (Final handoff)
```

### Dynamic Alterations Status Tracking
If a custom item is **Received** but alterations are required before the customer can pick it up:
* The system automatically tracks the linked alteration order status.
* If the alteration order is in **Intake**, the item status displays as **Scheduled for Alterations** (amber badge).
* If the alteration order is **In Work** or **Verify Completed**, the status displays as **In Alterations** (amber badge).
* If the alteration order is completed/ready, the status returns to **Received** (blue badge).
* This prevents the item from being marked as **Ready for Pickup** without manager override.

### Marking "Ready for Pickup"
Once the custom item is received and all associated alterations are complete and verified, staff must **manually** mark the line as **Ready for Pickup** inside the Transaction Record details. This triggers the automatic SMS and email notifications to the customer.

## 4. Receiving and Cost Entry
When the custom garment arrives:
1. Receive it through the normal purchasing / receiving workflow.
2. Enter the actual vendor cost from the receipt or invoice at that time.
3. Keep the order in the **Custom** bucket so pickup and reporting still reflect the correct order type.

---
*For workflow issues with Custom orders, contact a manager or administrator.*
