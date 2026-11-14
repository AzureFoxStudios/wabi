# What a hostile Wabi server can do to a client that connects to it — 2026-11-13/14

Asked for by ADR-0002 §9, answer 7: *"make sure servers can't hijack anything by just existing. We don't want bad actors destroying people's DMs or computers by just connecting."*

Branch `claude/hostile-server-audit`, started from `main` at `3633302`, with `main` merged in again on 2026-11-14. The attacker runs one of the servers a user has saved, and controls every byte it sends: HTTP responses, Socket.IO events, uploaded files, Lore files, server settings, the launch page and redirects. The user only added the server and opened it. Some findings are about a hostile *member* of an honest server; they are marked as such.

This document has had one independent review (by the coordinating session, at `ba6e3f1`). That review found that a change in the first round of this branch introduced a script injection (F1), and that several claims below were wrong. Both are corrected here. Where this page once said something that turned out to be false, the section says so.

## Read this first: what reached another server's credentials, or ran script in the app

Every finding in this table is **fixed in this branch**, and each fix has a test that fails when the fix is removed. "Browser client" means the web app used with more than one saved server. A server can always change the web app it hosts itself (known limit 3 in `ENCRYPTION_STATUS.md`). These findings let a *different* saved server, or a member, do the same, and so reach the user's other servers.

| ID | What could happen | Where it came from | Clients | Severity |
|---|---|---|---|---|
| **R1** | A hostile server's signed "community roster" made the client send **another saved server's login token** to an attacker host, on that server's next reconnect. | on `main` | desktop and browser | High |
| **F1** | Chat messages could carry a working `javascript:` link: `<a href="ja$x$vascript:…">`. Any member could send one; clicking it ran script in the app. | **introduced by the first round of this branch** (the M1 change) and removed in the second; it never reached `main` | browser; desktop by reading | High |
| **F1b** | The same in wiki pages: `<a href="javawabiwikilinkx9xscript:…">`. | on `main` | browser; desktop by reading | High |
| **L1 / F2** | The Lore "signed download URL" was not checked. `javascript:` ran script in the app (browser). Any other host turned a Lore download into a navigation of the **app window itself** to the server's page. In the desktop app, that page would have had Wabi's native commands (D1 below). | on `main` | browser: script and navigation; desktop: navigation, by reading | High |
| **L2** | A Lore "PDF" served as HTML or SVG ran as a page of the app, inside the preview frame. | on `main` | browser; desktop blocked by its CSP | High (browser) |
| **F4** | An encrypted attachment typed `image/svg+xml` by its sender ran its script, as the app, when the recipient opened the image in a new tab. Lore previews, the files workspace and forum file links had the same pattern. | on `main` | browser; desktop by reading | High |
| **W1** | Board data, which members write, made every whiteboard viewer send their login token to any host. | on `main` | desktop and browser (hostile member) | High |

What "by reading" means: the desktop app cannot be run in this sandbox, so a desktop claim marked "by reading" comes from its code and config and was not run.

## Plain summary

**What a hostile server cannot do after this branch:**
- **Send code to the desktop app.** The app runs only the code it was installed with. Its content rules allow scripts only from the app itself, and the add-on loader only loads add-ons built into it.
- **Get a server page into a desktop window.** A navigation guard now refuses any page that is not the app's own (read from code; not run on a desktop). Before this branch nothing stopped it: a Lore download link pointing elsewhere would have done it.
- **Reach the user's files and programs.** Every native command that saves a file, starts the private tunnel or opens a folder checks that the request comes from the app's own pages. A test fails if a new command skips that check, or calls the check and ignores the answer.
- **Read or reuse another server's stored data.** Each server's tokens, encryption keys, drafts and outgoing-message queue are stored under the address the user typed, not a name the server picks. One server's settings can no longer move another server's token. Nothing a server sends makes the client wipe local storage.
- **Switch on the microphone, camera or screen.** These start only after a click.
- **Turn an encrypted conversation back to readable.** Once a device has seen a conversation encrypted, a server saying "not encrypted" is ignored.
- **Run script through messages, wikis, notes, Reader and Lore documents.** These were rendered in a real Chromium with 121 attack inputs, and every link and button was clicked. Nothing ran.
- **Pass control codes to the terminal.** The terminal client removes them, and the invisible or right-to-left characters used to fake names, before drawing or logging.

