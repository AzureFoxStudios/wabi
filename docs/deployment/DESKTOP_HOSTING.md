# Desktop hosting implementation and validation

Status: current working-tree candidate, 2026-09-19. Not a published installer,
merged PR or deployment. The unmerged [Desktop Host Mode PR #233](https://github.com/AzureFoxStudios/wabi/pull/233)
was inspected as reference; selected implementation was integrated and revised
against this checkout. The user-facing flow is in [Self-host guide](SELF-HOST-GUIDE.md).

## Implemented slice

The desktop entrypoint now uses the same Tauri builder as native commands.
Desktop packages contain the normal `wabi-server` Authority and existing Tailcat
helper. Mobile configurations still omit desktop executables. Release and
manual-build workflows compile and stage the Authority from the checked source
revision before building desktop bundles. The staging tool checks Linux ELF,
Windows PE and macOS Mach-O/universal CPU headers; it does not certify signing,
ABI compatibility or provenance by inspecting a header.

A fresh desktop app presents Host, Join and My communities. Host offers Simple
or Configurable setup, collects a community name and owner credentials,
starts the Authority on loopback, waits for real readiness and creates the
owner. The ready screen offers invitations and entry to the existing workspace.
Simple keeps lifecycle/recovery details behind hosting settings. Configurable
opens those settings after owner creation.
Server selection and account persistence use the existing scoped registry and
authentication modules. No second navigation or account store was introduced.
The normal shell, channel context, center-stage workspaces and stubs remain.

Hosting settings expose Starting, Ready, Stopped and Failed, together with
Stop, Restart, Backup, restore, the data folder, diagnostics and explicit Quit.
LAN sharing requires completed owner setup and confirmation. Startup defaults
to loopback; enabling LAN binds all IPv4 interfaces and displays the HTTP and
firewall boundary. Internet/private access remains a separately configured
step. Simple's invitation action confirms LAN sharing, enumerates active
non-point-to-point RFC1918 IPv4 interfaces and uses the owned server port. One
address produces a one-use 24-hour invitation immediately; several require a
choice, and none produces an actionable retry state without issuing a token.
Enumeration uses local OS metadata, not an external discovery service. It is
not a reachability or firewall test. Configurable accepts a manually supplied
reachable private HTTP/public HTTPS address and expiration.

## Process, state and admission contracts

- One local community belongs to an OS app profile. `hosting/host.json` records
  its initial OS-assigned port, canonical data directory and root-key fingerprint.
  Missing/mismatched identity or invalid settings fail visibly instead of
  creating a replacement. The fingerprint is an identity check, not an account
  credential.
- An OS-held profile lock serializes desktop operations across app instances;
  WabiDB's existing storage leases also exclude separately started CLI writers.
  No code kills a process by port, process name or saved PID.
- The child runs with a narrowly constructed environment, explicit Authority
  role, upload directory inside the community data and optional helpers off.
  The actual socket is reserved before storage initialization. Its JSON address
  announcement must match the owned child and requested listener; `/readyz` and
  `/api/setup/status` determine readiness.
- A private stdin pipe owns the lifetime. Closing it requests graceful shutdown
  on Windows and Unix. Socket.IO is closed before drain, and its AppState cycle
  is broken so WabiDB can release its lock. Native fallback kills/reaps only its
  own child after the bounded deadline and marks that stop unclean.
- First-owner registration in desktop-managed mode requires a native-held
  random bootstrap secret. It is not exposed to frontend scripts. Community
  naming uses existing metadata storage, not a changed WabiDB record format.
- Desktop-managed servers enforce invitation admission after setup and refuse
  guests. Owner-only invitations expire and admit one account. Only their
  digests are stored; consumption is durable before account creation. An
  uncertain/failed creation can consume a token and requires a replacement.
- Invitation links put admission tokens in the fragment, which the join page
  clears from history. They reject URL userinfo, loopback/wildcard sharing and
  insecure public HTTP. Join checks that setup is complete before switching the
  existing selected-server/account state, including the existing-member shortcut.
- Native hosting commands accept only the local main webview. A remote server
  page, another window or an arbitrary local port cannot use these controls.
- Incomplete storage does not trigger automatic key generation. Missing root
  key, storage manifest or JWT identity on an existing instance require recovery.
  No postcard records, replay formats or engine durability policy changed.

## Shutdown and recovery

Close hides the window to the tray and keeps a running server alive. Explicit
Quit drains the owned Authority. Sleep/power-off interrupts availability; Wabi
is not a boot-time service. After a quit or reboot, **Start & open** resumes the
same saved community, initially local-only. Launching another desktop process
can show another client window, but the profile lock blocks a second owned
Authority. Use the tray to reopen the existing window.

Backups pause a cleanly stopped server and hold the actual WabiDB advisory lock
before copying all data and uploads. The persistent `wabidb/.lock` inode remains
in place; PID text and file presence do not establish ownership. A legacy root
`data/.lock` fails closed until every old process is confirmed stopped and that
legacy file is explicitly resolved. Hash manifests reject altered or extra
data files, symlinks and incomplete identity. Four exact runtime coordination
paths are excluded: `.lock`, `wabidb/.lock`, `.wabi-secret-publication.lock` and
`wabidb/.wabi-secret-publication.lock`. Uploaded files with those names remain
data. Older version-1 snapshots listing publication locks remain readable;
these runtime entries are not installed. Failed/forced stop is not a backup
boundary.

Restore validates a chosen snapshot, rejects another community's identity,
locks current storage before copying or moving it, locks the staged replacement
before publication, keeps both advisory descriptors through relocation and
keeps `before-restore-…`. Startup failure retains the failed copy and restores
the prior tree when it can safely acquire the required leases. A live CLI store
cannot be renamed by the restore helper.

Stopped operations verify that the held lock still names the same regular file.
Unix verification compares device and inode, including after relocation; the
integration's runtime gate uses Linux. Windows uses the canonical stopped-tool
creation-time check and still requires its platform-specific runtime gate.
Neither path deletes the persistent engine lock on completion or failure.

Generated snapshots contain server `data/` and a manifest. They do **not**
contain the desktop `host.json`. For disk-loss/profile recovery, stop hosting
and copy the entire `hosting/` folder—including `host.json`, `data/` and
`backups/`—to another drive. A damaged `host.json` requires the matching file
from that full folder backup; the app does not reconstruct it automatically.
Restore to the same OS profile/location. Moving to a different absolute path or
machine remains an operator migration and is not a certified in-app flow.

## Build and test commands

Use the repository-pinned Rust 1.93.1 and locked dependencies. For development,
build static assets before the Authority (the installer consumer needs none of
these tools):

```sh
cd frontend
bun run check
bun run build:static
cd ..
cargo test --locked -p wabi-server
cargo build --locked -p wabi-server
node scripts/stage-desktop-host.mjs --target x86_64-unknown-linux-gnu --binary target/debug/wabi-server --overwrite
cargo test --locked --manifest-path scripts/host-safety/Cargo.toml
WABI_HOST_TEST_BINARY="$PWD/target/debug/wabi-server" cargo test --locked --manifest-path scripts/host-safety/Cargo.toml -- --ignored
cargo test --locked --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol --lib hosting::
cargo build --locked --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol
node scripts/desktop-host-smoke.mjs target/debug/wabi-server
node scripts/desktop-host-account-smoke.mjs target/debug/wabi-server
node scripts/desktop-host-native-smoke.mjs src-tauri/target/debug/wabi-desktop
```

The last command uses [Tauri’s WebDriver support](https://v2.tauri.app/develop/tests/webdriver/) for a Linux real Tauri/WebKit smoke requiring WebKitWebDriver
and a display. It uses temporary XDG profile directories and real native IPC,
not a mocked native bridge. It leaves screenshots/report in a temporary folder.
The separate frontend browser smoke uses a synthetic native boundary and says
so explicitly; it tests layout, forms, errors and confirmations.

For release preparation, run `node scripts/build-desktop-host.mjs` after the
static build (or pass `--target universal-apple-darwin` on macOS), stage the
pinned Tailcat helper using the existing script, then use the normal Tauri
build. The main release workflow runs native hosting unit tests and the real
Authority helper test before retaining installers. Windows/Linux safety checks
also run independently without GUI dependencies.

## Verification for this change

See the final validation table below. Socket/browser tests used approved local
network access because the default sandbox forbids socket binding. All data
was disposable. No operator directory or live deployment was used.

| Check | Observed result |
| --- | --- |
| `cargo test -p wabi-server --offline` | 634 passed, 2 ignored; all 25 suites succeeded. |
| `cargo test -p wabi-tailcat --offline` | 4 passed. |
| Focused first-boot + Tailcat contracts | 8 + 3 passed; included protected bootstrap, owner/name persistence, invite race/revocation and recovery refusal. |
| `cargo test --locked --offline --manifest-path scripts/host-safety/Cargo.toml` | 28 passed, 1 real-binary test ignored in the ordinary run; executed separately below. |
| Same harness with `WABI_HOST_TEST_BINARY` and `-- --ignored --nocapture` | 1 real Authority lifecycle/backup/restore test passed. |
| Native `cargo check … --features tauri/custom-protocol` | Passed; two existing Tailcat proxy warnings. |
| Native focused hosting tests | 23 passed, including the exact-origin boundary test. |
| `node scripts/tests/desktop-host-foundation.test.mjs` | 11 passed: executable formats/staging, entrypoint, main-window close/show permissions and packaging contracts. |
| `node --experimental-strip-types scripts/tests/desktop-host-invites.test.mjs` | 7 passed. |
| `bun test src/lib/desktopHostFlow.test.ts` | 9 passed. |
| `bun run check` | 0 errors, 130 existing warnings. |
| `bun run build:static` | Passed. |
| `node frontend/scripts/desktop-host-browser-smoke.mjs` | 9 rendered scenarios passed, zero page errors; real routes/theme/stores with synthetic native/HTTP boundaries. |
| `node scripts/desktop-host-native-smoke.mjs src-tauri/target/debug/wabi-desktop` | Passed with real Linux Tauri/WebKit, actual Authority, a second Chromium client on the same machine’s LAN address, owner/name/workspace, close/show, restart, native backup/restore and quit/reopen retaining identity and account. |

Final native evidence: `/tmp/wabi-native-host-OQowuw/report.json`, with
`first-owner.png`, `community.png`, `invited-client.png` and `reopened.png` in
the same folder. The rendered frontend fixture report is
`/tmp/wabi-desktop-host-ui-dfPt2b/results.json`. These are disposable local test
artifacts, not checked-in operator data or installer certification.
| `node scripts/desktop-host-smoke.mjs target/debug/wabi-server` | Passed: owned loopback listener, real readiness, clean stdin shutdown. |
| `node scripts/desktop-host-account-smoke.mjs target/debug/wabi-server` | Passed: owner secret gate, invitation role/admission/replay/revocation, second-account channel access, Socket.IO shutdown, accounts/channels/messages/uploads after restart and stopped-copy restore, missing-key/manifest refusal. |

The local main-window capability now explicitly permits its existing close/show
operations; the actual webview refused close before that narrow permission fix.
The first native rendering check exposed uninitialized theme tokens; the host
and join routes now initialize the existing theme and own a scroll container.
The helper smoke exposed a real shutdown reference cycle; it was fixed and
rerun successfully. The full server suite also required a retention fixture to
use the real `data/wabidb` and sibling uploads layout instead of prepopulating an
uninitialized raw engine directory.

No installer installation/upgrade/uninstall, Windows/macOS native runtime,
physical-device LAN, remote/private enrollment or microphone/camera/calling
acceptance is claimed. macOS universal header/staging logic is unit checked;
its actual universal build has not been run locally.

The shortest release step is to run the updated Linux/Windows packaging jobs
on the final committed revision, install those exact artifacts on clean target
machines, and repeat owner → invite a second device → restart → backup/restore.
Validate calling and remote access separately before advertising either.

## Simple hosting follow-up and Linux release boundary

The Simple/Configurable follow-up adds native local interface enumeration
(`hosting/lan.rs`, pinned `if-addrs` 0.15.0), the ready invitation screen and
automatic LAN address selection described above. Invitation destinations are
captured before asynchronous issuance; restore clears any pending network
choice. A reproduced profile-lock release race during concurrent subprocess
creation was fixed by explicitly unlocking the held file before closing it.
The lock still excludes a second process for the lifetime of the owned host.

Focused follow-up results: 27 native hosting tests, 32 standalone safety tests,
11 foundation tests, 9 frontend flow tests and 7 invitation parser tests passed.
The rendered browser suite expanded to 13 passing scenarios, including explicit
LAN consent, single/multiple/no-interface behavior, address capture during an
in-flight invitation request and restore during address selection. Evidence:
`/tmp/wabi-desktop-host-ui-0w3S1M/results.json` (synthetic native/HTTP boundary).

Final Simple native smoke passed:
`/tmp/wabi-native-host-68mJ1y/report.json`. It exercised the actual Linux
Tauri/WebKit app, Simple owner creation, real interface discovery and LAN
invitation with no typed IP, focus/scroll to the Copy invitation action, a
second Chromium client joining, workspace
entry, close/show, restart, backup/restore and quit/reopen. Native screenshots
include `setup-choices.png` and `simple-invitation.png` in that directory.

During this follow-up, concurrent unrelated edits to `ChatComposer.svelte` and
`DmConversationView.svelte` introduced syntax errors that blocked the final
shared-tree build. They were preserved. Validation instead used an isolated
copy of HEAD frontend/packages/shared with the current hosting files overlaid:
`/tmp/wabi-simple-acceptance-f5j_4es1/validation-scope.json`. That copy passed
`bun run check` (0 errors, 130 existing warnings) and `bun run build:static`.
The native app was rebuilt with `TAURI_CONFIG` pointing `build.frontendDist`
at that isolated output before the successful smoke. This certifies the
hosting change, not those concurrent edits or the whole shared working tree.

Linux has a real native implementation; it does not need Rust, Node, Docker or
a separate database installed by the user. The GUI depends on GTK3/WebKitGTK
4.1 and associated Linux libraries. Release CI builds on Ubuntu 22.04 for an
older libc baseline. The local Bazzite/Fedora 44 test desktop requires
GLIBC_2.43 and its staged Authority requires GLIBC_2.39; these local executables
are not portable release downloads. Tailcat's staged Linux binary is static.
Inspect actual generated dependencies and install the release-built `.deb`,
`.rpm` and AppImage on clean target desktops before claiming compatibility.

Native smoke uses `WEBKIT_DISABLE_DMABUF_RENDERER=1` and re-shows the hidden
window through IPC. Default GPU/Wayland behavior and actual tray interaction
are therefore still unverified. Tauri does not emit Linux tray click events;
the existing tray menu's Settings item shows the window, and desktops without
a tray need separate acceptance. Production AppImage media-framework bundling
also remains a release decision/test, not a passed calling or playback claim.
See the official [Linux packaging](https://v2.tauri.app/distribute/debian/),
[AppImage](https://v2.tauri.app/distribute/appimage/) and
[tray behavior](https://v2.tauri.app/learn/system-tray/) documentation.

### Tailcat first-contact work still required

Current Tailcat access requires an authenticated Wabi member and registered
device key; the HTTP(S) invitation flow cannot perform that first connection
for a new remote guest. The bundled v0.4.0 CLI has no invitation/enrollment
command. A proposed next slice is an expiring enrollment listener limited to
invitation redemption: the recipient app creates a device key, redeems its
one-use grant, then moves to member-only transport with normal Wabi auth.
This is a proposal, not implemented behavior.

Before that slice, fix packaged client helper lookup (the current resolver
misses executable siblings), persist an explicit Tailcat server key in the
hosting profile, preserve account/offline identity across temporary localhost
proxy ports, and probe real application readiness instead of assuming a
500 ms process delay means connected. Do not solve enrollment by silently
opening the Authority's whole private transport to every address holder.
Tailcat already provides rendezvous/relay support; its default relay map is
hosted by tailcat.dev. A new central Wabi service is not inherently required,
but fresh-profile cross-network enrollment/revocation/restart must be tested.

## Changed files

The pre-existing untracked presentation/dossier/plan files and build cache were
left untouched. This change edits/adds:

- `.github/workflows/build.yml`
- `.github/workflows/desktop-host-safety.yml`
- `.github/workflows/tauri-build.yml`
- `core/addons/tailcat/backend/src/lib.rs`
- `core/crates/wabi-server/src/api/admin.rs`
- `core/crates/wabi-server/src/api/auth.rs`
- `core/crates/wabi-server/src/api/invites.rs`
- `core/crates/wabi-server/src/api/mod.rs`
- `core/crates/wabi-server/src/api/routes.rs`
- `core/crates/wabi-server/src/app_router.rs`
- `core/crates/wabi-server/src/bootstrap_guard.rs`
- `core/crates/wabi-server/src/lib.rs`
- `core/crates/wabi-server/src/listener.rs`
- `core/crates/wabi-server/src/main.rs`
- `core/crates/wabi-server/src/secrets.rs`
- `core/crates/wabi-server/src/state.rs`
- `core/crates/wabi-server/tests/first_boot_onboarding.rs`
- `core/crates/wabi-server/tests/message_retention_contract.rs`
- `core/crates/wabi-server/tests/tailcat_private_access_contract.rs`
- `docs/PROJECT_STATUS.md`
- `docs/deployment/DESKTOP_HOSTING.md`
- `docs/deployment/SELF-HOST-GUIDE.md`
- `frontend/scripts/desktop-host-browser-smoke.mjs`
- `frontend/src/lib/components/HostLink.svelte`
- `frontend/src/lib/components/Login.svelte`
- `frontend/src/lib/components/ServerSwitcherPanel.svelte`
- `frontend/src/lib/desktopHostFlow.test.ts`
- `frontend/src/lib/desktopHostFlow.ts`
- `frontend/src/lib/desktopHosting.ts`
- `frontend/src/lib/hostInvites.ts`
- `frontend/src/lib/serverUrl.ts`
- `frontend/src/routes/+page.svelte`
- `frontend/src/routes/host/+page.svelte`
- `frontend/src/routes/join/+page.svelte`
- `frontend/src/styles/components/desktop-hosting.css`
- `scripts/build-desktop-host.mjs`
- `scripts/desktop-host-account-smoke.mjs`
- `scripts/desktop-host-native-smoke.mjs`
- `scripts/desktop-host-smoke.mjs`
- `scripts/host-safety/Cargo.lock`
- `scripts/host-safety/Cargo.toml`
- `scripts/host-safety/authority.rs`
- `scripts/host-safety/lib.rs`
- `scripts/stage-desktop-host.mjs`
- `scripts/tests/desktop-host-foundation.test.mjs`
- `scripts/tests/desktop-host-invites.test.mjs`
- `src-tauri/Cargo.lock`
- `src-tauri/Cargo.toml`
- `src-tauri/capabilities/default.json`
- `src-tauri/src/desktop.rs`
- `src-tauri/src/hosting/archive.rs`
- `src-tauri/src/hosting/bounded.rs`
- `src-tauri/src/hosting/lan.rs`
- `src-tauri/src/hosting/mod.rs`
- `src-tauri/src/hosting/process.rs`
- `src-tauri/src/hosting/profile.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/main.rs`
- `src-tauri/src/shell_commands.rs`
- `src-tauri/tauri.conf.json`
- `src-tauri/tauri.hosting.conf.json`
- `src-tauri/tauri.hosttest.conf.json`
