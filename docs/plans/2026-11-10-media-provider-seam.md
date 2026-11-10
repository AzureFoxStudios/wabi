# Media provider seam: get LiveKit behind one door

**Status:** plan, nothing implemented.
**Audited at:** `14e95db` (main, 2026-11-10). Line numbers below are from that commit and will drift.
**Implements:** section 4 of `docs/architecture/MEDIA_BACKEND_AND_CERTIFICATION.md` ("Backend-specific objects must stay inside adapter/provider modules").

## Why

Wabi's media policy says the SFU backend is replaceable. Today it is replaceable in the SDK sense only: one file imports `livekit-client`, but a dozen other places know that "SFU" means LiveKit. Until that is fixed, a second backend (mediasoup or anything else) cannot be tried without editing the 3,500-line call core, and the SFU path cannot be unit-tested with a fake.

This plan changes no behaviour. It does not add mediasoup, remove LiveKit, or change the default transport.

## What the audit found

Good news first: **only `frontend/src/lib/callingLivekit.ts` imports the `livekit-client` SDK.** The leaks are of Wabi's own LiveKit wrapper, not the SDK.

| # | Where | What leaks |
|---|---|---|
| F1 | `frontend/src/lib/calling_impl_core.ts` | About 25 direct calls into `callingLivekit`: `connectLivekitSfu` (lines 453, 1461, 1625, 1994), `disconnectLivekitSfu` (294, 336, 451, 884, 1689, 1764, 3065), and the raw LiveKit `Room` for microphone and camera (732-735, 944, 2718-2722) |
| F2 | `frontend/src/lib/callingScreenShare.ts:17,78,100-104` | Holds a LiveKit `Room` object to publish screen shares |
| F3 | `frontend/src/lib/components/VideoSink.svelte` | A UI component imports `callingLivekit` and reads `__wabiLivekitShare*` tags off a `MediaStream` |
| F4 | `mediaRuntime.ts:275-314`, `callingTransport.ts:34-58`, `relaySelector.ts:29,98`, `callingTransports/builtins.ts:43-49` | `provider === 'livekit'` hard-coded as the only meaning of "SFU"; reads a `runtime.media.livekit` payload |
| F5 | `mediaGateway.ts:95-116` | Token call goes to `/api/media/livekit/token` and returns `LivekitAccessTokenResponse` |
| F6 | `core/crates/wabi-server/src/api/media.rs` | Route `/livekit/token` (line 94), `provider != "livekit"` check (469), runtime payload key `livekit` (667-810), all behind the default-off `experimental-livekit-broker` feature |
| F7 | `frontend/src/lib/callingTransports/registry.ts` | The adapter registry is used only by its own test. `ensureBuiltinTransports()` is never called by the app. Its header comment says the chain executor consumes it; that is not true today |

Two facts that shape the work:

- `frontend/scripts/audio-browser-smoke.mjs` does not exercise the SFU path, so there is no automated coverage of LiveKit calls. Every task below needs a manual LiveKit call before merge.
- The LiveKit path only works on a server built with `--features experimental-livekit-broker` and a reachable LiveKit server.

## Design

One interface, `SfuProvider`, living in `frontend/src/lib/callingTransports/sfuProvider.ts`. Its methods are exactly the things F1-F3 reach into `callingLivekit` for today, expressed in Wabi words (channel, user id, microphone, camera, screen share). No method is added for a future need. `callingLivekit.ts` exports the one implementation; everything else imports the interface and asks for "the active SFU provider".

The existing `CallTransportAdapter` registry (F7) stays as it is. Wiring the fallback chain through it is a separate, riskier piece of work and is out of scope.

## How to run this

- One task per session, one branch and PR per task, in order. Paste the preamble, then the task.
- "You check" is the one thing to look at before merging.
- Tasks 1.3 and 1.4 touch live call state. Have a second session review each PR with the instruction "find a reason this PR changes behaviour".

### Preamble (paste at the top of every session)

```
Read AGENTS.md, frontend/AGENTS.md, docs/architecture/MEDIA_BACKEND_AND_CERTIFICATION.md and docs/plans/2026-11-10-media-provider-seam.md first. Then do ONLY the task pasted after this. Create a new branch off main named after the task.

This plan is a behaviour-preserving refactor. A call must work exactly as it did before your change, on every transport (wabidb relay, P2P, LiveKit SFU).

Rules:
1. Change the smallest amount of code that completes the task. No drive-by refactors, renames or reformatting outside the lines you must touch.
2. Do not add mediasoup or any second provider. Do not remove or upgrade livekit-client. Do not change which transport is chosen or when fallback happens.
3. calling_impl_core.ts guards against stale work with abort signals, generation counters and `scope.current()` checks. Every call you reroute must keep the same guard, the same await/void behaviour, and the same ordering relative to its neighbours. If you cannot tell whether a guard is preserved, stop and say so.
4. Do not weaken any auth, permission or voice-policy check.
5. Do not edit files under docs/ unless the task says to. If a doc claim becomes false, list it at the end.
6. Verify from frontend/: `bun run check` (the known baseline is four xlsx type errors; add none), `bun test src/lib`, and `node scripts/audio-browser-smoke.mjs` if a headful browser is available. If dependencies cannot be installed in your sandbox, say so plainly and do not claim the checks passed.
7. The smoke script does not cover LiveKit. Say in your summary that the LiveKit path was not exercised by any automated test.
8. End with: the commands you ran and their output, the files changed, and anything you were unsure about. Push the task branch and open one pull request against main.
```

