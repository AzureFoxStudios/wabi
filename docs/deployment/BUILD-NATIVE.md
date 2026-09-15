# Build the desktop client

The native shell lives in repository-root `src-tauri/`; `frontend/` contains its web UI. Linux and Windows are the first pilot targets. Existing macOS builds remain configured, but Apple device acceptance is outside this pilot.

## Toolchain and dependencies

Use the repository-pinned Rust toolchain (1.93, currently patch 1.93.1), Node 22, Bun 1.3.14 and Tauri CLI 2.11.4. Install frontend dependencies from the committed npm lockfile:

```bash
cd frontend
npm ci --no-audit --no-fund
cd ..
```

Install the native prerequisites for the target OS using the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Linux needs GTK 3, WebKitGTK 4.1, OpenSSL development libraries and the relevant packaging tools. Windows needs the supported Microsoft build tools and WebView2. Native packaging must run on the corresponding OS; a cross-compiled raw executable is not an installer acceptance result.

## Stage the pinned helper

Tauri bundles the Tailcat sidecar declared in `src-tauri/tauri.conf.json`. The repository script downloads and verifies the pinned upstream archive, or builds the pinned macOS source as documented in the script:

```bash
./scripts/fetch-tailcat-sidecar.sh
```

A universal macOS build requires both architecture-specific helpers and a universal helper combined with `lipo`; the canonical workflow contains the exact staging procedure. Do not replace checksum-pinned binaries with arbitrary downloads.

## Build

From the repository root, with the pinned Bun executable available on `PATH`:

```bash
bunx @tauri-apps/cli@2.11.4 build --ci -- --locked
```

Tauri runs the configured `beforeBuildCommand`, which builds the frontend with its native configuration. Do not substitute adapter-node output. The Rust Authority separately requires its static SPA build; see [Fresh install](FRESH_INSTALL.md).

Unless `CARGO_TARGET_DIR` overrides the destination, bundles are under `src-tauri/target/release/bundle/`; universal macOS bundles use `src-tauri/target/universal-apple-darwin/release/bundle/`.

| Platform | Configured bundle outputs | Acceptance still required |
| --- | --- | --- |
| Linux | `.deb`, `.rpm`, `.AppImage` | Install/upgrade on the advertised distro, startup, permissions and real calls |
| Windows | NSIS setup `.exe`, `.msi` | Install/upgrade, WebView2, permissions, notifications and real calls |
| macOS | `.app`, `.dmg` | Existing build path; hardware, signing/notarization remain unvalidated |

The RPM dependency list uses OpenSSL 3 shared-library capabilities rather than Debian's `libssl3` package name. This still requires a real installation check on the target RPM-based system.

Keep the platform-specific Android/iOS configuration files. Mobile build and device acceptance are separate; deleting their configuration is not a desktop build repair.

## CI and candidate artifacts

`.github/workflows/build.yml` is the canonical automatic main/PR/tag build. Tag pushes matching `v*` may create a **draft prerelease** only after all required jobs pass. `.github/workflows/tauri-build.yml` is a manual native diagnostic workflow and does not publish releases.

See [Release candidates](RELEASE_CANDIDATE.md) for checksums, build identity and publication gates. Build outputs alone do not certify installation, notifications, screen capture or calling. No signing or auto-update guarantee is implied by a successful build.

### Fedora packaging diagnostics

A successful Rust compile does not prove installer creation. The AppImage GTK plugin also needs the development metadata for librsvg, Ayatana appindicator and its dependencies. On recent Fedora libraries, linuxdeploy's bundled strip utility may reject `.relr.dyn`; upstream supports `NO_STRIP=1` for diagnosis ([linuxdeploy issue 72](https://github.com/linuxdeploy/linuxdeploy/issues/72)). This does not establish compatibility with older distributions. Use the pinned Ubuntu CI build for distributable Linux candidates, then test installation on the target devices.
