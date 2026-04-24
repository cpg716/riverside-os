# Creating in-app Help manuals (ROS)

## Purpose

Riverside OS ships **staff-facing guides** inside the app: open **Help** (circle-question icon next to notifications) for a slideout with manuals, table of contents, and search. Search uses **Meilisearch** index `ros_help` when `RIVERSIDE_MEILISEARCH_URL` is set (`GET /api/help/search`); otherwise the same content is scanned in the browser.

---

## Single source of truth: `client/src/assets/docs/*-manual.md`

There is **no** separate `config/help-manuals.json`. The Help Center discovers every file named **`<id>-manual.md`** in:

`client/src/assets/docs/`

Examples: `pos-manual.md` → manual id **`pos`**; `insights-manual.md` → **`insights`** (Back Office Insights / Metabase + commission payouts).

### Optional YAML front matter (metadata only)

Between `---` lines at the **top** of the file (not shown in the Help article body):

| Field | Required? | Default |
|--------|-----------|---------|
| `id` | No | From filename (`pos-manual.md` → `pos`) |
| `title` | No | First `# heading` in the body |
| `summary` | No | Omitted |
| `tags` | No | `[id]` — comma-separated or `[a, b]` |
| `order` | No | `100` — lower numbers appear first in the manual picker |
| `status` | No | Inferred: `approved` for curated manuals, `draft` for `auto-scaffold` component stubs |

Example:

```yaml
---
id: pos
title: "Register (POS)"
order: 0
summary: "Short blurb for search / picker."
tags: pos, register, checkout
status: approved
---
```

Body markdown follows the closing `---` (start with `#` for the visible title).

---

## Automated wiring (`npm run generate:help`)

`client/scripts/generate-help-manifest.mjs` scans `*-manual.md`, then writes (do not hand-edit):

- `client/src/lib/help/help-manifest.generated.ts` — Vite `?raw` imports + `HELP_MANUALS`
- `server/src/logic/help_corpus_manuals.generated.rs` — Meilisearch file list

**When it runs**

- **`npm run generate:help`** (from `client/` or via **`npm run generate:help`** at repo root)
- Automatically before **`npm run build`** (`prebuild`)

**When you must run it**

- Added or **renamed** a `*-manual.md` file
- Changed **front matter** (`id`, `title`, `summary`, `tags`, `order`)

**When you usually do *not* need it**

- You only edited **body** text or existing **sections** (`##` / `###`) inside a file that was already listed — the next **`npm run dev` / `npm run build`** still bundles the updated `?raw` import.

Commit the generated `.ts` and `.rs` whenever the generator output changes.

---

## Help Manual Standard (publishable ROSIE / AIDOCS output)

This is the quality standard for Help manuals that actually ship into:

- the Help Center picker
- `help-manifest.generated.ts`
- `help_corpus_manuals.generated.rs`
- the `ros_help` search index

### Approved vs draft

- `status: approved`
  This manual is staff-facing and publishable. It appears in Help and is indexed for ROSIE / Help search.
- `status: draft`
  This manual is a maintainer scaffold only. It can live under `client/src/assets/docs/`, but it does **not** ship into the Help picker or `ros_help` until it is promoted.

If `status` is omitted:

- manuals with the `auto-scaffold` tag are treated as `draft`
- other manuals are treated as `approved`

### What an approved manual must do

Approved manuals should read like training and SOP documents, not raw UI notes.

They must include:

- a clear title and front-matter summary
- a purpose section
  Examples: `## What this is`, `## What this screen is for`
- a real step-by-step section with numbered steps
  Examples: `## How to use it`, `## Steps`, `## Quick steps`
- an operator guidance section
  Examples: `## What to watch for`, `## Tips`, `## Troubleshooting`, `## Important`

They should include, when helpful:

- when to use it
- prerequisites or permissions
- what happens next / expected result
- related workflows
- screenshots or anchors that match the real UI

### Writing style for approved manuals

- Write for staff training and day-to-day operations.
- Use Riverside labels staff will actually see.
- Prefer concrete actions over implementation detail.
- Explain what good completion looks like.
- Call out common mistakes and escalation points.
- Do not leave placeholder text, empty steps, or screenshot TODOs in approved manuals.

### What the maintainer flow enforces

`npm run generate:help` now performs Help quality validation before publishing manuals.

- approved manuals that miss required structure fail generation
- draft manuals are allowed, but remain outside the published Help corpus
- a generated quality report is written to:
  - `client/src/assets/docs/help-quality-report.generated.json`

This keeps the Help Center maintainer path durable instead of relying on one-time cleanup.

---

