# 🧩 Wabi Addon Architecture

**Version:** 3.0.0  
**Date:** April 28, 2026  
**Status:** Planning

---

## 🎯 Vision

**"Blender for Chat"** — A core application with optional addons that extend functionality.

### Principles

| Principle | What It Means |
|-----------|---------------|
| **Core is minimal** | Text chat, voice, DMs, calls. Nothing else required. |
| **Addons are optional** | Enable what you need. Server operators choose. |
| **Local-first** | Data lives on user's device by default. Server storage is opt-in. |
| **P2P first** | Money, files, data flow directly between users. Wabi is infrastructure. |
| **Legal protection** | Wabi enables, users/server operators comply. |
| **Rust where it matters** | Performance-critical, safety-critical, protocol logic in Rust. |
| **TypeScript where it helps** | Frontend UI, OAuth flows, provider SDKs. |

---

## 📁 Repository Structure

```
wabi/
├── core/                          # Wabi Base (the "blender binary")
│   ├── crates/
│   │   ├── wabi-core/             # Protocol types (Rust → TypeScript)
│   │   ├── wabi-stdb/             # STDB module (tables + reducers)
│   │   │   └── src/
│   │   │       ├── lib.rs         # All tables + reducers
│   │   │       ├── user.rs        # StateUser, auth reducers
│   │   │       ├── channel.rs     # StateChannel, channel reducers
│   │   │       ├── message.rs     # StateMessage, message reducers
│   │   │       ├── payment.rs     # StatePayment* tables (core, not addon)
│   │   │       └── voice.rs       # Voice channel state (future)
│   │   │
│   │   └── wabi-server/           # Main server binary
│   │       ├── src/
│   │       │   ├── main.rs        # Entry point
│   │       │   ├── api/           # HTTP API routes
│   │       │   │   ├── auth.rs    # Login/register
│   │       │   │   ├── channels.rs
│   │       │   │   ├── messages.rs
│   │       │   │   ├── payments.rs # Payment intent API (core)
│   │       │   │   └── voice.rs   # Voice channel API (future)
│   │       │   ├── websocket.rs   # Real-time connections
│   │       │   └── config.rs      # Server configuration
│   │       └── Cargo.toml
│   │
│   └── frontend/
│       ├── src/
│       │   ├── lib/
│       │   │   ├── core/          # Core UI (always loaded)
│       │   │   │   ├── chat/      # Message list, composer
│       │   │   │   ├── channels/  # Channel list, DMs
│       │   │   │   ├── voice/     # Voice channel UI (future)
│       │   │   │   └── calls/     # Call UI (future)
│       │   │   │
│       │   │   ├── payments/      # Payment UI (hidden until enabled)
│       │   │   │   ├── PaymentSheet.svelte
│       │   │   │   ├── PaymentHistoryModal.svelte
│       │   │   │   ├── ServerDonationModal.svelte
│       │   │   │   └── paymentTypes.ts
│       │   │   │
│       │   │   ├── addons/        # Addon runtime (dynamic loader)
│       │   │   │   ├── runtime.ts # Load/unload addons
│       │   │   │   ├── registry.ts # Addon manifest parsing
│       │   │   │   └── types.ts   # Addon interfaces
│       │   │   │
│       │   │   └── onboarding/    # First-run wizard
│       │   │       ├── Onboarding.svelte
│       │   │       └── steps/
│       │   │           ├── ServerSetup.svelte
│       │   │           ├── EnableAddons.svelte
│       │   │           └── PaymentConfig.svelte
│       │   │
│       │   └── routes/
│       │
│       └── package.json
│
├── addons/                        # Official addons
│   │
│   ├── media/                     # Media addons
│   │   ├── screen-share/          # Screen sharing (WebRTC-based)
│   │   │   ├── backend/
│   │   │   │   └── src/lib.rs    # Signaling, room management
│   │   │   ├── frontend/
│   │   │   │   └── ScreenShare.svelte
│   │   │   └── plugin.json
│   │   │
│   │   ├── albums/                # Photo albums, galleries
│   │   │   ├── backend/
│   │   │   │   └── index.ts      # Image storage, thumbnails
│   │   │   ├── frontend/
│   │   │   │   ├── AlbumView.svelte
│   │   │   │   └── GalleryGrid.svelte
│   │   │   └── plugin.json
│   │   │
│   │   └── maps/                  # Map viewer, location sharing
│   │       ├── backend/
│   │       │   └── index.ts      # Map tiles, location storage
│   │       ├── frontend/
│   │       │   ├── MapView.svelte
│   │       │   └── LocationShare.svelte
│   │       └── plugin.json
│   │
│   ├── content/                   # Content addons
│   │   ├── reader-mode/           # Article reader, read-it-later
│   │   │   ├── backend/
│   │   │   │   └── index.ts      # URL parsing, content extraction
│   │   │   ├── frontend/
│   │   │   │   ├── ReaderView.svelte
│   │   │   │   └── ReadingList.svelte
│   │   │   └── plugin.json
│   │   │
│   │   ├── 3d-viewer/             # 3D model viewer
│   │   │   ├── backend/
│   │   │   │   └── index.ts      # Model storage, metadata
│   │   │   ├── frontend/
│   │   │   │   ├── ModelViewer3D.svelte
│   │   │   │   └── ModelLoader.worker.ts
│   │   │   └── plugin.json
│   │   │
│   │   ├── youtube-sync/          # YouTube watch together
│   │   │   ├── backend/
│   │   │   │   └── index.ts      # Sync state, playlist management
│   │   │   ├── frontend/
│   │   │   │   └── YouTubeWatchEmbed.svelte
│   │   │   └── plugin.json
│   │   │
│   │   └── spotify-sync/          # Spotify sync
│   │       ├── backend/
│   │       │   └── index.ts      # Spotify API integration
│   │       ├── frontend/
│   │       │   └── SpotifyControlsEmbed.svelte
│   │       └── plugin.json
│   │
│   ├── payments/                  # Payment addons
│   │   ├── payments-core/         # Payment infrastructure (Rust + TS)
│   │   │   ├── backend/
│   │   │   │   ├── src/
│   │   │   │   │   ├── lib.rs    # Payment gateway abstraction
│   │   │   │   │   ├── intent.rs # Intent lifecycle
│   │   │   │   │   ├── webhook.rs# Webhook verification
│   │   │   │   │   └── types.rs  # PaymentIntent, PaymentEvent
│   │   │   │   └── Cargo.toml
│   │   │   ├── frontend/         # None — uses core UI
│   │   │   └── plugin.json
│   │   │
│   │   ├── payments-bitcoin/      # Bitcoin provider (TypeScript)
│   │   │   ├── backend/
│   │   │   │   └── index.ts      # BIP21 QR, Lightning, adapter client
│   │   │   ├── frontend/
│   │   │   │   └── BitcoinSettings.svelte
│   │   │   └── plugin.json
│   │   │
│   │   ├── payments-thailand/     # Thailand PromptPay (TypeScript)
│   │   │   ├── backend/
│   │   │   │   └── index.ts      # EMVCo QR, PSP adapter
│   │   │   ├── frontend/
│   │   │   │   └── PromptPaySettings.svelte
│   │   │   └── plugin.json
│   │   │
│   │   └── payments-psp/          # Stripe/PayPal/Gumroad (TypeScript)
│   │       ├── backend/
│   │       │   ├── index.ts      # OAuth flows, checkout links
│   │       │   ├── stripe.ts
│   │       │   └── paypal.ts
│   │       ├── frontend/
│   │       │   └── PSPConnect.svelte
│   │       └── plugin.json
│   │
│   ├── art-assets/                # Art asset management
│   │   ├── backend/
│   │   │   └── index.ts          # Asset storage, versioning
│   │   ├── frontend/
│   │   │   └── ArtAssetsOverlay.svelte
│   │   └── plugin.json
│   │
│   ├── webhooks/                  # Webhook delivery (moved from wabi-server)
│   │   ├── backend/
│   │   │   ├── src/
│   │   │   │   ├── lib.rs        # HTTP delivery, retry logic
│   │   │   │   └── types.rs      # WebhookEvent, DeliveryStatus
│   │   │   └── Cargo.toml
│   │   └── plugin.json
│   │
│   ├── mesh/                      # Multi-node sync (moved from wabi-server)
│   │   ├── backend/
│   │   │   ├── src/
│   │   │   │   ├── lib.rs        # Node discovery, state sync
│   │   │   │   └── types.rs      # MeshNode, SyncState
│   │   │   └── Cargo.toml
│   │   └── plugin.json
│   │
│   └── compliance/                # Compliance/auditing addons
│       └── server-auditor/        # Optional server-side archival
│           ├── backend/
│           │   └── src/lib.rs    # Message archival, export, retention policies
│           ├── frontend/
│           │   ├── AuditDashboard.svelte
│           │   └── RetentionSettings.svelte
│           └── plugin.json
│
├── plugins/                       # Runtime install directory (gitignored)
│   └── (addons are copied here when enabled)
│
├── docs/
│   ├── addons/
│   │   ├── creating-addons.md
│   │   ├── addon-security.md
│   │   └── publishing.md
│   │
│   └── payments/
│       ├── architecture.md
│       ├── legal-notes.md
│       └── provider-setup.md
│
└── scripts/
    ├── addon-pack.sh              # Package addon as .wabip
    ├── addon-sign.sh              # Sign addon with Ed25519
    └── addon-verify.sh            # Verify addon signature
```

