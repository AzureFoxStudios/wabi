# Steam Integration Proposal

**Date:** May 2026  
**Status:** If Time Permits  
**Priority:** Low  
**Author:** Wabi Architecture

---

## 1. What Steam API Can and Cannot Do

Steam's API and ecosystem have strict privacy controls. Understanding these limits is critical — Wabi must not violate them.

### Cannot Do (Hard Limits)

- **No automatic friend stalking.** Steam does not expose a user's friend list via Web API without explicit user-provided Steam API keys, and even then, rich friend data is restricted.
- **No background game tracking.** Steam only exposes "currently playing" data if a user's profile is set to "Public" and the player is currently in-game. Offline status and history are not accessible.
- **No invisible-mode access.** If a user hides their "Online" or "In Game" status, Steam returns nothing useful — Wabi must respect this.
- **No cross-user game history scraping.** The `player_games` endpoint requires the user's own API key and returns only the authorized account's data.
- **No Steam overlay control.** Valve does not expose overlay APIs to third parties. The overlay is a client-side Steam feature only.

### Can Do (Allowed)

- **Public profile data.** Game name, "Currently In-Game" (if public), and rich presence are readable for any public profile via `steam-user` / `ISteamUser` endpoints.
- **Steam rich presence.** Games can set rich presence strings (e.g., "In Lobby — [Map Name]"). This is readable via the Web API if the title supports it and the user has a public profile.
- **Deep links.** Steam supports `steam://run/<appid>` URL scheme to launch games directly. This is safe to use in UI — it is just a link protocol.
- **Opt-in game status sharing.** If a user provides their Steam API key (voluntarily), Wabi can read their game list and current status. This is analogous to giving Wabi read access to your public Steam profile.
- **Steam invite links.** Steam supports lobby invite URLs that can be opened via `steam://joinlobby/<appid>/<lobbyid>/<serverid>`.

---

## 2. What Wabi CAN Integrate

All features below require explicit opt-in by the user. No automatic discovery.

### "Currently Playing" Status (Opt-In)

A user can share their active game from their public Steam profile or from their own API key. Wabi displays this as a status badge beside their name:

```
@PlayerName 🎮 Playing Counter-Strike 2
```

**Implementation:** Poll `steam-user` `GetPlayerSummaries` endpoint. Cache for 60 seconds to avoid hammering the API. Requires user to set their Steam Profile to Public, or provide an API key.

### Game Join Links (`steam://run/<appid>`)

Wabi messages can include clickable "Join Game" buttons that launch the game directly via the Steam protocol handler. Example:

```
[Aldric is playing Baldur's Gate 3] [Join Game]
```

