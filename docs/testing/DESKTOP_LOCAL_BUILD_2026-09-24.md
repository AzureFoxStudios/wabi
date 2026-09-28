# Local Linux desktop build and runtime check — 2026-09-24

Host: Linux Mint 22.3, X11/Cinnamon. Source: `crash-harness-hardening` at HEAD `c634045b8050` **plus an uncommitted working tree**; the hash alone does not reproduce these builds. The initial release `.deb` SHA-256 was `f8e225ee3e18395807e6eeb79c09516f0440369244f2f039d08bd3ecf561e9b0`; the app-optimized bundle used for the paired measurements was `2349779f9108868cf62ac6d3a10d1bab1f35400bf0460f7677481980ddf9f4c9`. The current rebuilt bundle at the path below is `4dfd8f6bb22d1ea40a3d03c9559e02dff9fce1fbba62d7c239678ae0a1035985`. All native runs used disposable XDG profiles and test accounts; no operator data was used.

## Package and functional result

- Tauri built `src-tauri/target/debug/bundle/deb/Wabi_0.1.0_amd64.deb` (172 MiB). The package contains the desktop executable, `wabi-server`, and Tailcat under `usr/bin/`. Its declared dependencies include WebKitGTK 4.1, GTK 3, Ayatana AppIndicator, and OpenSSL 3.
- After extracting the package into `/tmp/wabi-deb-extracted`, `scripts/desktop-host-native-smoke.mjs` passed against the **packaged executable** with a disposable profile. It created an owner, opened the workspace, admitted a second browser through a LAN invitation, kept the server running across window close, restarted, backed up and restored, quit, and reopened with the same account. Output: `/tmp/wabi-native-host-5qNILB/report.json`.
- The initial release `.deb` also built locally (54 MiB). The same end-to-end smoke passed against its extracted executable with a disposable profile, including a second Chromium client joining by LAN invitation. Output: `/tmp/wabi-native-host-2tM92R`.
- After the app optimization pass below, the release `.deb` was rebuilt at `src-tauri/target/release/bundle/deb/Wabi_0.1.0_amd64.deb`. Its extracted executable passed the same native host flow, including the second client, restart, backup/restore, and quit/reopen. Output: `/tmp/wabi-native-host-TLh604`.
- The final rebuild after a message-slice snapshot cleanup also passed that packaged native flow. Output: `/tmp/wabi-native-host-mFKGyf`; the final PWA offline-shell smoke passed with 44 cached application assets.
- After the PWA full-precache change, the bundled Authority and desktop package were rebuilt again. The extracted package passed the native host flow and served a matching precache manifest and service worker from its hosted Authority. Output: `/tmp/wabi-native-host-5Cd6Fp`.
- The larger debug package includes debug build output; use the 54 MiB optimized bundle for distribution-size comparisons.
- The normal screenshot-taking native runs rendered the entry, owner, community, server hub, and settings screens. On this Mint/WebKitWebDriver combination, later screenshot requests stalled after navigation or window changes. The passing packaged functional run set `WABI_NATIVE_SKIP_SCREENSHOTS=1`; the default smoke still captures screenshots.
- This checks an extracted package layout on this host. It does not certify `dpkg` installation/upgrade, another Linux distribution, Windows, macOS, a physical phone, or calling.

## First resource reading

The real Tauri/WebKit workspace, with a locally hosted Authority, was sampled for 10.25 seconds after startup using process-tree `/proc` PSS and CPU ticks. The build was **debug**, and this smoke forced `WEBKIT_DISABLE_DMABUF_RENDERER=1`; the CPU reading may include software-rendering cost. This is diagnostic, not a release budget verdict.

| Process | PSS (MiB) | CPU (% of one core) |
| --- | ---: | ---: |
| Wabi desktop | 128.3 | 3.22 |
| WebKit content | 296.2 | 33.75 |
| WebKit network | 23.8 | 0 |
| Bundled Authority | 24.8 | 0 |
| **Total** | **473.0** | **36.97** |

