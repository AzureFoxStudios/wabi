# Wiki Knowledge Sync Protocol v1

> **Status:** design freeze for implementation fixtures. This protocol is for the separate knowledgebox companion; it is not a general Wabi API.

## 1. Purpose

Wabi remains the canonical authority for wiki content. A paired knowledgebox receives a bounded copy of selected wiki pages and keeps it current through snapshots and ordered deltas.

The protocol is designed around four properties:

1. **Outbound pairing:** the knowledgebox does not receive a general Wabi credential.
2. **Scoped data:** a pipe is limited to explicitly selected wiki channels.
3. **Resumability:** delivery can resume after disconnect without repeated full crawls.
4. **Deletion correctness:** page deletion is a first-class event and must purge downstream search results.

## 2. Non-goals

- No Wabi message/user/admin/upload access.
- No write-back into Wabi.
- No arbitrary URL fetch or proxying.
- No revision synchronization in v1.
- No embeddings or model-provider protocol.
- No guarantee against a compromised host owner.
- No assumption that page text is safe instructions; page text is untrusted source material.

## 3. Terms

- **Authority:** the Wabi server that owns canonical wiki data.
- **Knowledgebox:** a separately operated companion that stores and searches synchronized pages.
- **Pipe:** one owner-approved synchronization relationship between one Wabi authority and one knowledgebox.
- **Collection:** one knowledgebox search boundary corresponding to one Wabi pipe and its selected channels.
- **Cursor:** the highest contiguous authority sequence durably applied by the knowledgebox.
- **Tombstone:** a deletion event that removes a page from the knowledgebox.

## 4. Pipe scope

A pipe has a stable ID and an immutable credential identity. Its selected channel set is explicit. Adding or removing channels requires an owner-authorized scope update and a synchronization reconciliation.

A pipe must never infer scope from a caller-provided channel ID. Every event is checked against the pipe's stored scope before application.

For v1, selected channels are wiki channels and the synced payload is the current page state only. Revisions, messages, users, files, and arbitrary channel metadata are excluded.

## 5. Session direction

The preferred session is an outbound HTTPS connection established by the knowledgebox to Wabi after pairing. Wabi authenticates the pipe and sends bounded frames. The knowledgebox acknowledges application progress.

The exact streaming transport may be WebSocket or a bounded long-poll/HTTPS session, but transport must not change the event semantics below. A future transport adapter must consume the same fixtures.

Wabi must not block a wiki mutation on network delivery. If no session is connected, Wabi retains only the bounded delivery/replay state needed to resume or instruct a new snapshot.

## 6. Frame envelope

Every frame uses this envelope:

```json
{
  "protocolVersion": 1,
  "frameType": "event",
  "pipeId": "pipe_01J...",
  "eventId": "evt_01J...",
  "authoritySequence": 1842,
  "eventType": "wiki.page.upserted",
  "sourceServerFingerprint": "sha256:...",
  "issuedAt": "2026-08-12T00:00:00Z",
  "contentHash": "sha256:...",
  "payload": {}
}
```

Required envelope rules:

- `protocolVersion` must be supported or the receiver rejects the frame.
- `pipeId` must match the authenticated session.
- `eventId` is globally unique within the authority and is used for idempotency.
- `authoritySequence` is monotonic for the authority and is used for cursor/replay.
- `eventType` is an allow-listed string.
- `sourceServerFingerprint` identifies the Wabi authority, not a user.
- `contentHash` covers the canonical payload bytes.
- `issuedAt` is informational and not a replacement for sequence ordering.

The authenticated session provides integrity for v1. If frames are stored or relayed independently in a later version, add an explicit signature over the canonical envelope.

## 7. Frame types

### 7.1 Snapshot begin

```json
{
  "frameType": "snapshot.begin",
  "snapshotId": "snap_01J...",
  "collectionId": "collection_01J...",
  "selectedChannelIds": ["channel_wiki_1"],
  "pageCount": 12,
  "maxPageBytes": 1048576
}
```

The receiver stages the snapshot separately. It must not delete the current collection before `snapshot.end` validates successfully.

### 7.2 Snapshot page

```json
{
  "frameType": "snapshot.page",
  "snapshotId": "snap_01J...",
  "page": {
    "channelId": "channel_wiki_1",
    "pageId": "page_42",
    "parentPageId": "",
    "slug": "deployment",
    "title": "Deployment",
    "bodyMarkdown": "# Deployment\n...",
    "updatedAtMicros": 1786492800000000,
    "contentHash": "sha256:..."
  }
}
```

Pages must be bounded by `maxPageBytes`; oversized pages fail the snapshot instead of being truncated.

### 7.3 Snapshot end

```json
{
  "frameType": "snapshot.end",
  "snapshotId": "snap_01J...",
  "pageCount": 12,
  "snapshotHash": "sha256:...",
  "finalAuthoritySequence": 1842
}
```

The receiver validates count, hashes, scope, and all page limits, then atomically replaces the collection and advances its cursor to `finalAuthoritySequence`.

### 7.4 Page upsert

