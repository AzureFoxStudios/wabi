# What a hostile Wabi server can do to a client that connects to it — 2026-11-13

Asked for by ADR-0002 §9, answer 7: *"make sure servers can't hijack anything by just existing. We don't want bad actors destroying people's DMs or computers by just connecting."*

Branch `claude/hostile-server-audit`, started from `main` at `3633302`. The attacker runs one of the servers a user has saved and controls every byte it sends: HTTP responses, Socket.IO events, uploaded files, Lore files, server settings, the launch page, redirects. The user only added the server and opened it.

## Read this first: the findings that reached another server's credentials

These were the most serious findings. All three are **fixed in this branch**, and each fix has a test.

| ID | What the hostile server could do | Clients | Severity | State |
|---|---|---|---|---|
| **R1** | **Make the client send another saved server's login token to the attacker.** Server A served a signed "community roster" listing server B's address and an attacker host. The client saved that roster under B's address as well as A's. The next time B's connection dropped, the failover code read the planted roster, copied B's token to the attacker host and switched to it. Requirement: the user's account number on B equals the one A reports. Account numbers are small sequential integers, so this is easy to guess. | Desktop and browser | **High** | Fixed: a roster is pinned only under the address it was fetched from. Tests: `communityRoster.test.ts` |
| **L1** | **Run script inside the app and read every saved server's tokens and encryption keys (browser client).** The Lore "signed download URL" came back from the server and was clicked with no scheme check, so `{"url":"javascript:…"}` ran when the user clicked Download on a Lore file. | Browser: script runs. Desktop: blocked by its CSP (read from config, not run) | **High** (browser) | Fixed: http(s) only. Test: `hostileServerBoundaries.test.ts` (L1) |
| **L2** | **The same through the Lore PDF preview.** A "PDF" served as `text/html` or SVG became a `blob:` URL with the app's own origin and was shown in an iframe with no sandbox. Selecting the file ran its script. | Browser: script runs. Desktop: blocked by its CSP (read from config, not run) | **High** (browser) | Fixed: the preview blob is always `application/pdf`. Test: `hostileServerBoundaries.test.ts` (L2) |

"Browser client" here means the web app, used with more than one saved server. When a server hosts the web app itself, that server can already change the app's code (known limit 3 in `ENCRYPTION_STATUS.md`). L1 and L2 still mattered: they let a *different* saved server do the same, and so reach the user's other servers.

**No way was found for a server to run code in the desktop app, or to reach the user's files through it.** Those boundaries are listed under question 1, with their tests.

## Plain summary

**What a hostile server can no longer do, and what holds:**
- **Code in the desktop app.** The desktop app runs only the code it was installed with. Its content rules (CSP) allow scripts only from the app itself. No window ever opens a server's page, and the add-on loader only loads add-ons built into the app. A server cannot send it code.
- **The user's files and programs.** The app's native commands (save a file, start the private tunnel, open a folder) now check that the request comes from the app's own pages. A test fails if a new command skips that check.
- **Data stored on the device.** Each server's tokens, encryption keys, drafts and outgoing-message queue are stored under the address the user typed, not a name the server picks. One server cannot point the client at another server's storage. No server event makes the client wipe local storage.
- **Microphone, camera and screen.** These only start after a click, never from a server message.
- **Encrypted conversations.** Once a device has seen a conversation encrypted, a server saying "this conversation is not encrypted" is ignored. The client keeps encrypting.
- **Messages and documents.** Chat, Reader, Notes and Lore documents were rendered in a real Chromium with 49 script-injection payloads. None ran.
- **The terminal client.** It now removes terminal control codes from everything it draws. A server message can no longer write the clipboard, change the window title or redraw the screen.

**What a hostile server can still do (written up below, not fixed here):**
- **Fake parts of the screen.** A server can restyle parts of the app, for example a fake overlay or login box, through colours and custom CSS that are not checked strictly enough (S1).
- **Learn the user's local network address** during a call (S5).
- **Make the client slow or run out of memory**, mainly in the terminal client (S6).
- **Leave a stale login.** It can make the client copy its own login onto another saved server that has no login yet. This confuses which account the client thinks it has there until the user logs in again (R2).

