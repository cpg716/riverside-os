---
id: pos-register-dashboard
title: "POS Dashboard"
order: 1010
summary: "Daily shift overview, performance metrics, priority tasks, and urgent wedding notifications."
source: client/src/components/pos/RegisterDashboard.tsx
last_scanned: 2026-04-17
tags: pos, dashboard, metrics, tasks, notifications, shift-overview
---

# POS Dashboard

_Audience: Floor staff while a register session is open._

**Where in ROS:** POS mode → left rail **Dashboard** (first item).

---

## How to use this screen

This is your **shift overview** before you jump into the cart. Scan top-to-bottom: **your performance** (if your role shows them), **Priority Feed** (urgent weddings/tasks), **notifications**, and shortcuts back to **Register**.

## Blocks you might see

| Block | You use it to… | Requirements |
| :--- | :--- | :--- |
| **Headline / role** | Confirm sign-in as cashier | Valid POS Login |
| **Performance Stats** | View lines / $ visualization | Salesperson role |
| **Priority Feed** | Urgent wedding pickups / tasks | `weddings.view` |
| **Task List** | Open assigned checklist | `tasks.complete` |
| **Recent Activity** | Real-time store events | `notifications.view` |

## Common tasks

### Clear your notifications before shift
1. Tap the **bell** icon or **Open inbox**.
2. Work through **Read** → **Complete** or **Dismiss**.

### Check tasks before floor
1. From Dashboard, open the **Tasks** block.
2. Complete items expected before the door opens (lights, music, cash count verification).

## Troubleshooting

| Symptom | What to try first |
| :--- | :--- |
| **Dashboard empty** | Wait 15s; check Wi-Fi; refresh once. |
| **Metrics clearly wrong** | Note time and screenshot for Manager. |
| **Notification won’t dismiss** | Try toggling between Complete and Archive. |

**Last reviewed:** 2026-04-17
