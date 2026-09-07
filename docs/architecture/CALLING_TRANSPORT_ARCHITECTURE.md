# Calling transport architecture

Updated 2026-09-08. Implementation and verification details are in the
[audio-flow integrity work record](../plans/2026-09-06-audio-flow-integrity.md).

## Admission before media

Voice roster admission requires a live Voice channel and the shared persisted
channel-access policy. A private conversation cannot be passed through the
globally visible voice-roster API. Group initiation/answer requires GroupDm
membership, including for the instance owner; an empty membership list never
means "invite everybody". Existing group members can join an established call
without a ringing invitation.

The shared browser/Tauri client awaits HTTP membership then correlated
`voice-channel-admitted` before microphone acquisition or media setup. Group
starts await `group-call-started` and answers await `group-call-admitted`, both
before microphone/camera acquisition. Start acknowledgements include `established`
so joining an existing group call does not leave the new participant ringing.
Server emit order alone does not prove that another async handler has completed.
Client/server changes to these acknowledgments must ship together.

Group call setup has one local owner through admission, capture, signaling and
teardown. Group membership epochs invalidate that owner on removal or realm
change; a re-add permits a new call but cannot revive old async work. Incoming
participant notifications/offers wait for that owner's capture readiness and
cannot establish a group call without matching local intent. Teardown removes
the matching peers, graph session and relay, preserving unrelated primary or
listen-only voice consumers. Abort is not a transport failure: fallback must not
select another transport or publish a stale success after cancellation.

Relay local ownership is retired before HTTP leave awaits. Setup checks its
controller and membership lease after asynchronous boundaries; old completions
cannot delete new in-flight registrations or relays. Current group clients pin
create/join/leave HTTP requests with decimal `membership_revision` query values,
including across auth retries. The server checks supplied revisions under the
membership gate before writes (409 on mismatch). This is an optimistic fence,
not a replacement for authorization; legacy requests without it still use the
existing scope checks. Raw-call revocation also retires subscription identities
and cached rows, leaving other sessions intact.

See the [membership work record](../plans/2026-09-07-group-membership-revocation.md)
for verified race scenarios and remaining camera/screen-share/archive work.
These checks are not yet full native-webview or physical two-device proof.

Voice consent belongs to the exact connection, not any device with its account
ID. Authenticated sockets join their own ID room for device-addressed signaling.
Leave/cancel invalidates pending voice admission; primary and listener intents
are independent. Kicks revoke all of the target account's rostered sockets from
that channel's relay and clear only its cached headers. Roster locks serialize
relay admission/enqueue with eviction. Other calls remain intact; the client is
also told to tear down its peer/media state. A server cannot forcibly terminate
a direct P2P connection between two clients that both ignore its control events.

Direct relay keys name the two principals; the legacy `channelId` hint on these
requests is a UI/peer key, **not** a persisted channel. Group consent uses an
account-level session set. Durable group removal now evicts every authenticated
device from the group's chat/board/relay rooms, removes account consent and only
that group's cached headers. A shared membership gate orders socket admission,
peer signaling and REST call commands against that removal. See the
[admission work record](../plans/2026-09-07-call-admission-boundary.md); these
changes are not a claim of complete call/session authorization.

## Persisted call-state authorization (2026-09-07)

`/api/calls` and raw `/ws` now share `call_access.rs`. Voice/group calls require
current persisted channel access; canonical `dm:user-A:user-B` calls require one
of their two accounts. A People/DM UI channel hint is not authorization. Active
session host/scope are immutable across repeated create; participant identity is
derived from the account, join retries are idempotent, and end is host-only
except that a group's current owner may end a call whose host left the group.
Signal reads/writes additionally require active recorded participation. Unicast
signals are visible only to their sender and recipient, including replay.

Raw `/ws` is exclusively a call-state subscription stream; chat/media stay on
Socket.IO. The first application frame authenticates an account access JWT.
`authenticated` acknowledges readiness and expiry. Same-account reauthentication
renews without replacing the socket; account switching requires a new connection.
No URL credentials, anonymous subscriptions, or client-supplied server broadcasts
are accepted. Subscription authorization is rechecked before live delivery;
account expiry/revocation is also checked while idle. Heartbeats, handshake/write
deadlines and a 64-subscription limit bound connection lifecycle state.

`subscribe_call` accepts a durable `since` signal cursor and returns `call_snapshot`
(session, roster, authorized signals). Broadcast lag emits `resync_required` and
clears server subscriptions; the client resubscribes with its cursor and deduplicates
queued/replayed signals. No-op REST retries return `commit_seq: null`, not a fake
commit. New writes still await command → event → projection before publishing.
Signal IDs are allocated from the persisted session tail under a bounded striped
lock, not a process counter; composite IDs are split at the final colon.

Browser and Tauri share this client. Readiness waits for authentication ACK,
stacked waiters survive refresh, stale socket callbacks cannot affect replacements,
and a temporary refresh failure retries within the current token lifetime. Tokens
and refresh requests are server-scoped and account-bound; a late refresh response
cannot undo logout/account replacement. Previously stored unscoped refresh tokens
are intentionally not migrated to a guessed server: those sessions need a fresh
login on expiry. Client/server protocol updates must ship together.