**What a hostile server can still do (written up, not fixed):**
- **Restyle parts of the app.** Colours and custom CSS are not checked strictly enough, so a server could draw a fake overlay or login box (S1).
- **Learn the user's local network address** during a call (S5).
- **Make the client slow or run out of memory**, mainly the terminal client (S6).
- **Use the browser client without a page CSP** (S2). This is defence in depth, not a known hole.
- **Rely on a popup window for `target=_blank` links on the desktop app.** That popup has no access to the app; checklist item 1.

## How this was checked

**Run in a real Chromium** in this sandbox (`/opt/pw-browsers/chromium`):
- `frontend/scripts/hostile-server-browser-smoke.mjs`: 121 inputs through 9 renderers. The renderers are chat, chat with kept content, chat with tables, wiki, Reader markdown/html/kept, Notes and Lore documents. The inputs include every placeholder spelling (`$x$`, `$$x$$`, `\(x\)`, `\[x\]`, `\begin…\end`, old literal markers) in `href`, `src`, `xlink:href`, `action`, `formaction` and `style`. The smoke fails if any script runs (every link and button is clicked), and on any event attribute, script URL, dangerous element, placeholder left in an attribute, or KaTeX size over 20em.
  - Against this branch's first-round `markdown.ts`, 56 inputs ran script.
  - Against `main`'s wiki substitution, 2 ran script.
  - Against the final code, 0 ran.
- `kept-content-browser-smoke.mjs` still passes.
- A one-off check: Chromium does not run a `javascript:` URL opened with `window.open(url, '_blank', 'noopener')`.
- The reviewer reproduced F1, F1b, F2 and F4 in Chromium on their side.

**Unit and component tests (bun):**
- New: `hostileServerBoundaries.test.ts`, `api/loreSignedUrl.test.ts` (the real `getSignedLoreUrl`), `communityFailover.test.ts` (the real pin store, roster signatures and reconnection manager), `whiteboard/whiteboardCredentials.test.ts`, `components/login/launchPanel.render.test.ts` (the real component, rendered).
- New cases in `communityRoster.test.ts` and `e2ee.test.ts`.
- Full `bun test --isolate src/lib` after merging `main`: 3038 pass, 6 fail. All 6 are the spreadsheet suite, because this sandbox cannot download `xlsx` and a local, uncommitted stub stood in for it.
- `svelte-check`: 0 errors.

**Rust:**
- `cargo test -p wabi-tui`: 23 pass. That includes a test that renders a real `App` on all 5 screens and 8 overlay modes, with control and bidi text in every field a server fills.
- The desktop crate (`src-tauri`) cannot be built here (no WebKitGTK). Its origin and navigation logic (`bundled_origin_on`, `allowed_navigation`) and their tests were compiled and run on their own in a scratch crate; all pass. CI compiles the full crate and now runs both `hosting::` and `navigation_guard::` tests (`build.yml`).

**Desktop contract** (`node --test scripts/tests/desktop-shell-contract.test.mjs`): 7 pass. Each mutation below fails it.

**Other checks:** `python3 scripts/security/private_details_check.py` reports clean.

**Mutation runs** (remove or weaken one check, confirm a test fails). Every one listed fails a test:
- markdown: string substitution instead of DOM substitution; marker without nonce; final sanitize pass removed.
- wiki: string replace with a fixed marker.
- `getSignedLoreUrl` returning the raw URL.
- `LoreChannel` using the raw blob for the PDF, the other previews or the thumbnails.
- `LaunchPanel` with the raw `href`, or the raw condition.
- `rasterLayers` always sending the token; `boardRenderer` matching the path only.
- e2ee keeping the sender's type; an encrypted SVG treated as an image.
- files workspace with the raw blob; forum passing `data:` through.
- roster:
  - no pin carried (the second hop);
  - saved-server rule removed;
  - identity rule removed;
  - carried pin not bound to its token;
  - version rollback allowed;
  - pin source check removed.
