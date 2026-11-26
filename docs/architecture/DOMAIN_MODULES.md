# Domain modules

**Status:** first step. No flag guards it, because the stock server registers no modules. In-memory indexes only.

A domain module is a set of business records and routes that lives in a crate outside this repository and plugs into a Wabi server built by its owner. The stock server has none, names none and advertises none. Someone who only wants to talk sees no difference.

This is not the add-on system (`docs/ADDONS.md`). Add-ons are part of this repository and are wired by hand into the server. A domain module needs no edit to any engine or server source file.

## What a module brings

| Part | Where it is defined | What it is |
|---|---|---|
| Event types | `wabidb::domain_modules::DomainModule::event_types` | Names of the form `<id>.<name>`. Only the module can write them. |
| Projection | `wabidb::domain_modules::DomainProjection` | Turns the module's events into its indexes. Runs live and on replay. |
| Version | `DomainModule::version` | Identity of the projection logic. Change it whenever the same events would give different indexes. |
| Routes | `wabi_server::domain_modules::DomainModule::routes` | An Axum router, mounted at `/api/domains/<id>`. |

A host is its own executable, in its own repository, whose `main` is one call: `wabi_server::startup::run_with_modules(modules)`. That is the whole stock server (command line, static files, Socket.IO, rate limits, background jobs) plus the modules. The stock `wabi-server` executable calls `startup::run()`, which passes none. Tests that want only the API router use `AppState::new_with_modules`.

## What the engine guarantees

- **A namespace.** Event types are `<id>.<name>`, stream ids start with `<id>.`, and indexes are stored as `domain.<id>.<index>`. A module that names a core event type, or two modules with one id, stop the server from opening, before the data directory is touched.
- **Indexes that match the log.** `projections/snapshot.json` records, under `domains`, which modules at which version built the indexes it holds. At open, a module the snapshot does not vouch for has its indexes dropped and rebuilt from the whole log. That covers a module new to the directory, a module that was absent while its events arrived (an older build, a replicating peer), and a changed version.
- **Core durability.** A module's events go through the single writer, are encrypted at rest like every event, and are applied to the module's indexes before the write returns.
- **Nothing lost when the module is absent.** A server without the module opens the same directory, keeps the module's events, and serves no `/api/domains/<id>` routes. Its snapshot no longer vouches for the module, so the module rebuilds when it returns.

## What a module must keep to

- `apply` depends only on the event and on what it reads back through the `DomainIndexes` it is given. No clock, no randomness, no outside state: a rebuild must give the same indexes.
- Event payload formats are the module's to version. Events written today must stay readable by every later version of the module.
- One command writes at most one event per stream (an engine rule: the per-stream key and commit number form the encryption nonce).
- Authorization inside the module is the module's own decision. The server supplies the caller's identity (`AuthUser`) and rechecks the credential at the write (`DomainContext::write`).

## The three questions (`docs/VISION.md`)

1. *Does this get in the way of someone who only wants to talk?* No. The stock server registers no modules; with none, the engine writes the same snapshot format as before and the router has no extra routes.
2. *Does this make installing, backing up or restoring harder?* No new file. A module's events are in the log and its indexes in the existing snapshot. One new refusal: a module that needs a rebuild cannot start on a directory whose log is recorded as incomplete; the server starts without the module.
3. *Does every word the user sees about privacy match what the code enforces?* A module's events are server-readable, like any server-side record. A module must not present its records as end-to-end encrypted.

## Not done yet

- **Other start modes.** Only the normal server path loads modules. The helper, recovery-node and Planner modes and the `WABI_PURGE_ORPHANS` maintenance run open the data without them; the module's indexes are then rebuilt from the log at the next normal start.
- **SQL tables.** Indexes are ordered byte maps in memory, saved in the snapshot. Per-module tables in the SQLite read model are a later step.
- **Admission inside the writer.** A module cannot yet reject a command at the point of sequencing (for example "stock would go negative"), and has no gap-free number series.
- **Durable command ids.** `idempotency_key` de-duplicates only while the process lives.
- **Offline inspection.** `wabidb check`/`verify` replay with the core projections only, so on a directory that holds module data they report the module's indexes as differing from the log.
- **Listing.** Modules do not appear in `GET /api/addons`, and there is no frontend extension point.

## Tests

- `core/crates/wabidb/tests/domain_modules.rs`: namespace refusals; indexes identical after a restart, after losing the snapshot, after the module was absent, after a version change; an engine without modules is unchanged.
- `core/crates/wabi-server/tests/domain_modules_contract.rs`: a module defined in the test file serves authenticated routes through the production API router, keeps its records across a restart, and is absent from a server built without it.
