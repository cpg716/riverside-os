# ROS workspace design standard

This is the shared visual system for Riverside OS staff workspaces. It combines the strongest parts of Gift Cards and Loyalty into one reusable pattern: warm surfaces, softly colored summary cards, clear task grouping, compact filters, and readable data rows.

The goal is consistency without making unlike tasks identical. Staff should recognize the same ROS structure everywhere while each workspace keeps the controls and information its job requires.

## Standard workspace anatomy

Use these layers in order when they apply:

1. **Summary strip** — three to five `WorkspaceMetricCard` cards for the small set of numbers that help staff orient themselves. Omit it when a task has no useful overview or when POS should open directly into the active task.
2. **Context card** — optional short guidance or follow-up metrics. Keep it operational and concise; do not repeat the page title or explain implementation details.
3. **Primary workspace panel** — one dominant `ui-card ui-workspace-panel` containing the search, filters, table, list, or task content.
4. **Drawers and modals** — open detail and editing flows without replacing the workspace. Follow the existing portal and accessibility contract.

Avoid stacking several equally heavy white cards. One panel should read as the main place to work; summary and guidance cards support it.

## Reusable primitives

| Primitive | Purpose |
|---|---|
| `WorkspaceMetricCard` | Tinted overview card with an icon well, watermark icon, value, optional badge, and optional supporting detail. |
| `ui-workspace-summary` | Responsive horizontal summary strip. It scrolls horizontally on narrow screens instead of crushing cards. |
| `ui-workspace-panel` | Dominant rounded workspace surface for lists, tables, and task content. Use with `ui-card`. |
| `ui-workspace-panel-header` | Search and primary actions at the top of the main panel. |
| `ui-workspace-toolbar` | Compact outlined filter/search group when it sits outside a panel header. |
| `ui-workspace-page-header` | Compact title, icon, and one-line instruction for sub-tools such as Inventory Find Item. |
| `ui-control-chip` / `ui-control-chip-active` | Quick filters and lightweight view choices. |
| `ui-input`, `ui-btn-primary`, `ui-btn-secondary` | Standard form and action controls. |

The shell marks staff workspaces with `data-workspace-theme="ros"` and the active `data-workspace-section`. This root gives existing Back Office `ui-card`, `ui-table-shell`, `ui-panel`, `ui-filter-row`, and `ui-toolbar` primitives the shared workspace radius and surface hierarchy automatically. New general-purpose Back Office workspaces should inherit this root rather than creating a separate canvas treatment. Alterations and embedded Wedding Manager are explicitly excluded from the automatic radius treatment.

## Summary cards

- Show only metrics staff can understand and use. A card is not decoration.
- Use semantic tones: `info`, `success`, `warning`, `danger`, `accent`, or `neutral`.
- Do not use a warning or danger color merely to create variety. The tone must match the meaning.
- Use short labels and badges. Values should remain readable without wrapping.
- Prefer a stable four-card strip; use five only when the fifth category is genuinely distinct, as in Gift Cards.
- Do not show management summaries on a task-first POS surface unless the figures directly support the current action.

## Search and filters

- Put search first and give it the most horizontal space.
- Keep the most frequently used filters visible; move rare options behind an explicit secondary control.
- Use outlined controls at rest and the ROS accent for the active state.
- Use pill chips for quick, reversible filters. Use selects for larger controlled vocabularies.
- Active filters must remain visible and removable without clearing the whole search.
- Keep controls at least 44 CSS pixels high on touch surfaces.

## Tables and lists

- Desktop tables and Loyalty-style row cards are both valid. Choose the format that makes the task easiest to scan.
- Keep identity and the primary status toward the left; put the primary action toward the right.
- Use semantic status badges, tabular numerals, and restrained dividers.
- Preserve native root scrolling. A wide data table may scroll horizontally inside its panel, but the whole workspace must not be trapped in a nested vertical scroller.
- Empty, loading, and error states belong inside the primary panel and should state what staff can do next.

## Color, typography, and motion

- Use `--app-*` tokens and shared `ui-tint-*` classes; do not introduce one-off light/dark palettes.
- Reserve uppercase microcopy for labels, badges, and controls. Instructions and explanations use sentence case.
- Use Inter/Outfit through the existing app typography stack.
- Motion should confirm hierarchy: subtle hover lift on summary cards and short workspace entry transitions. Do not animate values or rows in a way that slows scanning.

## Responsive behavior

- Summary cards scroll horizontally below desktop widths.
- Toolbars wrap into a vertical, full-width layout before controls become cramped.
- The primary action remains visible and touch-sized.
- Tables may switch to record cards when their columns no longer preserve useful meaning.
- Validate at 390×844, 768×1024, 1024×1366, and 1440×900.

## Where this pattern does not apply unchanged

- **Register/POS checkout:** preserve the established tactical layout and payment hierarchy.
- **Alterations Hub:** remains the approved windowed/nested-scroll exception.
- **Wedding Manager:** visual redesign remains out of scope; apply shared tokens only where required for legibility.
- **Public storefront:** uses its customer-facing design system and remains outside the staff workspace standard.
- **Single-step utilities and full-screen guided workflows:** may omit summary cards or the dominant list panel when those elements would add noise.

## Migration rule

When touching an existing staff workspace, adopt these primitives in a small coherent slice: root, summary, primary panel, then filters. Do not change business logic, permissions, data contracts, or task sequencing merely to make the screen match visually.