- desktop:
  - `let _ = require_bundled_window(…)` (result discarded);
  - the guard commented out;
  - the check removed from `grant()`;
  - the navigation guard unregistered;
  - `require_bundled_window` always allowing.
- terminal: the scrub call removed from `render()`; the bidi range removed.

**Read from code only:** everything else, marked as such below.

---

## Question 1: Code execution in the client

### Desktop app (Tauri)

| Checked | Result | How we know |
|---|---|---|
| CSP `src-tauri/tauri.conf.json:27`: `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`, no `frame-src`/`child-src` | **Holds.** No remote script, inline script or `javascript:` URL. No frame from `blob:`, `data:` or another host. `connect-src`/`img-src`/`media-src` allow any http(s); that is privacy (S5), not code. | `desktop-shell-contract.test.mjs` fails if this widens |
| `frontendDist`, window URLs, `withGlobalTauri`, asset CSP modification, in every `tauri*.conf.json` | **Holds.** | same |
| Capabilities `capabilities/*.json` | **Holds.** No `remote` origins. Only window and notification permissions, so pages that are not the app's own get no plugin command (fs, shell, dialog are initialised but not granted). | same; Tauri 2.10.3 source, `webview/mod.rs` `on_message` |
| **D1.** Wabi's own `#[tauri::command]`s are not checked against Tauri's permission list (no app manifest). Tauri gives the IPC bridge to any page in a window's main frame. | **Did not hold; fixed.** These commands had no origin check: `save_call_recording`, `tailcat_connect`, `tailcat_register_key`, `tailcat_status`, `tailcat_disconnect`, `open_model_viewer`, `open_external_url` and `lore_local_choose`; Lore `grant()` checked only the window label. All now call `hosting::require_bundled_window` (`hosting/mod.rs:56`). The quit path uses an internal `tailcat::disconnect`. **Correction:** the first round called this "depth, not a live hole". That was wrong: F2 gave a way to load a server page in the main window. Severity **High** together with F2. | contract test (each guard must be an uncommented `…?;` statement); the guards' own bodies are checked too |
| **D2.** Navigation of a window away from the bundle | **Did not hold; fixed (read from code, not run).** No navigation handler was installed, so a no-target link to another origin (F2) loaded that page in the main window. `src-tauri/src/navigation_guard.rs` is now a plugin registered for every webview. Its `on_navigation` refuses anything but the bundled origin and `about:blank`/`about:srcdoc`. On Linux and macOS the hook also sees iframes; those were already blocked by the CSP, so nothing that worked is lost. **Still open:** `target=_blank` links open as the platform decides (a bare popup on WebView2, nothing on WebKitGTK/WKWebView); a popup has no IPC. Proposed: a new-window handler that sends http(s) to `open_external_url`. That needs the main window created in code; checklist item 1. | Rust `navigation_guard::tests`; contract test checks registration |
| Bundle origin per platform `hosting/mod.rs:91-93` | **Fixed.** `http(s)://tauri.localhost` is accepted only on Windows and Android, and `tauri://localhost` only elsewhere. Elsewhere `http://tauri.localhost` is a loopback name another local program could serve. `workspace_export.rs` `trusted` uses the same check. | Rust `hosting::tests::bundled_origin_accepts_only_the_app_frontend_in_any_window` (both platform settings) |

### Shared web frontend (browser, and what the desktop runs)