---

## 💾 Local-First Storage Model

**Default:** All data lives on the user's device (IndexedDB + local files).

**Server storage:** Opt-in via `server-auditor` addon or server operator policy.

### Storage Tiers

| Tier | Location | Use Case | Sync |
|------|----------|----------|------|
| **Local** | User's IndexedDB | Messages, channels, settings | P2P sync (CRDT) |
| **Server-cache** | Server RAM/SSD | Recent messages, online users | Volatile (restart = lost) |
| **Server-archival** | Server SSD (auditor addon) | Full history, compliance | Persistent |
| **User-backup** | User's export file | Personal backup | Manual export/import |

### Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│  User sends message                                          │
│                                                              │
│  1. Store in local IndexedDB (immediate)                     │
│  2. Broadcast via WebSocket to server                        │
│  3. Server broadcasts to other online users                  │
│  4. Other users store in their local IndexedDB               │
│                                                              │
│  Optional (if server-auditor addon enabled):                 │
│  5. Server stores in archival table (STDB or filesystem)     │
│  6. Offline users can fetch history when they reconnect      │
└──────────────────────────────────────────────────────────────┘
```

### STDB Usage

| Table | Purpose | Stored Where |
|-------|---------|--------------|
| `StateUser` | User accounts | Server (authoritative) |
| `StateChannel` | Channel definitions | Server (authoritative) |
| `StateMessage` | Message metadata (IDs, timestamps) | Server (optional cache) |
| `StatePaymentIntent` | Payment records | Server (authoritative — financial) |
| `StateSession` | Auth sessions | Server (authoritative) |

**Key insight:** STDB is the **coordination layer**, not the **database of record**.

- Users have full chat history locally
- Server has minimal state (user accounts, channel definitions)
- Optional: Server archives messages for compliance/backup

### Server Auditor Addon

```rust
// addons/compliance/server-auditor/backend/src/lib.rs