## How this was checked

- **Run in a real Chromium in this sandbox** (`/opt/pw-browsers/chromium`):
  - `frontend/scripts/hostile-server-browser-smoke.mjs` (new): 49 payloads × 7 renderers, inserted into a live page. It fails on any script that runs, any event-handler attribute, any `javascript:`, `vbscript:` or `data:text/html` URL, any dangerous element, or broken attribute quoting. It records every request to another host.
  - The existing `kept-content-browser-smoke.mjs` still passes after the markdown change.
  - A one-off check confirmed that Chromium does not run a `javascript:` URL opened with `window.open(url, '_blank', 'noopener')`.
- **Unit tests (bun):**
  - `frontend/src/lib/hostileServerBoundaries.test.ts` (new).
  - `communityRoster.test.ts` and `e2ee.test.ts` (new cases).
  - Full `bun test --isolate src/lib`: 3013 pass. 6 fail, all in the spreadsheet suite, because this sandbox cannot download `xlsx` and a local stub stood in for it. CI installs the real package.
  - `svelte-check`: 0 errors.
- **Rust:**
  - `cargo test -p wabi-tui`: 21 pass, including 2 new tests.
  - The desktop crate (`src-tauri`) cannot be built here (no WebKitGTK). Its new origin check was compiled and tested on its own in a scratch crate, together with the existing `local_main_origin` test; both pass.
  - The full desktop crate is compiled by CI (`build.yml`, which also runs `hosting::` tests, including the new one).
- **Desktop contract** (new): `node --test scripts/tests/desktop-shell-contract.test.mjs`, 5 pass. A mutation run removed the new guards and the test named exactly the six unguarded commands.
- **Mutation runs:**
  - Reverting the math fix gives 15 smoke findings.
  - Removing the encryption downgrade guard fails the new e2ee test.
- **Read from code only:** everything else, marked as such below.
- **Also read:** Tauri 2.10.3 and wry 0.54.4 source (`webview/mod.rs` `on_message`, `manager/webview.rs`), to learn how Tauri treats IPC from a page that is not the app's own.
- **Not runnable here:** the Tauri shell itself. A checklist for a real desktop is at the end.

---

## Question 1: Code execution in the client

### Desktop app (Tauri)

