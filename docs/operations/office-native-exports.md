# Native workspace exports

## Behavior

Documents, Sheets and Present continue using the same models, importers, formula
contract and collaboration protocol in browser and desktop builds. Desktop does
not receive a second calculation engine with potentially different answers.

Their common export helper now selects a local Tauri/Rust save path on desktop.
This covers the existing actions routed through `session.download`: recovery
bundles, original-file downloads and generated workbook/deck exports. Browser
and mobile callers retain the browser/system-download route. Print-to-PDF stays
with the existing audience-only print workflow; it is not a Rust PDF renderer.

A desktop export captures the requested immutable Blob, computes its checksum,
and invokes `workspace_export_file`. Rust accepts only protocol version, a
suggested basename, byte count and base64 payload. It accepts no destination path,
URL, overwrite flag, shell command or server credential. It opens a native Save
As dialog; an existing target additionally requires explicit replacement
confirmation. Cancellation does not trigger a browser fallback or upload.

The writer stages the complete file beside the selected destination, verifies
the write length, flushes it and only then commits the selected name. Ordinary
pre-commit errors do not truncate an existing destination. New files are linked
without replacing an already existing name. Staging files are cleaned on normal
success, cancellation and handled failures. A process kill can leave a private
`.wabi-export-*.part` file; the app does not indiscriminately scan or delete
unrelated filesystem entries at startup.

The returned receipt contains byte count, checksum and directory-flush outcome,
not a filesystem path. The frontend verifies the receipt against the captured
bytes. Missing, malformed or interrupted receipts produce an **uncertain** state
and instruct the user to inspect the selected destination before retrying. The
application never automatically repeats a possibly committed write. Browser
results say **Download requested**, not **Saved to disk**.

## Boundaries

- Native payloads are bounded to 32 MiB, before Rust decoding and before frontend
  IPC encoding. One native export runs per process. No new native or JavaScript
  dependency was introduced, and no parser/worker starts merely to register export.
- The Rust command checks the native workspace window and bundled origin before
  and after the dialog. Only debug builds admit the configured development
  origin. There is no new remote-origin grant. A native dialog remains mandatory;
  this is not a claim that same-origin scripts or compromised WebViews are safe.
- Newly created files require hard-link support on the selected filesystem.
  Unsupported removable/network filesystems fail visibly rather than falling
  back to a race-prone replacement. Existing regular files use same-directory
  rename after approval. Native saving does not broaden filesystem permissions.
- New Unix files are staged with mode 0600. An explicitly replaced export takes
  the staged file's permissions; previous ACLs/extended attributes are not copied.
- `sync_all` is checked before commit. Directory sync is attempted on Unix; other
  platforms and filesystems may not confirm directory power-loss durability.
  A post-commit directory-sync failure is a saved receipt with a warning, not a
  false claim that no write happened.
- Concurrent changes detectable by the captured target metadata are rejected.
  New-name installation is no-clobber. The writer is not a sandbox against a
  hostile same-user local process mutating ancestor directories or changing an
  existing target in the final metadata-check/rename interval.
- Exports do not publish, share, revoke or delete documents. Closing/replacing a
  server account does not turn an export into a network operation. Private
  speaker notes remain governed by the existing export-specific projections.
- Mobile native save/share integration is not added by this desktop command.
  Native dialog accessibility and visual behavior still need actual OS testing.

## Verification

`office-native-exports.yml` runs real temporary-file tests on Linux, Windows and
macOS, plus a Linux build/test of the actual Tauri command and both registration
entry points. Tests cover original retention on partial write, pre-commit
cancellation, concurrent destination creation, symlink/directory rejection,
Unicode/Windows filename handling, bounded payloads and temporary-file cleanup.

`fileExportCore.test.ts` verifies byte preservation, success/cancellation/error
receipts, no automatic fallback/retry, bounded concurrent work and truthful
browser-download status. Existing Office browser acceptance and addon package
inventory checks still run; their passing results must be tied to the new head.

These tests do not operate real OS Save As dialogs, certify all filesystems or
replace the outstanding native-device/call-coexistence and five-editor tests.
Check the PR's current results rather than treating this design note as proof
that an uncompleted run passed.

Implementation references: Tauri's native dialog documentation and command
origin/capability model; Rust `std::fs::rename`, `hard_link`, `OpenOptions` and
`File::sync_all`. The existing Tauri dialog, base64 and SHA-256 dependencies are
reused. The shared-document persistence format and Authority remain unchanged.