These persisted rows are **not** authoritative live media presence or device
consent. Group removal retires associated participant rows in its membership
command, including ended-session rows; last-member leave ends active sessions.
Raw WS gets versioned account-revocation control so a quick re-add cannot preserve
an old subscription, nor can a delayed removal cancel a later valid subscription.
Matching group UI/cache teardown is still in progress; see the
[membership work record](../plans/2026-09-07-group-membership-revocation.md).
Abrupt-client-death cleanup, multi-device presence and long-term signal
retention remain distinct lifecycle work. See the
[call-state work record](../plans/2026-09-07-call-state-authorization.md) for evidence
and limits. No call record/event encoding changed.

## Control, media, and persistence are different paths

Wabi's default `auto` calling policy prefers the WabiDB-labelled relay with a
P2P fallback; explicit P2P and optional LiveKit policies also exist. See
`callingFallback.ts` and `callingTransport.ts` for policy and selection.

The relay name does **not** mean that microphone samples are persisted as
WabiDB events. Call control uses the server's session/API/WebSocket machinery;
live audio/video envelopes use authenticated Socket.IO rooms. The server
maintains a bounded, ephemeral cache of initial Opus headers for late joiners.
The event-sourced database remains responsible for persistent application
state, not an append-only audio recording. Optional recording is separate.

## Microphone and screen sound

`audioCapture.ts` owns the shared microphone and optional browser DSP graph.
`AudioCaptureOwner` coalesces initial acquisition, invalidates superseded
permission requests, and retains the current input until a replacement commits.
Teardown also disposes capture results that arrive after the call ends.

The two media routes consume that selected, processed microphone:

- P2P owns a separate cloned send track per peer. Mute and transmit routing gate
  those clones synchronously, including pending device replacements. They do
  not mute an unrelated peer, recording source, or screen-share track.
- The relay passes an explicit `sourceNode` to opus-recorder. It must never ask
  the recorder to acquire another/default microphone. Screen audio has its own
  encoder borrowing the display track, and mic mute does not gate screen sound.

Relay capture starts only after correlated `wabidb-call-joined` authorization.
Socket loss stops both encoders immediately; rejoin restarts with fresh Opus
headers. Client and server changes to this acknowledgment must ship together.

## Receiving and handover

Relay decoders are keyed by account, sender socket, and microphone/screen
source. Decoder workers are streams: one Ogg page can produce zero or multiple
PCM outputs. Bounded PCM queues feed the playback AudioWorklet, then the shared
per-session audio graph. `playedChunks` counts render acknowledgments, not
successful decode calls or queued messages.

After 500 ms of microphone PCM has rendered for a participant, that participant's
redundant P2P **receive track** is suppressed. Screen audio and another peer's
audio cannot satisfy this gate. Room loss, stopped/suspended playback, or two
seconds without render acknowledgments restores the existing P2P receive path.
Stale relay teardown cannot override a replacement relay's selection.

Crucially, receive proof does not prove the outgoing direction. Handover does
not close a bidirectional P2P connection or its camera/sender. This intentionally
retains backup transport bandwidth; retiring it safely would require additional
bidirectional coordination, not a decode counter.

Manual channel switches prepare before tearing down the old route. A P2P switch
requires connected peers, not merely emitted SDP offers, and requires every
expected roster peer before leaving relay rooms. Failed preparation retains
the old route. DM/group manual switching and multiple channel-owned PCs for the
same peer are not supported by the current peer-key contract.

## Group media ownership and signaling scope (2026-09-08)

Video receive lanes belong to individual relay sessions. Wire session IDs are
unchanged; `viewSessionId` uses CallSessionManager identities for rendering.
Remote and local preview stores have session-indexed views used by CallStage,
VoiceView and the compatibility modal/strip selectors. Filtering by participant
alone is insufficient when a person is present in several calls.

One camera and one display capture can run independently, each with an explicit
destination. Stop retires the owner before asynchronous cleanup. Late codec,
permission, SDP and decoder callbacks cannot revive retired media or clear a
replacement lane. Video emission requires the owning relay's admitted room;
removal must not stop an unrelated microphone/receive relay. Newly negotiated
background peers cannot inherit a foreground group's camera from localStream.

Screen start/stop carry `requestId`, plus `channelId` (group/voice) or
`targetUserId` (direct). Groups include decimal `membershipRevision`. The client
awaits correlated `screen-share-targets` or `screen-share-error` before returning
success or starting relay video. Screen offers/answers/ICE retain channel/share
identity; ordinary call answers/ICE also retain channel scope. Server consent
checks the exact call under the membership gate, not any background relationship.
Unscoped peer signaling is direct-call-only. Recording's audience is unchanged.

**Ship client/server together and reload old clients:** old unscoped screen
starts are refused rather than selecting an ambiguous union-of-calls audience.
This is a Socket.IO contract change, not a postcard/event schema change.

Early ICE parking remains supported. `callingIce.ts` keeps the admission lease
and share identity with each parked candidate, and stops draining a replaced
peer. Webviews without WebCodecs select P2P video while retaining relay audio.
The installed LiveKit SDK awaits publication and returns it (or undefined on
failure); screen capture uses that owned result instead of polling a global room.

