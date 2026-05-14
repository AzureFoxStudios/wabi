# Wabi Session Notes — 2026-04-26

## What We Covered

### ✅ OpenCode Setup
- OpenCode working with API provider (minimax-m2.5-free)
- Local Ollama models available: deepseek-coder-v2:16b, gemma4:26b, qwen3.5:latest
- Configured for free local inference (optional switch later)

### ✅ Rust Generation Pipeline — COMPLETE

**Problem:** TypeScript generation was manual, easy to forget, no build integration

**Solution:**
- Added `crates/wabi-core/build.rs` for automatic rebuild triggers
- Updated `package.json` scripts:
  - `protocol:generate` — builds + generates
  - `protocol:check` — fast type checking  
  - `protocol:verify` — full test suite
- Created `packages/wabi-protocol/README.md` with complete docs
- Documented in `PROJECT_DOCS/RUST_GENERATION_PIPELINE_COMPLETE.md`

**Verification:**
```bash
cargo test -p wabi-core --features ts   # ✅ 76 tests passed
npm --prefix backend run build          # ✅ Success
npm --prefix frontend run check         # ✅ 0 errors
npm run protocol:generate               # ✅ 48 types generated
```

### Wabi-Core Assessment
- Rust crate exists: `crates/wabi-core/`
- Types ported: Message, Channel, User, VoiceChannel, events (48 total)
- ts-rs generation now automated with build.rs
- Backend/frontend both using `@wabi/protocol`

### Project Status
- ✅ STDB migration P1-P6 complete (state plane live)
- ✅ Plugin system live (BetterDiscord-style)
- ✅ 60+ docs in PROJECT_DOCS/
- ✅ Engineering standards documented ("Remove AI slop")

## Your Compass
1. Tool first, chat second — Wabi is infrastructure for communities
2. Privacy by architecture — self-hosted = you control data
3. Efficiency — respect users' RAM/CPU
4. Extensibility — plugins are the point
5. STDB is the bet — real-time state without DB ops headache

## High-Leverage Next Steps

### Option 1: Rust Generation Pipeline
Add `build.rs` to auto-generate TS types on every `cargo build`
- No more manual `npm run protocol:generate`
- Types stay in sync automatically

### Option 2: STDB P7/P8 Cleanup
Finish migration guide, prep for multi-server federation
- See: `PROJECT_DOCS/STDB_MIGRATION_P7_P8_GUIDE.md`

### Option 3: Reader Mode Fix
Implement scroll restoration fix from spec
- See: `PROJECT_DOCS/READER_MODE_ENHANCEMENT_PLAN.md`

### Option 4: Your Call
Tell me what matters most to you right now

## Commands Reference

```bash
# Test wabi-core
cargo test -p wabi-core

# Generate TS types manually
npm run protocol:generate

# Run OpenCode with specific model
opencode run 'task' -m ollama/deepseek-coder-v2:16b

# Check OpenCode usage
opencode stats

# Browser test (I can do this for you)
# "Check localhost:3000"
```

## Files to Know
- `PROJECT_DOCS/RUST_CORE_HANDOFF.md` — Rust realignment status
- `PROJECT_DOCS/SPACETIMEDB_WABI_STATE_PLAN.md` — STDB migration
- `PROJECT_DOCS/ENGINEERING_STANDARDS.md` — Code quality bar
- `docs/ALL_TASKS.md` — Current task list

---
Last updated: 2026-04-26 22:15
Session started with: opencode skill invocation
