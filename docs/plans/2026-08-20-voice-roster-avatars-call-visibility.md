# Voice roster avatars + call visibility fix

The "no avatars in voice channels" problem is two concrete gaps:

1. `voice_participant_to_view` (shared.rs:491) emits no `profilePicture` → sidebar roster always renders initials.
2. wabidb transport never populates `activeCalls` → `buildParticipants` (callRenderModel.ts:30) only ever sees your own tile. Remote people are invisible in CallModal.

Both are narrow, mechanical fixes.

---

## P1: Server — add `profilePicture` to voice roster payload

- `core/crates/wabi-server/src/socketio/shared.rs`
  - Add `pub profile_picture: Option<String>` to `VoiceParticipant` (line 57).
  - In `voice_participant_to_view` (line 491), emit `"profile_picture": p.profile_picture`.
  - In `on_voice_channel_join` (voice_channels.rs:57) and `on_voice_channel_subscribe` (~line 149): resolve `profile_picture` from WabiDB before constructing `VoiceParticipant`.
    - The caller already has `stable_id` = `user-{db_user_id}`.
    - Reuse the same lookup pattern as `connected_user_to_view` (shared.rs:455-472): `state.app.wdb.get_user(db_id as u64)` → `db_user.profile_picture`.
    - Two lookups (join + subscribe) — both need it.

## P2: Frontend — thread `profilePicture` through roster

- `frontend/src/lib/presenceStore.ts`
  - Add `profilePicture?: string` to `VoiceChannelParticipant` (line 24).
  - In `_setVoiceChannelMembers` (line 275): pass through `member.profilePicture` from the wire.
  - In `_updateVoiceChannelMember` (line 309): preserve/merge `profilePicture`.
- `frontend/src/lib/socketConnectionCore.ts`
  - `voice-channel-state` handler (line 974): members arrive with `profilePicture`; pass through to `_setVoiceChannelMembers`.
  - `voice-channel-joined` (line 1002) and `voice-channel-user-joined` (line 1224): pass `profilePicture` in the user object.
- `frontend/src/lib/components/sidebar/VoiceChannelList.svelte`
  - `visibleVoiceMembers` return type (line 131) already includes `profilePicture?: string`.
  - The avatar block (line 296) already checks `member.profilePicture` → once the payload carries it, it renders. **No change needed here.**
- `frontend/src/lib/components/sidebar/UnifiedChannelList.svelte`
  - Same: already checks `member.profilePicture` (line 369). No change needed.

## P3: CallModal — render roster-backed tiles for wabidb participants

- `frontend/src/lib/callRenderModel.ts`
  - Add new export `buildRosterParticipants(members: { userId: string; username: string; profilePicture?: string }[]): ParticipantMedia[]`.
    - Maps each member to `{ id: userId, label: username || 'User', hasVideo: false, kind: 'avatar', stream: null, isLocal: false }`.
    - Filters out ids already present in `activeCalls` (so P2P/LiveKit tiles don't duplicate).
- `frontend/src/lib/components/CallModal.svelte`
  - Compute `rosterParticipants`:
    - Source: `$voiceChannelMembers[$activeVoiceChannel?.id] ?? []`.
    - Exclude `selfStableUserId`.
    - Exclude ids already in `$activeCalls`.
    - Call `buildRosterParticipants(...)`.
  - Merge: `participants = [...buildParticipants(...), ...rosterParticipants]`.
  - `getParticipantAvatarUrl` (line 769) already resolves `profilePicture` from `$users` — roster-backed tiles will hit `byId?.profilePicture`. But the direct payload path (P2) means even users not in `$users` get avatars.

## P4 (optional, non-blocking): HTTP roster peek endpoint

- `core/crates/wabi-server/src/api/channels.rs`
  - Add `GET /api/channels/{id}/voice-members` → returns current `voice_channels` snapshot for that channel.
  - Allows non-participants (settings panel, channel peek) to see who's in voice without joining.
  - Depends on `voice_channels` state being accessible from the API layer (it's in `SioState`, not `AppState` — may need to expose via `AppState` or a shared registry).
  - **Defer if the state boundary is awkward.** P1+P2+P3 already solve the "I joined and see nobody" problem.

---

## Verification

1. `cargo check -p wabi-server` passes.
2. `npm run check` (frontend) passes.
3. Runtime smoke: two browser clients —
   - Both join same voice channel.
   - Sidebar shows both avatars (not initials) **before** either joins the call.
   - Client A opens call → Client B appears as avatar tile (no video, no stream — just name + avatar).
   - Client B joins call → both see each other's tiles.
