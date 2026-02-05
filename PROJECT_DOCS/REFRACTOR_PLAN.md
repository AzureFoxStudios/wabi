# Refactoring Plan for `+page.svelte`

## Introduction

The `frontend/src/routes/+page.svelte` component had grown significantly in complexity, acting as a "God component" that managed not only the application's authentication flow but also a large portion of its layout state, including responsive design logic, panel visibility, and resizing. This monolithic structure led to reduced readability, increased brittleness, and limited reusability.

## Goals

The primary objectives of this refactoring effort were:

1.  **Improve Readability:** Make `+page.svelte` easier to understand by separating concerns.
2.  **Enhance Maintainability:** Reduce the cognitive load associated with modifying or debugging layout-related logic.
3.  **Increase Reusability:** Decouple layout components and logic from a single page, making them reusable across the application.
4.  **Simplify Page Creation:** Lay the groundwork for easier development of new pages by providing a clear and modular layout structure.

## Key Changes

To achieve these goals, the following new files and modifications were implemented:

### 1. `frontend/src/lib/layoutStore.ts`

**Purpose:** This new Svelte store serves as the single source of truth for all application layout-related state. It centralizes variables and actions pertaining to:
*   Mobile/desktop detection (`isMobile`).
*   Visibility of right-hand panels (DM list, individual DM panel).
*   Visibility of mobile-specific channel sidebar.
*   Panel widths and resizing states.
*   Currently active DM channel and user information.

**Benefits:** By extracting this state management, `+page.svelte` no longer needs to directly manage these intricate layout details, leading to cleaner and more predictable state updates.

### 2. `frontend/src/lib/components/MainLayout.svelte`

**Purpose:** This new component encapsulates the entire visual structure of the main application interface, previously scattered within `+page.svelte`. It includes:
*   The `ChannelSidebar` (left panel).
*   The `Main Content` area (for `Chat` and `ScreenShareViewer`).
*   The `DMListPanel` and `DMPanel` (right panels).
*   Mobile bottom navigation bar.
*   Desktop-specific resize handles and toggle buttons.

**Integration with `layoutStore`:** `MainLayout.svelte` subscribes to `layoutStore` to reactively update its layout and component visibility based on the centralized state. This means the layout behaves dynamically without complex internal state management.

**Benefits:** This component provides a reusable and self-contained definition of the main application layout. Any page needing this multi-panel structure can simply import and render `MainLayout.svelte`.

### 3. `frontend/src/routes/+page.svelte` (Modified)

**Purpose:** `+page.svelte` has been dramatically simplified to focus solely on its core responsibilities:
*   **Authentication:** Determines if a user is logged in and renders either the `Login` component or the `MainLayout` component accordingly.
*   **Initial Loading State:** Manages the initial loading screen.
*   **Global Lifecycle Management:** Handles `onMount` and `onDestroy` for global tasks like notification permission requests, theme initialization, and keyboard shortcuts.
*   **Central Event Handling:** Acts as a central point for critical application-wide events (e.g., `dmPanelSignal` to open a DM, `handleLogin`, `handleLogout`).

**Benefits:** The component is now significantly smaller, more readable, and easier to maintain. It clearly separates authentication and global concerns from the detailed layout implementation.

## Overall Benefits of Refactoring

*   **Improved Code Organization:** Clear separation of concerns makes the codebase more modular and easier to navigate.
*   **Enhanced Maintainability:** Changes to the layout logic are isolated within `layoutStore.ts` and `MainLayout.svelte`, reducing the risk of unintended side effects in other parts of the application.
*   **Increased Reusability:** `MainLayout.svelte` can be reused on other pages that require the same application shell, and `layoutStore.ts` provides a consistent way to manage layout state across the app.
*   **Simplified Debugging:** With specific responsibilities assigned to each module, identifying and fixing issues (such as the reported theme/font saving bugs) becomes more straightforward.
*   **Easier New Page Creation:** Developers can now create new pages with less boilerplate, simply by composing existing layout components or defining their unique content within the existing structure.

## Next Steps

With the refactoring complete, the next immediate task is to use the added logging in `ThemeCustomizer.svelte` and `UsernameFontCustomizer.svelte` to diagnose and fix the reported issues with theme and font saving. We will need the browser console logs from an attempt to save these settings.
