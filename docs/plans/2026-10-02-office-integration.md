# Office branch integration decisions

This is an integration candidate, not a deployment or final browser/native
acceptance record. The active implementation is
`codex/docs-sheets-present-20260917` at `1e1c6bc11`.

- Preserve the existing Project/maps/profile/mobile shell, side panels and
  independent drafts. Office opens through the existing addon queue and center
  navigation event. Server Home retains precedence until explicit Office open.
- Retain one Yjs editor/session/API/projection path. The alternative
  `codex/workspace-addons-20260917` at `693a7eccc` uses incompatible field sync,
  artifact events and loaders; its implementation is superseded rather than
  mounted beside this one. Its historical branch remains recoverable.
- `codex/office-check-cleanup-20260918` only adds a historical workflow cancelling
  obsolete PR236 checks. It supplies no newer editor fix. Do not revive that
  workflow or the earlier self-repair workflow in the integrated product.
- Keep `docs-history` independent; this work does not merge archived content into
  current product/operator documentation.
- Use the existing current credential/membership retained-operation model for
  all Office handlers, including presentation reads which can persist lost
  controller state. No nested membership acquisition inside accepted work.
  Channel-associated content edits require participation and acknowledged rules.
- Keep the global 2 MiB JSON transport limit; private import/CRDT/storage limits
  are separate upper bounds. Conversion advertises a bounded source size fitting
  this transport. Native export keeps trusted origin and explicit dialog consent.
- Preserve current frontend dependency versions except the active branch's
  exact Office dependencies and cookie/devalue/socket.io-parser overrides. Keep
  current build targeting/minification, service-worker version and worklet files.

Focused verification performed in the isolated Office checkout: 83 Office unit
tests, two new center-navigation tests, and nine standalone native export writer
tests pass. Locked Cargo metadata loads. Frontend typecheck has a baseline locale
key mismatch (`login.auth.change_server_button`); it reported no Office error.
Pinned Cargo contract compilation was blocked by registry fetch timeouts before
compilation, and further heavy builds are held for coordinated shared resources.
New stale-credential, cancellation/durable-completion and channel-membership
regression tests are committed for the final integration gate. Actual browser,
converter and native-dialog acceptance remains required; no visual acceptance
is inferred from these source/unit checks.

The combined npm audit reports existing Svelte/Kit/devalue/MapLibre/DOMPurify
findings plus the Office `pptxgenjs`/`image-size` high-severity dependency finding.
No clean audit claim is made. The complete emitted bundle/worker inventory check
must still prove Node-only `image-size` is absent from shipped browser resources.
