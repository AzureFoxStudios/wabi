# Wabi + Lore: Self-Hosted Creative Collaboration Hub

> **Status:** Vision / Brainstorming
> **Date:** 2026-07-01
> **Authors:** Ronin, opencode
> **Context:** After investigating a security scan, the conversation pivoted when EpicGames/lore was discovered. What started as a "check these Caddyfile issues" evolved into a product vision for Wabi's next paradigm.

---

## 1. Why This Matters

Wabi's core is real-time communication for communities. But the people who run self-hosted platforms aren't just chatting — they're **building things together**.

**Current tools are fragmented:**
- Discord for chat, GitHub for code, Figma for design, Perforce for assets
- Context-switching overhead kills momentum
- No single self-hosted platform ties it together

**This is the gap Wabi can fill:**
A single self-hosted binary that gives you chat, voice, project workspaces, version control, role-based collaboration, and live broadcasting.

> "One-wabi-fits-all" — not just a chat app, but a creative workspace hub.

---

## 2. What Lore Is

EpicGames/lore (https://github.com/EpicGames/lore) is a next-generation, open source version control system optimized for projects that combine code with large binary assets, including games and entertainment.

### Key Technical Traits (Mid-2026)

| Trait | Detail |
|---|---|
| **License** | MIT — fully open source, self-hostable |
| **Language** | Rust (81.7%), Python (14%), C (4%) |
| **Server model** | Centralized service with caching layer — runs as a server, not just a CLI |
| **Storage** | Content-addressed (Merkle trees), immutable revision chain |
| **Binary assets** | Chunked storage with deduplication, sparse/on-demand hydration |
| **Scalability** | "Millions of files, terabytes per file, millions of revisions, hundreds of branches, thousands of concurrent users, hundreds of repos" |
| **APIs** | C, C++, C#, Rust, Go, Python, JavaScript |
| **Current state** | Pre-1.0 (v0.8.4 as of June 2026), active development |
| **Built for** | Games + entertainment (UEFN-backed), but general-purpose |

### What Lore Does Well

- **Binary-first design** — treats blobs and code equally under content-addressed storage
- **Sparse hydration** — working copies only pull what's needed (hours-long downloads become instant)
- **File locking** — one person holds the write lock (Perforce-style), others see "In Use by X"
- **Lightweight branches** — fast create/switch, low overhead, no duplication
- **Multi-tenant safe** — repos don't leak across tenants even with content hash guesses
- **Role-based access** — boundaries map naturally to Wabi's permission system

### What Lore Does NOT Do

- **Real-time collaborative editing** — no CRDTs, no operational transforms, no live cursors
- **Built-in chat or presence** — it's VCS, not communication
- **GUI for non-technical users** — CLI-first (though UEFN integration exists)

---

## 3. The Insight: Lore as Wabi's Storage Engine

The mental model is not "bolt Lore onto Wabi."
The mental model is: **Project workspace channels powered by Lore.**

| Wabi channel type | What it stores | Backed by |
|---|---|---|
| Text channel | Messages | Wabidb |
| Voice channel | Calls / presence | WebRTC + coturn |
| **Project channel** | **Code, assets, docs, versions** | **Lore** |

This means:
- Wabi handles **communication + collaboration UX** (chat, presence, roles, WebSocket sync, live viewers)
- Lore handles **storage + versioning + asset management** (content-addressing, chunking, locking, sparse hydration, branching)
- The addon bridges the two — provision a Lore repo per project channel, expose the tree in the frontend, map Wabi roles to Lore access boundaries

### Why This Fits the Philosophy

| Wabi principle | How this aligns |
|---|---|
| Self-hosted | Lore server runs alongside wabi-server (Docker compose profile) |
| MIT licensed | Both projects are MIT |
| Rust core | Lore's Rust API integrates directly into wabi-server |
| Privacy-first | All data stays on the operator's machine |
| Addon architecture | Project workspace = first-class addon, not core bloat |

---

## 4. Product Vision: "Wabi Workspace"

### User Story

> "I'm in a game dev team of 6. We have a Wabi server. In the `#game-jam` voice channel we're planning our next prototype. Someone creates a Project channel called `super-game`. I'm a viewer by default — I see the file tree, I can browse the README, I can see who's editing what. I click **Edit** on a script. The lock transfers to me. The right panel shows version history and that an artist is also working on the texture folder. We're all in the same voice channel, talking, building. Later, I promote a new contributor from viewer to developer with one click. They don't need to learn Git."

### Core Loop

1. **Browse** — See the project directory in the channel view. Files load lazily (Lore's sparse hydration).
2. **View** — Click a file to read it. Right panel shows: general info, version history, collaborator list.
3. **Edit** — Click "Edit" to claim the write lock. Others see "Being edited by X." Real-time sync via WebSocket.
4. **Save/Commit** — Auto-commit (for the "monkeys") or manual commit with message (for the "robot humans").
5. **Switch** — Branch swapping in the UI. Create forks. Merge via review.
6. **Broadcast** — Viewers can watch the live edit session. Thousands scale via pub/sub.

### Role System

| Role | Can do |
|---|---|
| **Owner** | Full admin — manage roles, delete projects, all permissions |
| **Developer** | Edit code, commit, branch, merge, review |
| **Artist** | Upload/replace assets, preview 3D models/textures, no code write |
| **Viewer** | Browse tree, read files, watch live edits, chat |
| **Guest** | View-only, transient access via invite link |

**Dynamic escalation:**
- Viewer → Developer: Promoted by Owner/Developer during live session
- Artist → Developer: Promoted for specific file types
- Viewers can request role; approved via chat

### UX Sketch

```
┌──────────────────────────────────────────────────────────────┐
│  # super-game  [Project]  [Branch: main]  [▼ Edit]          │
├──────────┬───────────────────────────────┬───────────────────┤
│ 📁 Files │  File: player.rs              │ 📋 Info            │
│          │                               │                    │
│  src/    │  fn move_player(input) {      │ Version: v0.3.2   │
│   main   │      /* Ronin is editing */   │                    │
│   playe→ │      let delta = input.dir;   │ 👤 Collaborators   │
│   rende→ │      // sync'd via WebSocket   │ ● Ronin (editing)  │
│  assets/ │  }                             │ ○ Alex (viewing)   │
│   model→ │                               │ ○ Sam (idle)       │
│   textu→ │                               │                    │
│  README  │                               │ 📜 History         │
│          │                               │ [v0.3.2] fix jump   │
│          │                               │ [v0.3.1] add anim  │
│          │                               │ [v0.3.0] init      │
├──────────┴───────────────────────────────┴───────────────────┤
│ [💬 A: "just pushed the animation fix"] [📎 file: anim.png]      │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Technical Architecture

### High-Level Stack

```
┌──────────────────────────────────────────────────────────┐
│                   Wabi Frontend (SvelteKit)               │
│  Project tree | Editor (Monaco) | Right panel | Chat      │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP + WebSocket
┌──────────────────────────▼───────────────────────────────┐
│                  wabi-server (Rust + axum)                │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ API Routes  │  │ Socket.IO    │  │ Collaboration     │  │
│  │ (auth, crud)│  │ (presence,   │  │ Sync (WebSocket)  │  │
│  │             │  │  chat, events)│  │ (locking, cursor, │  │
│  └─────────────┘  └──────────────┘  │  broadcast)       │  │
│                                      └──────────────────┘  │
│                                                           │
│  ┌──────────────────────────────────────────────────────┐  │
│  │    Wabi Lore Addon (bridge layer)                     │  │
│  │  • Provision repo per project channel                 │  │
│  │  • Map Wabi roles → Lore access                       │  │
│  │  • Expose file tree via API                           │  │
│  │  • Handle locks, commits, branches                    │  │
│  │  • Stream hydrate on demand                           │  │
│  └──────────────────────┬───────────────────────────────┘  │
└──────────────────────────┼────────────────────────────────┘
                           │ Lore Rust API / HTTP
┌──────────────────────────▼────────────────────────────────┐
│               Lore Server (self-hosted, Docker)             │
│  • Per-project repos with content-addressed storage         │
│  • Merkle tree revision chain                              │
│  • Chunked blob storage with deduplication                  │
│  • Caching layer for scale                                 │
└───────────────────────────────────────────────────────────┘
```

### Key Integration Points

| Layer | What Wabi owns | What Lore owns |
|---|---|---|
| **File tree** | Renders in Svelte, fetches from bridge | Manages tree via API |
| **Locking** | Lock UI + WebSocket sync | File lock primitives |
| **Commits** | Commit UX + auto-commit wrapper | Commit engine + history |
| **Branching** | Branch picker UI | Branch create/switch |
| **Hydration** | "Loading..." states, priority hints | Sparse fetch on demand |
| **Auth** | Wabi roles (Owner/Dev/Artist/Viewer) | Maps to Lore access boundaries |
| **Real-time sync** | WebSocket for live cursors, streaming | N/A (file locking model) |

### Data Flow: "Edit" Button

```
1. Viewer clicks "Edit" on player.rs
2. wabi-server checks: does user have Developer role? (yes)
3. Bridge calls Lore: lock acquire(user_id, "player.rs")
4. Lore grants lock; notifies current holder (if any) via WebSocket
5. WebSocket broadcast to channel: "Ronin is editing player.rs"
6. Viewer's frontend transitions to Editor mode
7. Lock held until: save & release, or idle timeout
8. On save: auto-commit or prompt for message → Lore commits
9. WebSocket broadcast: "player.rs updated (v0.3.3)"
```

### Data Flow: "Live Broadcast" (Thousands of Viewers)

```
1. Project channel has 500 viewers watching a coding session
2. Editor's keystrokes stream via WebSocket → wabi-server
3. wabi-server publishes diffs to pub/sub channel
4. Viewers receive patched file state (not full file on every keystroke)
5. Chat overlay visible alongside live code
6. Zero cost to Lore — no locks, no commits, no history for viewers
7. Escalation: viewer clicks "Request Edit" → Owner promotes to Developer
```

---

## 6. Roadmap & Phases

### Phase 0: Foundation (Now — 2 months)
- [ ] Project channel type (basic shell)
- [ ] File tree component (fetched from... something)
- [ ] Role system expansion (Owner/Developer/Artist/Viewer)
- [ ] Simple file upload / download endpoint
- [ ] Security hardening (Caddy headers, rate limiting, TLS)

### Phase 1: Lore Integration (2—4 months)
- [ ] Lore server as Docker compose profile (co-located with wabi-server)
- [ ] Rust bridge crate: `wabi-addon-lore` (wraps Lore's Rust API)
- [ ] Project provisioning: create Lore repo when project channel is created
- [ ] File tree API: expose directory structure to frontend
- [ ] Read-only file viewing (syntax highlighting via Monaco)
- [ ] Commit history in right panel

### Phase 2: Collaboration (4—6 months)
- [ ] "Edit" button + lock acquire/release
- [ ] WebSocket sync for file changes (editor ↔ viewers)
- [ ] Presence indicators (who's editing what)
- [ ] Auto-commit on save
- [ ] Manual commit with message (configurable per-team)
- [ ] Right panel: collaborator list, role badges

### Phase 3: Polish & Scale (6—9 months)
- [ ] Branch picker in UI
- [ ] Fork / merge via review
- [ ] Live broadcast mode (pub/sub for hundreds/thousands of viewers)
- [ ] Dynamic role escalation during sessions
- [ ] Permissions per-file or per-folder
- [ ] Sparse hydration priority hints (load what's visible first)

### Phase 4: Game Dev Extensions (9—12 months)
- [ ] 3D model preview (GLTF viewer in browser)
- [ ] Texture preview with diff overlay
- [ ] Build trigger integration (auto-build on commit)
- [ ] Blueprint/visual script preview
- [ ] Engine integration (UE/Unity project detection)

### Phase 5: Dream Features (12+ months)
- [ ] "Super hub" mode: thousands watching live repo
- [ ] Cross-project asset library (share textures across repos)
- [ ] Documentation-from-chat (auto-generate docs from channel history)
- [ ] One-click deployment previews
- [ ] Plugin SDK for third-party workspace tools

---

## 7. UX Decisions & Open Questions

### Resolved

| Decision | Chosen path |
|---|---|
| User limit per file | No artificial limit — "adults will crash their own machines" |
| Real-time co-editing of same file | File locking (Lore's model), not CRDTs. One primary editor + viewers |
| "Edit" UX | Button to claim lock + sync with host. Not persistent editing state |
| Auto vs manual commit | Configurable per-team (checkbox in project settings) |
| Merge | Hidden behind review UI for "monkey teams"; full tools for "robot humans" |
| Branch switching | Yes — doable via Lore's lightweight branches |

### Open Questions

1. **Migration path**: When an existing team moves from GitHub to Wabi + Lore, how do they bring their history?
2. **Offline support**: If Lore server is down, does the project channel become fully read-only?
3. **Asset preview**: Which formats get inline preview (GLTF, PNG, PSD) and which are just download links?
4. **Build pipeline**: Should Wabi trigger builds, or just notify external CI?
5. **Lock duration**: How long before a lock times out if the editor walks away?
6. **Viewer sync frequency**: Every keystroke, or batched every N seconds for large audiences?
7. **Plugin system**: Should the workspace addon be built into core or kept as an optional addon?

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Lore is pre-1.0 (API instability) | Isolate bridge behind a trait; pin Lore version in Docker. Track upstream closely |
| Scope creep kills Wabi | Keep project workspace as an addon, not core. Core stays lean |
| Real-time sync is hard | Start with file locking + WebSocket streaming. CRDTs later if needed |
| "Just use GitHub" objection | Self-hosted, one-click project setup, integrated chat, role control. Different value prop |
| Performance with thousands viewing | Pub/sub for patches, not full files. Separate read path from write path |
| Team adoption friction | Auto-commit mode + "Edit" button = zero Git knowledge required |

---

## 9. Key Links

- **Lore GitHub**: https://github.com/EpicGames/lore
- **Lore Docs**: https://epicgames.github.io/lore/
- **Lore Quickstart**: https://epicgames.github.io/lore/tutorials/quickstart/
- **Lore FAQ**: https://epicgames.github.io/lore/faq/
- **Lore System Design**: https://epicgames.github.io/lore/explanation/system-design/
- **Lore License**: MIT (Copyright 2026 Epic Games, Inc.)
- **Lore SDKs**: lore-js, lore-python, lore-dotnet, lore-go
- **Wabi GitHub**: (private)
- **Wabi Architecture**: `/PROJECT_DOCS/01-architecture/ARCHITECTURE.md`

---

## 10. Appendices

### A. Why Not Git?

Git handles text well but struggles with:
- Large binary files (no chunking, full clones)
- Sparse checkout (possible but complex UX)
- Locking (no native file locks)
- Teams mixing code + 3D assets

Lore was built specifically for these gaps. Using Lore as backend avoids re-inventing Git's edge cases.

### B. Why Not Build From Scratch?

Lore solves years of VCS engineering:
- Content-addressed Merkle tree storage
- Revision chain with cryptographic integrity
- Chunked blob store with deduplication
- Sparse hydration protocol
- Server-side caching architecture
- Multi-tenant access boundaries
- Language bindings for 6+ languages

Building these from scratch would take 2+ years. Lore's MIT license makes it free to embed.

### C. Original Context: Security Scan Trigger

This vision started when a security scan flagged wabi.chat for:
- Security.txt not configured
- Domains without "Always Use HTTPS"
- Domains without HSTS
- Domains missing TLS Encryption
- DMARC Record Error
- Bot Fight Mode not enabled

The Caddyfile configurations (Caddyfile.example, Caddyfile.tunnel) lacked security headers, rate limiting, and TLS enforcement. While investigating these, the team discovered EpicGames/lore and the conversation snowballed into the workspace vision documented here.

The security issues still need fixing — see `docs/lore-integration-workspace-vision.md` → Phase 0 for the security work items.

---

> *"No spying. No bloat. Just chill. And maybe build a game while you're at it."*
