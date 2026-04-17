# Audited Tax Exemption (POS)

## Role: Cashier / Manager
### Purpose: Removing sales tax for qualified organizations or out-of-state shipments.

Riverside OS requires an auditable reason for every tax-exempt transaction to ensure compliance with state and federal reporting.

---

## Applying an Exemption

Tax exemption is handled within the **Checkout Ledger** drawer:

1. **Enter Checkout**: Tap the primary **PAY** button.
2. **Toggle Switch**: In the right-hand **Totals** panel, find the **Tax Exempt** toggle.
3. **Reason Code**: When toggled ON, a required **Exemption Reason** field appears. 
   - **Common Reasons**: Non-profit, Out-of-State Shipment, Resale, Government.
   - You MUST provide a specific reason text.
4. **Validation**: Once the reason is entered, the Tax line item will drop to **$0.00**.

> [!IMPORTANT]
> The system will block the **Charge** or **Finalize** actions if the exemption toggle is active but the reason field is empty.

---

## Audit & Compliance

Every exemption is logged with:
- **Staff ID**: The person who applied the exemption.
- **Reason**: The mandatory audit string.
- **Order Metadata**: Permanently stored in the financial ledger for end-of-quarter audits.

Managers can review these details in the **Orders Workspace** or the **Tax Audit Report** in the Insights section.

---

## Best Practices

- **Certificate Collection**: Always verify the customer's Tax ID Certificate before applying the discount.
- **Case-Insensitivity**: Tax categories (e.g., "Clothing") are handled automatically for $110 NYS exemptions. You only need to use the toggle for **special** exemptions (Non-Profit, etc.).
- **Specifics**: Avoid generic reasons like "N/A". Use specific identifiers for audit clarity.

> [!NOTE]
> Tax exemption only applies to **Sales Tax**. Shipping fees and other service charges remain subject to their respective store rules.
