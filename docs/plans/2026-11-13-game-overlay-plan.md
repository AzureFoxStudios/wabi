# Game overlay plan, 2026-11-13

**Status: plan. Nothing here is built.** It is a new feature (Phase 5), not hardening. Do not describe any of it as shipped.

## Goal

Let a Wabi user stay in a game and still see who is talking, see new messages, reply, and mute or deafen, so that Wabi can replace the Discord overlay. A short list of games the owner chooses gets dedicated support. Every other game gets a generic fallback.

## What exists today

Checked against `main` on 2026-11-13:

- The desktop shell is Tauri 2.10 (`src-tauri/`). It has one ordinary window and a tray icon. It has no transparent or always-on-top window and no system-wide hotkey (the global-shortcut plugin is not a dependency).
- Wabi already knows about a user's games: curated game profiles with a favourite flag (`core/crates/wabidb/src/projections/game_profiles.rs`), the Games workspace (`frontend/src/lib/games/`), and an optional Steam link (`core/crates/wabi-server/src/api/steam.rs`).
- There is no overlay code of any kind.

## Rules

These hold for every tier and every game.

1. **No code inside the game.** No injection into a game process, no hooking of graphics calls, no reading of game memory, no simulated input sent to a game. Anti-cheat systems ban players for these, they crash games, and they are the opposite of what Wabi says about trust. A future exception is the owner's decision for one named game, and never for a game that has anti-cheat.
2. **Only official, documented, local game interfaces** for game data. If the publisher does not document it, Wabi does not use it.
3. **The overlay is a second view of the client.** It adds no server traffic. Anything it shows from a room with experimental encryption was decrypted on the device and stays on the device (`docs/PRIVACY_STANCE.md`).
4. **Game detection is local.** Which game is running is worked out on the user's machine and is not sent to the server unless the user already chose to share it.
5. **Hotkeys do not fight other overlays.** The default is not Shift+Tab (Steam) and not Shift+` or Ctrl+` (Discord). The user can change it, and a game profile can suggest a different one.
6. **Opt-in, and Wabi works without it.** The overlay is off until the user turns it on.
7. **Screen capture.** A stream or recording can capture the overlay. There is a setting to hide message text in the overlay and show only the sender.

## Tiers

### Tier 0: generic overlay, every game

A second Tauri window: transparent, no frame, always on top, not in the taskbar. By default mouse clicks pass through it to the game. A hotkey switches it to interactive (clicks land on the overlay, the reply box takes focus) and back. This is the same model as Discord's overlay lock.

Widgets: a voice strip (who is in the call, who is speaking, mute state), message toasts, a quick reply box, mute and deafen buttons.

Limits, to be stated in the UI and not hidden:

- It draws over a game that runs windowed or borderless. Over exclusive fullscreen it cannot draw. There the hotkey brings the main Wabi window forward and messages arrive as operating-system notifications.
- Windows is the first target. On macOS a transparent window needs Tauri's private-API flag and full-screen Spaces limit what can sit on top. On Linux, X11 is expected to work and Wayland compositors restrict both always-on-top windows and global hotkeys. None of this is verified until someone runs it on a real machine (AGENTS.md golden rule 7).

### Tier 1: game profile, data only

One small file per game. It adds no code. It tells Tier 0 how to behave for that game: how to recognise it, where to put widgets so they do not cover the game's own interface, which hotkey to suggest, what is known not to work. This is the tier another agent can add for a new game by following the guide below.

### Tier 2: game adapter, official interface only

Code for one game that reads the game's own documented local interface. Two examples of such interfaces, to be checked against the publisher's current documentation before anyone builds on them: Valve's Game State Integration for Counter-Strike 2 and Dota 2 (the game sends JSON to a local HTTP address the player configures), and the League of Legends Live Client Data API (served on the player's own machine during a match).

An adapter lets the overlay react to the game: hold toasts during a fight and show them between rounds, show which Wabi friend is which teammate when both linked accounts. A game with no documented local interface stays at Tier 1.

### Tier 3: drawing inside the game

Not planned. See rule 1.

## Build order

1. **Tier 0 on Windows.** Overlay window, global hotkey, voice strip, toasts, quick reply. Accepted only after a person runs it on a real Windows machine against one borderless game and one exclusive-fullscreen game.
2. **Profile format and loader**, with profiles for the owner's games. This step fixes the format and moves the guide below into `docs/ai/`.
3. **First Tier 2 adapter**, for whichever of the owner's games has an official local interface.
4. **macOS and Linux passes.**

Each step is its own PR. Any change in maturity updates `docs/PROJECT_STATUS.md` in the same PR.

## Guide for an agent adding a game

The profile format below is a proposal until step 2 lands. After that, the copy in `docs/ai/` is the contract.

### 1. Research, from official sources only

Find and cite (URLs in the PR description):

- the game's anti-cheat, by name, or that it has none;
- which window modes the game offers (windowed, borderless, exclusive fullscreen);
- the game's default key bindings that touch candidate hotkeys;
- whether the publisher documents a local interface for third-party tools.

If an official source cannot be found, write `unknown`. Do not guess, and do not use a forum post as a fact.

### 2. Write the profile

```json
{
  "schema": 1,
  "key": "<the key the Games workspace uses for this game>",
  "title": "Example Game",
  "detect": { "windows": { "process": ["example.exe"] } },
  "windowModes": { "borderless": "works", "exclusiveFullscreen": "overlay hidden" },
  "antiCheat": "unknown",
  "hotkey": { "suggested": "Ctrl+Shift+W", "avoid": ["Tab", "`"] },
  "layout": { "voiceStrip": "top-left", "toasts": "bottom-right" },
  "adapter": null,
  "sources": ["https://publisher.example/docs"],
  "verifiedBy": null
}
```

- `key` matches the game's existing key in Wabi (`frontend/src/lib/games/localGameKey.ts`), so a favourite game and its profile are the same game.
- `layout` keeps widgets off the game's own minimap, chat and health display. Take positions from the publisher's own screenshots.
- `verifiedBy` stays `null` until a person has run the game with the overlay. An agent never fills it in.

### 3. An adapter only when the interface is official

An adapter must:

- listen on `127.0.0.1` only, and accept connections from the local machine only;
- treat everything the game sends as untrusted input: size limits, a strict schema, no panics on malformed data;
- never forward game data to a Wabi server unless the feature says so in the UI and the user chose it;
- do nothing and report nothing when the game is not running.

### 4. Tests

- a schema test that the profile parses and has every required field;
- a detection test with sample process names, including near-misses;
- for an adapter, a parser test against sample payloads taken from the publisher's documentation.

### 5. What the PR may claim

It may say what the code does and what the tests show. It may not say the overlay works in the game: only a person on a real machine can say that. End the PR description with a manual checklist for the owner.

### 6. Never

Injection, memory reading, simulated input, reading game files outside documented config or log locations, or anything the game's terms of service forbid. If a game needs one of these to be supported, the answer for that game is Tier 0.

## Open decisions for the owner

- Which games get dedicated support. This decides which tier each can reach.
- The default hotkey.
- Whether Windows-first is right.
