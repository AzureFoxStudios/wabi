# PROJECT_DOCS Reorganization Plan

**Date:** April 29, 2026  
**Action:** Audit and restructure 86 files

---

## Categories

### 📚 Keep (Current/Active)
Core architecture, active specs, deployment guides

### 📦 Archive (Historical Reference)
Completed migrations, old decisions, session reports

### 🗑️ Delete (Outdated/Wrong)
Superseded docs, incorrect info, temporary notes

---

## File Classification

### KEEP (25 files)

| File | Reason |
|------|--------|
| `ADDON_ARCHITECTURE.md` | ✅ Active - addon system design |
| `ARCHITECTURE.md` | ✅ Core architecture |
| `DEEP_WORK_SESSION.md` | ✅ Current session plan |
| `DEPLOYMENT.md` | ✅ Deployment guide |
| `ENGINEERING_STANDARDS.md` | ✅ Active standards |
| `FRESH_INSTALL.md` | ✅ Setup guide |
| `PERSISTENCE_MODEL.md` | ✅ Just created |
| `POLICY_SYSTEM.md` | ✅ Active policy |
| `README.md` | ✅ Docs index |
| `WABI_MULTI_SERVER_ARCHITECTURE.md` | ✅ Active architecture |
| `FEATURE_SPEC_MEDIA_ALBUMS.md` | ✅ Active feature spec |
| `READER_MODE_ENHANCEMENT_PLAN.md` | ✅ Active feature |
| `PLUGIN_PORTING_MASTER_PLAN.md` | ✅ Ongoing work |
| `PLUGIN_SPEC_CAMERAS_AND_3D.md` | ✅ Active spec |
| `SERVER_MESH_PLAN.md` | ✅ Active architecture |
| `SPACETIMEDB_WABI_STATE_PLAN.md` | ✅ Active STDB design |
| `TURN_SETUP.md` | ✅ Active infra guide |
| `TAURI_BUILD_READINESS.md` | ✅ Active milestone |
| `PAYMENTS_NONCUSTODIAL_PLAN.md` | ✅ Payment architecture |
| `CALLING_TRANSPORT_ARCHITECTURE.md` | ✅ Active design |
| `CALL_RECORDING_PLAN.md` | ✅ Active feature |
| `WHITEBOARD_MVP_PLAN.md` | ✅ Active roadmap |
| `PLUGIN_SPEC_TEMPLATE.md` | ✅ Active template |
| `IYOKU_DEPLOYMENT_PROMPT.md` | ✅ Active deployment |
| `TIM_IYOKU_UPDATE_RUNBOOK.md` | ✅ Active runbook |

### ARCHIVE (45 files)

**Historical/Completed:**
- `AI_CLEANUP_HANDOFF_GUIDE.md` — Old AI handoff
- `ARCHITECTURE_ASSESSMENT.md` — Old assessment
- `CODEBASE_CLEANUP_STATUS.md` — Completed cleanup
- `CODEBASE_OVERVIEW.md` — Superseded by ARCHITECTURE.md
- `DM_STDB_CHAT_MEMO_2026-04-22.md` — Session memo
- `docking-refactor-report.md` — Completed refactor
- `EXTERNAL_AI_WORKER_TEST_RUN.md` — Old test
- `MORNING_REPORT.md` — Session report
- `NIGHT_SESSION_PROGRESS.md` — Session report
- `PHASE_1_COMPLETE.md` — Completed milestone
- `POST_OS_RECOVERY_CHECKLIST.md` — One-time checklist
- `RUST_CORE_HANDOFF.md` — Old handoff
- `RUST_GENERATION_PIPELINE_COMPLETE.md` — Completed
- `RUST_REALIGNMENT_DECISION_MEMO.md` — Historical decision
- `RUST_REALIGNMENT_MIGRATION_PROPOSAL.md` — Completed migration
- `RUST_REALIGNMENT_PHASE2.md` — Completed phase
- `STDB_INTEGRATION_COMPLETE.md` — Completed milestone
- `STDB_MIGRATION_P7_P8_GUIDE.md` — Completed migration

**Plugin Decisions (reference only):**
- `PLUGIN_CROSS_ANALYSIS_BETTERDISCORD.md`
- `PLUGIN_DECISIONS_*.md` (14 files)
- `PLUGIN_GRADING_ROUND1.md`
- `PLUGIN_GRADING_ROUND2_BETTERDISCORDPLUGINS.md`

**Payment Docs (superseded):**
- `PAYMENTS_ADAPTER_CONTRACT.md`
- `PAYMENTS_IMPLEMENTATION.md`
- `PAYMENTS_PROVIDER_RUNBOOK.md`

