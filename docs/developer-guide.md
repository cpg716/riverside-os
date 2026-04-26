# Developer Guide for Main Shell Component

## Overview

The main shell component is the central hub of the application, responsible for managing UI state and rendering content based on user interactions and application state. It supports various modes such as POS (Point of Sale), Insights (analytics and reporting tools), and Wedding (wedding-related functionalities). The component includes features like sidebar navigation, global search drawer, deep link handling, modals for closing the register, drawers for help center and bug reports, permissions and access control, theme mode, error handling, and navigation and routing.

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

## Working with the Main Shell Component

### Setting Up the Environment

1. **Clone the Repository**: Ensure you have the latest version of the repository.
   ```bash
   git clone https://github.com/your-repo/riverside-os.git
   cd riverside-os
   ```

2. **Install Dependencies**: Install the necessary dependencies.
   ```bash
   npm install
   ```

3. **Start the Development Server**: Start the development server to see changes in real-time.
   ```bash
   npm start
   ```

### Key Files and Directories

- **`client/src/App.tsx`**: Owns the main shell state, `AppMainColumn`, deep links, global drawer state, and POS / Insights / Wedding shell switching.
- **`client/src/components/layout/GlobalTopBar.tsx`**: Provides the persistent top bar, staff identity controls, global search entry, Help, Bug Report, and notification bell.
- **`client/src/components/layout/PosShell.tsx`**: Manages the Point of Sale interface.
- **`client/src/components/layout/InsightsShell.tsx`**: Provides access to analytics and reporting tools.
- **`client/src/components/layout/WeddingShell.tsx`**: Manages wedding-related functionality.
- **`client/src/components/layout/Sidebar.tsx`**: Handles Back Office sidebar navigation.
- **`client/src/components/layout/GlobalSearchDrawers.tsx`**: Hosts global search result drawers for customers, products, wedding party customers, and related routed results.
- **`client/src/components/layout/DetailDrawer.tsx`**: Shared drawer shell used by help, notification, and operational slideouts.

### State Management

The main shell component uses React's state management to handle different modes and UI elements. Modify the shell state in `client/src/App.tsx` unless a mode-specific shell already owns the behavior.

### Conditional Rendering

Conditional rendering is handled in `client/src/App.tsx`, which renders the POS, Insights, Wedding, or Back Office workspace tree based on the current mode.

### Deep Link Handling

Deep link handling is managed by parsing the URL and updating shell state accordingly. Extend the deep-link logic in `client/src/App.tsx` and keep corresponding sidebar / route mappings synchronized.

### Permissions and Access Control

Permissions and access control are managed by checking user roles and permissions. Update permission checks near the owning workspace or route guard rather than adding ad hoc shell bypasses.

### Theme Mode

Theme mode is managed through the shared app theme helpers and `client/src/App.tsx` shell state.

### Error Handling and Loading States

Error handling and loading states are managed using the app shell, global overlays, and owning workspaces. Keep user-facing operational failures on the established toast / overlay patterns.

### Navigation and Routing

Navigation and routing are managed through `client/src/App.tsx`, sidebar section mappings, and deep-link handlers. Update those mappings together when adding routes or navigation options.

## Conclusion

By following these instructions, developers can effectively work with the main shell component of the application to manage UI state, rendering, deep linking, permissions, theme mode, error handling, and navigation.