| Checked | Result | How we know |
|---|---|---|
| **M1 / F1.** Chat markdown: KaTeX inserted after sanitising | **On `main`:** placeholders were string-replaced with KaTeX HTML after DOMPurify, so a placeholder in an attribute broke its quoting (no script found). **First round of this branch:** substitution moved to text nodes, but the placeholder was *cut out* of other attributes. `href="ja$x$vascript:…"` passed DOMPurify as a relative URL and came out as `javascript:` (**F1, introduced here**). **Now:** `htmlPlaceholders.ts:36` uses a per-render random marker, so typed text never matches. It substitutes in text nodes only; in `title`/`alt` the TeX becomes plain text, and any other attribute holding a real marker is removed whole. `sanitizeMessageHtml` (`markdown.ts:451`) runs last. KaTeX runs with `maxSize: 20` and `maxExpand: 200`, so `\rule`/`\kern` cannot cover the app. | Chromium smoke; `hostileServerBoundaries.test.ts` "F1" |
| **F1b.** Wiki `[[links]]` (`WikiChannel.svelte`, now `wiki/renderWikiBody.ts`) | **Did not hold on `main`; fixed.** A fixed `wabiwikilinkx{n}x` was string-replaced over sanitised HTML, attributes included. **Correction:** the first round called this "holds for script; fragile, Low" and proposed copying the M1 change, which was F1. Now it uses the same helper and sanitises last. | Chromium smoke (`wiki` renderer) |
| Other "substitute after sanitising" sites | Swept: `grep` for `.replace`/`.split` after `sanitize`/`parseMessage`/`renderReaderHtml`/`renderNote`/`renderLoreDocument`, and for `{@html …replace}`. Notes (`notes/render.ts`) and entity/emoji/code placeholders (`markdown.ts`) substitute **before** DOMPurify: hold. Lore documents: no substitution, hold. **Reader kept content** (`readerTabHelpers.ts`): `neutralizeRemoteMediaHtml` rewrites media into links after sanitising, and a `data:` `img src` could become an `href`. **Fixed:** sanitised again afterwards (`target`/`rel` kept). The chat kept path is covered by the final pass. | Chromium smoke (`readerKept`, `chatKept`) |
| Reader, Notes, Lore documents, community rules, documents, forum, diary | **Holds.** DOMPurify runs last. | Chromium smoke for Reader, Notes, Lore, chat and wiki; the rest by reading |
| Prism/KaTeX/icon sinks (`CodeBlockEditor.svelte:114`, `LoreDiffViewer.svelte:165`, whiteboard math, `readerDocumentTools.ts:185`, `Icon.svelte:55`) | **Holds.** Prism escapes, KaTeX runs with `trust: false`, icons come from a static table. | read from code; KaTeX `\href`/`\url`/`\htmlData` in the smoke |
| **L1 / F2.** Lore signed URL (`lore/linkSafety.ts:9`) → downloads in `LoreFileViewer`, `LoreProjectWorkspace`, `LoreHistoryBrowser`, `LoreChannel`; previews; `LoreRefChips`; `LoreCodePanel` fetch | **Did not hold; fixed.** The first round allowed any http(s) host, which was not enough: `//evil`, `/\evil` and `https:\\evil` all reach another host. `getSignedLoreUrl` now requires the server's own origin (the honest server returns a path, `core/crates/wabi-server/src/api/lore.rs`). Downloads fetch the bytes and save an octet-stream blob (`saveSignedLoreFile`, `:27`); no link to a server URL is clicked. | `api/loreSignedUrl.test.ts` (real function, mocked server answers) |
| **L2.** Lore PDF preview | **Fixed.** Always `application/pdf` (`pdfPreviewBlob`, `:48`). On the desktop the CSP blocks `blob:` frames, so the PDF preview probably shows nothing there; that was true before this branch too (checklist item 5). | `hostileServerBoundaries.test.ts` "F4" wiring |
| **F4.** Blobs whose type the server or sender chose | **Did not hold on `main`; fixed.** `safeBlobType.ts:26` keeps only raster images (no SVG), audio, video, PDF and plain text; everything else becomes `application/octet-stream`. It is applied in: <br>• `e2ee.ts:804` (decrypted attachments) <br>• the encrypted-image check (`messageItemUtils.ts`) <br>• Lore previews and thumbnails <br>• the files workspace preview (SVG is no longer previewed) <br>• forum file links (`safeFileHref`: `data:` only for raster images). | `e2ee.test.ts` (real encrypt→decrypt), `hostileServerBoundaries.test.ts` "F4" |
| **L3.** Launch page call to action `login/LaunchPanel.svelte` | **Fixed.** http(s) only (`safeExternalUrl.ts`). **Low**: Chromium does not run `javascript:` in a `noopener` popup. | `launchPanel.render.test.ts` |
| Add-on loader `addons/loader.ts:21-71`; computed `import()`; scripts and workers | **Holds.** Add-on IDs map to bundled modules. Six computed imports exist: five load pinned three.js/OpenCascade builds from esm.sh/jsDelivr (blocked on desktop by its CSP), and one is the user's own local file. | `hostileServerBoundaries.test.ts` "C1" |
| Service worker `static/sw.js` (not registered in Tauri), iframes, `postMessage` | **Holds.** Caches same-origin shell files only. Iframes use fixed hosts, or are sandboxed without `allow-same-origin`. No `window` `message` listener. | read from code |
| **S1.** Server or member styling: unvalidated colours in `style="background: {…}"` (`GalleryChannel.svelte:377,558,629`, `CalendarDayModal.svelte:67`, `KanbanColumnManagement.svelte:42`), `--w-sig` (`MainLayout.svelte`), block-list `customCss` (`cssSanitize.ts:45`) | **Does not hold. Medium, open.** It allows fake overlays and beacons, but no script. Proposed: `sanitizeAccentColor` on every colour; an allow-list for custom CSS. | read from code |
| **S2.** No CSP for the browser client (`core/crates/wabi-server/src/app_router.rs:735-741`) | **Does not hold. Medium, open.** Proposed: a server-sent CSP matching the desktop's. It changes which embeds load, so it is the owner's call. | read from code |