| Checked | Result | How we know |
|---|---|---|
| CSP `src-tauri/tauri.conf.json:27`: `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval'`; no `frame-src`/`child-src` | **Holds.** No remote script, no inline script and no `javascript:` URL. No frame from `blob:`, `data:` or a server. `connect-src`, `img-src` and `media-src` allow any http(s); that is privacy, not code (see S5). | `scripts/tests/desktop-shell-contract.test.mjs` fails if this widens |
| `frontendDist: ../frontend/build`; no window `url`; no `withGlobalTauri`; asset CSP modification on | **Holds.** The app shows only its bundled pages. | same test (all `tauri*.conf.json`) |
| Capabilities `capabilities/default.json`, `mobile.json` | **Holds.** No `remote` origins. Only window and notification permissions. No fs, shell, opener, http, updater or process permission, even though the fs/shell/dialog plugins are initialised (`lib.rs:14-24`). Tauri checks every plugin command against these capabilities, so a page that is not the app's own gets none. | same test; Tauri source `webview/mod.rs` `on_message` |
| **D1.** Wabi's own `#[tauri::command]`s | **Did not hold; fixed.** Tauri checks app commands against no permission list unless the app ships an app manifest; Wabi does not. Tauri injects its IPC bridge into every page loaded in the main frame (`manager/webview.rs`, `for_main_frame_only`). So if a server page ever loaded in a window, it could call every command that does not check its caller. Credentials, hosting, Planner, export and Lore already checked (`hosting/mod.rs` `local_main_origin`, `workspace_export.rs` `trusted`). These did not: `save_call_recording` (writes into Documents/WabiRecordings with no dialog), `tailcat_connect` / `tailcat_register_key` (start a process), `open_model_viewer`, `open_external_url`, `lore_local_choose` (folder picker); `grant()` also checked only the window label. All now call `hosting::require_bundled_window` (`hosting/mod.rs:56`, `bundled_origin` at `:84`). Severity **Medium**: no way to load a server page in a window was found (next row), so this is depth, not a live hole. | `scripts/tests/desktop-shell-contract.test.mjs` (every registered command must call an origin check; four harmless ones are listed with reasons); Rust test `hosting::tests::bundled_origin_accepts_only_the_app_frontend_in_any_window` |
| Can the main window be navigated to a server URL? | **Holds as far as the code goes; not checked on a real desktop.** No code assigns `location` to a server value. Every in-app `<a>` without `target` points to a fixed path. Message links get `target="_blank"` (`markdown.ts` link renderer). **But the shell installs no navigation or new-window handler.** So the result of clicking a `_blank` link is whatever each OS webview does by default: WebKitGTK ignores it; WebView2 opens a plain popup with no IPC; WKWebView ignores it. `open_external_url` exists but nothing in the frontend calls it. | read from code (frontend) and wry 0.54.4 source; **checklist item 1–2** |
| Proposed (not done, needs a real desktop): **D2** | Add an `on_navigation` guard that keeps the main frame on the bundled origin, plus a new-window handler that sends http(s) links to `open_external_url`. Or ship a Tauri app manifest so Tauri itself denies app commands to remote pages. Both change visible behaviour (how links open) and cannot be tried here. WebKitGTK and WKWebView call the navigation handler for iframes too, so a naive guard would break YouTube and map embeds. | — |

### Browser client and the shared web frontend (also what the desktop runs)

