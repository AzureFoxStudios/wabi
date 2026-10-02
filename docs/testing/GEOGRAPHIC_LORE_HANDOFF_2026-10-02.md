# Main Wabi geographic checkpoint progress — October 2

## Source and repository boundary

This is a progress record for the ongoing main Wabi geographic community
implementation. It is not a source synchronization, production release or HA
claim. The canonical native Lore repository is attached to Wabi channel
`ch_460`, at `/home/tim/Desktop/Wabi/data/wabi-server/lore/1120`, repository
UUID `01a041f5628a7640bb6f1a78ff3555a2`. Before this note it was main revision
8, signature `cb0badaa3907599f39136e0756238627400843872f614b60ca45554c857cc271`.
Its history records a September 8 source import from Git
`4fed90d728caf4d3e05645541f569d505ac883ed`.

The tested candidate instead lives on dotRonin in `/home/ironin/wabi`, branch
`codex/security-boundary-hardening-20260930`, base Git commit
`138abe39e08e400188d1812ed3bfd378df435315`, with shared uncommitted changes.
No genuine automatic checkout-to-Lore synchronization has been verified.
The deployed directory and Lore source snapshot do not resolve as a working
Git checkout. This note preserves their existing source and custom files.

## Accepted checkpoint prerequisite

- Strict, domain-separated community P256 source signatures bind the actual
  captured node, bootstrap identity, applied prefix, ciphertext and inventory.
- Separate versioned manifests store ordered encrypted checkpoint chunks and
  freshly verify required bytes. Allocation knowledge remains `unknown`.
- The experimental Linux source sidecar and retrieval route are default off.
  Access requires the actual loopback socket peer plus the operator secret;
  forwarded headers and account tokens do not substitute for that boundary.
- Real export/decrypt/identity checks, later writes and an actual same-database
  Authority restart preserve community identity and the existing lock inode.
- Final workspace session 84268 exited 0: **2,663 passed, 0 failed,
  15 ignored, 88 result groups**. All 5,163 source/build hashes stayed unchanged
  during that acceptance window. Ignored external fixtures are not accepted.

The exact source receipt is
`a15c45f56be8097e65db49d7a6154b888d14b74ea611bba468fb0d0b48b14807`.
The accepted embedded frontend was build `1305bddd7c8f3af6`, index SHA256
`366331ef3f743cfc94864654584b411bc4a62efec20e7e90f858fe24b7d33253`.
The UI owner subsequently rebuilt a different bundle for its separate release
work. That later bundle is not retroactively covered by the earlier receipt.

The checked-out evidence paths are
`docs/testing/SIGNED_CHECKPOINT_SOURCE_2026-10-02.md` and
`docs/testing/geographic-2026-10-02/producer-workspace-acceptance.json`.
They refer to the dotRonin candidate; their existence in this older Lore tree
is not assumed by this note.

## Remaining full objective

The master objective remains one community served by multiple sites, with
regional load offload and safe survival of one node loss. This checkpoint
prerequisite does not activate another writer or provide automatic recovery.

Required next gates:

1. Authenticated recovery-voter byte transfer, exact peer acknowledgments,
   fresh availability checks, retrieval/reseeding and cancellation-safe storage.
2. Committed required-tail/blob majority and independently verified inactive
   recovery of the complete supported enabled instance.
3. Safe encryption allocation and fencing of every old-writer mutation,
   acknowledgment, session-only operation and live publication path.
4. Client discovery/account/offline continuity and actual automatic full Wabi
   recovery after a node loss.
5. Independent regional room ownership, selective cross-region delivery,
   permission epochs and per-room failover.
6. Physical desktop/Tailcat/ordinary-IP/file/media trials and measured
   many-room/hot-room capacity, privacy and operator acceptance.

The first signed-byte store accepts at most 1,024 ordered 64 KiB references:
64 MiB logical ciphertext. Larger communities require segmented/hierarchical
manifests and incremental committed-tail delivery; copying a full snapshot per
message would not satisfy the bandwidth design. A 500,000-member community is
a sizing and measurement target, not a demonstrated capacity result.

Source-role, payload encryption/replay, quorum, full-instance and canonical
writer permission remain unproved by a local byte receipt. The shared
geographic card stays In Progress. Git publication, Lore publication, runtime
deployment and whole-goal acceptance are separate operations.
