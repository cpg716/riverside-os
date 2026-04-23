---
id: pos-register-reports
title: "Register Reports & Daily Sales"
order: 1074
summary: "Daily sales activity timeline, tender totals, and professional audit printing for the current register session."
source: client/src/components/pos/RegisterReports.tsx
tags: pos, register, reports, audit, printing
---

# Register Reports (Daily Sales)

This screen provides a real-time audit of all activity on the current register session. 

## What this is

Use this screen to review the current register session, print the full-page daily report, and verify lane activity before final close.

## How to use it

1. Open **POS → Reports** while the register session is still active.
2. Review the sales timeline and summary cards for the current lane or till group.
3. Open individual entries when you need receipt or tender detail.
4. Use **Print Report (Full Page)** when the shift needs a professional audit printout.

## Daily Sales Activity
The **Daily Sales** view shows a chronological timeline of every transaction. Tap an entry to view the full receipt or reprint it. Use this for:
- Verifying the status of recent sales.
- Correcting tender types by reviewing the audit log.
- Monitoring mid-shift velocity without closing the drawer.

## Professional Audit Printing
You can now generate a professional, full-page **Daily Sales Report** that includes:
- **Tender Breakdown**: Totals for Cash, Card, Gift Card, and R2S charges.
- **Transaction Audit**: A complete list of all ticket numbers and amounts.
- **Reporting Station**: The report header identifies the assigned printer for accountability.

To print, tap **Print Report (Full Page)**. This will route the document to your **Report Station** (System Printer), not the thermal receipt printer.

## Performance Metrics
The summary cards at the top of the screen provide instant visibility into:
- **Gross Sales**: Total volume before taxes and returns.
- **Tender Totals**: Net collections per payment method.
- **Transaction Count**: Total number of finalized tickets.

## Tips
- **Decoupled Printing**: Receipts print on receipt paper; Reports print on office paper. Ensure your **Report Printer** is set in Terminal Overrides.
- **Shared till group**: Reporting on Register #1 includes data aggregated from all satellite lanes (iPad and Back Office).
