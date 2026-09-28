# Regional Anchor access preflight

**Date:** 2026-09-27  
**Scope:** One disposable loopback Authority and two separate Anchor listeners on one machine. This is a three-process preflight, not the required three-network field pilot.

```bash
cargo test --locked -p wabi-server --lib anchor::tests -- --nocapture
```

All twelve focused Anchor tests passed. The three-process case sent the same authenticated request through each Anchor to the one Authority. Stopping the materials Anchor left the equipment Anchor usable. Stopping the Authority made the remaining Anchor return HTTP 503, which is the expected current behavior: it cannot serve canonical work or promote itself. The suite also covers request/query/auth forwarding, streamed uploads and responses, WebSocket frames, Engine.IO polling and Socket.IO WebSocket connection. Two live WebSocket cases verify that a close code and reason travel from the Authority to a client and from a client to the Authority through the Anchor. The unauthenticated `/health` response no longer exposes the configured Authority URL; a direct response check confirms the private upstream address is absent.

The URL-guard case accepted HTTPS origins and explicit private/Tailcat-IP HTTP upstreams, and rejected public HTTP, implicit private HTTP, URL credentials and paths/queries. The Anchor's HTTP client now refuses upstream redirects. `WABI_ANCHOR_ALLOW_PRIVATE_HTTP=true` permits a private-IP URL but does not create or authenticate the private transport; public member-facing access still needs HTTPS.

This check does not exercise three internet connections, Ronin/iRonin's desktop clients, real sign-in or files through all sites, network partitions, long sessions, public-IP certificate setup, Tailcat reachability, measured site bandwidth, or client endpoint switching. The [three-site acceptance scenario](../plans/2026-09-26-geographic-community-nodes.md#three-site-acceptance-scenario) remains open.