pub struct AuditorConfig {
    pub enabled: bool,
    pub retention_days: u32,      // 0 = forever
    pub export_format: ExportFormat, // JSON, CSV, MBOX
    pub include_deleted: bool,    // Archive even deleted messages
    pub encryption_key: Option<String>, // Encrypt archives at rest
}

pub trait Auditor {
    // Archive incoming messages
    async fn archive_message(&self, msg: &ArchivedMessage) -> Result<()>;
    
    // Export data for compliance request
    async fn export_range(
        &self,
        channel_id: &str,
        start: i64,
        end: i64,
    ) -> Result<Vec<ArchivedMessage>>;
    
    // Delete old messages per retention policy
    async fn apply_retention(&self, max_age_days: u32) -> Result<u32>;
}
```

**Server operator enables this if:**
- They want message history to survive server restarts
- They have compliance requirements (business use)
- They want to offer history to users who rejoin

**Server operator skips this if:**
- Ephemeral chat is desired (no history)
- Privacy-focused server (nothing stored server-side)
- Minimal resource usage (no archival overhead)

---

## 🔌 Addon System Design

### Addon Manifest (`plugin.json`)

```json
{
  "id": "payments-bitcoin",
  "name": "Bitcoin Payments",
  "version": "1.0.0",
  "description": "Accept Bitcoin via QR or Lightning",
  "author": "Wabi Core",
  "license": "MIT",
  
  "dependsOn": ["payments-core"],
  "conflictsWith": [],
  
  "permissions": [
    "payments:intent:create",
    "payments:intent:read",
    "user:settings:write"
  ],
  
  "security": {
    "threatNotes": "Non-custodial only. User configures their own Bitcoin address.",
    "dataAccess": ["user_payment_settings"],
    "networkAccess": ["outbound:bitcoin-adapter.example.com"]
  },
  
  "backend": {
    "language": "typescript",
    "entry": "./backend/index.ts",
    "runtime": "node20"
  },
  
  "frontend": {
    "entry": "./frontend/BitcoinSettings.svelte",
    "mountPoint": "settings/payments"
  },
  
  "payment": {
    "providerName": "Bitcoin",
    "countries": [],
    "currencies": ["BTC"],
    "methods": [
      {
        "id": "bitcoin_qr",
        "label": "Bitcoin QR",
        "checkoutModes": ["qr", "app_switch"]
      }
    ],
    "nonCustodialOnly": true
  },
  
  "integrity": {
    "algorithm": "sha256",
    "checksum": "<sha256-of-packaged-addon>"
  },
  
  "signer": {
    "keyId": "ed25519:<fingerprint>",
    "publicKey": "<pem-public-key>",
    "algorithm": "ed25519"
  }
}
```

### Addon Lifecycle

```
1. Install
   └─→ Copy addon folder to plugins/
   └─→ Validate plugin.json
   └─→ Verify signature (if present)
   └─→ Scan for malware (optional)

