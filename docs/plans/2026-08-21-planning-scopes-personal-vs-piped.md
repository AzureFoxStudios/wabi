# Planning channels scoping: personal vs piped — 2026-08-21

Ronin's double-check: is there a difference between *planning channels*? There must be a way to check a **personal** calendar/kanban, while project A (roadmap) pipes to channel A, Commissions pipe to channel B, etc. And can channels be shared so the planning data is shared too?

**Verdict: yes — and the model is simpler than it sounds. Two scopes only: `personal` and `channel`. Sharing comes free from the existing channel membership system.**

---

## 1. Verified substrate (what the backend already gives us)

- Channel types include `'lore'` alongside text/voice/forum/wiki/gallery (`packages/wabi-protocol/src/generated/ChannelType.ts`). No planner-specific type exists — and we don't need one (see §3).
- **Channel membership is a real server-side system**: WDB projection `channel_members:{channel_id}` with records `{channel_id, user_id, joined_at_micros, role}` and roles `Member/Moderator/Admin/Owner` (`wabidb/src/domain/mod.rs`), written through durable events (`add_channel_member` / removal) in `adapter/mod.rs`.
- Channels already carry optional `members/memberUsers` on the wire; group/DM visibility is member-scoped. So **"shared channel" = "you're in the channel"** — no new sharing machinery required.
- Server admin gates exist for channel creation (`is_admin` checks in `api/channels.rs`) — relevant later for who may create planning channels, not for this slice.

## 2. The model: every planner item gets an explicit scope

```
Scope = 'personal'                                  → device-local, only you
      | { channelId: string }                        → piped to a channel; shared with its members
```

Concretely:

- **Personal is the default and always exists.** Your own calendar/journal/scratch tasks never require a channel and never leave your device (until the deferred snapshot-routes slice makes channel storage real). This answers "way to check personal calendar/kanban" — the Planner's default view IS personal.
- **Piping = setting one field.** A project/task/event piped to channel A inherits that channel's audience automatically. Thing A roadmap → #roadmap. Commissions → #commissions. One item belongs to exactly one channel (no multi-channel fan-out; that's the nesting-doll trap again).
- **Sharing is inherited, not configured.** Add someone to the channel → they see the piped plan. Remove them → they don't. Zero new permission UI. This is precisely how Discord QoL works: permissions ride on containers, not on content.

## 3. Why NOT a 'planner' channel type

Tempting, rejected: a dedicated type multiplies special cases everywhere channels are rendered (sidebar grouping, create-forms, mobile tabs, notifications), and it would fork the Lore precedent where "Project channel" is just a lore-type channel with a workspace attached. Planning should follow that same proven pattern:

> **Any channel can host a piped plan. The Planner surfaces it by link, not by type.**

The sidebar doesn't change at all. What changes: opening Planner while inside channel A offers "This channel's plan" as a scope chip next to "Personal".

## 4. UX shape (small surface, big clarity)

1. **Scope switcher in Planner header** (segmented control beside the tabs): `Personal | <Channel name>` — defaults to Personal, remembers last per device (views-local rule).
2. **Pipe affordance**: in ProjectModal / task modal, a "Pipe to channel…" select (from `$channels`, filtered to types you're in). Empty = personal.
3. **Share indicator**: piped items show a small channel badge (#roadmap); personal items keep today's "On this device" honesty badge.
4. **Read-only for non-authors initially**: until server-side snapshot routes land, piped data still lives device-local — so piping is *intent + routing*, and the honest badge says "Synced via channel" only once the backend slice ships. No fake sharing claims.

## 5. Sequencing against everything already agreed

| Slice | Status | Feeds |
|---|---|---|
| `Project.channelId` link | agreed direction (2026-08-21 doc) | this scope model is its generalization |
| Piped-scope field on Project (+ later Todo/Event) | THIS doc | calendar commit overlay, shared roadmaps |
| Server snapshot routes `/api/planner/{channel_id}/snapshot` | deferred backend design | makes piping actually sync; scope field is its key |
| Lore citations on tasks | P0 pair | orthogonal, rides anytime |

The piped/personal split IS the generalization of channel-as-project: projects were the first thing asking for a home; calendar/journal ask the same question. Answer once with `scope`, apply everywhere.

## Non-goals

- ❌ New channel type, planner sidebar category, or cross-posting one plan to many channels.
- ❌ Per-item ACLs — sharing rides channel membership only.
- ❌ Claiming shared sync before backend routes exist (honesty badges stay truthful).
