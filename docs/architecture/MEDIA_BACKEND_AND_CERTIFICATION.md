# Media backend contract, certification, and deployment philosophy

**Status:** architecture and release policy  
**Updated:** 2026-09-14

Wabi is an open-source tool, not a hosted service that happens to publish source.
The media layer must preserve that property. A community must be able to build,
run, repair, fork, and replace Wabi's call infrastructure without depending on
AzureFoxStudios, `wabi.chat`, a project-owned account, or a project-owned media
service.

This document defines the stable Wabi-owned boundary around real-time media. It
also defines how a media backend earns release status.

## 1. Product invariant: simple setup stays simple

More capable media infrastructure must not turn normal Wabi installation into a
systems-administration exercise.

The core install remains:

```bash
docker compose up -d --build
```

A media-enabled install must also have a **single operator command** path. The
exact CLI spelling may evolve, but the user experience may not degrade into
manually compiling C++ workers, authoring ICE JSON, creating certificates,
choosing RTP port ranges, wiring TURN by hand, or running a sequence of database
bootstrap commands.

A valid simple-mode media package must:

- ship through the normal Wabi release/container path;
- generate safe local secrets when practical, or ask for the minimum required
  external/public address information once;
- start every required local component from one command even when Compose starts
  more than one container internally;
- expose useful health/readiness state to Wabi;
- require no AzureFoxStudios account or hosted control plane;
- keep advanced topology optional;
- support exportable configuration so expert operators can take full control.

The implementation may be complicated. **The operator path must not be.**

### mediasoup-rust does not invalidate this rule

mediasoup-rust uses the proven mediasoup C++ SFU worker through a Rust API. Wabi
can package the worker and Wabi-specific Rust control process into a release
image and launch them as one media service. coturn may remain a separate
container internally; Compose can still start the entire stack from one command.

Therefore a future mediasoup backend is acceptable only if Wabi owns the
packaging and lifecycle so an ordinary administrator never has to understand or
manually build the C++ worker.

A backend that is technically powerful but cannot meet this setup invariant is
not eligible to become Wabi's default backend.

## 2. Version strategy

### Wabi 1.x — LiveKit reference backend

Wabi 1.x should use self-hosted LiveKit as the reference SFU once the integration
passes the certification gates below. LiveKit is an implementation detail behind
a Wabi-owned contract; normal product semantics must not depend on LiveKit types
throughout the UI.

### Wabi 2.x — media architecture generation 2

Wabi 2.x is **not pre-declared to mean mediasoup**. mediasoup-rust is the leading
candidate for a more Wabi-native backend, but it must earn that role.

A candidate may become the reference backend only when it:

1. passes the same Wabi Media Contract suite as the current reference backend;
2. passes the same network-torture and load gates;
3. preserves or improves the one-command setup path;
4. demonstrates a concrete advantage such as lower resource use, better
   selective routing, easier Wabi Media Node operation, or substantially better
   large-room behavior;
5. does not make Wabi materially harder for future maintainers to understand,
   replace, or operate.

If mediasoup produces no meaningful advantage after accounting for maintenance
cost, Wabi may remain on the LiveKit generation indefinitely. A major version is
not a scheduled rewrite.

Where practical, an older certified backend should remain available after a new
reference backend is introduced so operators have a migration and fallback path.

## 3. Wabi owns policy; the backend owns packets

Voice policy must exist above every transport. A user must not be able to bypass
Wabi authorization by switching between P2P, WabiDB relay, LiveKit, mediasoup,
or a future backend.

Examples of Wabi-owned policy:

- membership and admission;
- self mute versus server mute;
- self deafen versus server deafen;
- muted-on-entry;
- listen-only entry;
- role-gated or approved speaking;
- request-to-speak / audience behavior;
- camera/screen publication permission;
- whether a user has chosen to view a screen share;
- kick/move/revocation;
- per-session recording policy.

The media backend is responsible for enforcing the resulting publication and
subscription decisions and for moving encrypted real-time media efficiently.

## 4. Provider-neutral media contract

The exact TypeScript/Rust traits may differ from these names, but the stable
conceptual surface should include operations equivalent to:

```text
joinRoom()
leaveRoom()

publishMicrophone()
unpublishMicrophone()
publishCamera()
unpublishCamera()
publishScreen()
unpublishScreen()

subscribeTrack()
unsubscribeTrack()
setPreferredVideoLayer()

setServerMuted()
setServerDeafened()

getMediaStats()
```

Backend-specific objects must stay inside adapter/provider modules. UI and call
policy code should consume Wabi concepts such as participant, microphone,
camera, screen share, subscription, and quality preference.

The provider registry may grow beyond the current `none | livekit` implementation
shape. Candidate values include `mediasoup` and explicitly experimental providers,
but adding an enum value is not proof that the backend is certified.

## 5. Selective media behavior

A scalable backend must avoid moving media merely because it exists.

Baseline behavior:

- microphone audio may be subscribed automatically for active listeners;
- listen-only means no microphone publication;
- server mute must prevent publication at the authoritative media boundary, not
  merely disable a UI button;
- deafen should stop unnecessary remote-audio reception where the backend allows
  it;
- a remote screen share first arrives as metadata/presence only;
- actual screen video/audio is subscribed when the user explicitly chooses
  **View** (or when a documented small-room policy intentionally auto-opens it);