## Question 2: Reaching the user's computer

| Checked | Result | How we know |
|---|---|---|
| Native file writes | **Holds.** <br>• `recording.rs`: client-built name, now origin-checked. <br>• `workspace_export_io.rs:15-30` `safe_name`: behind a save dialog. <br>• `lore_local.rs:45-77`: rejects `..`, separators, reserved names and symlinks. Minor gap: `CONIN$` and `COM¹` are not rejected. | existing Rust tests; read from code |
| Auto-open or execute | **Holds.** `open::that` is used only for http(s) (origin-checked), the Lore folder the user picked, logs, and the hosting folder. | read from code; contract test |
| Server-chosen schemes (`file:`, `smb:`, `ms-msdt:`, custom handlers) | **Holds in code.** Markdown links: http(s), mailto, tel, `#`, `/` only. `open_external_url`: http(s) only. Lore URLs: same origin only. Steam asks first. Desktop `target=_blank` with odd schemes was **not run** (checklist item 2). | `hostileServerBoundaries.test.ts`; read from code |
| Download names (`message/MessageFileContent.svelte`) | **Holds in Chromium.** Not run in WebKitGTK, WebView2 or WKWebView (checklist item 3). | read from code |
| OS permission prompts | **Holds.** Notification permission is asked on page load, never from a server event. Clipboard writes happen only on click. | read from code |

## Question 3: Reaching the user's other servers

| Checked | Result | How we know |
|---|---|---|
| Storage namespaces: tokens (`authSession.ts`), e2ee keys (`e2ee.ts`), drafts, Reader, settings, outbound queue | **Holds.** Keyed by the saved URL, never a value the server reports. | read from code |
| Tauri credentials (`nativeAuthPersistence.ts` → `secure_auth_*`) | **Holds.** The scope is the client-owned URL; the command checks the main window's origin. | read from code; contract test |
| **R1.** Roster pins (`communityRoster.ts:141`) | **Did not hold on `main`; fixed.** A roster is pinned only under the address that served it. Pins written by other addresses (including old ones) are ignored. | `communityRoster.test.ts`; `communityFailover.test.ts` R1 |
| **F3.** The R1 fix broke the second failover hop inside one community | **Fixed.** When a session is carried to a listed address, `prepareSessionCarry` (`:239`) carries the pin too, bound to a hash of that exact token. A later, different login there ignores the pin. Two hops work offline, and a session can come back. | `communityFailover.test.ts` F3 (real pin store and manager) |
| **R2.** One server's session written over another saved server's slot (`savedServerActions.ts`, `socketConnectionReconnect.ts`) | **Did not hold on `main`; fixed. Corrected severity: Medium.** The first round rated it Low–Medium and said B must have no token. On the desktop, after a restart an inactive server's token is in the OS store, not visible, so a switch or failover from A wrote A's token, username and account id over B's slot. Now a carry is refused onto an address that holds another token, has its own stored account id or username, or is saved as a separate server, unless it already holds this exact session. | `communityFailover.test.ts` R1/R2 |
| **W1.** Whiteboard credentials (`whiteboard/sameServerAuth.ts`) | **Fixed.** Credentials go to the server's own origin only. | `whiteboardCredentials.test.ts` (real `hydrateRasterLayer`, real board-image gate) |
| Other credential sends; socket, TURN and helper URLs; redirects | **Holds.** Built from the saved URL. No auth cookies exist. | read from code |
| A's events acting on B | **Holds.** A switch reloads the page; socket listeners are fenced by realm. | read from code |
| Dead code: `dm/dmKeyring.ts`, `backendEndpoints.ts:64-77` | Unsafe if revived: delete or namespace first. | read from code |

