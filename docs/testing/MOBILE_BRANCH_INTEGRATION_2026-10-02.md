# Mobile branch integration — 2026-10-02

This integration reconciles `origin/fix/mobile-native-green-2026-09-13`
(and the identical-tree `origin/feat/mobile-first-2026-09-12` squash tip) with the current
integration candidate. It is not native-device release acceptance or a deployment.

## Integrated behavior

- Native remember-me credentials use only the platform's persistent OS store:
  Android Keystore-backed preferences, Apple Keychain/protected data, Windows
  Credential Store, or Linux Secret Service. Unavailable stores fail clearly;
  no plaintext file or Linux kernel-keyring fallback is added.
- Every native credential command checks the existing
  `hosting::local_main_origin` boundary before I/O. Mobile credentials do not
  use `hosting::authorize`, which intentionally refuses mobile hosting.
- Per-Authority frontend ordering and session generations fence queued saves,
  logout deletion, refresh rotation and bootstrap reads. Native credential
  operations also hold one process-wide I/O lock. Guest/logout cleanup and
  scoped account/session ownership remain intact; scoped auth copying is absent.
- Mobile notifications initialize the native plugin and receive explicit main
  window permissions. Browser clients still guard an unavailable Notification
  API. These are local OS notifications, not background push delivery.
- Mobile Back tracks opened surfaces chronologically, including center-stage
  workspaces. Keyboard inset calculations cover visual viewport offsets.
- Android initialization wires the credential store's application context;
  desktop folder operations in Lore return an explicit mobile limitation.
- Existing desktop single-instance, hosting, origin controls and CI remain.

## Verification

Pinned tools: Bun **1.3.14**, Rust **1.93.1** (`+1.93`).

- 38 targeted frontend tests passed across eight files: native persistence and
  queue races, refresh rotation, mobile notifications, Back/workspace behavior,
  viewport math, existing Tailcat origin scoping, composer session retirement
  and owner step-up/session checks.
- `node --test scripts/tests/desktop-host-foundation.test.mjs` passed.
- `node --check scripts/tauri-android-init.mjs` passed.
- `bun run build:static` passed, producing 273 immutable offline assets in this
  isolated worktree. This does not establish visual or native acceptance.
- `bun run check` found one inherited error: Thai translations lack
  `login.auth.change_server_button`; 119 existing warnings. The integration
  coordinator owns that shared translation repair. No mobile-file error remains.

## Native dependency and acceptance gates

The incoming branch's large dependency refresh was not adopted. Existing native
package versions and checksums remain intact. Only the required OS credential
store graph was seeded from the incoming lock and reconciled by Cargo. The
`keyring` CLI feature was replaced with explicit target-specific stores, following
[upstream guidance](https://docs.rs/keyring/4.2.0/keyring/) to avoid unrelated
example/database credential stores. Cargo pruned unused seed entries.

Initial native resolution failed offline and timed out on the crates.io index.
Disabling HTTP multiplexing recovered the fetch and lock reconciliation:

```sh
CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_TIMEOUT=20 CARGO_NET_RETRY=1 \
  cargo +1.93 fetch --manifest-path src-tauri/Cargo.toml \
  --target x86_64-unknown-linux-gnu
```

Full native compilation was held by the integration coordinator while another
release build used the shared host. Run after that build slot is available:

```sh
CARGO_HTTP_MULTIPLEXING=false cargo +1.93 check --locked \
  --manifest-path src-tauri/Cargo.toml \
  --target-dir /home/ironin/wabi/src-tauri/target --lib
CARGO_HTTP_MULTIPLEXING=false cargo +1.93 test --locked \
  --manifest-path src-tauri/Cargo.toml \
  --target-dir /home/ironin/wabi/src-tauri/target --lib secure_auth
```

Android/iOS compilation, physical-device notification/permission behavior,
process-death credential restore, OS-store failure handling and real mobile
Back/keyboard rendering remain native acceptance gates. No APK, iOS bundle,
real notification delivery, independent cryptographic verification, push or
main-branch merge is claimed here.
