# Riverside OS App Updates

**Audience:** All staff using Riverside on iPad, iPhone, or web browser.

**Where in ROS:** Applies everywhere — the update prompt appears as a floating banner at the bottom of the screen.

**Related permissions:** None. All staff see update prompts.

---

## What this is for

Riverside is a Progressive Web App (PWA). That means it stores a local copy on your device so it works quickly and stays available even if the network is slow. When the store system is updated, your device needs to load that newer copy. The app tells you when that is ready.

## The update banner

When a new version is available, a banner appears at the bottom of the screen:

> **A new version of Riverside is ready.**
>
> Reload when staff can afford a quick refresh. If the shell still looks stale after reloading, close and reopen the installed app icon or clear site data when practical.

You have two choices:

| Button | What it does |
|--------|-------------|
| **Later** | Dismisses the banner. The app keeps running the current version. The banner will return on the next page load or next session. |
| **Reload now** | Instantly switches to the new version and refreshes the page. You will remain signed in; your current register session stays open. |

## When to reload

- **Prefer a quiet moment.** Reloading takes 1–2 seconds and refreshes the current screen. Do not reload mid-checkout or while a customer is actively paying.
- **If you are in the middle of a sale,** finish the transaction first, then reload.
- **If you tapped Later multiple times** and the banner keeps coming back, pick a safe moment and reload. Repeatedly dismissing it does not cause problems, but it does leave you on an older version.

## If you installed Riverside from your home screen (iPad / iPhone)

The reload button refreshes the app inside its home-screen shell. You do **not** need to delete the icon and re-add it.

If a reload does not feel like it changed anything:

1. Close the app fully (swipe up from the bottom and swipe Riverside away).
2. Tap the Riverside icon again to reopen it.
3. If the banner still appears, tap **Reload now**.

## If you are using a desktop browser

The reload button refreshes the browser tab. Your sign-in state is preserved. If the tab still looks old after reloading, press **Ctrl+Shift+R** (Windows) or **Cmd+Shift+R** (Mac) for a hard refresh, then close and reopen the browser tab.

## Common issues

| Symptom | What to try first | If that fails |
|---------|-------------------|---------------|
| Banner does not appear, but something looks broken | Close and reopen the app or tab. | See `pwa-update-troubleshooting.md` or ask IT to check the server version. |
| After reload, the screen is blank or stuck on a spinner | Wait 5 seconds. If still blank, close and reopen the app. | Clear site data in browser settings and reopen. |
| Reload button does nothing on the first tap | Tap it once more after 2 seconds. | Close and reopen the app. |

## When to get a manager

- The update banner appears immediately after every reload (possible server-side issue).
- The app fails to load entirely after reloading.
- You suspect a feature is missing that should have been in a recent update.

---

## See also

- `pwa-update-troubleshooting.md` — deeper steps for clearing caches and forcing an update.
- `REMOTE_ACCESS_GUIDE.md` — installing Riverside as a home-screen app.
- `working-offline.md` — what happens when the network is down.

**Last reviewed:** 2026-05-27
