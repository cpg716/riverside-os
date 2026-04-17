# Technical Details of Main Shell Component

## Key Components

- **PosShell**: Manages the Point of Sale interface.
- **InsightsShell**: Provides access to analytics and reporting tools.
- **WeddingShell**: Manages wedding-related functionalities.
- **Sidebar Navigation**: Allows users to switch between different sections of the application.
- **Global Search Drawer**: Facilitates searching for customers, products, and wedding party customers.
- **Modals**: Includes modals for closing the register.
- **Drawers**: Includes drawers for help center and bug reports.

## State Management

The main shell component uses several state variables to manage the current mode (`posMode`, `insightsMode`, `weddingMode`), active tab, sub-section, and other UI elements like drawers and modals.

## Conditional Rendering

Renders different shells (`PosShell`, `InsightsShell`, `WeddingShell`) or the main dashboard based on the current mode.

## Deep Link Handling

Handles deep links for various features like alterations, procurement, inventory product hub, QBO sync logs, and more.

## Permissions and Access Control

Checks user permissions to determine which sections are visible and functional.

## Theme Mode

Allows users to switch between light and dark themes.

## Error Handling and Loading States

Manages loading states and potential errors gracefully.

## Navigation and Routing

Manages navigation between different tabs and sub-sections, as well as deep linking to specific features.