- closing/minimizing an explicitly viewed share should unsubscribe when it is no
  longer needed;
- large-room camera subscriptions should follow visible, pinned, or otherwise
  intentionally selected tiles rather than receiving every camera at full
  quality;
- simulcast/SVC/adaptive layers should reduce quality for small tiles and stop
  unused layers where supported.

Hiding an HTML video element after downloading the track does not count as
selective subscription.

## 6. CGNAT and Wabi Media Nodes

A Wabi Authority must be allowed to live behind NAT or CGNAT. The architecture
must not require the community's main state server to expose a public UDP media
socket.

For deployments that cannot host a public SFU locally:

```text
CGNAT/private Wabi Authority
          |
          | outbound authenticated control
          v
Public Wabi Media Node
          |
          +-- SFU
          +-- TURN as required
          |
       clients
```

The Media Node may be operated by the same community, a friend, a hosting
provider, or another organization. Wabi must not require a project-operated node.

A Media Node should be addressable through normal operator configuration and
short-lived/scoped media authorization. It should not receive Wabi's durable
database or become an Authority merely because it routes calls.

The existing media-room/node registry is the correct architectural direction:
Wabi chooses a media endpoint while Wabi remains the authority for membership and
policy.

## 7. Wabi Media Certification Suite

The test environment is part of Wabi. A developer's home ISP is one field-test
case, not the certification system.

Every reference media backend must pass a backend-neutral suite using generated
media and automated clients.

### Functional matrix

At minimum verify:

- join, leave, cancellation, reconnect, and socket replacement;
- microphone publish/unpublish;
- self mute/deafen;
- server mute/deafen;
- muted-on-entry and listen-only behavior;
- malicious-client attempts to publish while server-muted;
- camera publish/unpublish;
- camera visibility/subscription changes;
- screen-share announcement without receiving its media;
- explicit View -> subscribe;
- close/minimize -> unsubscribe;
- kick/move/revocation leaves no ghost publication or hot mic;
- simultaneous camera + screen share;
- multiple calls/sessions without cross-call media leakage;
- transport/backend failure without stale success or ownership resurrection.

### Scale matrix

Maintain repeatable scenarios for at least:

- 2 participants;
- 6 participants;
- 25 participants;
- 50 participants (release target for normal large rooms);
- 100 participants (stress/degradation target, not necessarily a promise that
  every hardware profile sustains every camera at maximum quality).

Scenarios should distinguish connected users, active talkers, published cameras,
visible cameras, published screen shares, and actual screen viewers.

### Network torture matrix

Use Linux network namespaces, `tc netem`, firewall rules, and equivalent CI/lab
controls to manufacture predictable failure conditions instead of waiting for a
particular ISP:

- normal low-latency network;
- mobile-style latency/jitter/loss;
- constrained upstream bandwidth;
- sustained packet loss;
- UDP blocked;
- direct ICE blocked / TURN required;
- TCP fallback;
- TURN/TLS-only restrictive network;
- short total network loss followed by recovery;
- media-node restart/disconnect during an active call.

Where a platform prevents reproducing a condition in CI, keep an explicit field
certification checklist rather than silently treating it as covered.

## 8. Existing automated foundation

Wabi already has generated-media browser regression coverage through
`frontend/scripts/audio-browser-smoke.mjs` and the `Voice Browser Smoke` GitHub
Actions workflow. The media certification suite should extend this foundation
rather than create an unrelated testing philosophy.

Synthetic testing is not allowed to overclaim. Physical microphones/speakers,
real two-device NAT traversal, native WebView behavior, and selected field
networks remain explicit release checks where they cannot be proven by the
harness.

## 9. Call Doctor

Wabi should expose a user-facing **Voice & Video -> Connection Test** that reports
media diagnostics without recording conversation content.

Useful fields include:

- signaling latency;
- selected media backend;
- selected route/candidate class;
- UDP success;
- TURN/UDP success;
- TCP fallback success;
- TURN/TLS success;
- RTT, jitter, and packet loss;
- estimated/observed send and receive bitrate;
- current publications and subscriptions;
- selected video layers;
- an exportable privacy-conscious diagnostic report.

The same diagnostic surface must work regardless of backend so future maintainers
can compare providers and investigate real networks without needing the original
Wabi developers.

## 10. Release gates

A media backend is not "done" because it compiles or because two local browser
tabs can talk.

Before becoming the reference backend it must have evidence for:

| Gate | Minimum evidence |
| --- | --- |
| policy | voice permissions/state transitions pass |
| browser | generated-media browser suites pass |
| provider contract | backend-neutral contract suite passes |
| network | UDP plus required fallback/TURN paths pass |
| adverse network | loss/jitter/bandwidth/reconnect scenarios pass |
| security | unauthorized publication/subscription attempts fail |
| selectivity | unviewed media does not continue consuming full media bandwidth |
| load | 50-participant target passes on documented hardware |
| stress | 100-participant test fails/degrades sanely if capacity is exceeded |
| desktop | supported Tauri smoke/field checks pass |
| field | selected real multi-network checks complete |

The test results should be reproducible and retained with releases where
practical.

## 11. Survivability rule

A clean third-party machine should be able to clone/build Wabi, generate its own
keys, start the Authority, optionally start or point at its own Media Node, and
make a call without contacting infrastructure controlled by the Wabi project.

This is a release property, not just a philosophical preference.