## Phase 1: frontend

### Task 1.1 Boundary test (Sonnet)

```
TASK 1.1

Add frontend/src/lib/callingTransports/sfuBoundary.test.ts, a bun test that scans frontend/src for provider leaks and acts as a ratchet for the rest of this plan.

It must check every .ts and .svelte file under frontend/src (skip *.test.ts) for:
- an import of 'livekit-client';
- an import from a module whose path ends in callingLivekit or callingLivekitTokenRefresh;
- the identifiers getLivekitRoom, connectLivekitSfu, disconnectLivekitSfu.

Files allowed to do this permanently: callingLivekit.ts and callingLivekitTokenRefresh.ts.

Files that do it today are listed in an explicit KNOWN_LEAKS array in the test, each with the finding number from the plan (F1, F2, F3) and a one-line reason. Build that array from what the scan actually finds on main, not from the plan's table.

The test fails if (a) a file not in either list leaks, or (b) a file in KNOWN_LEAKS no longer leaks (so the entry must be deleted when the leak is fixed).

Change no production code.
```

You check: the test passes on its branch, and `KNOWN_LEAKS` names `calling_impl_core.ts`, `callingScreenShare.ts`, `components/VideoSink.svelte` and `calling.ts`.

### Task 1.2 Define `SfuProvider` and implement it for LiveKit (Opus)

```
TASK 1.2

Create frontend/src/lib/callingTransports/sfuProvider.ts exporting:
- an `SfuProvider` interface;
- `getActiveSfuProvider()` and `setActiveSfuProvider()`.

Derive the interface from real use. List every place outside callingLivekit.ts and callingLivekitTokenRefresh.ts that calls into those two modules or touches the LiveKit Room (findings F1, F2, F3 in the plan give the starting points; re-scan, do not trust the line numbers). Each distinct thing those callers need becomes one method, named in Wabi terms: channel id, user id, microphone, camera, screen share, connect, disconnect. No LiveKit type (Room, Track, Participant, publication) may appear in the interface. Do not add a method nothing calls today.

Two cases need care:
- calling_impl_core.ts uses the Room object's identity to detect staleness (`getLivekitRoom() === room`). Give the interface an opaque session token or equivalent that supports the same comparison.
- callingScreenShare.ts publishes through the Room. Read how it uses it and expose only that.

Then make callingLivekit.ts export one object implementing the interface, delegating to the functions that already exist, and register it as the active provider where initLivekitDeps is called today.

This task is additive: do not change any existing caller. Add a unit test that a fake SfuProvider can be set and retrieved, and that the LiveKit object satisfies the interface at the type level.

Put a table in the PR description: each interface method, and the existing call sites it will replace.
```

You check: the PR's table. Every row should have at least one existing call site; a method with none is speculative and should go.

### Task 1.3 Route the call core through the provider (Opus)

```
TASK 1.3

In frontend/src/lib/calling_impl_core.ts, replace every direct use of callingLivekit (connectLivekitSfu, disconnectLivekitSfu, getLivekitRoom, getLivekitChannelId) with the SfuProvider from task 1.2. Keep initLivekitDeps and configureLivekitTokenRefresh wiring working; move them behind the provider only if that needs no behaviour change, otherwise leave them and say so.

Do this one call site at a time. For each, the PR description lists: the old line, the new line, and the guard (abort signal, generation check, scope.current(), preserveCallState flag) that applied before and still applies after.

Do not touch the fallback order, the transport-selection logic, or any wabidb/P2P code path.

Remove calling_impl_core.ts from KNOWN_LEAKS in the boundary test.

If calling_impl_core.ts can be imported under bun test, add tests with a fake SfuProvider asserting that leaving a channel disconnects with the same arguments as before and that mute state reaches setMicrophoneEnabled. If it cannot be imported without a large harness, do not build one; say so.
```

You check: on a LiveKit-enabled server, with two real devices: join a voice channel, mute and unmute, turn the camera on and off, switch channels, leave. Then repeat with the SFU disabled to confirm the relay path is unchanged.

### Task 1.4 Screen share through the provider (Opus)

