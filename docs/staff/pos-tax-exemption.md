# Staff Manual: Audited Tax Exemption (POS)

Riverside OS v0.2.0 introduces **Audited Tax Exemption**. This feature allows staff to remove sales tax from a transaction while ensuring a clear reason is documented for reporting and compliance purposes.

---

## 📋 How to Exempt a Transaction

Tax exemption is performed during the checkout process within the **Payment Ledger** drawer.

1.  **Open Checkout**: Press the large **PAY** button to open the checkout drawer.
2.  **Toggle Exemption**: In the **Totals** section (right-hand side), locate the **TAX EXEMPT** switch.
3.  **Provide a Reason**: When the switch is toggled ON, a required field will appear. You MUST select or type a valid reason for the exemption (e.g., "Non-profit Organization," "Out-of-State Shipment," or "Government Agency").
4.  **Confirm**: The tax amounts will automatically drop to **$0.00**.

> [!IMPORTANT]
> The transaction cannot be completed if the tax-exempt switch is ON but no reason is provided.

---

## 🔎 Audit Trail & Reporting

Every tax-exempt transaction is recorded with the following metadata:
- **Exempt Flag**: Permanently set on the order record.
- **Reason**: The audit text provided at checkout.
- **Operator**: The staff member who authorized the exemption (derived from the signed-in session).

This data is available to managers in the **Back Office Reports** and the **Orders Workspace** for tax filing and internal audits.

---

## 🎓 Best Practices

- **Verify Documentation**: Always ensure the customer has provided valid tax-exempt credentials (e.g., a tax ID certificate) before applying the exemption.
- **Be Specific**: Use clear, standardized reasons to make end-of-quarter reporting easier for the accounting team.
- **Check State Rules**: Remember that tax exemption rules vary by state; ensure the transaction qualifies under your local jurisdiction's guidelines.
