# Futuresight: OpenAI Codex / OSS Submission for Wabi

Date: 2026-06-18
Status: draft / parking-lot doc

## Short verdict

Yes, Wabi is worth submitting to the OpenAI Codex open-source support program / open-source fund, even while the project is messy, heavily local-first, and still resolving the SpacetimeDB / WabiDB architecture question.

Do not wait 1-4 months for the database question to be fully solved before submitting. The database question is not a disqualifier; it is part of the project's serious open-source maturity story.

The key is to submit Wabi honestly:

- pre-alpha
- active R&D
- self-hosted
- privacy-first
- local-owned
- AI-assisted
- not production-ready yet
- currently using SpacetimeDB as a reducer/live-state prototype engine
- actively evaluating a Wabi-native embedded state backend for long-term OSS independence

## Why Wabi is worth submitting

Wabi has a strong OSS identity:

- Self-hosted Discord alternative.
- Privacy-first architecture.
- No central service lock-in.
- Local-first / small-community-first defaults.
- Rust backend.
- Svelte / Tauri frontend.
- Artist- and creator-friendly customization goals.
- Designed for friend groups, gaming communities, artists, private servers, and small teams.
- Explicitly trying to reduce dependence on centralized platforms.
- Uses AI agents/Codex-style workflows as a real force multiplier for code review, refactors, architecture, docs, design, and implementation.

This is a natural fit for an open-source support program focused on Codex or AI-assisted maintainer workflows.

## The SpacetimeDB issue should be framed as maturity, not failure

Bad framing:

> We picked the wrong database and now the project is delayed.

Better framing:

> Wabi currently uses SpacetimeDB to prototype reducer-based live state and real-time subscriptions. Because Wabi's long-term goals are self-hosting, privacy, retention guarantees, and OSS independence, we are evaluating a Wabi-native embedded state backend that preserves the same reducer/live-subscription model while reducing licensing and operational risk.

This is a serious architectural concern, not a sign that Wabi is unserious.

The core insight:

- Wabi should not be loyal to SpacetimeDB-the-product.
- Wabi should preserve the good architecture pattern SpacetimeDB revealed:
  - reducer-like commands
  - transactional state mutation
  - live subscriptions
  - permission checks beside mutation
  - structural retention/deletion
  - simple self-hosting
- Long term, this may become a small Wabi-owned state engine rather than a BSL database dependency.

## What not to claim

Do not claim:

- Wabi is production-ready.
- Wabi is already a stable Discord replacement.
- The database architecture is fully settled.
- The repo is polished if it is not.
- SpacetimeDB is fully open source today.
- The project has no rough edges.

Honesty is stronger here.

## Suggested project description

Wabi is a pre-alpha, self-hosted, privacy-first community/chat platform exploring a local-owned alternative to Discord for small communities, artists, friend groups, and game/dev teams. It prioritizes user-owned servers, local-first defaults, retention controls, artist-friendly customization, and average-joe deployment.

The project currently uses SpacetimeDB to prototype reducer-based live state and real-time subscriptions, while actively investigating a Wabi-native embedded state backend to keep the long-term foundation fully OSS-aligned, privacy-preserving, and simple to self-host.

Wabi uses AI/Codex-style agents heavily for code review, architecture audits, refactors, frontend polish, documentation, implementation, and test planning. Support would help stabilize the codebase, reduce reliance on source-available infrastructure, build the embedded state abstraction, improve tests, and make the project easier for outside contributors to run and understand.

## Suggested application narrative

Wabi is a self-hosted, privacy-first Discord alternative for small communities, artists, friend groups, and game/dev teams. It prioritizes user-owned servers, local-first defaults, retention controls, artist-friendly customization, and average-joe deployment.

The project is pre-alpha but active, with a Rust backend, Svelte/Tauri frontend, helper-node/media experiments, and an architecture focused on avoiding central-service lock-in. Today Wabi uses SpacetimeDB to prototype a reducer/live-state architecture. We are now evaluating a Wabi-native embedded state layer to preserve that architecture while improving long-term open-source independence, retention guarantees, and deployment simplicity.

We use AI/Codex-style agents heavily for code review, refactors, architecture audits, frontend polish, implementation, and documentation. OpenAI/Codex support would help us stabilize the project, map and reduce risky dependencies, build a clean state-backend abstraction, improve tests, and prepare Wabi for outside contributors.

## Why the DB conundrum may strengthen the application

The SpacetimeDB / WabiDB question shows that Wabi is grappling with real OSS architecture issues:

- dependency sovereignty
- licensing compatibility
- privacy-by-architecture
- retention/deletion guarantees
- single-binary deployment
- average-user self-hosting
- maintainability beyond the original author

This is the kind of work open-source support can help accelerate.

Support could directly help with:

- codebase audit
- mapping STDB coupling points
- designing a `WabiState` abstraction
- building an embedded SQLite/redb prototype
- writing migration tests
- improving local dev setup
- generating regression tests
- documentation cleanup
- security review of retention/E2E design

## Minimum repo clarity sprint before submitting

If time allows, do a short repo-facing cleanup before applying.

Minimum checklist:

- [ ] GitHub repo reflects the current meaningful state, or at least has a clear branch/tag for submission.
- [ ] README explains what Wabi is in plain language.
- [ ] README says the project is pre-alpha / active R&D.
- [ ] README has screenshots or a short demo GIF if possible.
- [ ] README has basic local-dev instructions.
- [ ] README has a clear project status section.
- [ ] LICENSE is clear.
- [ ] CONTRIBUTING or developer notes exist, even if short.
- [ ] Architecture doc explains the self-hosted model.
- [ ] Architecture doc explains current SpacetimeDB dependency honestly.
- [ ] Architecture doc links to the future WabiDB / embedded-state investigation.
- [ ] Roadmap lists near-term stabilization goals.
- [ ] Known issues are stated plainly.

## Submission positioning

Best positioning:

> Wabi is a serious pre-alpha OSS project with a clear mission, active development, and a real architectural frontier.

Avoid positioning as:

> Finished Discord clone.

Or:

> Random local experiment with no public path.

## What reviewers need to understand quickly

A reviewer should be able to open the repo and answer:

1. What is Wabi?
2. Who is it for?
3. Why does it matter?
4. How is it different from Discord/Matrix/Revolt?
5. How do I run it, even roughly?
6. What is working today?
7. What is still experimental?
8. How would Codex/OpenAI support help?

If the repo answers those questions, Wabi is worth submitting.

## The honest final pitch

Wabi is not ready because everything is solved.

Wabi is worth submitting because the problem is important, the values are clear, the codebase is real, the architecture is ambitious, and AI-assisted development is genuinely central to how the project moves forward.

The database uncertainty should be presented as a serious design frontier, not as a blocker.

Submit after a repo clarity pass. Do not wait for the full WabiDB rewrite.