The rendered client alone was about 448 MiB PSS. `document.getAnimations()` reported no running CSS animations at the measurement point. GPU load was not measured. The provisional 180 MiB target is not met by this debug run; the release-mode reading below is a better basis for further profiling.

Evidence: `/tmp/wabi-native-host-4uHx8v/visible-idle.json`, plus its server-hub and settings screenshots.

## Initial release build resource reading

The Tauri release executable was built locally with `cargo build --locked --release --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol` and run in the same X11/Cinnamon session. This run used the default WebKit renderer, not the forced DMABUF fallback above. The smoke created a disposable hosted community and workspace, then measured 10-second visible and minimized idle windows. No running CSS animations were reported.

| State | Total PSS (MiB) | CPU (% of one core) | Desktop | WebKit content | WebKit network | Authority |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Visible idle | 564.8 | 0.29 | 104.2 | 413.3 | 23.2 | 24.1 |
| Minimized idle | 559.7 | 1.84 | 104.5 | 407.9 | 23.2 | 24.1 |

These are single samples on this host, not cross-platform limits. WebKit content dominates memory; excluding the bundled Authority, the visible client was about 541 MiB PSS. The 180 MiB aspiration is not met in this run. CPU was low at visible idle. The first minimized 10-second sample was higher, but the longer repeat below did not sustain it. GPU use was not measured. Evidence: `/tmp/wabi-native-host-u49jYI` and `/tmp/wabi-release-resource.log`.

## Controlled release renderer comparison

The same release executable was rerun on the same host with `WEBKIT_DISABLE_DMABUF_RENDERER=1`, using the same disposable hosted-workspace smoke. One 10-second visible-idle window measured 441.7 MiB total PSS (287.0 MiB WebKit content) and 0.49% of one core. One 10-second minimized window measured 439.6 MiB PSS and 0.20% of one core. Relative to the original default-renderer release sample, this is about 123 MiB less total PSS and 126 MiB less WebKit-content PSS. The controlled comparison supports a substantial renderer-associated memory difference on this Mint/X11 host. It does **not** support a claim that disabling DMA-BUF necessarily causes the debug run's 33.75% content CPU: release with the fallback renderer remained low at idle. Single short samples cannot establish a general CPU or GPU trade-off. Evidence: `/tmp/wabi-native-host-DT3xlr` and `/tmp/wabi-release-no-dmabuf-resource.log`.

## Five-minute minimized repeat

The default-renderer release build was rerun with a disposable hosted workspace. Visible idle was 0.29% of one core and 558.5 MiB PSS in the initial 10-second window. After minimizing, five consecutive one-minute CPU samples were **0.22%, 0.13%, 0.15%, 0.13%, and 0.13%** of one core; PSS settled from 519.8 to 518.4 MiB. Thus the earlier 1.84% ten-second minimized result was not sustained in this repeat. It may have captured a transient event; this evidence does not identify its cause or rule out occasional spikes. No persistent minimized CPU regression was reproduced, so no timer or render-loop change was made on that basis. Evidence: `/tmp/wabi-native-host-5whYbt` and `/tmp/wabi-release-default-long-background.log`.

The Mint measurements should not be compared to measurements on Bazzite as if they were a before-and-after test: WebKit, display server, compositor, hardware, and workload can differ. No Discord measurement was made in this test, so this report makes no comparative Discord CPU or memory claim.

## App optimization pass

The frontend now subscribes each channel message slice only while a view uses it, instead of retaining a global subscription and last message array for every channel visited. The E2EE scan cache now retains only encrypted message identities, not a duplicate copy of every plaintext message, and removes entries when encrypted messages leave the loaded state. Nondefault chat surfaces, the payment sheet, and the closed right panel now load their code when first used. This pass does not change the default WebKit renderer.

Two alternating old/new release runs used the same Mint/X11 host, default renderer, disposable hosted workspace, 60-second warm-up, and visible-idle process-tree PSS measurements. The first pair used 30-second samples; the reverse-order pair used 20-second samples.

