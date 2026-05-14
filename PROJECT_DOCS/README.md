# Wabi Project Documentation

**Last Updated:** April 29, 2026  
**Total Docs:** 86 files (25 active, 45 archived, 16 deleted)

---

## 📚 Quick Links

| Category | Description |
|----------|-------------|
| **[Architecture](01-architecture/)** | Core system design, addon model, persistence |
| **[Deployment](02-deployment/)** | Install guides, server setup, Iyoku/Tim runbooks |
| **[Features](03-features/)** | Active feature specs and roadmaps |
| **[Payments](04-payments/)** | P2P payment architecture |
| **[Tauri](05-tauri/)** | Desktop/mobile app development |
| **[Archive](archive/)** | Historical docs, completed migrations, old decisions |

---

## 🚀 Start Here

### New to Wabi?
1. Read [`01-architecture/ARCHITECTURE.md`](01-architecture/ARCHITECTURE.md) — System overview
2. Read [`01-architecture/ADDON_ARCHITECTURE.md`](01-architecture/ADDON_ARCHITECTURE.md) — Blender-style addon model
3. Read [`02-deployment/FRESH_INSTALL.md`](02-deployment/FRESH_INSTALL.md) — Setup guide

### Deploying a Server?
1. [`02-deployment/DEPLOYMENT.md`](02-deployment/DEPLOYMENT.md) — Full deployment guide
2. [`01-architecture/PERSISTENCE_MODEL.md`](01-architecture/PERSISTENCE_MODEL.md) — Storage options
3. [`02-deployment/IYOKU_DEPLOYMENT_PROMPT.md`](02-deployment/IYOKU_DEPLOYMENT_PROMPT.md) — Iyoku-specific setup

### Building Features?
1. [`01-architecture/ENGINEERING_STANDARDS.md`](01-architecture/ENGINEERING_STANDARDS.md) — Code quality standards
2. [`03-features/PLUGIN_PORTING_MASTER_PLAN.md`](03-features/PLUGIN_PORTING_MASTER_PLAN.md) — Plugin/addon roadmap
3. Check [`archive/old-specs/`](archive/old-specs/) — Superseded specs for reference

---

## 📁 Directory Structure

```
PROJECT_DOCS/
├── README.md                    # You are here
├── REORGANIZATION_PLAN.md       # Docs reorganization plan
│
├── 01-architecture/             # Core system design
│   ├── ARCHITECTURE.md
│   ├── ADDON_ARCHITECTURE.md
│   ├── PERSISTENCE_MODEL.md
│   ├── WABI_MULTI_SERVER_ARCHITECTURE.md
│   ├── SERVER_MESH_PLAN.md
│   ├── SPACETIMEDB_WABI_STATE_PLAN.md
│   ├── CALLING_TRANSPORT_ARCHITECTURE.md
│   └── ENGINEERING_STANDARDS.md
│
├── 02-deployment/               # Deployment guides
│   ├── DEPLOYMENT.md
│   ├── FRESH_INSTALL.md
│   ├── IYOKU_DEPLOYMENT_PROMPT.md
│   ├── TIM_IYOKU_UPDATE_RUNBOOK.md
│   └── TURN_SETUP.md
│
├── 03-features/                 # Feature specifications
│   ├── READER_MODE_ENHANCEMENT_PLAN.md
│   ├── CALL_RECORDING_PLAN.md
│   ├── FEATURE_SPEC_MEDIA_ALBUMS.md
│   └── PLUGIN_PORTING_MASTER_PLAN.md
│
├── 04-payments/                 # Payment system docs
│   └── PAYMENTS_NONCUSTODIAL_PLAN.md
│
├── 05-tauri/                    # Desktop/mobile app
│   └── TAURI_BUILD_READINESS.md
│
└── archive/                     # Historical docs
    ├── 2026-04-rust-realignment/
    ├── 2026-04-stdb-migration/
    ├── plugin-decisions/
    ├── session-reports/
    ├── old-specs/
    └── [misc archived files]
```

---

## 🔍 Search Tips

**Find active docs:**
```bash
ls 01-architecture/ 02-deployment/ 03-features/
```

**Find payment docs:**
```bash
find . -name '*payment*' -o -name '* Payment*'
```

**Find archived specs:**
```bash
ls archive/old-specs/
```

**Grep across all docs:**
```bash
grep -r "persistence" 01-architecture/
```

---

## 📊 Doc Status

| Status | Count | Description |
|--------|-------|-------------|
| ✅ Active | 25 | Current architecture, specs, guides |
| 📦 Archived | 45 | Historical reference, completed work |
| 🗑️ Deleted | 16 | Obsolete/superseded (in archive for review) |

---

## 🛠️ Maintaining Docs

### When to Create a New Doc
- New architectural decision
- Feature spec (before implementation)
- Deployment runbook
- Post-mortem / lessons learned

### When to Archive
- Milestone completed (e.g., migration finished)
- Spec superseded by new design
- Session reports (move after 30 days)

### When to Delete
- Factually incorrect information
- Superseded by newer doc (keep old in archive)
- Temporary notes that served their purpose

---

## ✏️ Recent Changes

**April 29, 2026:**
- Added `PERSISTENCE_MODEL.md` — Server-side persistence design
- Created `persistence-disk` addon (Rust, JSONL writer)
- Reorganized 86 files into categorized folders

**April 28, 2026:**
- Added `ADDON_ARCHITECTURE.md` — Blender-style addon system
- Completed 22-task restructure (payments, media, content addons)

---

## 📞 Questions?

- Architecture questions → Check `01-architecture/`
- Deployment issues → Check `02-deployment/`
- Feature requests → Check `03-features/` for active specs
- Historical context → Check `archive/`