The `Join Game` button triggers `steam://run/1086940` (BG3's AppID). This works on desktop Steam clients. On mobile or web, the link is non-functional but harmless — degrade gracefully.

**Note:** "Join Game" is a link, not an auto-join. It launches the game; the user must then manually join or invite. This avoids any integration with Steam's actual multiplayer APIs.

### Steam Rich Presence (Opt-In)

For supported games, Wabi can display richer context — not just the game name, but what the player is doing inside it (e.g., "In a Party — Act 2"). This requires the game to publish rich presence to Steam and the user to have a public profile.

### "Join Game" Button in Chat Messages

When a user shares a Steam game link or when their "currently playing" status is known, render an inline action button:

```
@Teammate is playing Helldivers 2 [Join Game]
```

Clicking "Join Game" on desktop opens `steam://run/553850`. This is purely a UX convenience — it saves the recipient a manual search.

### Tauri Overlay for In-Game Quick Chat (Ambitious)

A native overlay window rendered by Tauri that floats above full-screen games. This is the "if time permits" feature — likely Phase 3.

The overlay is a frameless, semi-transparent window that displays Wabi chat on top of any full-screen application:

```
┌─────────────────────────────┐
│  Wabi  [unread: 3]      [X] │
│─────────────────────────────│
│  Aly: anyone up for a run?  │
│  Ben: sure, which mission?  │
│  Aldric: joining you now    │
└─────────────────────────────┘
```

This uses Tauri's window API to set `always_on_top`, `decorations: false`, and `transparent: true`. Requires the user to grant display overlay permission (standard OS-level).

---

## 3. Privacy-First Design

Every Steam feature in Wabi is opt-in. Privacy is not a preference — it is a hard constraint.

| Feature | Requires | What is shared |
|---|---|---|
| "Currently Playing" (public profile) | Public Steam profile + user enables it | Game name only |
| "Currently Playing" (API key) | User provides Steam API key | Game name + rich presence |
| Game Join Links | None (link is just a link) | None |
| In-Game Overlay | User installs/enables overlay addon | Same as normal Wabi chat data |

**No automatic friend tracking.** Wabi does not pull Steam friends. If you want to see what games your Wabi contacts play, you add them on Wabi — not via Steam.

**No game history scraping.** Only currently-in-game status is read, not past play history.

**Revocable consent.** Users can disable any Steam integration at any time. All Steam-related settings live in `Settings > Privacy`.

---

## 4. Implementation Sketch

### Phase 1: Basic "Currently Playing" Status (Core)

**Backend:**
1. User enters their Steam Profile URL or Steam ID in `Settings > Gaming > Steam`.
2. Wabi resolves the Steam ID via `steamid.io` lookup or `steam-user` `ResolveVanityURL`.
3. Poll `ISteamUser/GetPlayerSummaries` every 60s, cache result.
4. Store `current_game_name` in the user's profile, exposed as a field in the contact/session model.
5. If the profile is private or user has not opted in, show no game status.

**Frontend:**
- Display game badge in user profile popover: `🎮 Playing {game}`.
- Setting toggle: "Show my current game to contacts" (default: off).

**API Endpoints:**
```
GET  /api/profile/steam        → { steam_id, opted_in, current_game }
PUT  /api/profile/steam        → { steam_id, consent }
GET  /api/contacts/:id/game    → { current_game, rich_presence }
```

### Phase 2: Join Game Button

**Message Rendering:**
When rendering a message, detect if the sender has `current_game` set and render:

```svelte
<!-- MessageAction.svelte -->
{#if sender.current_game}
  <button
    class="join-game-btn"
    onclick={() => openSteamLink(`steam://run/${sender.current_game.appid}`)}
  >
    Join Game
  </button>
{/if}
```

The `steam://` URL is handled by the OS (desktop) or ignored gracefully (mobile/web). No special backend logic needed.

### Phase 3: In-Game Overlay (Tauri Addon)

**This is ambitious and lower priority — target only if time permits.**

A Tauri addon (`wabi-steam-overlay` or `wabi-in-game-overlay`) that:

1. Creates a transparent, frameless window positioned at the screen edge.
2. Loads Wabi chat via Tauri's webview.
3. Uses `window.always_on_top = true` and `window.decorations = false`.
4. Reads the user's current game from the Wabi profile state (populated in Phase 1).
5. Optionally auto-shows when user enters a game (polling, or relies on user manually activating).

**Risks:**
- Overlay detection may be flagged by anti-cheat in some games (Valve's own games are fine; third-party anti-cheat is a minefield).
- Requires OS-level display permission for overlay rendering.
- High complexity for marginal gain — only pursue if bandwidth exists after Phase 2.

### Steam Web API Integration

```rust
// Use `steam-web-api` crate or raw reqwest calls

// Get player summary (includes current game if public)
GET https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/
    ?key={API_KEY}&steamids={STEAM_ID}

// Response shape:
#[derive(Deserialize)]
struct SteamPlayerSummary {
    pub games_played: Option<Vec<GameInfo>>, // if in-game
}

struct GameInfo {
    pub gameid: String,
    pub game_extra_info: String, // game name
}
```

For unauthenticated (public profile only) access, omit `key` and rely on `steam_id` with `CommunityVisibilityType: 3` (Public).

---

## 5. Open Questions and Steam Policy Concerns

1. **Steam API key handling.** Users providing their own API key gives Wabi read access to their full publicly-available Steam data. We must document exactly what we read and store. Do not store the API key — store only the resolved Steam ID and game data.

2. **Rich presence privacy.** Rich presence can reveal more than just game name (e.g., what map a user is on, what lobby they're in). Should we display rich presence at all, or only the base game name? Recommendation: display base game name only unless user explicitly opts into "show rich presence context."

3. **Overlay and anti-cheat.** Rendering a window above a game can trigger false positives in some anti-cheat systems (e.g., Easy Anti-Cheat, BattlEye). Valve's own games (CS2, Dota 2, etc.) are safe. Third-party anti-cheat is not. We should detect the running game and warn users, or skip overlay injection for known-sensitive titles.

4. **Steam distribution policies.** Valve has policies against applications that impersonate Steam or interfere with Steam's functionality. An in-game overlay is a grey area — Valve has not publicly approved or blocked third-party overlays, but anti-cheat integration is the real risk. This needs legal review before Phase 3 ships.

5. **Steam Web API rate limits.** `GetPlayerSummaries` has rate limits (~100k calls/day per key). For a small self-hosted app, polling every 60s for active users is well within limits. Use caching aggressively.

6. **Public vs. private profiles.** If a user's Steam profile is private, Wabi cannot read their game status without an API key. We should surface this clearly in the settings UI so users understand why their game status isn't showing.

---

## Summary

| Feature | Effort | Privacy Risk | Priority |
|---|---|---|---|
| Currently playing status (public) | Low | None (public data only) | Medium |
| Currently playing status (API key) | Low | Low (user-controlled) | Low |
| Join Game button in chat | Low | None (deep link only) | Medium |
| Game join links via steam:// | Low | None | High |
| In-game overlay (Tauri) | High | Low (OS-level permission) | Low (if time permits) |

Steam integration in Wabi is fundamentally a UX problem, not an engineering problem. The APIs are well-documented, the deep-link protocol is stable, and Valve has no formal objection to applications that read public profile data. The privacy constraints are strong, but they align perfectly with Wabi's values: no stalking, no auto-discovery, explicit consent for everything.

Start with Phase 1 (public profile game status) + Phase 2 (Join Game button). Treat the overlay as a future ambition. Do not attempt the overlay without dedicated testing on a range of anti-cheat titles.