```
TASK 1.4

In frontend/src/lib/callingScreenShare.ts, replace the LiveKit Room (import at the top, the `room` field around line 78, and its use around lines 100-104) with the SfuProvider methods defined in task 1.2. The existing condition for choosing the SFU path (provider connected, SFU media active, same channel as the share scope) must be preserved exactly.

Remove callingScreenShare.ts from KNOWN_LEAKS.
```

You check: on a LiveKit-enabled server, start and stop a screen share, with a second device confirming it appears and disappears.

### Task 1.5 Neutral screen-share gate in the UI (Sonnet)

```
TASK 1.5

frontend/src/lib/components/VideoSink.svelte imports viewLivekitScreenShare / hideLivekitScreenShare and reads `__wabiLivekitShare*` properties tagged onto a MediaStream by callingLivekit.ts.

1. Rename the tag properties to provider-neutral names (`__wabiSfuShare`, `__wabiSfuShareOwnerId`, `__wabiSfuSharePending`, `__wabiSfuShareViewing`) in both the writer (callingLivekit.ts) and the reader. Define the tagged-stream type once, in sfuProvider.ts, and import it in both.
2. Call view/hide through the SfuProvider instead of importing callingLivekit.
3. Rename the `.livekit-share-*` CSS classes to `.sfu-share-*`. First search the whole repo (stylesheets, tests, scripts under frontend/scripts) for those class names and update every reference.

No visual change: do not alter any style value, markup structure or wording. Remove VideoSink.svelte from KNOWN_LEAKS.
```

You check: a remote screen share still shows the "View" gate first, and "View" then shows the share.

### Task 1.6 Provider selection by id (Opus)

```
TASK 1.6

Finding F4: mediaRuntime.ts, callingTransport.ts, relaySelector.ts and callingTransports/builtins.ts hard-code `provider === 'livekit'` and read `runtime.media.livekit` to decide whether the SFU is usable.

Add one optional method to SfuProvider, `isAvailable(runtime)`, implemented for LiveKit with the exact condition used today (provider is 'livekit', configured, url present). Replace the four hard-coded readiness checks with a lookup: find the provider whose id matches `runtime.media.sfu.provider`, ask it. An unknown or missing provider id must behave exactly as a non-LiveKit provider does today (SFU unavailable, same fallback, same reason strings: 'sfu_plugin_disabled', 'livekit_unconfigured', 'livekit_connect_failed').

Before changing code, write table-driven tests for resolveCallTransportPlan and resolveActiveTransport covering: no runtime, provider absent, provider 'livekit' unconfigured, configured without url, fully ready, unknown provider id. They must pass before and after your change.

Do not rename the reason strings or the runtime payload keys; the server still sends them. Also correct the header comment in callingTransports/registry.ts, which says the chain executor consumes the registry; it is used only by its own test.
```

You check: the new tests were committed in a first commit that passes on its own, before the refactor commit.

## Phase 2: server (after phase 1 is merged)

### Task 2.1 Provider-neutral token route (Opus)

```
TASK 2.1

Finding F6. Read core/crates/wabi-server/src/api/media.rs, api/media_permissions.rs, api/media_node_catalog.rs, and the tests tests/realtime_security_contract.rs and tests/helper_resource_security_contract.rs before writing anything.

Goal: a client can request SFU join credentials without naming LiveKit in the URL, so a future provider needs no new client code path.

1. Add POST /api/media/sfu/token. It runs the same authentication, membership, voice-policy and media-node selection as /api/media/livekit/token, then dispatches on the selected node's provider string. 'livekit' calls the existing code. Any other value returns a clear error naming the unsupported provider.
2. Keep /api/media/livekit/token working unchanged; older clients call it.
3. The response gains a `provider` field. If the response type lives in crates/wabi-core, follow the documented ts-rs regeneration workflow (AGENTS.md golden rule 4); do not hand-edit packages/wabi-protocol.
4. Every security-contract test that covers the old route must have an equivalent for the new one, written first and failing before the route exists.
5. The route stays behind the same `experimental-livekit-broker` feature and returns the same response as today when the feature is off.

Do not change the runtime payload shape, token contents, identity format, or token lifetime. Then switch frontend/src/lib/mediaGateway.ts to the new route, falling back to the old one on 404 so a new client still works against an older Authority.

No persistent record types may change. If you find one that would, stop and say so.
```

You check: the diff adds security tests for the new route and deletes none for the old.

## Out of scope, and what comes next

- **Certification suite** (section 7 of the media backend doc) and **Call Doctor** (section 9). These are the next two plans. Phase 1 here gives them a fake-able provider to test against.
- **A second provider.** Once the suite exists, a mediasoup backend is: implement `SfuProvider`, add a server dispatch arm in the token route, run the suite, compare.
- **Wiring the fallback chain through the `CallTransportAdapter` registry** (F7).
- **Renaming** `callingLivekit*.ts`, the `LIVEKIT_TOKEN_REFRESH_*` constants, or the `runtime.media.livekit` payload key. They are inside the provider boundary or part of the wire format and cost more to rename than they return.
