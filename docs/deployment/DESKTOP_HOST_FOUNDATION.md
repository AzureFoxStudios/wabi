# Desktop hosting foundation — developer contract

Status: implementation branch, **not a finished Host Mode or release claim**.
Plan: `docs/plans/2026-09-16-desktop-host-mode.md`.

## What this slice changes

The desktop executable delegates to the actual `app_lib` library entrypoint.
One builder owns command/state registration; desktop tray and notification,
shell, filesystem, dialog and logging integrations remain present. Tailcat,
recording, model viewing and Lore commands use that same registration path.
Desktop-only tray behavior stays out of mobile startup.

Authority and Anchor now bind the configured `--host`, instead of ignoring it
and using an unspecified IPv6 address. The default `0.0.0.0` now means IPv4 as
advertised. Operators needing IPv6 must explicitly select `--host ::` or a
specific IPv6 address. This intentionally corrects the previous bind behavior;
it is not a promise of unchanged accidental dual-stack behavior.

The Authority reserves its actual listener before opening storage or starting
helpers. `--port 0` selects an OS-assigned port, held continuously, and the
resolved port is put in ServerConfig before runtime consumers are initialized.
An occupied port fails without killing another process or switching to a
wildcard address.

## Supervisor launch contract

An already-built server can be launched with:

```text
wabi-server --host 127.0.0.1 --port 0 --data-dir <instance-directory> --print-bound-address --shutdown-on-stdin-close
```

The supervisor must use a private piped stdin and keep its write end open.
Closing that pipe requests the same graceful shutdown path as the existing
signal handler, on Windows as well as Unix. Normal CLI launches do not watch
stdin. These flags cannot be combined with helper mode. This slice does not
add an HTTP shutdown endpoint, a bounded active-WebSocket drain, an OS service
manager, a restart policy, or a data-recovery mechanism.

`--print-bound-address` writes and flushes one JSON record, for example:

```json
{"event":"wabi-listener-bound","protocolVersion":1,"pid":1234,"address":"127.0.0.1:49152"}
```

This is a listener announcement, **not application readiness**. The future
supervisor must correlate the owned child PID/address, reject unexpected
protocol/addresses, request `/readyz`, monitor child liveness and invalidate
stale startup completions. A successful request is not a cross-network or
media test. Keep first-owner creation bound locally before any remote exposure.

## Opt-in packaging

The default desktop build is unchanged. After building an Authority for the
matching target, stage it through:

```text
node scripts/stage-desktop-host.mjs --target x86_64-unknown-linux-gnu --binary target/release/wabi-server
```

For Windows, use the actual Windows target and `.exe` input. The script checks
ELF/PE format and CPU architecture, does not execute or download the input, and
refuses to replace a staged binary unless `--overwrite` is explicit. It does
not prove ABI compatibility, signature/provenance, build identity, or runtime
correctness. Release CI must build the client/server from the same revision
and add those integrity checks.

Use `src-tauri/tauri.hosting.conf.json` as an explicit Tauri build overlay. Its
externalBin array includes both Tailcat and the Authority because arrays are
replaced by configuration merging, not implicitly appended. Existing Tailcat
staging is still required. Windows/Linux x86-64 and ARM64 header formats are
accepted; this is not certification of all four release targets.

Packaging an Authority **does not yet expose a Host button**. The native
supervisor, Join/Host onboarding, owner bootstrap, safe close/quit behavior,
fresh-device private enrollment and physical media tests remain subsequent
work. Do not label this overlay a completed end-user installer.

## Verification

```text
node --test scripts/tests/desktop-host-foundation.test.mjs
rustc --edition=2021 --test core/crates/wabi-server/src/listener.rs -o listener-tests
./listener-tests
node scripts/desktop-host-smoke.mjs /absolute/path/to/a/newly-built/wabi-server
```

On Windows, compile/run `listener-tests.exe`. The std-only socket tests exercise
real binds without replacing the implementation with a mock. Node tests cover
staging behavior and source-registration contracts, not Rust compilation.
The smoke test requires a real compiled server, creates its own temporary
instance, checks the owned loopback listener and actual `/readyz`, then requests
shutdown through stdin EOF. It does not certify persistence recovery or calls.

Before merge: build/check the actual server and native application, run the
real-binary smoke test, inspect generated target packages, and retain all
existing release gates from `docs/PROJECT_STATUS.md`.
