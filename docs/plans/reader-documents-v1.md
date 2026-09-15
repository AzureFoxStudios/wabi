# Reader Documents V1

Reader is Wabi's document shell. V1 intentionally separates local durability from remote replication.

## Invariants

- **Saved** means the latest document state is durable on this device.
- Entering Edit/Suggest/Comment on arbitrary Reader content creates or resumes a private local working copy; it does not mutate the source.
- Private document storage is isolated by normalized **server + account** (registered user, guest session, or anonymous device identity).
- Crossing a server/account boundary clears the visible Reader selection before the new document scope is hydrated.
- Chat and Notes working copies use their stable source entity IDs, not content-derived Reader hashes.
- IndexedDB is the canonical local store. Each document carries a `storageRevision`, and writes compare-and-swap inside one read/write transaction so a stale tab/window cannot replace a newer durable revision.
- Competing writers keep separate crash-recovery mirrors. A losing writer remains local and reports a conflict rather than overwriting or discarding its text.
- Network availability is not required for editing.
- Share / Go Live remain gated until Wabi has a merge-safe document replication transport. The existing whiteboard server-snapshot-wins conflict policy is not safe for prose documents.

## V1 work modes

- Read
- Edit
- Suggest
- Comment

Suggestions stay separate from canonical content until Apply/Reject. Comments are stored with the local document and may be resolved/reopened.
