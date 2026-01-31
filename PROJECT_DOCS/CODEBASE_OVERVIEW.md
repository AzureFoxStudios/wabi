# Wabi Codebase Overview & Master Document

**Last Updated:** 2026-01-31

## 1. Project Overview

Wabi is a **private, self-hosted, and feature-rich real-time chat platform** designed for small to medium-sized communities. While its original philosophy was based on ephemeral (in-memory) data, the project has evolved to include a **persistent SQLite database** that supports a robust set of features, including user accounts, offline messaging, and detailed user customization.

The core mission remains focused on privacy and user control through self-hosting, opt-in logging, and support for client-side encryption.

### Key Features:
- **Persistent User Accounts:** Users can register accounts with passwords, profiles, and custom settings.
- **Real-time & Offline Messaging:** Supports both live chat via WebSockets and persistence of messages for offline users.
- **Advanced Theming Engine:** Highly customizable UI with a theme and uniform font system, persisted per user.
- **Real-time Collaboration:** Includes WebRTC-based screen sharing and an integrated Excalidraw whiteboard.
- **Role-Based Access Control (RBAC):** A permission system with roles like 'admin', 'mod', etc.
- **Client-Side Encryption Support:** The database schema includes tables for managing user encryption keys.
- **Extensibility:** A backend plugin system allows for adding new functionality.
- **Desktop & Web:** Runs as a web application and can be packaged as a native desktop application using Tauri.

---

## 2. Architecture

The application follows a classic client-server model, with a clear separation between the frontend and backend. The original "ephemeral" concept has been replaced by a persistent model centered around an SQLite database.

### High-Level System Design

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (SvelteKit + Tauri)             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Routes: Login, Chat, Draw, Screen Share, Settings   │   │
│  │ State: Svelte stores (users, channels, theme)       │   │
│  │ Real-time: Socket.IO client, WebRTC peer conns     │   │
│  │ API: REST client for user settings (e.g., themes)   │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────┬───────────────────────┬────────────────────────┘
             │ (REST API)            │ (WebSocket)
         HTTP/HTTPS              WSS/WS
             │                       │
┌────────────▼───────────────────────▼────────────────────────┐
│                  Backend (Node.js + Fastify)                │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ API: Fastify routes for auth, user settings, etc.   │    │
│  │ Real-time: Socket.IO event handlers                 │    │
│  │ Auth: JWT-based session management                  │    │
│  │ Plugins: Hot-loaded modules from /plugins           │    │
│  └──────────────────────────────────────────────────────┘    │
└────────────┬───────────────────────┬────────────────────────┘
             │                       │
             │ (File I/O)            │ (DB Queries)
             │                       │
    ┌────────▼─────────┐    ┌────────▼───────────────┐
    │  File Storage    │    │    SQLite Database    │
    │  /data/uploads   │    │      (chat.db)        │
    └──────────────────┘    └───────────────────────┘