**Old Specs (superseded by new addon structure):**
- `PLUGIN_SPEC_BETTERSEARCHPAGE.md`
- `PLUGIN_SPEC_CUSTOMSTATUSPRESETS.md`
- `PLUGIN_SPEC_EMOJISTATISTICS.md`
- `PLUGIN_SPEC_GIFCAPTIONER.md`
- `PLUGIN_SPEC_GOOGLESEARCHREPLACE.md`
- `PLUGIN_SPEC_HIDEMUTEDCATEGORIES.md`
- `PLUGIN_SPEC_LOCALNICKNAMES.md`
- `PLUGIN_SPEC_MOREQUICKREACTS.md`
- `PLUGIN_SPEC_REMOVENICKNAMES.md`
- `PLUGIN_SPEC_SPOTIFYCONTROLS.md`
- `PLUGIN_SPEC_STAFFTAG_TOPROLEEVERYWHERE.md`
- `PLUGIN_SPEC_TIMEDLIGHTDARKMODE.md`
- `PLUGIN_SPEC_UNICODEEMOJIS.md`
- `PLUGIN_SPEC_USERNOTES.md`
- `PLUGIN_SPEC_VIDEOCOMPRESSOR.md`
- `PLUGIN_SPEC_ZIPPREVIEW.md`

**Old Infra:**
- `RELAY_PHASE1_SERVER_RUNBOOK.md`
- `TURN_REST_AUTH.md`
- `PRETEXT_COMPARISON.md`
- `MICROSHOP_RESEARCH.md`
- `OTHER_AI_MICROTASK_GUIDE.md`

### DELETE (16 files)

| File | Reason |
|------|--------|
| `BETTERDISCORD_CONVERSION_DIRECTIONS.md` | Obsolete - BetterDiscord no longer relevant |
| `FEATURE_SPEC_MEDIA_ALBUMS.md` | Superseded by addon architecture |
| `MICROSHOP_RESEARCH.md` | Irrelevant research |
| `OTHER_AI_MICROTASK_GUIDE.md` | Obsolete workflow |
| `PLUGIN_SPEC_*.md` (14 files) | Superseded by new addon system |
| `WHITEBOARD_MVP_PLAN.md` | Superseded by current roadmap |

---

## New Directory Structure

```
PROJECT_DOCS/
├── README.md                    # Docs index
├── 01-architecture/
│   ├── ARCHITECTURE.md
│   ├── ADDON_ARCHITECTURE.md
│   ├── PERSISTENCE_MODEL.md
│   ├── WABI_MULTI_SERVER_ARCHITECTURE.md
│   ├── SERVER_MESH_PLAN.md
│   ├── SPACETIMEDB_WABI_STATE_PLAN.md
│   ├── CALLING_TRANSPORT_ARCHITECTURE.md
│   └── ENGINEERING_STANDARDS.md
│
├── 02-deployment/
│   ├── DEPLOYMENT.md
│   ├── FRESH_INSTALL.md
│   ├── IYOKU_DEPLOYMENT_PROMPT.md
│   ├── TIM_IYOKU_UPDATE_RUNBOOK.md
│   └── TURN_SETUP.md
│
├── 03-features/
│   ├── READER_MODE_ENHANCEMENT_PLAN.md
│   ├── CALL_RECORDING_PLAN.md
│   ├── FEATURE_SPEC_MEDIA_ALBUMS.md
│   └── PLUGIN_PORTING_MASTER_PLAN.md
│
├── 04-payments/
│   ├── PAYMENTS_NONCUSTODIAL_PLAN.md
│   └── [new payment docs]
│
├── 05-tauri/
│   ├── TAURI_BUILD_READINESS.md
│   └── [new Tauri docs]
│
├── archive/
│   ├── 2026-04-rust-realignment/
│   │   ├── RUST_CORE_HANDOFF.md
│   │   ├── RUST_REALIGNMENT_DECISION_MEMO.md
│   │   ├── RUST_REALIGNMENT_MIGRATION_PROPOSAL.md
│   │   └── RUST_REALIGNMENT_PHASE2.md
│   │
│   ├── 2026-04-stdb-migration/
│   │   ├── STDB_INTEGRATION_COMPLETE.md
│   │   └── STDB_MIGRATION_P7_P8_GUIDE.md
│   │
│   ├── plugin-decisions/
│   │   └── [all PLUGIN_DECISIONS_*.md]
│   │
│   ├── session-reports/
│   │   ├── MORNING_REPORT.md
│   │   ├── NIGHT_SESSION_PROGRESS.md
│   │   └── DM_STDB_CHAT_MEMO_2026-04-22.md
│   │
│   └── [other archived files]
│
└── deleted/                     # Staged for deletion
    └── [files to delete]
```

---

## Execution Plan

1. Create new directory structure
2. Move files to appropriate folders
3. Update README.md with new structure
4. Review archive folder (delete if truly obsolete)
5. Delete staged files

---

## README.md Update

New index with categorized links, search tips, and "start here" guidance.