## Question 4: Destroying local data

| Checked | Result | How we know |
|---|---|---|
| Deletions a server can trigger | **Holds.** No `localStorage.clear`, `sessionStorage.clear` or `deleteDatabase` anywhere. Refresh failures clear only that server's tokens. | read from code |
| Encryption state | **Holds.** No client-side downgrade. | `e2ee.test.ts` |
| Bounds on server files (zip, xlsx/ods, DXF/DWG, OCCT) | **Holds.** | read from code |
| **S6.** Missing bounds | **Open. Low–Medium (denial of service only).** <br>• 3MF has no size limit. <br>• Zip previews without `Content-Length` read the whole body first. <br>• Markdown has no length cap. <br>• Images have no dimension cap. <br>• The terminal client's per-channel message list and Lore downloads are unbounded. | read from code |
| Crash loops from a malformed event replayed on every start | **Not found.** | read from code |

## Question 5: Encryption-specific

(The three known limits are not repeated.)

| Checked | Result | How we know |
|---|---|---|
| A room this device saw encrypted, reported "disabled" | **Holds** (`e2ee.ts` `cacheRoomStatus`). | `e2ee.test.ts`; mutation fails it |
| A room never seen on this device | The server decides, as for any first contact; the UI labels it server-readable. Belongs with known limit 2 (ADR-0002 stage 1). | read from code |
| Decrypted content leaving the device | **F4** let a member's encrypted SVG run as the app and read every saved server's tokens and keys (browser); fixed. L1/L2/F1/F1b were script-in-origin paths with the same reach; fixed. The whiteboard and workspaces are refused in encrypted rooms only by an honest server. Whether the client warns before a member types into a workspace inside an encrypted DM was **not checked**. | see the rows above |

## Question 6: Calls and media

| Checked | Result | How we know |
|---|---|---|
| Microphone, camera, screen without a click | **Holds.** Answer is a click; capture starts in user actions only; rejoin only for calls already joined. Design note: `voice-self-moved` lets a server move a live microphone to another channel of the same server (**Low**, open: show a notice). | read from code |
| **S5.** ICE/TURN | **Open. Low–Medium.** Any TURN host is accepted (a small LAN probe). There is no `iceTransportPolicy`, so **the device's local network addresses** reach the server and peers once a call starts. Proposed: a "relay only" option, and refusing private-range TURN hosts from public servers. | read from code |

## Question 7: Terminal client (`core/crates/wabi-tui`)

| Checked | Result | How we know |
|---|---|---|
| **T1.** Escape sequences in server text | **Did not hold; fixed. High for terminal users.** ratatui writes cell symbols verbatim. `ui::scrub_terminal_controls` (`ui.rs:249`) runs on every finished frame (`ui.rs:201`). | `ui::terminal_control_tests`; `ui::hostile_render_tests` (real `render`, real `App`, every screen) |
| **F6.** Bidi and invisible characters (U+202A–202E, U+2066–2069, U+200B–200F, U+061C, U+FEFF, U+00AD) | **Fixed.** Shown as `�`, the same as controls (`is_terminal_unsafe`, `ui.rs:218`). Side effect: emoji joined with U+200D show as separate emoji. | same tests, with an independent character list |
| **F6.** Server text in the log file (`tracing` lines such as "live auth failed: {reason}") | **Fixed.** The log file writer and the in-app log buffer scrub the same characters. | `ui::hostile_render_tests::the_log_file_writer_scrubs_server_text` |
| Unbounded output, file writes | See S6. The only file writes are the config and `$TMPDIR/wabi-tui.log` (predictable path, follows symlinks; a local issue, **Low**). | read from code |

