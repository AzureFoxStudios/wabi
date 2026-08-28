# Post-login: messages "poof", can't create channels, Join as null

## First rule
**Probe APIs before blaming the UI.** In the 2026-07-23 incident:
- Messages were durable in WabiDB (`GET /api/messages/{channel_id}`).
- `POST /api/channels` worked for owner (admin).
- Forum/wiki kinds exist server-side; UI just never refreshed.

Missing routes (`/api/theme`, `/api/addons`, `/api/places`) used to return SPA HTML 200 → client `JSON.parse` errors. Fix: JSON 404 for unknown `/api/*` + stubs (`api-spa-fallback-and-stubs.md`). Cosmetic vs message path, but clean the console.

## Channel click does nothing (can create, can't go)
`ChannelSidebar.handleChannelClick` historically called `joinChannel(id)` only — emits socket `join-channel`, **never** updates `currentChannel`. Main pane stays put.

`switchChannel` also used to gate on `getChannelById` and silently no-op if the channel was briefly missing from the client list.

**Required shape:**
```ts
export function switchChannel(channelId: string): void {
  if (!channelId) return;
  if (get(currentChannel) !== channelId) currentChannel.set(channelId);
  joinChannel(channelId); // socket room only
}
```
All user navigation (sidebar, following feed, mode tabs, admin jump) must call `switchChannel`, not bare `joinChannel`. Init default selection should too.

Also list forum/wiki under Text (or dedicated sections) — filters that only allow `text|public|live` orphan other kinds.

## Socket: "Join as: null" after good join
Console pattern:
```
[SocketManager] Join as: wabi
[SocketManager] Init received: { channels: N, ... }
[SocketManager] Cannot connect from state: connected
[SocketManager] Force resetting from state: connected
[SocketManager] Join as: null
Uncaught TypeError: e.subscribe is not a function
```

Cause: second `connect(username, token)` with empty/null username while already connected. Old code forceReset'd then overwrote `this.username = null`, destroyed the healthy session, and init did `this.username.trim()` unsafely.

Fix (frontend `socketConnectionCore.ts`, shipped):
- Resolve username = incoming trim || existing; refuse connect with no username at all.
- If already connected and caller passes empty username → **return existing socket** (no forceReset).
- Init: `(this.username || '').trim()` before matching currentUser.
- Prefer default channel by **name** `general` when id is `ch_*` not literal `general`.
- Normalize init channels: `id`/`channel_id`, `type`/`channel_type`.

## Channel create UI dead while API works
`createChannel` called REST then ignored the response. No reliable socket `channel-created` fanout from HTTP create.

Fix: optimistic upsert into `channels` store from `CreateChannelResponse`; listen for `channel-created` if server emits later.

## userLookup cycle risk
`userLookupStore` must import `users` from **`./presenceStore`**, not `./socket-manager` (re-export layer). Circular/order-dependent re-exports can yield `undefined` → `$userLookup` → `e.subscribe is not a function`.

## Diagnosis order when user says "logged in but chat broken"
1. `POST /api/auth/login` + `GET /api/user/me` (revocation?).
2. `GET /api/channels` + `GET /api/messages/{id}` (data present?).
3. `POST /api/channels` (permission/admin?).
4. Console: Join as null / forceReset / subscribe crash; confirm clicks call switchChannel.
5. Only then sourcemap store hunt (`references/post-login-store-crash.md`).

## Deploy note
FE is rust_embed'd: `STATIC_BUILD=1 bun run build` → `cargo build --release -p wabi-server` → scp binary to Tim `/home/tim/Desktop/Wabi/target/release/wabi-server` → clear both locks → `docker compose restart wabi-server`.
