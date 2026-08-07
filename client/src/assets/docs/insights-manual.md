---
id: insights
title: "Insights — conversational reporting"
order: 15
summary: "Ask ROSIE for governed reports, refine them in plain language, export or print every result, and reuse favorites and report history."
tags: insights, rosie, reports, analytics, favorites, history, export, print
---

# Insights — conversational reporting

## Screenshots

![Open Advanced Reports from the curated Reports library](../images/help/insights/workflow-2.png)

![Use curated Reports when a fixed report already answers the question](../images/help/insights/workflow-3.png)

## What this is

**Back Office → Insights** is Riverside's native report builder. Ask for a report in plain language and ROSIE converts the request into a validated report definition. The Riverside server runs that definition against approved read-only report data. ROSIE cannot submit arbitrary SQL.

There is no separate reporting login. Riverside staff access and permissions apply throughout the workspace. Cost and margin measures remain Admin-only.

## Ask for a report

1. Open **Insights** in the left rail.
2. Describe the result you need, including the business basis and period when they matter. For example: **“Show recognized revenue by category for the last 90 days as a bar chart.”**
3. Select **Generate report**.
4. Review the title, business-basis explanation, date range, chart, and table before using the result.

Use **booked** for activity measured when a Transaction was created. Use **recognized** for revenue measured when qualifying fulfillment or pickup occurred. If that distinction is unclear, state which business event you mean.

## Refine or correct the current report

Keep the current result open and type the change you want, such as:

- **Change this to recognized revenue.**
- **Group it by salesperson instead.**
- **Use the prior quarter and show a line chart.**
- **Remove canceled Fulfillment Orders.**

ROSIE receives the current validated definition as context and returns a replacement definition. Each successful version is recorded in report history.

## Change the period

Use the **From** and **To** controls above a result, then select **Run period**. This reruns the same report definition for the new dates without rebuilding it. The rerun is also saved to report history.

## Export and print

Every successful result includes:

- **Export CSV** — downloads the complete returned table using the displayed business labels.
- **Print report** — opens a print-ready report with the title, period, generated time, basis explanation, columns, rows, and totals available in the result. Choose a physical printer or **Save as PDF** in the system print dialog.

## Favorites

Select **Save favorite**, give the report a useful name, and save it. Favorites store the governed report definition, not a copied spreadsheet. Open a favorite to rerun it against current Riverside data, then use the period controls for another day, week, month, quarter, or custom range.

Deleting a favorite does not delete its prior history entries.

## Recent reports and archive

Every successfully generated or rerun report is saved automatically under **Recent**. History stores the question, validated definition, generated time, row count, and last-used time. It does not preserve a stale copy of financial rows; reopening an entry reruns its definition against authoritative current data.

Reports that have not been used within the configured retention period are moved to **Archive** automatically. The default is **180 days**. Open **Archive** to restore or rerun an older report. An Admin can change the retention period in **Settings → Integrations → Insights**.

## Permissions and safety

- **insights.view** is required to open Insights and run reports.
- Cost and margin measures require Riverside Admin access.
- The server builds queries only from approved reporting views and static dataset/member mappings.
- ROSIE builds a constrained report definition; the server validates datasets, measures, filters, dates, row limits, and visualization before running it in a read-only transaction.
- Report results are read-only. Any business correction still uses the normal Riverside workflow and confirmation rules.

## Troubleshooting

| Symptom | What to try |
|---|---|
| Reporting needs an update | Ask an Admin to run the normal Riverside Main Hub update or repair process. There is no separate reporting password. |
| ROSIE cannot build the report | Add a clear period, measure, grouping, and booked or recognized basis. The requested data may not yet be in the governed catalog. |
| A report returns no rows | Check the period and filters, then verify whether the requested activity occurred on the selected basis. |
| Cost or margin is rejected | Sign in with Riverside Admin access or choose a revenue-only measure. |
| Insights is missing | Ask an Admin to verify **insights.view** for your role. |

## Related workflows

- [Reports (curated)](manual:reports)
- [Staff Commissions](manual:staff-commission-manager-workspace)

For operational and deployment detail, see **`docs/CUBE_INSIGHTS_REPORTING.md`** and **`docs/REPORTING_BOOKED_AND_FULFILLED.md`**.
