# Global Command Palette & Navigation

**Status:** Historical / superseded. The standalone `CommandPalette` component was removed; current universal lookup behavior lives in the global search drawer host at `client/src/components/layout/GlobalSearchDrawers.tsx` and the app-level drawer wiring in `client/src/App.tsx`.

Riverside OS includes a system-wide Command Palette for instant navigation and data retrieval, optimized for keyboard-first throughput.

## Shortcut: `Cmd+K` (or `Ctrl+K`)

The palette can be summoned from anywhere in the application, including while typing in other input fields.

## Core Features

### 1. Omnisearch (Fuzzy Search)
*   **Customers**: Search by name, email, or phone. Results deep-link to the Customer Hub.
*   **Products/SKUs**: Search by name or SKU. Results deep-link to the Inventory Control Board.

### 2. Navigation Shortcuts
Jump instantly between the core workspaces:
*   `Go to Register` (POS Mode)
*   `Go to Weddings` (Wedding Manager)
*   `Go to Dashboard` (Operations Home)
*   `New Customer` (Redirects to Customer Add form)

### 3. Quick System Actions
*   `Sync Counterpoint`: Jump directly to the Bridge settings.

## Technical Implementation

### Component: `GlobalSearchDrawers.tsx`
*   **Location**: `client/src/components/layout/GlobalSearchDrawers.tsx`
*   **API Sources**: 
    *   `/api/customers/browse?q=...`
    *   `/api/products/control-board?search=...`

### Keyboard Support
*   `ArrowUp` / `ArrowDown`: Navigate results.
*   `Enter`: Execute action/link.
*   `Esc`: Close palette.

## UX Design Principles
The Palette follows the Riverside OS "VIP Premium" design language:
*   Translucent blurring (glassmorphism).
*   High-density result layout.
*   Automatic input focus on summons.
