# How to report a bug (staff)

**Audience:** Any **signed-in Riverside OS staff** (Back Office or POS).

**Permission:** You only need to be **authenticated** with your normal staff sign-in. You do **not** need admin access to **submit** a report.

**Related (admins):** triage lives under **Settings → Bug reports** — see **[bug-reports-admin-manual.md](bug-reports-admin-manual.md)**.

---

## What this is for

Use **Report a bug** when something in Riverside OS **breaks**, **behaves wrong**, or **confuses you** and you want the **settings admin** team (or IT) to investigate. The app can attach a **screenshot**, **your written summary**, **what you were doing**, and **automatic diagnostics** (browser/console context, which tab you were on, and a short **server log slice** from the moment you hit Submit — not a full computer or disk log).

**Not a replacement for:**

- **Emergency** register or payment outages where your SOP says **call the manager** or **merchant support** first.
- **Password / access** problems — use **Staff / admin** per your store process.
- **Training questions** — ask a lead or use **[README.md](README.md)** staff guides first.

---

## Where to open it

| Surface | Where |
|---------|--------|
| **Back Office** | Top **header** — **bug** icon (tooltip / screen reader: **Report a bug**). |
| **POS mode** | Same **bug** icon in the POS top bar. |

You must be **signed in**. If you are in **POS** with an open till, the app still sends your staff identity with the report (merged with register session context when applicable).

---

## Step-by-step

### 1. Get to a stable moment (if you can)

- If the bug is **visual**, leave the **wrong screen** visible before you open the report (the capture runs when the dialog opens).
- If the bug **crashes** the page, reload, sign in again, then report from the nearest safe screen and **describe** what you saw in the text boxes.

### 2. Open **Report a bug**

Tap the **bug** icon. A dialog titled **Report a bug** opens.

### 3. Screenshot choice

- **Attach screenshot** is **on** by default. The app captures the **main app area** (`#root`), roughly what you see in the window.
- **Uncheck Attach screenshot** if:
  - the network is **slow**, or
  - the screen might show **sensitive customer data** you do not want stored (card numbers, medical notes, etc.). You can still describe the issue in words; an admin may ask for a **cropped** or **redacted** photo another way.

If capture fails, you will see a short message; you can still **submit** — only a **placeholder** image is stored.

### 4. Fill in the form (required)

| Field | What to write |
|-------|----------------|
| **What went wrong?** | One clear problem — e.g. “Save on customer profile did nothing” or “Tax on this order looked wrong.” |
| **What were you doing right before it happened?** | **Screen / tab / subsection**, **customer or order** if relevant, and the **last taps or keys** (e.g. “Customers → opened Jane Doe → edited phone → Save”). |

Both boxes must be **non-empty** or Submit will show an error toast: **Describe the issue and what you were doing**.

### 5. Submit

Tap **Submit report**. Wait until the button returns (do not close the tab mid-send).

**Success:** A toast confirms the report was sent. If a **reference** appears (first part of the **correlation id**), you can give that to an admin so they can find your row quickly. Example: *Report sent. Reference abc12def…*

**Failure:**

| Message / situation | What it usually means |
|---------------------|------------------------|
| **Too many bug reports — try again in a few minutes** (or similar) | **Rate limit:** at most **12** reports per **15 minutes** **per staff member**. Wait and try again; use one good report instead of many tiny ones. |
| **Could not submit bug report** / **Network error** | API unreachable, session issue, or payload too large. Retry once; if it persists, tell **settings admin** with **approximate time** and **screen**. |
| **Describe the issue…** | Fill both text areas. |

---

## Privacy and common sense

- Screenshots and client diagnostics may include **PII** visible on screen (names, phones, order totals). Submit only what your **store policy** allows; **uncheck** the screenshot when unsure.
- The **server log snapshot** is a **bounded** in-process buffer on the API process — useful context for engineers, **not** a full host audit log. See **[../OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md](../OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md)** if your IT team asks what it is.

---

## Tips for a report that gets fixed faster

1. **One issue per report** — unless two problems are clearly the same root cause.
2. **Exact navigation** — “Settings → Integrations → Podium” beats “in settings somewhere.”
3. **Whether it repeats** — “Every time” vs “only once.”
4. **Register / till** — if you were in **POS**, say if a **session was open** and which **lane** if your store uses multiple registers.

---

## See also

- **[bug-reports-admin-manual.md](bug-reports-admin-manual.md)** — triage workflow (**settings.admin**).
- **[settings-back-office.md](settings-back-office.md)** — Settings overview (Bug reports subsection).
- **[../PLAN_BUG_REPORTS.md](../PLAN_BUG_REPORTS.md)** — technical behavior (developers / IT).
- **[PII-AND-CUSTOMER-DATA.md](PII-AND-CUSTOMER-DATA.md)** — handling customer data carefully.

**Last reviewed:** 2026-04-08
