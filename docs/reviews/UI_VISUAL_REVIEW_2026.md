# Riverside OS UI/UX Review (April 2026)

This document details the visual standards and ergonomic design of the Riverside OS (ROS) user interface.

## 1. Aesthetic Identity
- **Premium Design Philosophy**: Avoids "General ERP" aesthetics. Uses curated color-mix functions, rich shadows, and vibrant accent colors (Fuchsia).
- **Theming**: Strict support for Light and Dark modes. The system prefers `var(--app-*)` tokens from `index.css` over hardcoded Tailwind colors to ensure consistency during theme transitions.
- **Micro-interactivity**:
    - `workspace-snap`: 14px slide-in animation for tab transitions.
    - Status-based icons (Cloud/Sun for weather, Heart for weddings, Package for returns).

## 2. Component Design
- **Density Controls**:
    - `density-standard`: Default for Back Office management screens.
    - `density-compact`: Used for POS catalogs and staff lists to maximize information density on small screens.
- **Button Tokens**:
    - `ui-btn-primary`: Action-heavy primary buttons.
    - `ui-btn-secondary`: Ghost/Stroked buttons for supporting actions.
    - **Terminal Emerald**: Emerald-600 background with Emerald-800 bottom border (8px) for final checkout/post actions.

## 3. POS Ergonomics
- **Touch Targets**: Minimum 44px targets for all critical POS interactions (`ui-touch-target`).
- **Dashboard Visualization**:
    - Weather pulse for foot-traffic context.
    - "Morning Compass" for priority coating.
    - Dark-mode optimized high-contrast numeric displays for dollar amounts.

## 4. UI Compliance
- **Zero-Browser-Dialog**: All alerts, prompts, and confirmations use custom React components (`useToast`, `ConfirmationModal`) to maintain the "Native Desktop" feel within Tauri.
- **Accessibility**: Focus traps via `useDialogAccessibility` are mandatory for all DetailDrawers.

---
*Last Updated: 2026-04-08*
*Design Phase: 5 (Complete)*