## Socket replacement and group readmission (2026-09-08)

SocketManager creates a **new Socket.IO object** on reconnect. Joining its media
room cannot repair a relay or video lane that still holds the old object.
`callSocketLifecycle.ts` is the import-light owner notification boundary:
disconnect/replacement notifies synchronously **before** listener removal;
readmission begins only after the current authoritative `init` is reconciled.
This does not depend on the optional offline queue. Roster snapshots and queue
dispatch no longer initiate media by themselves.

Established group and voice owners retire old peers/relay/video lanes locally,
preserve capture and user intent, and show reconnecting. Transient retirement
does not issue account-level HTTP leave: a delayed leave with an unchanged
membership revision could erase a replacement join. Screen sharing stops; its
picker is never reopened automatically. Pending initial group attempts cancel.

A fresh group owner sends correlated `call-initiate` with `rejoin: true` and the
**original** decimal `membershipRevision`. It waits for `group-call-started`
before constructing new-socket media. This path does not ring invitees and can
reconstruct empty ephemeral server state. Any membership revision change requires
new explicit user intent, conservatively including changes to other members.
An offline removal/re-add seen only as a final init cannot revive the old call.
Old owner controllers/identities stay retired across repeated reconnects.

Server `GroupCallParticipants` owns `account -> admitted socket IDs`, not an
account-only consent set. Account counts remain deduplicated. Relay/signaling/
recording admission requires the sending device's slot; a device leaving or
disconnecting removes only that slot. Participant-left is published on the last
admitted device's departure. Membership removal removes **all** account slots.
An unadmitted device or old socket disconnect cannot evict another admitted
device. These are ephemeral structures/wire preconditions, not postcard fields.
Persisted CallParticipant records remain account-level.

Primary and background voice readmit independently before transport construction;
recovery preserves microphone ownership, mute, session focus and volume. Explicit
primary leave removes one session, not all calls. Direct-call reconnect and
multi-device P2P negotiation still have their separate legacy boundaries; this
does not claim a generalized multi-device P2P engine.

Sidebar subscribe/unsubscribe now use the same call owners (an explicit
listen-only join option), not raw presence commands with roster-triggered media.
Offline unsubscribe cancels retained local intent even between socket objects.
Voice actions are not durable queue work: enqueue refuses them and legacy rows
fail non-retryably. Recovery sends current transmit routing after admission.
Clicking Join while recovery is pending shares its operation; leaving the
focused call can transfer focus to a retained reconnecting session without
marking that session's media connected.

`audio-browser-smoke.mjs /__call_reconnect` exercises production owners and real
encoded audio with fixture network boundaries. Run the script without arguments
for all eight routes. See the active membership plan for actual results and limits.

Server-forced voice moves transfer socket ownership, primary/listener intent and
session controls before awaiting destination admission. The source relay, peers
and screen share retire immediately; its HTTP leave cannot block the move. The
destination uses the same cancellable readmission and transport fallback path as
reconnect, not a separate relay-only setup. A newer move/kick cancels the old
operation; stale joins cannot clear a replacement. Forced kicks use scoped voice
leave, preserving other calls and releasing capture when the last consumer ends.
Failed initial joins use that same teardown: an unanswered P2P connection must
close when setup fails, not survive removal of its visible session.
Recovery reacquires ended microphone tracks only after fresh admission. Call
session transport labels use their own fallback outcome, not another session's
last write to the shared transport diagnostic. The `/__voice_ownership` headful
route covers these client races, including real P2P peer/screen teardown. Its
fixture server does not certify moderator/breakout multi-device behavior or the
separate account-level persisted leave/rejoin race within one membership revision.

The embedded channel panel has independent **view** and **transmit** targets.
Second-click toggles the viewed session without focusing its microphone. Hang up
leaves the displayed session, including cancellation of retained voice/group
intent while offline; closing the panel leaves the call running. A stale ended
panel target falls back to the displayed live session for toggle behavior.
Roster camera/screen badges use session-indexed feeds, never a global union by
account: one person can send different media to different calls. `/__call_panel`
mounts the production panel and roster to verify these boundaries, including
foreground group revocation while viewing a background voice call.

## Desktop and verification boundary

The actual native crate/config is at repository-root `src-tauri/`; the frontend
is shared with the browser. Its CSP permits the codec's WASM compilation and
blob decoder workers without general `unsafe-eval`. The standalone CodeMirror
build must also remain compatible with the installed Vite/Rolldown version.

Native media capability declarations are not proof that corresponding Rust
commands are registered. The current native crate does not implement a separate
microphone/DSP engine. Do not label browser processing as shipped native DSP.

Synthetic headful Chromium tests exercise actual codecs, worklets, local ICE,
mute, replacement, DSP recovery, and receive handover under the desktop CSP.
They do not certify physical microphones/speakers, NAT/TURN, two authenticated
Wabi clients, or WebKitGTK/WebView2/WKWebView behavior. Those remain release
checks. SRT/native enhancement proposals are not the current media baseline.
