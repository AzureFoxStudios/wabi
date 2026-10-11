# Geographic room-load observer regression — October 2

**Current result:** 18 single-room and 24 many-room in-memory checks pass with
zero failures. The isolated runner also passes both file groups; these counts
are not additive. This changes
the observer used for future workloads; it is not a Wabi runtime, network,
locality, failover or capacity result.

The earlier canary matched deliveries and acknowledgments by the test's
`clientMessageId`, but did not validate their room, message body/type or global
canonical identity. Four new fixtures reproduced false `PASS` receipts for
wrong-room delivery, wrong-room acknowledgment, two distinct sends receiving
one canonical ID, and altered delivered text. The preserved
[before receipt](geographic-2026-10-02/room-load-observer-before.json) records
the actual four passing/four failing tests and exact source hashes.

The observer now checks the correlated envelope's room, nonempty string IDs,
exact expected text/type, distinct canonical IDs across sends, and agreement
between delivered and acknowledged IDs. It requires the configured number of
distinct acknowledgments and exact retained history content. Invalid correlated
events fail the outstanding operation immediately; owned sockets and abort
listeners still close in the final cleanup path. Receipts count wrong-room and
invalid-payload events without recording credentials, content or endpoints.

Valid delivery-before-ack and ack-before-delivery both pass. Wrong-room events,
changed bodies, empty/nonstring IDs, wrong message type, mismatched identities,
duplicate deliveries/acknowledgments, and missing/changed retained history
refuse. The existing resource/schedule, percentile and pre-aborted cleanup
checks remain covered. The [acceptance receipt](geographic-2026-10-02/room-load-observer-acceptance.json)
records the actual command, 17/0 result, unchanged source hashes and compressed
log digest. These tiny fake-transport checks ran during the thermal build hold;
they opened no sockets and started no compiler or network workload.

```sh
node scripts/geographic-acceptance/room-load.test.mjs
```

The first isolated `node --test` invocation returned a root file failure while
the new false-pass regression fixtures were still failing. Current acceptance
also runs both files through that isolated runner successfully. Direct test
commands provide the individual 18/24 counts; the isolated runner reports two
file groups. The earlier 17-check receipt remains historical evidence for its
recorded source.

The harness defaults to the real Socket.IO client and history fetch. Tests
inject owned fakes; any overridden runtime receives `executionMode:
"injected_runtime"` rather than `"network"`. In both modes
`capacityCertification` remains false. Existing small canary ceilings and one
outstanding send remain unchanged; measured many-room/hot-room capacity,
network traffic, regional ownership and privacy acceptance stay open.

Historical field receipts retain their original scope. They did not exercise
these stricter observer checks and must not be relabeled as fresh acceptance.

## Bounded concurrent room canary

`runRoomsLoad` now runs two to four existing disposable rooms concurrently,
with uniform per-room options. Before opening any socket it validates every
room, requires distinct room IDs and supplied credential values, and caps the
**combined** workload at 32 clients, 95 messages and a 20 messages/second
ceiling. A supplied credential count is not proof of distinct user accounts.
Sparse arrays, inherited option names, invalid room shape and oversized
aggregate workloads refuse before any network work.

Each room keeps its own subscriptions, acknowledgment/delivery latencies and
history verification. A bounded shared correlation registry catches this run's
messages or acknowledgments delivered to another room's sockets, and this
run's history returned for another room. A shared canonical-ID registry refuses
cross-room identity reuse. This checks **correlated test traffic**, not every
possible private content or authorization behavior.

The first failed room cancels its siblings. All rooms settle and close their
owned sockets/listeners before the aggregate receipt returns. Receipts identify
rooms by index, contain individual results plus combined counts, and retain
the existing privacy exclusions. Unknown harness failures report failure,
without copying exception details into the receipt. Mid-join cancellation,
pre-aborted work and socket-factory failures have fixture coverage.

Send spacing is measured from the previous actual send. A long stall cannot
accumulate credit for a later catch-up burst. Each room still waits for every
expected delivery before sending again, so requested rate remains a ceiling;
it is not a sustained-throughput claim or a hot-room stress generator.

The [current exact receipt](geographic-2026-10-02/rooms-load-acceptance2.json)
records frozen hashes of all three scripts, actual direct 18/0 and 24/0 runs,
the successful isolated two-file run, and compressed log digest. Positive
fixtures cover two and four rooms. A deliberately stalled room also leaves
another room able to finish before owned cancellation drains both. Negative
fixtures cover cross-room traffic,
history and identities, budgets/input, cancellation and owned cleanup. No
actual Wabi server, client connection or network load ran in these fixtures.

```sh
node --test scripts/geographic-acceptance/room-load.test.mjs scripts/geographic-acceptance/rooms-load.test.mjs
```

For a future **authorized disposable network run**, an operator can import
`runRoomsLoad` from `scripts/geographic-acceptance/room-load.mjs` and provide:

- `sites`: three explicit approved Wabi entry-point URLs;
- `rooms`: two to four `{ channelId, tokens }` records for existing retained
  disposable rooms, with separate supplied credentials;
- `options`: the existing per-room client/message/payload/rate/deadline values;
- `signal`: optional cancellation from the supervising harness.

Keep live credentials in private operator input, not source or the receipt.
Public entry points require the existing HTTPS operator contract; protected
private IP paths retain their separate transport acceptance. The returned
receipt leaves measured network bytes and registered-account counts unknown,
and sets regional locality, recovery and capacity certification false. A real
many-room run, calibrated hot-room load, actual traffic/backpressure measurement
and physical privacy/failure acceptance remain required by the master plan.
