# Insights conversational reporting and commission reports

**Audience:** Owners, managers, accountants, and staff with reporting access.

## Where in ROS

- **Back Office → Reports** provides fixed, curated operational reports backed by Riverside APIs.
- **Back Office → Insights** builds custom Riverside reports from plain-language requests.
- **Back Office → Staff → Commissions → Reports** provides payroll-oriented commission review.

Insights remains inside the standard Back Office workspace, with the left navigation available while staff build and review reports. All three surfaces use Riverside authentication. There is no separate analytics login.

## Permissions

- **Reports and Insights:** **insights.view**
- **Cost and margin measures:** Riverside Admin only
- **Staff → Commissions → Reports:** **insights.view**
- **Staff → Commissions → SPIFFs & Combos:** **staff.manage_commission**

## Run and refine an Insights report

1. Open **Insights** in the left rail.
2. Ask for the measure, grouping, period, and business basis you need. Example: **“Recognized revenue and units by category for the prior quarter.”**
3. Review the basis explanation and table before relying on the result.
4. Ask a follow-up change while the report is open, or change the **From** and **To** dates and select **Run period**.
5. Use **Export CSV** for spreadsheet work or **Print report** for a printout or PDF.

**Booked** measures a Transaction when it is created. **Recognized** measures qualifying fulfillment or pickup. These are deliberately separate datasets; do not silently substitute one for the other.

Insights validates each request against approved reporting data and staff permissions. Reports are read-only; any business correction still uses the normal Riverside workflow.

## Favorites, history, and archive

- **Save favorite** preserves a named report definition. Reopen it to run current data, then choose a different period when needed.
- Every successful generation and rerun is saved automatically under **Recent**.
- History records the question, validated definition, row count, generated time, and last-used time. It does not retain a stale row-level financial snapshot.
- Reopening a history item reruns it against current authoritative ROS data.
- History unused for the configured retention period moves to **Archive** automatically. The default is **180 days**.
- Archived reports can be restored or rerun. Admins set the retention period in **Settings → Integrations → Insights**.

## Commissions → Reports

1. Open **Staff → Commissions → Reports** and unlock Staff if prompted.
2. Set **From** and **To**, or use a period preset, then refresh.
3. Optionally select one staff member.
4. Review **Rate**, **Rate since**, **Sales**, **By rate**, **SPIFF $**, and **Earned commission**.
5. Use **Print report** for payroll review and **Trace** for line-level calculation context.

Commission is earned on the configured fulfillment or pickup recognition event, not merely when the Transaction is booked. Alteration charges count as commissionable sales; shipping charges are excluded. Effective-dated base rates live on Staff Profile. SPIFF and combo incentives live under **Staff → Commissions → SPIFFs & Combos**.

## RMS / R2S reporting

Operational RMS charge and payment lines remain under **Customers → RMS charge**. Staff with **insights.view** can also ask Insights for modeled payment activity or use the curated **RMS charges** report where appropriate.

## Common issues

| Symptom | First check |
|---|---|
| No Insights tab | Role has **insights.view**. |
| Reporting unavailable | Ask IT to run Main Hub Update or Repair. |
| Report cannot be generated | Ask for a supported measure, grouping, period, and booked or recognized basis. |
| No margin or cost option | Riverside Admin access is required. |
| Unexpected total | Verify the date range, filters, and booked versus recognized basis before escalating. |

If fulfilled reports, receipt loyalty, commissions, QBO staging, or tax totals disagree, Admin or IT should inspect **`reporting.transaction_status_integrity`** before relying on the affected window.

## See also

- [reports-curated-manual.md](reports-curated-manual.md)
- [reports-curated-admin.md](reports-curated-admin.md)
- [../REPORTING_BOOKED_AND_FULFILLED.md](../REPORTING_BOOKED_AND_FULFILLED.md)
- [../AI_REPORTING_DATA_CATALOG.md](../AI_REPORTING_DATA_CATALOG.md)
- [../POS_PARKED_SALES_AND_RMS_CHARGES.md](../POS_PARKED_SALES_AND_RMS_CHARGES.md)

**Last reviewed:** 2026-08-09