| Pair | Initial release PSS | App-optimized release PSS | Difference |
| --- | ---: | ---: | ---: |
| Initial → optimized | 501.8 MiB | 462.1 MiB | 39.7 MiB less |
| Optimized → initial | 436.9 MiB | 417.3 MiB | 19.6 MiB less |

Both pairs favor the app-optimized build, but absolute PSS varied substantially between fresh processes, so these two pairs do not establish a guaranteed saving. Visible-idle CPU samples were 0.16%/0.20% in the first pair and 0.20%/1.04% in the second (initial/optimized); short CPU windows include transient work and do not establish a CPU improvement. The delayed People right panel opened in the rebuilt native app. The rebuilt release package passed the full functional smoke. Focused message-slice and E2EE boundary tests passed; the static frontend build and Chromium PWA offline-shell smoke passed. `bun run check` still reports four errors in the unrelated unused `NotesView.svelte` imports and no new errors from this pass. Evidence: `/tmp/wabi-warm-baseline.log`, `/tmp/wabi-warm-optimized.log`, `/tmp/wabi-warm-optimized-repeat.log`, `/tmp/wabi-warm-baseline-repeat.log`, and `/tmp/wabi-optimized-package-smoke.log`.

## Five-minute visible-idle repeat

The final app-optimized release executable ran with the default renderer, a disposable hosted workspace, and a 60-second warm-up. Five consecutive one-minute visible-idle CPU samples were **0.55%, 0.22%, 0.43%, 0.33%, and 0.20%** of one core (mean about 0.35%). PSS stayed near 428–430 MiB. The earlier 1.04% short sample was not sustained; one minute exceeded the exploratory 0.5% per-core target slightly, so this is not evidence that every interval stays below that target. Evidence: `/tmp/wabi-native-host-OlE0hR` and `/tmp/wabi-final-visible-five-minute.log`.

## Blank WebKit baseline and memory interpretation

On this same Mint/X11 host, a temporary plain GTK/WebKitGTK 2.52.6 window loading `about:blank` at 1200 × 832 measured 215.1 MiB process-tree PSS after 60 seconds with the default renderer: 72.3 MiB GTK host, 123.5 MiB WebKit content, and 19.3 MiB WebKit network. With `WEBKIT_DISABLE_DMABUF_RENDERER=1`, it measured 163.4 MiB after 20 seconds: 67.7 MiB host, 76.3 MiB content, and 19.5 MiB network. Both samples were stable across two readings. This control uses the same WebKit library and display but is **not** a blank Tauri/Wry app; it therefore gives an approximate engine baseline, not an exact attribution of Wabi's overhead.

An earlier fresh Wabi entry-screen measurement on this host was 371.3 MiB PSS with no hosted Authority: 90.3 MiB desktop, 261.9 MiB WebKit content, and 19.1 MiB network. The entry screen had 165 DOM nodes and one 1200 × 832 canvas. The separate workspace measurements above were taken after the smoke opened the server hub, Settings, and other surfaces, so they are warmed-app measurements rather than a clean workspace floor. PSS accounts for shared resident pages proportionally; it is not JavaScript heap size, and graphics allocations may not all be represented by this process-tree sum. The Wabi entry-to-blank difference is about 156 MiB under the default renderer, but a matched blank Tauri control and memory-category/heap profile are needed before assigning that difference to specific Wabi code.


## PWA lazy-code offline check

The static build now embeds a list of all immutable application assets in the service worker and versions both shell and asset caches by a content-derived build ID. Installation succeeds only after all required assets are cached. Chromium verified 246 cached assets, an offline shell reload, and an offline fetch of a JavaScript chunk that the page had not previously loaded. The packaged Tauri desktop app already loads its embedded code locally; this change addresses the web/PWA path. Live server data and calls still need a reachable Wabi Authority. A LAN-hosted server needs no public internet for code fetches. Evidence: `/tmp/wabi-static-precache-final.log`, `/tmp/wabi-precache-package-smoke.log`, and the `frontend/scripts/pwa-production-smoke.mjs` result from this run.
