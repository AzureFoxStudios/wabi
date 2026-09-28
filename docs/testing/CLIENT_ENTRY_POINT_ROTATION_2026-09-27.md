# Signed entry-point reconnect rotation — 2026-09-27

**Scope:** Main Wabi client code-level check of a registered member's reconnect path. This is not an ERP test or a three-network field result.

```bash
cd frontend
bun test src/lib/socketConnectionReconnect.test.ts src/lib/communityRoster.test.ts
bun run check
```

The two focused files passed 4 tests and 22 assertions together. The frontend check reported zero errors and 109 existing warnings. The reconnect test injects endpoint, session and roster sources so it can exercise the production rotation method without changing the module cache used by the real signature-verification test.

The check found that reconnect rotation previously moved the current endpoint to the front of the candidate list on every attempt. In a three-site list it could alternate between two sites and leave the third untried. The current code keeps signed-roster order, locates the current site within it and walks forward with wraparound. The test follows roofing → equipment → materials → roofing, skips a private HTTP entry for automatic credential carry, refuses a destination with a different stored token, and aborts when logout or a manual endpoint change races the roster read. The adjacent test verifies the P-256 roster signature and rejects altered destinations.

This does not prove actual Socket.IO reconnect across distant hosts. A listed Anchor still depends on the one Authority; losing that Authority remains an outage. Refresh tokens, URL-scoped offline queues and drafts, encrypted client keys, notification state and long sessions have not been shown to move seamlessly between addresses. Ronin and Iyoku have not run this client test yet.
