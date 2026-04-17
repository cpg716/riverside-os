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

- **`src/components/MainShell.js`**: The main shell component file.
- **`src/components/PosShell.js`**: Manages the Point of Sale interface.
- **`src/components/InsightsShell.js`**: Provides access to analytics and reporting tools.
- **`src/components/WeddingShell.js`**: Manages wedding-related functionalities.
- **`src/components/SidebarNavigation.js`**: Handles sidebar navigation.
- **`src/components/GlobalSearchDrawer.js`**: Facilitates global search functionality.
- **`src/components/Modals.js`**: Contains modals for closing the register.
- **`src/components/Drawers.js`**: Contains drawers for help center and bug reports.

### State Management

The main shell component uses React's state management to handle different modes and UI elements. You can modify the state variables in `MainShell.js` to control the behavior of the component.

### Conditional Rendering

Conditional rendering is handled using React's conditional rendering syntax. You can modify the conditions in `MainShell.js` to render different components based on the current mode.

### Deep Link Handling

Deep link handling is managed by parsing the URL and updating the state accordingly. You can modify the deep link handling logic in `MainShell.js` to support additional features.

### Permissions and Access Control

Permissions and access control are managed by checking user roles and permissions. You can modify the permission checks in `MainShell.js` to enforce different access levels.

### Theme Mode

Theme mode is managed by toggling a state variable that controls the theme. You can modify the theme toggle logic in `MainShell.js` to support additional themes.

### Error Handling and Loading States

Error handling and loading states are managed using React's error boundaries and loading indicators. You can modify the error handling and loading state logic in `MainShell.js` to improve user experience.

### Navigation and Routing

Navigation and routing are managed using React Router. You can modify the routing configuration in `MainShell.js` to support additional routes and navigation options.

## Conclusion

By following these instructions, developers can effectively work with the main shell component of the application to manage UI state, rendering, deep linking, permissions, theme mode, error handling, and navigation.