```json
{
  "frameType": "event",
  "eventType": "wiki.page.upserted",
  "payload": {
    "channelId": "channel_wiki_1",
    "pageId": "page_42",
    "parentPageId": "",
    "slug": "deployment",
    "title": "Deployment",
    "bodyMarkdown": "# Deployment\nUpdated...",
    "updatedAtMicros": 1786492800000000
  }
}
```

An upsert replaces the current source document only when the event is valid for the pipe scope and is newer according to authority sequence.

### 7.5 Page delete

```json
{
  "frameType": "event",
  "eventType": "wiki.page.deleted",
  "payload": {
    "channelId": "channel_wiki_1",
    "pageId": "page_42",
    "deletedAtMicros": 1786492800000000
  }
}
```

Deletion is applied to the source store and search index. The receiver must not retain the page as a searchable result after successful application.

### 7.6 Reset required

```json
{
  "frameType": "control",
  "eventType": "wiki.sync.reset_required",
  "reason": "cursor_outside_replay_window",
  "minimumSnapshotSequence": 1900
}
```

The receiver discards its replay assumption and requests/accepts a new scoped snapshot. It must not attempt unbounded replay.

## 8. Acknowledgement

The knowledgebox sends:

```json
{
  "frameType": "ack",
  "pipeId": "pipe_01J...",
  "highestContiguousAuthoritySequence": 1842,
  "appliedEventIds": ["evt_01J..."],
  "receivedAt": "2026-08-12T00:00:01Z"
}
```

The authority advances delivery state only to the highest contiguous sequence. An acknowledgement must be sent only after the corresponding data is durable in the knowledgebox. Duplicate events may be acknowledged again without changing the result.

## 9. Idempotency and ordering

- Duplicate `eventId` application is a no-op.
- A sequence gap pauses delta application and requests the missing range or a reset.
- Out-of-order frames are staged only if the receiver can enforce bounded memory; otherwise reject and request replay.
- A stale upsert must not overwrite a newer applied sequence.
- A delete is ordered like any other event and must not be undone by an older upsert.
- Cursor persistence follows durable application, never receipt.

## 10. Pairing and revocation

Pairing is owner-authorized in Wabi:

1. Knowledgebox generates a short-lived bootstrap code.
2. Owner authenticates to Wabi and confirms the code plus selected wiki channels.
3. Wabi creates a pipe ID and scoped credential identity.
4. Knowledgebox exchanges the bootstrap code for the pipe credential over the authenticated pairing flow.
5. Bootstrap code becomes invalid immediately.

Pipe credentials:

- are not Wabi Bearer tokens;
- are not `Bot <token>` credentials;
- are not accepted by ordinary wiki/message routes;
- are scoped to one pipe and its selected channels;
- are rotatable and revocable;
- must not be logged after issuance.

Revocation causes future sessions to fail and marks the pipe revoked. Existing sessions must be closed or rejected at their next frame boundary.

## 11. Limits

The initial implementation must define configuration-backed limits for:

- maximum page bytes;
- maximum pages per snapshot;
- maximum snapshot bytes;
- maximum replay span;
- maximum queued events per pipe;
- maximum reconnect attempts per interval;
- maximum snapshot requests per interval;
- maximum concurrent pipe sessions;
- maximum acknowledgement batch size.

The existing Wabi global rate limiter remains useful for ordinary API traffic. These pipe-specific limits are required because a valid pipe can otherwise create valid-looking load.

When a limit is exceeded, the authority returns a structured error and does not partially apply a snapshot or silently expand the queue.

## 12. Knowledgebox read API

The companion exposes only:

- `GET /health`;
- `GET /status`;
- `GET /collections`;
- `POST /collections/{collectionId}/search`;
- `GET /collections/{collectionId}/documents/{documentId}`;
- `GET /collections/{collectionId}/documents/{documentId}/source`;
- `DELETE /collections/{collectionId}`.

Non-health routes require local/operator authentication. There is no arbitrary URL fetch, Wabi proxy, Wabi write, shell, filesystem, or model-provider route.

Search results include:

- source server fingerprint;
- Wabi channel ID/name;
- page ID and slug;
- page title;
- exact excerpt;
- updated time;
- canonical Wabi citation/link;
- a field explicitly identifying source text as untrusted content.

## 13. Test fixture requirements

Protocol tests must cover:

- valid snapshot replacement;
- oversized page rejection;
- incomplete snapshot rejection without destroying the old collection;
- duplicate event idempotency;
- sequence gaps;
- out-of-order events;
- delete purge from source and search;
- stale upsert rejection;
- scope violation rejection;
- cursor persistence after restart;
- reset-required behavior;
- revoked-pipe rejection;
- replay and snapshot quotas;
- prompt-like page content remaining data rather than authorization instructions.

Fixtures must not call a live Wabi deployment, remote AI provider, or public endpoint.

## 14. Compatibility and evolution

- Unknown frame fields must be ignored where safe.
- Unknown frame types must be rejected with a structured protocol error.
- `protocolVersion` changes require an explicit compatibility decision.
- No v1 implementation may silently broaden scope when a newer frame adds fields.
- Revisions, attachments, embeddings, MCP, and remote model policy require later protocol versions or separately versioned extensions.