---

## Needs the owner's decision (open)

| ID | Severity | Proposed fix |
|---|---|---|
| S1 | Medium | `sanitizeAccentColor` on every colour; an allow-list for custom CSS |
| S2 | Medium | A browser CSP from `app_router.rs`, matching the desktop |
| D2 (rest) | Low–Medium | A desktop new-window handler that sends http(s) links to the system browser |
| S5 | Low–Medium | A "relay only" call option; refuse private-range TURN hosts |
| S6 | Low–Medium | Size caps before parsing; a ring buffer for terminal messages |
| — | Low | A `voice-self-moved` notice; delete dead `dmKeyring.ts` and the endpoint cache; reject `CONIN$`/`COM¹` in Lore paths |

Behaviour changes in this branch that the owner may notice:
- SVG files are offered as downloads instead of being previewed (Lore, files workspace, encrypted images).
- Lore downloads save directly instead of opening a link.
- Experimental Anchor failover no longer carries a session onto an address saved as its own server.
- The terminal client shows `�` for control, bidi and zero-width characters.

## Possible CodeQL alerts

The "CodeQL" check failed on `ba6e3f1`, while every "Analyze" job passed. The alerts themselves are not visible from this session. These are what this diff added that a scanner is likely to flag, for the owner's triage:

1. `js/insecure-randomness` on `htmlPlaceholders.ts` `placeholderNonce`. In the second round it had a `Math.random` fallback, now removed (it uses `crypto.getRandomValues` only). If an alert remains there, it is a real fix to keep.
2. `js/xss-through-dom` or `js/html-constructed-from-input` on `template.innerHTML = …` in `htmlPlaceholders.ts` (`substitutePlaceholders`) and `markdown.ts`. The input is the sanitiser's output, re-parsed in an inert `<template>` and sanitised again before use. If flagged: dismiss as "used in tests / false positive", citing the Chromium smoke.
3. `js/xss-through-dom` / DOM sinks in `frontend/scripts/hostile-server-browser-smoke.mjs` (`host.innerHTML = html`, and payload strings containing `javascript:` and `<script>`). This is a test fixture that deliberately feeds attack strings to a throwaway page. Dismiss as test code.
4. `js/incomplete-url-scheme-check` or `js/bad-tag-filter` on regexes in the smoke and in tests (`/^(javascript|vbscript|data:text\/html)/i`, `/<template\b/i`). These are assertions over rendered output, not filters. Dismiss as test code.
5. `js/request-forgery` on `lore/linkSafety.ts` `saveSignedLoreFile` (`fetch(url)` with a URL from a response). The URL is checked same-origin first (`checkedSignedLoreUrl`). Probably a false positive; dismiss with that reason.
6. Rust: no new logging of secrets. `navigation_guard.rs` logs only the blocked URL's scheme.

## What the owner should try on a real desktop

1. Click a message link `[x](https://example.com)` on Linux, Windows and macOS. Note whether it opens the system browser, a bare popup, or nothing; the main window must stay on Wabi. Then use a Lore download, which must save a file, not open a page.
2. Try `smb:`, `mailto:` and other unusual links that a server could put in an embed. No OS handler may start without a prompt.
3. Download an attachment named `..\..\evil.lnk` or `../../.bashrc`. It must land in Downloads with a harmless name.
4. A call recording still saves to Documents/WabiRecordings.
5. Tailcat connect, status and disconnect still work, and the native model viewer still opens. All of them now check their caller's origin.
6. Open a Lore PDF. A blank preview is the CSP blocking `blob:` frames, which was already the case before this branch. Downloads still work.
7. In `wabi-tui`, send a message with `ESC ] 52 ; c ; aGk= BEL` and a name with U+202E. The clipboard must stay unchanged, and both show `�`.
8. Navigation guard: the YouTube, map and Sketchfab embeds were already blocked by the desktop CSP. Confirm nothing that worked before stopped working.
