# Wabi DM Mode — Design & Architecture Evaluation Request

You are evaluating a greenfield DM (Direct Message) system for **Wabi**, a self-hosted chat app built with SvelteKit + TypeScript (frontend) and Rust (backend with wabiDB event-store database). Your task: produce a holistic evaluation covering UX design, architecture, and implementation plan for a DM mode that can operate independently from the app's community/channel features.

This is NOT a feature request — I want your original analysis, design thinking, and implementation judgment. Be critical. Point out flaws in my existing approach. Suggest alternatives I haven't considered. The final deliverable from you should be a comprehensive written evaluation.

---

## 1. PROJECT CONTEXT

### What Wabi is
- A self-hosted chat app (like Discord/Slack but you run your own server)
- **Frontend:** SvelteKit, TypeScript, vanilla CSS with CSS custom properties for theming
- **Backend:** Rust server + wabiDB (embedded event-store database with AES-256-GCM per-stream encryption, lock-free SkipMap projections)
- **Design:** Dark cosmic/nebula theme — deep indigo/purple (#0f0c29, #1a1a2e, #24243e, #302b63), indigo accent (#6366f1), frosted glass effects, subtle gradients
- **Layout:** Three-panel — Server Rail (92px) | Channel Sidebar (240px, resizeable) | Center Chat | Right Panel (320px, resizeable)

### Current state of Direct Messages
DM was **fully built** (with E2E encryption, DM list panel, conversation view, CreateDMModal) then **completely stripped** on June 16, 2026 ("DM-strip") because it kept getting broken by overlapping changes. The codebase now has:
- Socket stubs: `createDM(_userId)` is a no-op, `getDMChannelIdForUser(_,_)` returns `""`
- Layout stores still active: `selectedDmChannelId`, `dmOtherUser`, `openDM()`, `closeDM()`, `showDMsTab()` all work
- The right-panel DMs slot in `WorkspacePanelHost.svelte` renders **nothing** (empty `{:else if panel.component === 'dms'}`)
- Orphaned CSS classes still exist in `mobile.css` and `accessibility.css` (`.dm-panel`, `.dm-username`, `.dm-list-panel`, etc.)
- Old CSS files (`dm-tab.css`, `dm-message-view.css`) and `CreateDMModal.svelte` exist in backup but are not wired in
- Channel type `'dm'` and `'group'` exist in the protocol spec as first-class types
- The DM panel is registered as a `WorkspacePanelManifest` with id `'dms'` and component key `'dms'` — the manifest exists, the component doesn't
- Channel sidebar explicitly filters out `type === 'dm'` channels
- DMs render in the CENTER pane (like channels) via `Chat.svelte` when `currentChannelData.type === 'dm'`

---

## 2. CORE PHILOSOPHY (non-negotiable)

The following principles MUST shape the DM system. Challenge them if you disagree, but know they are the product's identity:

### Tool, not SaaS
Wabi is a **tool** (like a hammer), not a **service** (like Uber). Users own their data, run their own server, control their experience. Every design decision should ask: "does this give the user more control or less?"

### People-first, not channels-first
The People list (address book) is the FIRST surface a user sees after signing in, not a side panel. DMs are relationships, not threads. A DM exists because two specific people chose to talk — it has its own state, visual identity, history, and retention rules independent of any server.

### Encryption is non-negotiable
"The server MUST NOT be able to read DM contents. Not 'we promise not to look.' Structurally." E2E for message bodies. Server holds ciphertext only. Metadata exposure (who, when, message count) is honest and visible. Single-device key for v1 with honest banner; multi-device sync for v2 with opt-in tradeoff.

### Memory is what the user says
Retention ladder following Snapchat/Session: `view once / 30s / 1m / 5m / 10m / 30m / 1h / 1d / 1w / 1mo / forever`. Default 1 week. Per-conversation, per-message. "Forever" uses a local sidecar (IndexedDB web, file-backed Tauri), not server persistence.

### LINE mode (DM-first layout) is a first-class home view, not an extra
Many users from LINE/Signal/WhatsApp only want DMs. The app must support a "personal messenger" layout where:
- The home view shows People + DMs + Notes, with a single "browse servers" entry
- Server channels are still accessible but hidden by default
- The personal section has its own theme/layout independent of any server
- Switching between "DM focused" and "server browser" modes is one tap, no confirmation
- This mode travels with the account, not the device

### DMs vs Group Messages
- DM (1:1) = two people, a conversation. Group (3+) = named, participant-driven, has an owner, explicit membership.
- Group messages are NOT smaller channels and NOT DMs with extra people. They're their own type.
- Group messages are encrypted (same as DMs). Read state is shared (who has read it). Retention is a group property set by owner.
- Groups can be promoted to channels and channels demoted to groups — one click each way.

---

## 3. WHAT I NEED FROM YOU

Produce a comprehensive evaluation with three sections:

### A. UX / Design Analysis
- How should the DM-first home layout (LINE mode) look and behave? Propose a concrete layout.
- How does the user discover and start DMs? (People-first address book)
- How does the DM list panel in the right sidebar work? (conversation list with unread, last message preview, status dot)
- What does an active DM conversation look like in the center pane? (encryption indicator, retention badge, call buttons, no @mention model, "promote to note" action)
- How does the mode toggle (DM-focused vs server-browser) work visually?
- How does the retention ladder UI work? (picker, default, per-conversation, visual treatment for ephemeral messages)
- How do group DMs differ visually from 1:1 DMs?
- What's the DM request/accept flow? (opt-in by default, pending state, notification)

### B. Architecture Analysis
- How should the three new surfaces (`DmListPanel`, `DmConversationView`, `DmFocusLayout`) fit into the existing SvelteKit component tree?
- How should the home-layout switcher work? (setting `ui.homeLayout`: `'server-browser'` vs `'dm-focused'`, persisted locally)
- How does E2E encryption integrate with the existing wabiDB storage? (key generation, key storage, ciphertext storage, nonce handling)
- How does the retention ladder interact with the storage layer? (ciphertext deletion, local sidecar for "forever")
- How does read state work differently for DMs vs channels?
- How does presence/typing work differently in DMs vs channels?

### C. Implementation Plan
- What is the minimum rebuild order to get a working DM system?
- What should be rebuilt from the old code vs written fresh?
- What are the highest-risk areas? (encryption, key management, the layout switcher)
- What explicit deferrals should v1 have? (what goes in v2?)
- How do you test a system where the server cannot read plaintext?
- What's the migration path for users who had DMs before the strip?

---

## 4. CONSTRAINTS & BOUNDARIES

### Do NOT propose:
- A separate login/auth for DM mode (single sign-in for both modes)
- Server-side full-text search of DM contents (client-side only)
- Mandatory note titles, reactions on notes, shared notes (notes are personal)
- SaaS features, usage quotas, or billing tied to DM count
- Any design that makes the server admin able to read DM plaintext

### Do NOT assume:
- That users read documentation (the UI must be self-explanatory)
- That every user wants both modes (LINE mode users may never browse servers)
- That the existing channel chat component can be reused as-is for DMs (DMs have fundamentally different social dynamics)

### Technology constraints:
- Frontend: SvelteKit + TypeScript + vanilla CSS (no component library, no Tailwind)
- CSS custom properties for theming, `backdrop-filter: blur()`, `color-mix()` for accent overlays
- Storage: wabiDB embedded event-store (SkipMap projections, AES-256-GCM per stream)
- Layout: Three-panel responsive system with resizeable panels

---

## 5. DELIVERABLE FORMAT

Return a structured evaluation with clear headings. Be specific — reference concrete UI elements, component names, data structures, and code patterns. Include ASCII diagrams for layout proposals. State your assumptions explicitly. Flag any place where you're uncertain and need more information.

BE CRITICAL. If the existing vision document makes mistakes, say so. If the LINE mode concept conflicts with E2E encryption in a specific way, explain the conflict. If the retention ladder is impractical for v1, propose a simpler v1 with the full ladder deferred.

The goal is not agreement — it's the sharpest possible analysis I can get from you.

---

# Follow-up: Corrections & Codebase Reality

This update is sent after reviewing all initial responses. It corrects a critical misunderstanding about Wabi's architecture and provides real codebase state that most models lacked.

## Critical correction: Wabi is NOT federated

Multiple responses assumed a cross-server address book or unified People directory. This is wrong.

**Wabi's network model:**
- Wabi is a **self-hosted tool**, not a federated network
- There is a basic server list that updates only after you make a *successful connection* to another instance
- Otherwise, Wabi acts as if it's the only server in existence
- Users CAN make friends between the voids of servers (manual contact exchange), but the system does not seek nor assume it will connect islands
- It is a tool that CAN connect islands but doesn't assume it will

**What this means for the DM system:**
- The People list is **not** a universal address book. It is the roster of the currently active server, plus any manually added external contacts
- External contacts from other servers are **inert** until you switch to that server — no presence, no cross-server DMs
- A user on a fresh self-hosted instance with no server members sees an **empty People list**. LINE mode onboarding must account for this
- Cross-server DMs do not exist in v1. You can only DM people on your current server. This is honest about the "tool that connects islands" model
- The "People list as front door" works — but only when there are people to show. For a single-user server, the first interaction is "invite someone or join a community"

**All models should revise their UX/architecture proposals to assume a single-server scope with optional manual external contacts.**

## Codebase reality (what the models didn't have access to)

Most responses assumed a harder rebuild than it actually is. Here's the real state of the codebase as of June 30, 2026:

### Already working (no rebuild needed):
- `selectedDmChannelId`, `dmOtherUser`, `selectedGroupChannel` writable stores — fully active
- `openDM()`, `openGroupDM()`, `openNotes()`, `closeDM()`, `showDMsTab()` — all functional
- `getDMOtherUser()` in `userLookupStore.ts` — fully implemented, returns `channel.otherUser` or finds via members
- `WorkspacePanelManifest` for `'dms'` — exists with correct manifest entry (id, label, icon, component key, capabilities)
- Channel type `'dm'` and `'group'` — first-class protocol types, backend handles them
- Socket events (`dm-created`, `dm-channel-added`) — still fire on the backend
- `ChannelSidebar.svelte` — already filters out `type === 'dm'` channels (correct behavior)
- `Chat.svelte` — already renders DMs in center pane when `currentChannelData.type === 'dm'`
- Call initiation (`startDMVoiceCall`, `startDMVideoCall`) — fully implemented, UI buttons in `ChatHeader.svelte`
- DM payment targeting — fully implemented
- Layout stores for right panel — `rightPanelView`, `activeRightTab`, `channelSidebarWidth`, `rightPanelWidth` all functional

### Stubbed (needs implementation, not architecture):
- `createDM(userId)` in `socket.ts` — currently a no-op. Needs to emit `create-dm` socket event
- `getDMChannelIdForUser()` in `socket.ts` — returns `""`. Needs channel lookup from `channelStore`
- `WorkspacePanelHost.svelte` `'dms'` slot — renders nothing. Needs `<DmListPanel />`

### In backup (salvageable):
- `dm-tab.css` — 819 lines, polished glass-morphism DM list styling. Needs CSS variable name updates
- `dm-message-view.css` — 847 lines, DM thread styling with bubbles, retention controls, headers. Needs CSS variable name updates
- `CreateDMModal.svelte` — UI structure salvageable, but modal pattern is wrong for people-first. Inline picker preferred

### Total rebuild cost estimate:
- **New components:** 4 (`DmListPanel`, `DmConversationView`, `DmFocusLayout`, `DmRail`)
- **Edited files:** 2 (`socket.ts` un-stub, `WorkspacePanelHost.svelte` wire component)
- **New stores:** 1 (`ui.homeLayout` preference, persisted locally)
- **CSS:** 2 files ported from backup with variable updates

## Adjusted build order (scoped for speed, not weeks)

Each phase is independently shippable and testable.

### Phase 0 — Foundation
- Crypto module: X25519 keygen + AES-256-GCM encrypt/decrypt + test vectors
- Recovery phrase: BIP39 mnemonic → wraps private key → encrypted blob stored server-side
- Un-stub `createDM()` and `getDMChannelIdForUser()` (2 files, socket layer only)

### Phase 1 — Working DMs
- `DmListPanel.svelte` — fills the empty `{dms}` slot in `WorkspacePanelHost`
- `DmConversationView.svelte` — build fresh, share only headless utilities with `Chat.svelte`
- Wire into existing layout stores (already work)

### Phase 2 — Social boundaries
- DM request/accept flow (opt-in default, pending state, inline accept/decline)
- Quick-reaction bar on message hover (thumbs up, heart, etc.) — replaces read receipts
- Honest banners: "single device · key not backed up · server cannot read"

### Phase 3 — Retention + LINE mode
- 4-rung retention picker (1h / 1d / 1w / keep-on-device), conversation-level only
- Server-side TTL cleanup (wabiDB compaction pass, deletes ciphertext by timestamp)
- LINE mode: single-column layout, People drawer, browse-servers at bottom
- Mode toggle: expand scope (not teleport)

### Phase 4 — Groups (late v1 / v2)
- Group DMs: pairwise E2E fanout, max 8 members
- Group read state: "read by N/M" (not per-message read receipts)
- Promote/demote group ↔ channel (with typed security confirmation, never one-click)

## Key decisions that gated all responses

### 4-rung retention, not 11
v1 ships: 1 hour / 1 day / 1 week (default) / keep-on-device. Full 12-rung ladder deferred to v2. Per-message retention override deferred. This cuts ~70% of the failure surface while keeping the philosophy.

### No read receipts — quick reactions instead
Read receipts cause documented anxiety (Signal's own UX research confirms this). Ship a quick-reaction bar (thumbs up, heart, etc.) on message hover instead. Read receipts are an opt-in toggle, off by default. The social signal ("they saw it") is better served by a lightweight reaction than by a timestamp-display anxiety loop.

### "Forever" is NOT a local sidecar
Simplified for v1: "forever" = no TTL on server ciphertext. The server already cannot read it (E2E). No IndexedDB sidecar, no "best effort" disclaimer, no device-bound caveat. The ciphertext stays on the server indefinitely. For users who want truly device-local copies, an export/backup feature can be added later. This eliminates the entire "local sidecar" complexity while maintaining the security model.

### Single-device key is honest, not a failure
The banners must say: "Your messages are end-to-end encrypted. Your encryption key lives on this device. If you lose access to this device or clear your browser data, your messages cannot be recovered." A recovery phrase (encrypted blob server-side, unlocked by BIP39 mnemonic) is the v1.5 safety net — but v1 ships the honest single-device limitation.

### Build DmConversationView fresh, do not fork Chat.svelte
The old DM-strip happened because DMs shared a render path with channels. `DmConversationView` should share only headless utilities (message virtualization, composer textarea) but have its own render tree. The `type === 'dm'` path in `Chat.svelte` is the trap — rip it out.

## Prominent feature comparison (initial responses)

Across all responses, two evaluations stood out as most useful:

**Battle 2** produced the sharper structural criticism — it identified 8 concrete internal contradictions in the vision doc (single-device vs account-portable, forever = least portable, promote group→channel = E2E-to-plaintext downgrade, Chat.svelte reuse trap, type-discriminator code smell, etc.) and presented them as an actionable conflict matrix with severity ratings and resolution paths. Its treatment of the E2E↔plaintext boundary during promote/demote operations was the single most insightful point across all responses.

**Battle 1** produced stronger concrete layout proposals (ASCII diagrams with pixel widths, detailed row anatomy) and a more practical v1 scope definition. Its People-list-as-front-door treatment was the most detailed.

Both missed the non-federated reality. Both overestimated the rebuild cost. Both assumed ✓/✓✓ read receipts as a given.

The final implementation plan above incorporates the strongest recommendations from both: Battle 2's structural honesty and conflict-awareness combined with Battle 1's concreteness and scope discipline.