```

### Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Frontend** | SvelteKit | Web framework with file-based routing and server-side rendering. |
| **Frontend State** | Svelte Stores | Reactive state management. |
| **Desktop Wrapper** | Tauri | Builds a native desktop application from the web frontend. |
| **Backend** | Node.js with Fastify | High-performance web framework for APIs and serving Socket.IO. |
| **Real-time API** | Socket.IO | Handles WebSocket-based real-time events. |
| **Database** | SQLite (via `better-sqlite3`) | Persistent storage for users, messages, settings, etc. |
| **P2P Media** | WebRTC | Peer-to-peer screen sharing and voice/video calls. |
| **Media Relay** | Coturn | A TURN server to relay WebRTC media across restrictive networks. |
| **Deployment** | Docker & Docker Compose | Containerization for all services. |
| **Reverse Proxy** | Caddy (recommended) | Handles SSL termination and proxying traffic to services. |

---

## 3. Data Model & Persistence

**This is the most significant evolution of the project.** The application is **no longer ephemeral**. It uses an SQLite database (`chat.db`) for persistent storage.

**Location:** `backend/src/db/database.ts` (connector), `backend/src/db/schema.sql` (schema)

### Key Database Tables (`schema.sql`):

-   `users`: Stores registered user accounts, including `username`, `password_hash`, profile details, and custom font settings.
-   `sessions`: Tracks active user sessions, for both registered and temporary users.
-   `offline_messages`: Persists chat messages for registered users who are offline, to be delivered on their next connection.
-   `theme_preferences`: Saves each user's theme and font customizations.
-   `user_roles`: Manages role-based access control (RBAC) by linking users to roles.
-   `resource_visibility`: Defines permissions for resources based on roles.
-   `user_encryption_keys`: Stores public keys and encrypted private keys to support client-side encryption.
-   `guest_codes`: Manages guest access to the platform.
-   `user_settings`: Stores user-specific preferences, like message retention policies.

This database model indicates a mature application with a strong focus on user-specific features and security.

---

## 4. Frontend Architecture

**Location:** `/frontend`

The frontend is a modern SvelteKit application responsible for the entire user experience.

### Key Systems:

-   **UI Components (`frontend/src/lib/components`):** A rich library of Svelte components builds the UI, including chat panels, user lists, modals, and collaborative tools. Recent efforts have standardized icons to SVGs for a polished look.
-   **State Management (`frontend/src/lib/socket.ts`):** Centralized Svelte stores manage reactive application state, such as the current user, list of users, channels, and messages. These stores are updated in real-time by Socket.IO events.
-   **Theme Engine (`frontend/src/lib/theme`):** A sophisticated theme system allows users to customize the application's appearance.
    -   It uses REST API calls to ` /api/user/theme` to persist settings to the backend database.
    -   It applies themes by setting CSS custom properties on the `:root` element.
    -   Recent bug fixes have improved error handling and logging for theme persistence.
-   **Authentication:** The frontend implements a JWT-based login flow. After a user logs in, the JWT is stored in `localStorage` and sent with subsequent API requests and the Socket.IO connection.
-   **Tauri Integration (`frontend/src-tauri`):** The project is configured to be wrapped by Tauri, allowing for cross-platform desktop builds.

---

## 5. Backend Architecture

**Location:** `/backend`

The backend is a Node.js application built with the Fastify framework. It serves as the central hub for business logic, real-time communication, and data persistence.

### Key Systems:

-   **Server (`backend/src/server.ts`):** The main entry point, which sets up the Fastify server, registers plugins (like Socket.IO and CORS), and defines routes.
-   **API Routes (`backend/src/api`):** RESTful endpoints for features like authentication (`authRoutes.ts`) and theme persistence (`themeRoutes.ts`).
-   **Socket.IO Handlers:** Manages all real-time events for chat, presence, WebRTC signaling, etc. The logic is organized into handlers for different features.
-   **Database Layer (`backend/src/db`):** Contains the SQLite database connection (`database.ts`), schema (`schema.sql`), and repositories that provide a clean interface for data access.
-   **Authentication (`backend/src/auth`):** Handles JWT creation and verification, password hashing, and role-based middleware.
-   **Plugin System (`backend/src/plugins`):** A loader system (`loader.ts`) that can dynamically load and initialize plugins from the `/plugins` directory, allowing for modular extension of backend functionality.

---

## 6. Deployment

The application is designed to be deployed using Docker.

-   **Docker Compose (`docker-compose.yml`):** The preferred method for orchestrating the `backend`, `frontend`, and `turn-server` services.
-   **Reverse Proxy:** Caddy is the recommended reverse proxy for handling SSL certificates and routing traffic, including WebSocket connections, to the correct services. See `DEPLOYMENT.md` for a sample `Caddyfile`.
-   **Environment Configuration:** The application is configured via `.env` files in the root, `frontend`, and `backend` directories. These control database paths, CORS settings, TURN server credentials, and more.
-   **DigitalOcean:** The project is actively deployed on the DigitalOcean App Platform. The `.do/app.yaml` file defines the infrastructure.
-   **Zero-Downtime Goal:** There is a recognized need to move towards a zero-downtime deployment strategy. `claude_Notes.txt` outlines a plan to use `docker-rollout` and SvelteKit's `updated` store to provide seamless updates to users.

---

## 7. Key Files & Directories Map

| Path | Description |
|---|---|
| **`/`** | |
| `README.md` | (Outdated) Project overview. |
| `ARCHITECTURE.md` | (Outdated) Detailed architecture document. |
| `docker-compose.yml` | Defines services for local development and deployment. |
| `.do/app.yaml` | DigitalOcean App Platform specification. |
| **`/backend`** | **Node.js Fastify Backend** |
| `backend/src/server.ts`| Main server entry point (Fastify). |
| `backend/src/db/schema.sql`| The definitive schema for the SQLite database. **Crucial for understanding the data model.** |
| `backend/src/api/`| Contains REST API route definitions. |
| `backend/src/auth/`| JWT, password hashing, and role middleware. |
| **`/frontend`** | **SvelteKit Frontend** |
| `frontend/src/routes/`| File-based routing for the SvelteKit application. |
| `frontend/src/lib/socket.ts` | Initializes the Socket.IO client and manages core reactive stores. |
| `frontend/src/lib/components/` | Contains the library of Svelte UI components. |
| `frontend/src/lib/theme/` | The powerful and persistent theming engine. |
| `frontend/src-tauri/`| Configuration for building the desktop application with Tauri. |
| **`/turn-server`**| Docker configuration for the Coturn TURN server. |
| **`/plugins`**| Directory for backend plugins. |

This document provides a high-level, up-to-date understanding of the Wabi codebase. For more granular details, refer to the key files listed above.