| Checked | Result | How we know |
|---|---|---|
| Chat markdown `markdown.ts` `parseMessage`: marked → DOMPurify allow-list → KaTeX | **Holds** for script. **M1 did not hold; fixed.** KaTeX's HTML replaced math placeholders after sanitizing, by plain string replacement. A placeholder inside a link `href`/`title` or an image `alt` (`[x](https://a "$x$")`) let KaTeX's quotes break out of the attribute, adding stray attributes and a `style`. No script ran, but this was one change away from an injection. `renderMathSlots` (`markdown.ts:236`) now replaces placeholders in text nodes only: TeX becomes plain text in `title`/`alt` and is removed from URL attributes. Severity **Low**. | `hostile-server-browser-smoke.mjs` (Chromium); mutation: old code gives 15 findings |
| Reader `readerTabHelpers.ts:52-60`, Notes `notes/render.ts`, Lore documents `lore/documentMarkdown.ts`, community rules (Reader), documents `DocumentsWorkspace.svelte:67-72`, forum, diary (parseMessage) | **Holds.** DOMPurify runs last, or its output is only re-parsed in an inert `<template>`. | browser smoke for Reader (markdown and html), Notes, Lore and chat; the rest read from code |
| Prism / KaTeX sinks: `CodeBlockEditor.svelte:114`, `LoreDiffViewer.svelte:165`, `WhiteboardToolbar.svelte:671`, `WhiteboardMathRecognize.svelte:80`, `whiteboard/mathRender.ts:150`, `readerDocumentTools.ts:185`, `Icon.svelte:55` | **Holds.** Prism escapes, KaTeX runs with `trust: false`, and icon bodies come from a static table. | read from code; KaTeX `\href`/`\url`/`\htmlData` and error cases are in the browser smoke |
| Wiki `WikiChannel.svelte:607-618`: link placeholder `wabiwikilinkx{n}x` substituted after parseMessage | **Holds for script; fragile** (same pattern as M1, but the inserted `<a>` closes the tag and its label is escaped). Proposed: use the DOM substitution from `renderMathSlots`. **Low**, open. | read from code |
| **L1** Lore signed URL `api/lore.ts` `getSignedLoreUrl` → `anchor.click()` in `LoreFileViewer.svelte:157`, `LoreProjectWorkspace.svelte:233`, `LoreHistoryBrowser.svelte:71`; also `window.open` in `LoreRefChips.svelte:33` | **Did not hold; fixed.** See the top table. Now `lore/linkSafety.ts` `checkedSignedLoreUrl`, called at `api/lore.ts:416`. | `hostileServerBoundaries.test.ts` "L1" |
| **L2** Lore PDF preview `LoreChannel.svelte:173`, iframe `:919` | **Did not hold; fixed.** See the top table. Side effect noted: in the desktop app the CSP blocks `blob:` frames, so the PDF preview probably shows nothing there today (checklist item 5). | `hostileServerBoundaries.test.ts` "L2" |
| **L3** Launch page call to action `login/LaunchPanel.svelte` (`heroPrimaryCtaUrl`) | **Did not hold; fixed.** A raw server `href`. Chromium does not run `javascript:` in a `noopener` popup (checked), so **Low**; still now http(s) only via `safeExternalUrl.ts`. | `hostileServerBoundaries.test.ts` "L3" |
| Add-on loader `addons/loader.ts:21-31,62-71` | **Holds.** Add-on IDs map to fixed, bundled `import()`s. A server manifest's `frontendEntry` is never imported. | `hostileServerBoundaries.test.ts` "C1" |
| Any other dynamic `import()`, `eval`, `new Function`, scripts or workers built from server data | **Holds.** Six computed imports exist. Five load pinned three.js or OpenCascade builds from esm.sh/jsDelivr (constants in the file). These are trusted CDNs, not the server, and the desktop CSP blocks them anyway. The sixth is the user's own local file (`EffectsTab.svelte:156`). The only injected `<script>` is YouTube's fixed `iframe_api`. | `hostileServerBoundaries.test.ts` "C1" fails on any new computed import |
| Service worker `static/sw.js`, registered at `routes/+layout.svelte:246-267` only outside Tauri | **Holds.** It caches only same-origin app-shell and immutable files, keyed by URL. It does not touch `/uploads/` or `/api/`, so one server's response is never served for another's. | read from code |
| iframes | **Holds** apart from L2. `GlanceHost.svelte:113` is http(s) only, sandboxed without `allow-same-origin`. YouTube, Spotify, Sketchfab and OpenStreetMap embeds have a fixed host (`allow` has at most `clipboard-write`, `fullscreen`). None grants camera, microphone or display capture. | read from code |
| `postMessage` | **Holds.** There is no `window` `message` listener. The service worker, BroadcastChannel and worker listeners cannot receive messages from another origin. | read from code |
| **S1** Server-styled UI: unvalidated colours in `style="background: {…}"` (`GalleryChannel.svelte:377,558,629`; `CalendarDayModal.svelte:67`; `KanbanColumnManagement.svelte:42`); `MainLayout.svelte:1384` `--w-sig` from `accentColor` (`sanitizeAccentColor` exists but is not used there); launch `customCss` filtered by a block list (`cssSanitize.ts:45`) | **Does not hold. Medium, open.** A value such as `red;position:fixed;inset:0;z-index:2147483647` lets a server or member cover the app with a fake screen (for example a fake login), and `image-set(...)`/`url(...)` beacons out. No script. Proposed: run every colour through `sanitizeAccentColor`, and use an allow-list for custom CSS (properties and values), not a block list. Not done here: a dozen components and visible styling are affected. | read from code |
| **S2** No CSP for the browser client: the embedded index is served with only `Referrer-Policy` (`core/crates/wabi-server/src/app_router.rs:735-741`) | **Does not hold. Medium, open.** Nothing contains a future injection in the browser, and the browser has no `frame-src`. Proposed: a server-sent CSP matching the desktop's (`script-src 'self' 'wasm-unsafe-eval'`, plus the YouTube origin the web build uses). It changes which embeds load, so it needs the owner's decision and a browser pass. | read from code |

