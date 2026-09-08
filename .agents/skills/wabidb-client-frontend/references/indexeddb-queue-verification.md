# Verifying the client queue

Run from `frontend/`, with a working display for headful Chromium:

- `bun test src/lib`: pure receipt/ownership/state-machine regressions.
- `node scripts/group-membership-browser-smoke.mjs`: production SocketManager,
  message store and actual isolated IndexedDB; sender/account isolation,
  receipt ordering, concurrent claims, reconnect/commit interleavings and
  explicit-session retirement.
- `node scripts/storage-boundary-browser-smoke.mjs`: actual Settings and
  IndexedDB transaction aborts, retained non-retryable failures, quarantined
  unowned archives and simulated native boundaries.
- `node scripts/message-delivery-rows-browser-smoke.mjs`: real status rows,
  narrow/dark/light layouts, escaping and state transitions.

These scripts create isolated browser storage and close their owned processes.
Do not paste destructive/bad-record probes into a user's live IndexedDB. A
successful request followed by transaction abort is not a completed write;
deliberately writing a record without the required inline `key` throws, even
when the application serializer is correct.

Trace a control's actual consumer and result handling, not just its import or
translation key. Storage translations use `storage.offline`. Usage estimates
and incoming-history methods remain scaffolds, not measured archives. Report
current typecheck results, not the obsolete July error allowance.

These checks do not prove native WebView/installer behavior, physical mobile
devices, real microphones or correctness of every non-message queued action.
See the maintained client-offline skill and the dated message-delivery plan for
the full verified contract and release status.
