# Truthful message delivery — 2026-09-08

Status: implemented and verified locally; not pushed or deployed.
This work follows the deployed frontend repair pass, not a new production release.

## Diagnosis and objective

The socket send handler logged a WabiStore failure and continued with a provisional
ID, cache insertion, webhook, acceptance and recipient broadcast. Meanwhile the
client did not consume `message-error`; online optimistic messages could remain
pending indefinitely. The offline queue settled by bare client ID, could adopt
unowned legacy chat intent, and had a separate timeout path. The old persistence
Retry control only elicited an echo from an unimplemented server retry handler.

Objective: make delivery outcomes truthful end-to-end, including reconnect and
explicit account-session boundaries. Do not turn uncertainty into automatic
resends: WabiDB may fail application after durability, and client nonces are not
currently durable server deduplication keys.

## Implemented contract

- Durable success effects require successful WabiStore completion. A write error
  returns a correlated unknown outcome before cache, webhook, acceptance or push.
  Pre-write validation, access and mute denials are correlated rejections.
  Revoked authentication retains its existing disconnect behavior. Intentional
  live channels still deliver without writing to the event store.
- The shared browser/Tauri frontend owns one bounded attempt per socket/channel/
  client nonce. Disconnect, deadline and emit exceptions resolve to unconfirmed;
  the status row explains uncertainty rather than claiming the message was lost.
  Successfully queued offline messages have a separate neutral waiting state,
  not a red failure; history refresh preserves them until dispatch/acceptance.
  Accepted messages clear the status without replacing their client nonce.
- Server message echoes/history match client nonces only for the same sender.
  A peer cannot replace your pending content by copying your nonce. Complete
  acceptance payloads are required; late failures cannot downgrade acceptance.
- Queue receipts atomically match realm (server/account), channel, chat action,
  nonce and persisted attempt marker. Acceptance outranks rejection, which
  outranks uncertainty. Unattempted/unowned/other-account queue records cannot
  be accepted by an unrelated receipt. Unowned legacy chat is retained as failed,
  not adopted or deleted. New offline chat requires an account realm.
- Receipt callbacks and queue drains capture explicit session generations as
  well as socket and realm, preventing same-account logout/re-login ABA races.
  Enqueue completion requests a fresh drain if reconnect already happened;
  an already sending/accepted row is not relabeled queued. Uncertain attempts
  are never automatically resent, including through general Retry.
  Drain ownership releases in the same continuation as its last pending-work
  check: a separate Promise.finally microtask could lose a new drain request.
- The legacy fake persistence Retry control and client wrappers are removed.
  Old commands receive an explicit unsupported error, not a success echo.

No Rust domain/projection/postcard records, event formats or generated protocol
files changed. Optional `deliveryOutcome` is client IndexedDB JSON only. Existing
WabiStore commit/projection completion owns durability; no parallel store added.

## Verification

Regression coverage:

- Real Axum/Engine.IO sender and recipient, actual WabiDB, deliberate failed writer
  and a real local webhook receiver with successful-send positive control.
- Production SocketManager/messageStore with actual browser IndexedDB and
  controlled transport; receipt ordering, sender collisions, account/socket
  retirement, offline ownership, concurrent claims and reconnect/commit races.
- Actual delivery UI/shared CSS under the desktop CSP in headful Chromium,
  dark/light, desktop and 390px/320px; status transitions, long escaped text,
  own-message-only status and no nonfunctional Retry.
- Broader frontend/server, calling and storage-boundary regressions; Tauri
  frontend and static web builds in that order.

Final results:

- `bun run check`: zero errors, 145 existing warnings in 40 files.
- `bun test src/lib`: 533 passed, 12 existing crypto-environment skips, zero
  failures, 18,998 assertions across 66 files.
- `cargo test -p wabi-server --features addons`: 442 passed across 19 suites,
  two ignored, zero failures. Includes the four new real delivery contract tests.
- Headful group/receipt suite passes the queue/commit/reconnect/session races,
  normal queued → sending → accepted transitions and all previous membership,
  profile and call-owner checks. The drain-tail regression was also run against
  the prior Promise.finally code and **failed** with the lost request; the fixed
  implementation passes. Evidence: `/tmp/wabi-message-delivery-tail-before.log`.
- All eight headful audio/call routes pass. Storage-boundary checks pass for
  browser and simulated native modes, including actual IndexedDB transactions.
- Delivery rows pass under desktop CSP, dark/light at 1100/390/320px: neutral
  queued state, sending/failure/confirmation, escaped errors, wrapping and polite
  status semantics. Parent inspected dark 320px and light 390px screenshots.
  Final row evidence: `/tmp/wabi-message-delivery-rows-E1u3xZ`.
- Tauri frontend, then static frontend builds pass; the addon-enabled release
  server was rebuilt with final static assets. Final local binary SHA-256:
  `b069ccd9e3cc4b74945012314f6b04a39e6af73ad2cb5fe7e6c9fa449aa913ca`.
- Full-app headful run against that actual local server passes mounted-composer
  real-server acceptance and correlated validation rejection, plus drafts,
  settings/navigation, panel restoration and existing responsive regressions.
  The rejection fixture only corrupts one outbound text field; it uses the real
  server's validation and actual receipt listener, not a synthetic result.
  Final evidence: `/tmp/wabi-workspace-smoke-dNFQEy`.
  No uncaught application errors; existing caught relay/donation `not_found`
  requests remain and are explicitly recorded for the reopened UX work.
- Independent headful run against the **embedded minified assets**, with actual
  local UI login and no Vite/injected authentication, passes real message send/
  acceptance as one confirmed row, draft roundtrip and desktop/mobile Admin.
  Evidence: `/tmp/wabi-embedded-polish-IJfPZn`.
- Resulting diff and all three changed skill entrypoints validated. The obsolete
  client-frontend skill now routes to maintained guidance instead of teaching
  emit-then-success or unsafe live IndexedDB probes. No owned test server or
  browser is left running; evidence files and isolated test data are retained.

Logs: `/tmp/wabi-message-delivery-{check,unit,server-tests,browser,media,storage,rows,tauri,static,server-build,app,embedded}.log`.

The interface skill guided restrained inline status, readable wrapping and
semantic styling, not another modal or animation. The offline/architecture skills
guided ownership and the distinction between handoff, acceptance and uncertainty.
Rejected alternatives: retry after a timeout (duplicate risk), clear the composer
only after a server roundtrip (couples editor lifetime to delivery), treat every
storage error as not sent (post-commit errors are uncertain), or preserve a Retry
button backed only by an echoed event. **Verdict: pass for this delivery-outcome
contract, not full chat persistence or product-wide UX certification.**

## Explicit remaining limits and next priority

This does **not** complete durable attachment/rich-message reconstruction. Existing
single-file camelCase fields and multi-file payload decoding do not consistently
reach `FileAttachmentRecord`; session-cache delivery can mask missing metadata.
The domain/history paths also omit or flatten richer message metadata. Fixing
that requires a separate compatibility-aware reconstruction contract, not a
casual postcard field addition. Do not advertise a receipt as proof that every
rich message survives a restart intact. No restart-safe client-nonce deduplication,
general non-message queue acknowledgement, native WebView/installer, physical
Android or real two-device audio verification is claimed here.

The user explicitly prioritizes a **thorough top-to-bottom UX/UI pass after this
delivery objective**. See the reopened product UX scope in the frontend repair
plan. Finish and verify this objective before starting that work; do not silently
expand this stretch into another large persistence rewrite.
