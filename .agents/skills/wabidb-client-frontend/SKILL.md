---
name: wabidb-client-frontend
description: Compatibility entry point for Wabi's browser/Tauri IndexedDB outbound queue and Offline & Storage UI. Routes to the maintained client-offline contract.
metadata:
  hermes:
    tags: [WabiDB, frontend, sveltekit, indexeddb, offline, queue]
---

# WabiDB client frontend

This historical skill name remains discoverable, but its July v1 recipes were
superseded. Before queue or storage work, read the maintained
[client-offline skill](../wabidb/wabidb-client-offline/SKILL.md) completely and
follow its relevant references. It owns the current implementation guidance.

Do not restore the old emit-then-markSynced recipe, bare-client-ID settlement,
unowned history exports, scaffold usage counters or fake persistence Retry.
The real queue uses IndexedDB transaction completion, captures account/server
ownership before awaits, claims message attempts before emit and waits for
correlated application outcomes. Uncertain attempts cannot be blindly resent.

For rendering/storage checks use the
[verification reference](references/indexeddb-queue-verification.md).
A green typecheck or an imported helper is not evidence that an action works.