## aidocs-cli: capture + drafts → ROS paths

**Configure [aidocs-cli](https://github.com/BinarCode/aidocs-cli)** so exports land directly under ROS (no manual copy step):

- Markdown: **`client/src/assets/docs/<id>-manual.md`** (must end with **`-manual.md`**)
- Images: **`client/src/assets/images/help/<id>/`** (paths in Markdown like `../images/help/pos/foo.png`)

Use **`.claude/workflows/docs/*`** and **`aidocs init . --ai cursor`** (or your stack) as needed. After aidocs writes files:

1. Ensure front matter / filename match your intended **`id`**.
2. Run **`npm run generate:help`** if you added a **new** manual file or changed front matter.
3. **`npm run build`** (or your normal client build).
4. **Reindex Meilisearch** when **search** should reflect new or heavily changed **text** (Settings → Rebuild, or your reindex script).

### Checked-in AIDocs config

Riverside now ships a checked-in AIDocs config at:

- `docs/aidocs-config.yml`

That gives the repo a real upstream AIDocs entrypoint for:

- `uvx --from aidocs aidocs check`
- `/docs:init`
- `/docs:generate`
- `/docs:flow`

For the bundled in-app Help Center, AIDocs is the guided authoring layer. The
deterministic screenshot + manifest refresh path is still repo-owned.

## One-command refresh

Use the root command when you want the repo to refresh the shipped Help Center
artifacts end to end:

```bash
npm run generate:help:refresh
```

What it does:

1. runs `aidocs check` when `uv` is installed
2. auto-boots the local E2E stack if the UI/API are not already running
3. captures deterministic Help screenshots with Playwright
4. runs `npm run generate:help`

Optional flags:

```bash
npm run generate:help:refresh -- --no-auto-boot
npm run generate:help:refresh -- --skip-screenshots
npm run generate:help:refresh -- --skip-generate-help
npm run generate:help:refresh -- --reindex-search
```

The current deterministic screenshot set is defined in:

- `client/scripts/help-screenshot-specs.mjs`

The Playwright capture runner is:

- `client/scripts/capture-help-screenshots.mjs`

More detail: `docs/HELP_CENTER_AUTOMATION.md`

---

## Updating **existing** Help sections

| Change | What to do |
|--------|------------|
| **Edit prose** under an existing `##` / `###` | Change `*-manual.md` only. Dev server / build picks up content. **Reindex Meilisearch** if you rely on search for that wording. |
| **Add/remove/rename a section** | Same file; slugs derive from headings — **reindex** so Meilisearch chunks match. |
| **Change title, summary, tags, sort order** | Edit **front matter**, then **`npm run generate:help`** and commit generated files. |
| **New manual** | Add **`newid-manual.md`** (+ images dir), then **`npm run generate:help`** and commit. |
| **Screenshots** | Re-run **aidocs** (or replace PNGs in `client/src/assets/images/help/<id>/`). No generator run unless filenames/path references change. |

---

## Scaffold a new manual

```bash
cd client
node scripts/generate-help-manifest.mjs --scaffold inventory --title "Inventory"
```

Creates `client/src/assets/docs/inventory-manual.md` with front matter and `client/src/assets/images/help/inventory/`, then run **`npm run generate:help`** (or `npm run build`).

---

## Bulk stubs from React components (`*-manual.md` per `.tsx`)

To **auto-create** one stub manual for each `client/src/components/**/*.tsx` file (excluding `ui-shadcn/` and `*.test.tsx`):

```bash
# from repo root
npm run generate:help:components
```

Or: `cd client && npm run generate:help:components`

- **Dry run** (list only): append **`-- --dry-run`**
- **Include** `ui-shadcn` primitives: append **`-- --include-shadcn`**

Each new file is named from the component path, e.g. `pos/Cart.tsx` → **`pos-cart-manual.md`**, with **`order`** in the **1000+** range so hand-written manuals (lower `order`) stay at the top of the Help picker. Tags include **`auto-scaffold`** so you can find generated stubs. Stubs also get **`source:`** (repo path to the `.tsx` file), **`last_scanned:`** (ISO date), and a **`<!-- help:component-source -->`** block in the body linking to that file. Existing `*-manual.md` files with the same name are **skipped** (safe to re-run).

Component stubs are generated as **`status: draft`** with the full Help Manual Standard outline already in place:

- What this is
- When to use it
- Before you start
- Steps
- What to watch for
- What happens next
- Related workflows
- Screenshots

They are maintainer drafts, not publishable Help, until someone promotes them to **`status: approved`** and replaces the draft text with real SOP content.

### Rescan later (new components + path sync)

When you add or move `.tsx` files, run **`--rescan-components`** so that:

- **Missing** manuals are created (same rules as bulk scaffold).
- Manuals that still include the **`auto-scaffold`** tag get **`source`**, the linked-component block, and **`last_scanned`** updated when the resolved path or body block changed (no daily churn if nothing moved).
- Manuals **without** `auto-scaffold` are left alone (curated docs stay safe).
- **Orphans**: warns on `*-manual.md` files that still have `auto-scaffold` but whose id no longer matches any scanned component (e.g. after a rename).

```bash
npm run generate:help:components:rescan
# preview: npm run generate:help:components:rescan -- --dry-run
```

Same **`--include-shadcn`** / **`--dry-run`** flags as above (pass after `--` from repo root).

### Orphan Cleanup & Safety Net

To automatically remove orphaned manuals (those with the `auto-scaffold` tag that no longer map to a component), use the cleanup script:

```bash
npm run generate:help:components:cleanup
# preview: npm run generate:help:components:cleanup -- --dry-run
```

**How it works:**
1. **Trash System:** Instead of permanent deletion, orphans are moved to `client/src/assets/docs/.trash/` and appended with a timestamp (e.g., `.2026-04-11-15-06.bak`).
2. **Safety:** Only files with the `auto-scaffold` tag are eligible for automatic trashing. Your manually curated guides stay safe.
3. **Restoration:** To restore a trashed manual, move it from `.trash/` back to the parent directory and remove the `.bak` suffix.
4. **Maintenance:** Stale backups in `.trash/` are automatically purged after **60 days** to prevent storage bloat.

After the first bulk run or a rescan/cleanup that creates/updates/trashes files, commit changed markdown plus regenerated **`help-manifest.generated.ts`** and **`help_corpus_manuals.generated.rs`**.

---

## aidocs MCP (optional)

**`aidocs mcp`** — optional MCP server for AI clients to search/read a docs folder. Not required for in-app Help.

---

## Integration checklist

1. Add or edit **`client/src/assets/docs/<id>-manual.md`** (and images under **`client/src/assets/images/help/<id>/`**).
2. Run **`npm run generate:help`** when you add/rename a manual or change front matter.
3. Commit **generated** `help-manifest.generated.ts` + `help_corpus_manuals.generated.rs` when they change.
4. **Reindex Meilisearch** for search parity after meaningful text changes.
5. **`npm run build`** and spot-check Help in Back Office and POS.

---

## Prompt template (for assistants)

Read `docs/MANUAL_CREATION.md`. Add or update in-app Help: place or update **`client/src/assets/docs/*-manual.md`** (optional front matter), images under **`client/src/assets/images/help/<id>/`**, capture with **aidocs-cli** into those paths, run **`npm run generate:help`** when needed, commit generated artifacts, then Meilisearch reindex for search.

---

## Terminal command reference

All paths below are from the **repository root** unless noted.

| Goal | Command |
|------|---------|
| Regenerate manifest + server file list | `npm run generate:help` |
| Same from `client/` only | `cd client && npm run generate:help` |
| Run generator directly (any cwd) | `node client/scripts/generate-help-manifest.mjs` |
| Scaffold one manual (example) | `cd client && node scripts/generate-help-manifest.mjs --scaffold <id> --title "Title"` |
| Stub every `components/**/*.tsx` | `npm run generate:help:components` |
| Resync auto-scaffold manuals | `npm run generate:help:components:rescan` |
| Purge orphaned stubs to trash | `npm run generate:help:components:cleanup` |
| Pass flags through npm (dry-run, shadcn) | `npm run generate:help:components -- --dry-run` — same pattern for `:rescan`, `:cleanup` and `--include-shadcn` |
| Full app dev (API + Vite) | `npm run dev` (Postgres should be up: `npm run docker:db` or `docker compose up -d db`) |
| Apply DB migrations (includes **`help_manual_policy`** / **`help.manage`** when migration **79** is present) | `./scripts/apply-migrations-docker.sh` |
| Meilisearch full reindex (optional; includes `ros_help`) | `./scripts/ros-meilisearch-reindex-local.sh` or **Settings → Integrations → Rebuild** |

The help manifest script **always** runs at the end of **`generate:help:components`** and **`generate:help:components:rescan`**, and as **`prebuild`** before **`npm run build`** in `client/`.

---

## Related

- Plan: `PLAN_HELP_CENTER.md`
- Meilisearch: `docs/SEARCH_AND_PAGINATION.md`
- In-app overrides / visibility: **Settings → Help center** (`help.manage`); schema migration **79**
