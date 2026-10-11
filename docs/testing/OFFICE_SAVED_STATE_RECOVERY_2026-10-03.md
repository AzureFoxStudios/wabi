# Main Wabi Office saved-state recovery — October 3, 2026

**Local saved-state gate accepted. Full recovered API, external inventory and
automatic failover remain unaccepted.** Main Wabi before ERP; no deployment.

## Executed source and results

The [actual frozen rerun](geographic-2026-10-02/availability-control-root-office2.json)
compiled successfully and executed both targets serially: seven existing
checkpoint checks passed with one ignored physical-export entry, and four
expanded peer checks passed. Total: **11 passed, zero failed, one ignored**.
These counts overlap the previous peer target; they are not eleven additional
Office checks. All 5,190 Rust/graph/static inputs stayed unchanged.

- Exact two-file fixture:
  [source4 ledger](geographic-2026-10-02/availability-control-office-fixture-source4.json)
  and [source archive](geographic-2026-10-02/availability-control-office-fixture-source4-exact.json.gz).
- Source freeze: `5322519304627308a0fb162eb2546e84098c1850b52319a6e10e74f34e8c934a`.
- Expanded peer executable: `f3ec215ede08e4ffbaf642c56a473fbea036288dc2d0575e7143f0c8921c4662`.
- [Fresh post-compile precheck](geographic-2026-10-02/availability-control-root-office2-precheck.json)
  verified artifacts, unchanged inputs, space and CPU below 60°C. Direct timed
  tests were unthrottled: 12.07 seconds for checkpoint checks and 7.33 for peers.
- [Scoped terminal readback](geographic-2026-10-02/availability-control-office-saved-state-acceptance1.json)
  records the assertions below. The generic runner's scope does not certify
  full enabled Office recovery; this companion identifies the saved-record
  coverage established by the expanded fixture.

The [first run](geographic-2026-10-02/availability-control-root-office1.json)
compiled, but both Office-seeding cases received HTTP 400 before capture: the
fixture omitted the mandatory workbook `structureEdits` object. Its exact
failed [source3](geographic-2026-10-02/availability-control-office-fixture-source3-exact.json.gz)
and [log](geographic-2026-10-02/availability-control-root-office1.log.gz)
remain preserved. The sole source3→4 change adds `structureEdits: {}`; production
validation and permissions were not changed.

## What the real fixture covers

Real authenticated REST handlers create a document, spreadsheet and native
deck, commit subsequent CRDT deltas, resolve a review, revoke one recipient and
refuse its later read, and refuse an editor's stale generation after a mode
change. A spreadsheet editor's protected-cell update is refused without
changing the stored record; its owner can update the cell. Audience output
omits the hidden slide and source artifact identity, and publishing private
speaker notes is refused. Intermediate disabled-capability checks refuse
sheet edits and presentation starts; both capabilities are re-enabled before
the genuine encrypted Authority capture.

The fixture replaces the **source router**, retaining the same source engine,
and checks paused/lost controller state, generation advancement and no revived
pointer. It is not a whole-process restart or a recovered candidate API run.
The capture includes that already-paused historical session and its question.

The existing approved Noise peer supplies the genuine capture to the actual
default-off operator job. In the retained private candidate, `OfflineInspection`
replays the complete history with no writer/mutation handle. It compares every
saved workspace row, including exact revisions, grants, reviews, protection,
session state and checkpoint/delta bytes: settings + three artifacts + one
presentation. It independently decodes title/body/native data for all three
artifacts and compares the resulting content. Both inactive guard bytes and
the existing lock inode remain unchanged. Cleanup-failure admission/restart
refusal still pass with the expanded source fixture.

## Remaining gates

This does not establish permission-checked **restored** REST behavior, recovery
of a captured active controller in a new process, converter configuration and
credentials, external asset lifetime, client-only drafts/notes, regional private
artifact ownership, production consensus publication, nonce continuity,
writer activation, three physical sites or capacity. Both
`fullInstanceReady` and `canonicalWriterPermitted` remain false. Never remove
guards or weaken admission to make those remaining tests run. See the
[full recovery plan](../plans/2026-10-01-recovery-material-integration.md).
