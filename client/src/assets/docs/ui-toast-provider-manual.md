---
id: ui-toast-provider
title: "Errors, Toasts, and Feedback"
order: 1200
summary: "Understand system feedback, troubleshooting HTTP error codes, and resolving common UI state conflicts."
source: client/src/components/ui/ToastProvider.tsx
last_scanned: 2026-04-17
tags: ui, errors, toasts, feedback, troubleshooting, status-codes
---

# Errors, toasts, and feedback

ROS uses **toasts** and **modals** for feedback — not browser alerts or prompts. This page maps what you see to what you should do.

---

## Read the toast before tapping away

- **Green / success**: Confirm the action matches what you intended (correct customer, correct order).
- **Red / error**: Read the **first line**; often it names the specific field or permission required.
- If the toast disappears too quickly, reproduce the action once and watch carefully for the error message.

## Troubleshooting by HTTP Code

| Code | Usually means | First steps |
| :--- | :--- | :--- |
| **401** | Not signed in or stale token | Sign out and sign in again; hard refresh if it persists. |
| **403** | **Permission denied** | Do not retry blindly. Check your role's access permissions. |
| **404** | Missing record or session | In POS, ensure a till session is open. In Back Office, ensure ID is valid. |
| **409** | State conflict | Refresh the order or list once; another user may have edited it. |
| **422** | Validation failure | Fix any red-bordered fields; read the server message for details. |
| **500+** | Server or network failure | Refresh once; if repeated, stop and escalate with the exact time of error. |

## Common Symptoms

- **"Network error"**: Check Wi-Fi or VPN connectivity.
- **"Complete Sale" disabled**: Usually means a customer is required, a line has a zero total, or a modal is still open.
- **Stuck on "connecting" (payment)**: Wait for the full timeout once before retrying.
- **Duplicate charge worry**: Compare the receipt numbers before running a third tender.

## Modals & Prompts

- **Confirmation Modals**: Read the title and body carefully; financial modals are designed as intentional friction to prevent mistakes.
- **Standard Prompts**: Entry of PINs and overrides is audited on all sensitive paths. Have a manager present if an override is needed.

**Last reviewed:** 2026-04-17