2. Enable
   └─→ Load backend (Rust: load crate, TS: require entry)
   └─→ Register hooks (API routes, websocket handlers)
   └─→ Mount frontend UI (if any)
   └─→ Run onLoad() hook

3. Runtime
   └─→ Handle API requests
   └─→ Process websocket events
   └─→ Store data (via STDB or addon storage)

4. Disable
   └─→ Run onUnload() hook
   └─→ Unregister hooks
   └─→ Unmount frontend UI
   └─→ Keep data (user can re-enable)

5. Uninstall
   └─→ Run onUninstall() hook
   └─→ Delete addon folder from plugins/
   └─→ Optionally delete addon data
```

### Addon Hooks (Rust API)

```rust
// addons/payments-core/backend/src/lib.rs

pub trait PaymentProvider {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    
    async fn create_intent(
        &self,
        ctx: &AddonContext,
        params: CreateIntentParams
    ) -> Result<PaymentIntent>;
    
    async fn get_status(
        &self,
        ctx: &AddonContext,
        intent_id: &str
    ) -> Result<IntentStatus>;
    
    async fn generate_qr(
        &self,
        ctx: &AddonContext,
        intent: &PaymentIntent
    ) -> Result<String>;
    
    async fn verify_webhook(
        &self,
        ctx: &AddonContext,
        payload: &str,
        signature: &str
    ) -> Result<WebhookEvent>;
}

// Addon context provides:
pub struct AddonContext {
    pub stdb: StdbClient,          // Query/mutate STDB tables
    pub storage: AddonStorage,     // Key-value storage for addon
    pub logger: AddonLogger,       // Namespaced logging
    pub config: AddonConfig,       // Addon configuration
}
```

---

## 💰 Payment System Design

### Legal Model

> **Wabi is infrastructure, not a financial service.**
>
> - Wabi stores payment intent records (like storing a message)
> - Wabi generates payment requests (like generating an invoice)
> - Wabi does NOT hold, transmit, or process funds
> - All payments settle directly between users via external providers
> - Server operators are responsible for their own compliance

### Data Flow

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│   Payer      │         │   Wabi       │         │   Payee      │
│              │         │              │         │              │
│ 1. Click $    │────────▶│              │         │              │
│              │         │ 2. Create    │         │              │
│              │         │    intent    │         │              │
│              │         │    (STDB)    │         │              │
│              │◀────────│              │         │              │
│ 3. Show QR  │         │              │         │              │
│    or link  │         │              │         │              │
│              │         │              │         │              │
│ 4. Pay via  │─────────────────────────────────▶│ 5. Receive   │
│    external │         │              │         │    funds     │
│    provider │         │              │         │              │
│              │         │              │         │              │
│ 6. Confirm  │────────▶│              │         │              │
│    (webhook)│         │ 7. Update    │         │              │
│              │         │    intent    │         │              │
│              │         │    status    │         │              │
│              │◀────────│              │◀────────│              │
│ 8. Show     │         │ 9. Notify    │         │              │
│    "Paid"   │         │    payee     │         │              │
└──────────────┘         └──────────────┘         └──────────────┘
```

### Provider Implementation

| Provider | Language | Why |
|----------|----------|-----|
| **payments-core** | Rust | Intent lifecycle is safety-critical, performance matters |
| **payments-bitcoin** | TypeScript | BIP21 libraries, adapter SDKs in JS ecosystem |
| **payments-thailand** | TypeScript | PromptPay libraries, PSP SDKs in JS |
| **payments-psp** | TypeScript | Stripe/PayPal SDKs are JS-first |
| **webhooks** | Rust | HTTP delivery needs retry logic, performance |