### Terminal client

Nothing in the terminal client runs or loads code. Its terminal-escape problem is under question 7.

## Question 2: Reaching the user's computer

| Checked | Result | How we know |
|---|---|---|
| Native file writes: `recording.rs` (client-built name, `/` `\` and controls stripped; now origin-checked), `workspace_export_io.rs:15-30` `safe_name` (reserved Windows names, bidi controls, separators; always behind a save dialog), `lore_local.rs:45-77` `valid_path`/`checked` (rejects `..`, `\`, `:`, controls, reserved names, symlinks at every step; re-checked before replacing) | **Holds.** A server-chosen name cannot leave the chosen folder. Minor: `lore_local` does not reject `CONIN$` or superscript `COM¹`. Pulled files may have any extension, but are written, never opened. | existing Rust tests `workspace_export`, `lore_local` (lines 404, 415); read from code |
| Auto-open / execute | **Holds.** `open::that` is used only for http(s) URLs (`shell_commands.rs`, now origin-checked), the Lore folder the user picked, the logs folder, and the hosting folder. Nothing opens a download. | read from code; contract test pins the http(s) check |
| "Open externally" on a server-chosen scheme (`file:`, `smb:`, `ms-msdt:`, custom handlers) | **Holds in code**, with these checks: `open_external_url` is http(s) only; markdown links allow `https:`, `http:`, `mailto:`, `tel:`, `#` and `/` only (`markdown.ts` `isSafeUrl`); Steam `steam://` asks first (`SteamJoinButton.svelte:5`). How each desktop webview treats `target=_blank` with odd schemes was **not checked** (checklist item 2). | `hostileServerBoundaries.test.ts` (L1/L3 refuse `smb:`, `ms-msdt:`, `file:`, `steam:`); read from code |
| Chat attachments `message/MessageFileContent.svelte:294…`: `download={fileName}` | **Holds in Chromium** (it strips separators and `..` from `download`). **Not checked** in WebKitGTK, WebView2 or WKWebView (checklist item 3). | read from code |
| OS permission prompts that look like Wabi's | **Holds.** Notification permission is asked on page load (`routes/+page.svelte:185-189`), never from a server event. Clipboard writes happen only in click handlers, and nothing reads the clipboard. Microphone, camera and screen: see question 6. | read from code |

## Question 3: Reaching the user's other servers

| Checked | Result | How we know |
|---|---|---|
| Storage namespaces. Tokens: `authSession.ts:68-74`, `api/authRefresh.ts:15-20`. E2EE keys and room status: `e2ee.ts:154-199`, keyed by server URL and JWT `sub`. Drafts: `composerDraftState.ts:13-17`. Reader copies: `readerDocumentScope.ts:13-20`. Settings DB: `storage.ts:15-26`. Outbound queue: realm checks in `wabidb/queue/manager.ts:24-31,91-96` and `groupPolicy.ts:31-32`. | **Holds.** Every namespace is the server URL the client saved, not one the server reports. A server reporting another server's id or URL changes nothing. | read from code |
| Tauri secure credentials `nativeAuthPersistence.ts:18-57` → `secure_auth_*` | **Holds.** The scope is the client-owned URL; the command checks the main window's origin. | read from code; contract test |
| **R1** Community roster pins (`communityRoster.ts`) | **Did not hold; fixed.** See the top table. `pinCommunityRoster` (`communityRoster.ts:136`) pins under the source only. `getPinnedCommunityRoster` (`:177`) ignores pins written by another address, including ones stored before this fix. | `communityRoster.test.ts`: three new tests |
| **R2** Session carry on switch/failover (`savedServerActions.ts:262-273`, `socketConnectionReconnect.ts:156-161`) | **Does not hold. Low–Medium, open.** A's own roster may list B. If B has no token at that moment, switching from A to B (or A failing over) writes A's token, username and account id into B's slot and sends A's token to B. A's token is no use to the user, so nothing of B's leaks, but the user's identity for B is confused until they log in again. The e2ee realm for B can briefly take A's account id. Proposed fix: carry a session only to an address the user approved as part of the same community, and never onto an address saved as a separate server. That changes how experimental Anchor failover behaves, so it is left for the owner. | read from code |
| Credentials to other hosts. `apiRequest.ts:88-93` refreshes/replays only for the same server root. Attachments are plain `<img>` with no header. TURN, socket and helpers all use `getServerUrl()` (`turnConfig.ts:15`, `socketConnectionCore.ts:455-467`). | **Holds**, except W1. | read from code |
| **W1** Whiteboard assets: `whiteboard/rasterLayers.ts`, `fontAssets.ts` and `boardRenderer.ts` sent the bearer token (or guest session) to any URL named in board data; `boardRenderer` matched only the path | **Did not hold; fixed.** This is the "hostile member on an honest server" variant. Any member could put `https://evil.example/api/whiteboard/boards/1/files/1` on a board and collect every viewer's token. Severity **High** for that server. Now `whiteboard/sameServerAuth.ts` sends credentials only to the server's own origin. | `hostileServerBoundaries.test.ts` "W1" |
| Redirects | **Low.** There are no auth cookies (only `anchor.rs` sets any), so a redirect can only carry A's own header. Modern webviews drop `Authorization` on cross-origin redirects; old WebKitGTK builds were not checked. | read from code |
| Events from A acting on B | **Holds.** A user switch reloads the page (`savedServerActions.ts:279-281`). Socket listeners are fenced by socket identity, realm and auth generation (`socketConnectionCore.ts:664-676`). | read from code |
| Dead code noted: `dm/dmKeyring.ts` (IndexedDB keyed by uid only), `backendEndpoints.ts:64-77` (server-written endpoint cache for any URL) | Not reachable today. **Unsafe if revived**; delete or namespace before reuse. | read from code |

## Question 4: Destroying local data

| Checked | Result | How we know |
|---|---|---|
| Deletions a server can trigger | **Holds.** There is no `localStorage.clear`, `sessionStorage.clear` or `deleteDatabase` anywhere. A refresh 401/403 clears only that server's tokens (`api/authRefresh.ts:97-101`). `auth-revoked` and `auth-failed` only trigger a refresh (`socketConnectionCore.ts:650-651`). `wabidb` `clearScope` is never called. | read from code |
| Encryption state | **Holds.** The client keeps a room's "encrypted" status even if the server later says otherwise (question 5). | `e2ee.test.ts` (new case) |
| Bounds on server files: zip preview (25 MiB, 200 entries, per-entry inflate limits, on click, `zip/zipPreview.ts`); xlsx/ods (12 MB in, 4096 entries, 64 MB total, `sheets/fileAdapter.ts:17-45`); DXF/DWG 20 MB, OCCT 60 MB, click to activate | **Holds.** | read from code |
| **S6** Bounds that are missing | **Do not hold. Low–Medium, open (denial of service, nothing destroyed).** Missing bounds, file by file: <br>• `ThreeMFViewer.svelte:49-60`: no size or decompressed-size limit, and the viewport tab loads without a click. <br>• `ZipPreviewPanel.svelte:96`: when there is no `Content-Length`, the whole body is read before the size check. <br>• `markdown.ts`: no length cap; some regexes are quadratic on unterminated input. <br>• Images: no dimension cap. <br>• Terminal client: per-channel `messages` grow without limit (`app.rs:1247,1251`), and `lore_download` reads the whole body (`api.rs:869`) after trusting the server's claimed size. <br>Proposed: one size cap before each parse, and a ring buffer for the terminal message list. | read from code |
| Crash loops from a malformed event replayed on start | **Not found.** The outbound queue holds only the client's own intents. Server events are not persisted raw, apart from the e2ee status cache, which is parsed in a try/catch. | read from code |

## Question 5: Encryption-specific

The three known limits (the server supplies keys; the browser gets its code from the server; no outside review) are not repeated here.

| Checked | Result | How we know |
|---|---|---|
| Can a server make a room this device saw encrypted fall back to readable? `e2ee.ts:363` `cacheRoomStatus` | **Holds.** A "disabled" answer is ignored once the device has stored "enabled". Encryption, content gates and labels keep using the stored status. | `e2ee.test.ts` "a server cannot switch a room this device has seen encrypted back to readable"; mutation fails it |
| A room this device never saw | **The server decides**, as for any first contact. It can call a new DM an "older room" with no encryption policy. The UI then labels it server-readable. This belongs with known limit 2, not a new hole; key verification (ADR-0002 stage 1) is where it gets fixed. | read from code |
| Decrypted content leaving through something PR 355 did not cover | **None found** among the paths in this audit. The whiteboard and other workspaces are refused by an honest server in encrypted rooms (`ENCRYPTION_STATUS.md`); albums, Lore and forwarding are also switched off by the client there (`privacy/contentEgress.ts`). Against a hostile server the whiteboard refusal is the server's own choice, so it protects nothing; whether the client warns before a member types into a workspace inside an encrypted DM was **not checked** and is worth a follow-up. L1/L2 were script-in-origin problems: in the browser they could have read decrypted messages and keys of every saved server. Both are fixed. | read from code |
| Terminal client | Shows encrypted messages as a placeholder and sends none. Not affected. | ADR-0002 §1.7 |

## Question 6: Calls and media

| Checked | Result | How we know |
|---|---|---|
| Can the server switch on the microphone, camera or screen share? | **Holds.** `call-incoming` only sets a store; Answer is a click (`IncomingCallModal.svelte:47`). `getDisplayMedia` runs only inside a user action (`callingScreenShare.ts:121`, `callingWabidb.ts:189`). Rejoin after reconnect (`calling_impl_core.ts:1420-1449`) acts only on a call the user already joined. **Design note:** `voice-self-moved` (`calling_impl_core.ts:1771-1781`) lets the server move a live microphone into another voice channel of the same server. The server already relays that audio, so it learns nothing new, but the people listening change. Worth a visible notice (**Low**, open). | read from code; earlier headful call tests (`SECURITY-MODEL.md`) cover admission and teardown |
| **S5** ICE/TURN configuration | **Does not fully hold for privacy. Low–Medium, open.** <br>• `turnCredentials.ts:14-25` accepts a TURN URL on any host, including LAN or loopback addresses (a small probe of the local network). <br>• `turnConfig.ts:72-77` sets no `iceTransportPolicy`, so once a call starts, WebRTC sends **the device's local network addresses** to the server and to peers. That is normal WebRTC behaviour; it means a server learns your home network address. <br>• Proposed: a "relay only" call setting, and refusing private-range TURN hosts unless the server itself is on a private range. | read from code |
| LiveKit: `callingLivekit.ts:581` uses the server-supplied URL with that server's own token | **Holds.** No other server's credential is involved. | read from code |

## Question 7: Terminal client (`core/crates/wabi-tui`)

| Checked | Result | How we know |
|---|---|---|
| **T1** Escape sequences in server text (messages, names, channel names, Lore previews, errors) | **Did not hold; fixed. High for terminal users.** ratatui 0.29 writes each cell's symbol verbatim, and nothing removed control characters. A message `\x1b]52;c;…\x07` could write the user's clipboard. Others could set the window title, add OSC 8 hyperlinks or move the cursor and redraw the screen. Now `ui::scrub_terminal_controls` (`ui.rs:213`) runs on the finished frame (`ui.rs:201`), so every widget is covered, including future ones. Tabs become spaces; other controls become `�`. | `ui::terminal_control_tests` (2 tests; one is a control showing ratatui really passes the bytes through) |
| Unbounded output | Logs are capped at 200. Messages and Lore downloads are not: see S6. | read from code |
| File writes | Only its own config and a fixed log file `$TMPDIR/wabi-tui.log` (`main.rs:31-36`). That path is predictable and follows symlinks, which is a local-user issue (**Low**), not a server one. | read from code |

---

## Fixed in this branch

| ID | Change | Test |
|---|---|---|
| R1 | `communityRoster.ts`: a roster is pinned only under the address that served it; old cross-pins are ignored | `communityRoster.test.ts` (3 new) |
| L1 | `lore/linkSafety.ts` `checkedSignedLoreUrl`, used by `getSignedLoreUrl` | `hostileServerBoundaries.test.ts` |
| L2 | `lore/linkSafety.ts` `pdfPreviewBlob`, used by `LoreChannel.svelte` | `hostileServerBoundaries.test.ts` |
| L3 | `safeExternalUrl.ts`, used by `login/LaunchPanel.svelte` | `hostileServerBoundaries.test.ts` |
| W1 | `whiteboard/sameServerAuth.ts`, used by raster layers, fonts and board images | `hostileServerBoundaries.test.ts` |
| M1 | `markdown.ts` `renderMathSlots` substitutes in text nodes only | `scripts/hostile-server-browser-smoke.mjs` (Chromium), CI `hostile-server-browser.yml` |
| D1 | `hosting::require_bundled_window` on `save_call_recording`, `open_model_viewer`, `open_external_url`, `tailcat_register_key`, `tailcat_connect`, `lore_local_choose`, and Lore `grant()` | `scripts/tests/desktop-shell-contract.test.mjs` (in `desktop-host-safety.yml`), Rust `hosting::tests` |
| T1 | `wabi-tui` frame scrub | `ui::terminal_control_tests` |
| — | Tests for boundaries that already held: desktop CSP, config and capabilities; no computed code imports; the add-on allow-list; no client-side encryption downgrade | contract test, `hostileServerBoundaries.test.ts` "C1", `e2ee.test.ts` |

## Needs the owner's decision (open findings, proposed fixes)

| ID | Severity | Proposed fix |
|---|---|---|
| S1 | Medium | Validate every server/member colour with `sanitizeAccentColor`; allow-list custom CSS |
| S2 | Medium | Send a CSP with the browser client from `app_router.rs` that matches the desktop |
| D2 | Medium (depth) | Desktop navigation/new-window handler, or a Tauri app manifest. Needs a real desktop to try |
| R2 | Low–Medium | Carry a session only to user-approved community addresses, never onto a separately saved server |
| S5 | Low–Medium | "Relay only" call option; refuse private-range TURN hosts from public servers |
| S6 | Low–Medium | Size caps before parsing (3MF, zip without length, markdown length, images); terminal message ring buffer |
| — | Low | Wiki link placeholder: use the DOM substitution from M1. `voice-self-moved` notice. Delete dead `dmKeyring.ts`/endpoint cache |

## What the owner should try on a real desktop

1. In the desktop app, post `[x](https://example.com)` and click it, on Linux, Windows and macOS. Does it open the system browser, a bare popup window, or nothing? The main Wabi window must stay on Wabi.
2. Do the same with `<a href="smb://example/x" target="_blank">`-style links that a server could put in an embed, and with `mailto:`. No OS handler should start without a prompt.
3. Download an attachment named `..\..\evil.lnk` / `../../.bashrc`. The saved file must land in Downloads with a harmless name.
4. Start a call recording and confirm it still saves to Documents/WabiRecordings (the command now checks its caller's origin).
5. Open a Lore PDF. If the preview is blank on desktop, that is the existing CSP blocking `blob:` frames (not new); the download still works.
6. Connect through Tailcat, and open a model in the native viewer. Both commands now check their caller's origin and must still work.
7. With `wabi-tui`, receive a message containing `ESC ] 52 ; c ; aGk= BEL`. The clipboard must stay unchanged, and the message shows `�` characters instead.
