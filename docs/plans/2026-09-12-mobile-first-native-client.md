# Wabi mobile-first native client plan — 2026-09-12

Status: active implementation branch `feat/mobile-first-2026-09-12`.

## Goal

Make Wabi a dependable installed phone app rather than a desktop layout squeezed into a narrow viewport. The PWA remains useful, but mobile product decisions must stand on their own.

Primary target: Android first for hands-on iteration, while keeping iOS architecture compatible from the beginning.

## Product invariants

1. Ordinary navigation is visible and dependable. Root navigation never disappears because the user paused to read.
2. A conversation owns the phone screen. Desktop docking/peek/panel concepts do not become required phone knowledge.
3. System Back closes transient surfaces before abandoning the current conversation.
4. Unread indicators are derived from real conversation state; no decorative/stub badge values.
5. Drafts, pending sends and accepted messages have distinct state. Never claim delivery/read state that the protocol has not proven.
6. Server/account identity remains explicit. Same-looking users on different servers are not silently merged.
7. Native privilege is narrow. Community content/addons do not gain arbitrary filesystem/process/native access.
8. Calls must eventually survive normal backgrounding/lock-screen use. Browser/WebView success while foregrounded is not enough evidence.
9. Mobile performance is measured: startup/resume, memory, scrolling, idle CPU/battery and bundle/install size are separate metrics.
10. Privacy claims must be testable. A private keyboard may avoid third-party keyboard providers, but it does not make the OS or Wabi message transport disappear.

## Proposed stack

- Tauri 2 installed client.
- Svelte/TypeScript mobile-first UI, sharing useful Wabi components and state rather than desktop layouts.
- Rust for durable client services and account-scoped local persistence boundaries.
- Kotlin native integration on Android; Swift native integration on iOS.
- Native/system services for notification delivery, secure credential handling, share sheets, audio routing/call lifecycle and optional private input surfaces.
- Existing Wabi server + WabiDB remain authoritative; the phone does not bundle a Wabi server.

## Implementation batches

### Batch A — phone shell and correctness (current)

- [x] Create dedicated mobile-first branch.
- [x] Replace stub DM unread total with real DM/group unread aggregation.
- [x] Keep root phone navigation persistent rather than hiding after 2.2 seconds.
- [x] Add bounded unread badge presentation and pure behavior tests.
- [x] Scope push endpoint unsubscribe to the authenticated account.
- [x] Make test-push UI distinguish HTTP success from actual delivery.
- [x] Make detached native 3D viewer desktop-only and remove its startup self-test from mobile/release startup.
- [ ] Replace flag-priority Back handling with an explicit mobile surface stack.
- [ ] Audit server switcher/profile/settings/full-screen workspace back paths.
- [ ] Add real device-safe keyboard/visual viewport acceptance fixtures.

### Batch B — conversation-first phone UX

- Merge/reconcile the newer unified DM UX rather than cloning another DM implementation.
- Full-screen conversation view on phones; tablet may use two panes.
- Header: Back, identity/server context, call affordance, grouped secondary actions.
- Preserve per-conversation draft/reply/attachment state across ordinary navigation.
- Reliable unread boundary and return-to-latest affordance.
- Attachment picker/preview/progress/cancel/retry.
- Message action sheet designed for touch and text selection.

### Batch C — native app foundation

- Generate/maintain Android and iOS Tauri projects reproducibly.
- Split desktop-only Tauri dependencies/commands from mobile build graph.
- Add a native capability bridge with explicit commands/events instead of broad privilege.
- Account-scoped local SQLite cache/queue behind Rust APIs.
- Secure credential storage using platform secure storage/key material.
- Native share-to-Wabi ingress.
- Native notification adapters; UnifiedPush-compatible Android path is a target.

### Batch D — calls

Foreground WebView calling is not the finish line.

Acceptance sequence:

1. join/answer call;
2. verify audio;
3. switch app;
4. lock screen;
5. return;
6. change audio route;
7. Wi-Fi/cellular transition;
8. interruption/recovery;
9. camera and screenshare where platform policy permits;
10. leave/rejoin without stale session state.

Native system call integration must coordinate lifecycle/audio routing. Existing Wabi call/session protocol remains the interoperability target unless an explicit protocol change is designed and tested.

### Batch E — private keyboard

Two separate scopes:

1. Optional Wabi-only private composer keyboard/input surface.
2. Later optional system-wide companion keyboard.

Requirements: no keyboard telemetry/cloud suggestion service, usable English/Thai input, composition/cursor/delete behavior, accessibility, easy switch back to the user's preferred keyboard, and no misleading claim of protection from the operating system itself.

The core mobile release does not wait for the system-wide keyboard.

## Verification labels

Every mobile item should be reported as one of:

- source implemented;
- repository checks passed;
- native build passed;
- emulator tested;
- physical-device verified.

Do not collapse those into one word such as “done.”

## Current device-only blockers

This chat session can edit/push GitHub and use repository CI, but it does not expose an attached Android/iPhone, local Android SDK, Xcode signing environment or Bluetooth/camera hardware. Those remain physical/native verification gates, not excuses to stop source implementation.
