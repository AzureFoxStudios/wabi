# Steam and curated game boards — recovery and release boundary

Base: `29d3208b1ae9b29b4e54fad41a46ff0f1848db48`. The earlier
`review/steam-games-2026-09-11` branch held setup workflows and only the first
of seven transfer fragments. It was not a feature implementation ready to merge.
This change recovers complete saved-game source from that fragment and
reconstructs the missing integration. Previous isolated test counts are not
verification of this change. Record actual CI results in the pull request.

## Included product surfaces

Settings → Games, Settings → Addons, and a Games action on registered members'
profile cards open one game-board surface. A DM's actions include What can we
play? with its conversation preselected. My game board and Steam connection
are separate tabs, not a second app-wide profile system.

Manual games work without Steam. Rotation/favorite/invitation choices are
independent. Entries begin private; edits publish only after Save changes gets
a server response. The same shared game code identifies a non-Steam title for
friends: copy its code, then paste it when adding that game. Equal text titles
alone never imply equal games. Steam titles use canonical `steam:<appid>` IDs.
A Steam launch action never says Join and never accepts arbitrary arguments.

Group matching consults only current channel members' *server-visible*,
*open-to-invitations* selections. No imported library, hidden game, private
note, playtime, or hidden-game count contributes. A match is not a claim of
ownership, installation, cross-play, or availability. Copy suggestion prepares
text for the user; it never sends a message or opens a call automatically.

## Operator setup (optional)

The core manual board is usable without configuring any provider. Steam network
access is **off by default**. To exercise it deliberately on a test deployment:

```sh
WABI_STEAM_ENABLED=1
WABI_STEAM_PUBLIC_URL=https://your-wabi-domain.example
STEAM_API_KEY=<server-owned-web-api-key>
```

`WABI_STEAM_PUBLIC_URL` is the backend's external origin, not a path, arbitrary
return URL, or browser-provided hostname. HTTPS is required except localhost
loopback development. Make `/api/steam/link/callback` reachable at that origin.
The public origin is needed for linking; the key is only needed for library
requests. Keep the key in operator secret configuration, never committed source
or member settings. Disable network integration by removing the enable flag.
Disconnect remains available while disabled. No key or credential is bundled.

Connect Steam starts a ten-minute handoff, opens Steam's own authentication
page, then asks the user to copy its returned one-use connection code into the
*initiating Wabi session*. This intentionally supports a native client without
relying on the browser sharing its bearer token. Account/session ownership,
separate initiation proof, exact return_to/provider/claimed identity, signed
fields, nonce age/replay, and direct provider verification are all checked.
Neither a handoff URL nor a copied SteamID alone is linking authority.

Load my Steam library is an explicit private request for the linked account.
OpenID does not grant private-library access: unavailable data is reported, not
presented as an empty library and not worked around by scraping. Import returns
only names and canonical IDs, then the user selects titles into an unsaved
private draft. There is no background polling or automatic publishing. Steam
account ownership is not developer verification, a trust score, or proof of
current game ownership.

## Data and privacy boundary

A new JSON v1 record and event `game_profile_replaced_v1` project to
`game_profiles`. Existing postcard User and Layout records are untouched. All
new writes use one serialized compare-and-swap path, reject undecodable records
before persistence, and await engine commit/application completion. Raw records
are never passed to subscription fan-out, presence, or user-updated broadcasts.
Account deletion removes the active row, and late events cannot resurrect it.

The private Steam association is only returned by the authenticated owner's
endpoint. A separate explicit saved option exposes a fixed Steam profile link.
Public game reads and matching construct minimal viewer-safe responses. All
these API surfaces send no-store/private and no-referrer headers, including
errors. Client requests are bound to account, server, token and session generation;
logout/destruction aborts requests, clears raw imports and handoff material, and
ignores late results. Failed saves retain the current in-memory draft; they are
not retried automatically. Offline persistence or draft recovery after closing
the app is not claimed.

Private here means application access by the owner, **not E2EE against the server
operator**. Historical events and backups can retain old selections/associations;
unlinking clears the active association, not historical storage. Already delivered
shared information cannot be remotely erased. Comparison results expire after
30 seconds or when the window visibility changes; this is not a push revocation
protocol. Friends-only visibility and global cross-server identity are not added.

Outbound requests use fixed HTTPS Steam endpoints, no redirects, bounded bodies,
timeouts, and bounded per-user/server request budgets. Raw errors containing
key-bearing upstream URLs are not reflected into the client. No arbitrary-id
status proxy or Steam account token is accepted. No third-party artwork loads
when profiles or game boards open.

## Deliberately unavailable in this release

Live Steam activity, rich presence, session joining, Steam friends, achievements,
Workshop automation, wishlist/deal sync, news subscriptions, publisher entitlement
checks, and arbitrary native commands remain disabled/unimplemented. The old
self-only status badge and polling side effect are retired; legacy status routes
return an explicit disabled result without a Steam request. The broader profile
and Discord feature issue is not closed by this change.

## Verification contract

Run frontend tests, whole-app Svelte checking, static frontend build, Cargo
workspace checks/tests, and the `game_profile_contract` production-router tests.
That integration suite covers private-read filtering, real persistence/readback,
conflicts, payload spoofing, current-membership enforcement, explicit clearing,
deleted-account cleanup, and replay after a child process exits without snapshot
or graceful Drop. It does not authenticate a real Steam account.

An operator-authorized Steam account, registered API key, callback origin and
real desktop/browser are still needed for the external handoff/import smoke.
No deployment or real account modification is part of this merge. Any UI fixture
checks must be identified as fixtures, not authenticated production validation.

Primary protocol references used for implementation:
- https://partner.steamgames.com/doc/features/auth
- https://partner.steamgames.com/doc/webapi/IPlayerService
- https://partner.steamgames.com/doc/webapi_overview
- https://openid.net/specs/openid-authentication-2_0.html