---

## 🚀 Implementation Phases

### Phase 1: Core Separation (Week 1)

- [ ] Move `wabi-node` → `core/crates/wabi-server`
- [ ] Extract payment tables to `core/crates/wabi-stdb/src/payment.rs`
- [ ] Move payment UI to `core/frontend/src/lib/payments/`
- [ ] Create `addons/payments-core/` Rust crate
- [ ] Implement `PaymentProvider` trait in Rust

### Phase 2: Provider Reorg (Week 2)

- [ ] Move `plugins/btc-payments` → `addons/payments-bitcoin/`
- [ ] Move `plugins/th-payments` → `addons/payments-thailand/`
- [ ] Create `addons/payments-psp/` (Stripe/PayPal)
- [ ] Split monolithic `index.mjs` into modules
- [ ] Update plugin manifests with new structure

### Phase 3: Addon Runtime (Week 3)

- [ ] Implement addon loader in `core/frontend/src/lib/addons/`
- [ ] Create `addons/3d-viewer/`, `youtube-sync/`, etc.
- [ ] Move `webhooks.rs` → `addons/webhooks/` (Rust)
- [ ] Move `mesh.rs` → `addons/mesh/` (Rust)
- [ ] Test enable/disable flow

### Phase 4: Onboarding (Week 4)

- [ ] Create `core/frontend/src/lib/onboarding/`
- [ ] First-run wizard (server setup, addon selection)
- [ ] Payment configuration step
- [ ] Settings → Addons panel
- [ ] Documentation

---

## 📋 Addon Checklist

When creating an addon:

- [ ] Create `plugin.json` manifest
- [ ] Implement backend (Rust or TS)
- [ ] Implement frontend UI (if needed)
- [ ] Define permissions in manifest
- [ ] Write `security.threatNotes`
- [ ] Generate checksum (`sha256sum -b`)
- [ ] Sign with Ed25519 (optional but recommended)
- [ ] Test install/enable/disable/uninstall
- [ ] Document in `docs/addons/`

---

## 🔒 Security Model

### Permission System

```typescript
type Permission = 
  | 'user:read'
  | 'user:write'
  | 'channel:read'
  | 'channel:write'
  | 'message:read'
  | 'message:write'
  | 'payments:intent:create'
  | 'payments:intent:read'
  | 'webhook:send'
  | 'network:outbound';
```

### Addon Sandboxing

| Layer | Implementation |
|-------|---------------|
| **Filesystem** | Addons can only read their own folder |
| **Network** | Outbound only, domains declared in manifest |
| **STDB** | Read/write via context, no direct access |
| **Storage** | Namespaced key-value store per addon |
| **Signing** | Ed25519 signatures verified on load |

---

## 📝 Notes

### Why Rust for payments-core?

1. **Safety** — Intent lifecycle is money-adjacent, no room for errors
2. **Performance** — High throughput, low latency
3. **Type safety** — Rust types → TypeScript types via ts-rs
4. **Consistency** — Matches wabi-server, wabi-stdb

### Why TypeScript for providers?

1. **Ecosystem** — Stripe, PayPal, Bitcoin SDKs are JS-first
2. **Rapid iteration** — Provider logic changes often
3. **OAuth flows** — Easier in JS (redirect handling, tokens)
4. **Less critical** — Provider bugs affect one payment method, not all

### Why payments in core STDB?

1. **Protocol** — Payment intents are like messages (core data)
2. **Consistency** — All servers have same schema
3. **Simplicity** — No separate module to manage
4. **Legal** — Storing intent records ≠ processing payments

---

## 🎯 Success Criteria

- [ ] Server operator can enable/disable addons in Settings
- [ ] First-run wizard asks about payments, suggests addons
- [ ] Bitcoin payments work end-to-end (QR → payment → confirm)
- [ ] Thailand PromptPay works end-to-end
- [ ] Stripe/PayPal "bring your own account" flow works
- [ ] Server donations visible in server info panel
- [ ] 3D viewer loads as addon (not core)
- [ ] YouTube sync loads as addon (not core)
- [ ] Webhooks/mesh can be disabled (not core)
- [ ] Addon signing/verification works

---

**This document is the source of truth for the addon architecture.**
All implementation should follow this design.
