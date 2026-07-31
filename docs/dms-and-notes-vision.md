# DMs and Notes: The Important Ideas

> **Implementation status (2026-07-29):** This is a future vision, not a description of current security. Current DMs are server-readable and must not display or advertise E2EE. Any operator-blind wording below is a target gated on a verified implementation.

A short vision document for Wabi's two most personal surfaces, plus the
People list that connects them. Not a spec. No code. No schemas. No
timeline. Just the ideas that should anchor every decision about how
DMs, Notes, and the People directory feel and behave.

The previous revision got three things wrong:

1. It said "people first" in passing but didn't make the address book a
   real surface. Without a People list, DMs are unreachable.
2. It prescribed how the conversation should be persisted ("server-side
   STDB, period") instead of treating memory as a user-facing setting.
3. It told the reader not to build DMs as private channels. The reader
   is right — a DM is just a space for two people to send messages.
   The transport (STDB calling, p2p, whatever) is an implementation
   choice, not a philosophy. Encryption is the philosophy.

The document below fixes all three.

---

## The core principle

**DMs, Notes, and the People list are the user's, not the server's.**
Everything that isn't a shared channel belongs to the person who
created it. The server is a place to gather; the personal stuff
(relationships, thoughts, who-you-know) travels with the user, not
the workspace. Every product decision about these three surfaces
should start from "does this respect that the user owns this?" and fail
if the answer is no.

This is a real differentiator. Discord, Slack, Teams all default to
"everything is in the workspace, the admin can see it." That model
collapses the moment a server hosts people who don't fully trust each
other — a friend group that drifted apart, a small business with former
employees, a community with internal disagreements. The workspace stops
being a home and starts being a surveillance surface.

Wabi is self-hosted, which means the user picked the server. That's
trust. But trust is fragile. The personal surfaces should be designed
as if that trust could be betrayed tomorrow — by the server admin, by
a subpoena, by a backup that leaks, by a future maintainer who sees
things differently.

---

## People before DMs

You cannot DM someone you don't know exists. The People list is the
**address book of the Wabi universe** — every person the user can
reach, with their current state (online, away, busy, offline), and a
way to start a conversation. This is the FIRST surface a user sees
after signing in, not a side panel.

The model: the People list is the user's contact directory. It is not
the server's user roster. A user should be able to find a person they
met six months ago on a different server, see whether they're
currently online, and start a conversation — without remembering which
server they were on.

What this means for the experience:

**The People list is the front door.** When a user opens Wabi, the first
thing they see is "who is here, and who's around." Not the channel
tree. Not the server list. People. A grid of faces (or handles) with
status, a search field at the top, and a "new conversation" button.

**Status is honest, not decorative.** Online means the person is
online *right now*, with the Wabi app open in a tab or a window.
Away means they haven't touched the app in N minutes. Busy is a
manual setting. Offline is the default. The status is per-installation
(Tauri desktop, web tab) and reported through presence. No ghost
status. No "online 5 minutes ago" fudging.

**The list starts flat.** No custom groups, no favorites, no drag-to-
reorder. The first version is a sorted, searchable list: online first,
then alphabetical. We can add reorganization later, after we know
what people actually want to do with it. Premature flexibility is
distracting. Get the basics right first.

**Search is the primary interaction.** Most of the time, the user
knows who they're looking for and types a name. The list is also
browsable. Both modes work. Both are fast.

**Discoverability flows from the list, not from channels.** A user
should not need to know which server or which channel a person is in to
find them. The People list is the index. The server/channel context is
a detail, surfaced when relevant.

**Privacy controls are per-person.** Block, mute, hide — all from
the People list, all per-person, all stored on the user's device
first, synced to the server only as needed for enforcement.

---

## DMs are a space for two people to send messages

A DM is not a private channel. A DM is two people (or a small named
group — see "Group messages" below) and a stream of messages. The
transport is an implementation choice. The user-facing thing is: I
write something, the other person reads it, the conversation is
remembered for as long as I want it remembered.

The framing for the ephemeral ladder (View once, 30s, 1min, 5min,
10min, 30min, etc.) follows Snapchat and Session: a small, fixed
list of options, the message auto-deletes after the chosen duration.
Snapchat pioneered the "tap to view" + short-timer pattern. Session
pioneered the "disappearing messages" pattern in privacy-focused
messengers. Wabi's DM retention is in the same family.

What this means for the experience:

**DMs surface first, above channels.** A user opens Wabi to talk to
specific people. DMs are at the top of the sidebar, pinned, persistent.
The channels are below, scrolled to. The People list is one tap away.

**A DM is a relationship, not a thread.** The same model as before:
two endpoints, shared history, asymmetric read state (I read what
*you* sent; you read what I sent), typing and presence are real-time
here but not in channels.

**The transport is the user's choice.** DMs should work over any
transport the architecture supports. The current default is STDB
calling (server-mediated, real-time, low-latency for users on the same
server). Future options include direct P2P (WebRTC, when both
participants have Tauri or are on the same LAN), and offline queue
(message stored locally, delivered when the other person comes back).
The user shouldn't have to care which transport a given DM is using —
it just works. But the architecture should make the choice per-
conversation if the underlying network allows.

**Encryption is non-negotiable.** The server MUST NOT be able to read
DM contents. Not "we promise not to look." Structurally. The transport
layer encrypts the message body with a key the server doesn't hold.
Metadata (who, when, message count) is harder to hide, and the user
should know what metadata is exposed. But the message body itself is
always encrypted. The same rule applies to Notes.

**Memory is what the user says.** This is the part I got wrong before.
The conversation's memory is a per-user, per-conversation setting. Not
"the server stores everything forever by default and the user can
delete." Not "messages vanish after 24 hours because that's the
default." The user picks, every time, and the system respects it.

**The retention ladder follows the ephemeral-messenger convention.**
Snapchat and Session are the reference framing: the user picks a
duration from a small, fixed list, the message auto-deletes after
that. Custom timers are not exposed. The list of choices is short,
predictable, and the same on every device. The full ladder:

- **View once** — message disappears the moment the recipient opens
  it. Sender can't see it again either. The Snapchat "tap to view"
  pattern. Use for: passwords, one-time codes, "screenshot this,
  then it's gone."
- **30 seconds** — message stays 30 seconds after the recipient
  opens it. Long enough to read, short enough to feel ephemeral.
- **1 minute, 5 minutes, 10 minutes, 30 minutes** — the standard
  Session/Snapchat quick-tier. The "I want this gone in a few
  minutes" range. Use for: phone numbers shared in a chat, addresses,
  "where are you right now."
- **1 hour, 1 day** — the "this morning" range. Use for: planning a
  meetup, sharing something you'll need to reference today.
- **1 week, 1 month** — the "default conversation" range. Long enough
  to scroll back, short enough that the conversation doesn't
  accumulate forever.
- **Forever** — uses a local sidecar (see below). The user has
  explicitly opted in to keeping this.

The default should be **1 week** for new DMs. The user can change it
per-conversation at any time, and the change applies to messages sent
*after* the change. Past messages keep the retention setting they were
sent under, unless the user explicitly extends or shortens them.

The picker UI is a fixed list, not a duration input. The user picks
"5 minutes" or "1 day," not "every 4 hours" or "until 6pm." The point
is the user has *thought about* the duration and made a choice.
Custom timers are a footgun: they let the user create configurations
they'll forget about.

For "view once," the message renders with a special visual treatment
(usually a one-tap "tap to view" with a clear warning that it will
self-destruct). Screenshots are not prevented (that's a broken
promise), but the visual treatment makes the intent obvious.

**The local sidecar is the "forever" tier.** When the user picks
"forever," the conversation history is mirrored to a local
sidecar — IndexedDB on the web, a real file-backed store on Tauri.
The server stores the canonical message log (because the user is on
the server), but the sidecar is the user's durable copy. If the user
leaves the server, they take their DMs with them.

Web is limited. Tauri is the full version. The web client supports
"forever" by caching in IndexedDB, which is durable-ish but tied to
the browser profile. Tauri supports "forever" with a real local
file, encrypted with the user's key, portable across machines by
export. The web client should not pretend to be the full version —
if the user wants durable "forever," they should use Tauri.

**Read state is a first-class signal.** Channels can be noisy and
unread is fine. DMs are a conversation — if someone wrote to me and
I haven't read it, that's personal. Unread counts on DMs are
aggressive and honest. Read state is per-person, not per-server. I
clear my unread with *you*, not with the server.

**Typing and presence are part of the conversation, not a feature.**
The other person is here, right now, typing. That signal only matters
in DMs. Don't surface typing in channels, don't bury it in DMs.

**Voice and screen share are DM-first.** A DM is where you call a
friend. The calling model can be the same code under the hood, but
the default and the invite model should treat DMs as the natural home
for voice.

**File transfer is verbose and trustworthy.** DMs are where you send
actual files to actual people. The transfer should make both sides
feel in control: clear progress, clear failure modes, the ability to
pause, resume, retry. This already matches the file-transfer principle
in the existing Wabi product spec; DMs inherit it.

**Group messages are a first-class conversation type, not a
smaller channel.** A DM is two people. A group message is three or
more, and the social dynamics are different. Wabi should not treat
group messages as "DMs with extra participants" (channels feel like
community) or as "small channels" (channels have a topic and a
history of different audiences). Group messages are their own thing,
and they should feel like it.

What this means for the experience:

**A group message is named, not derived.** When a user creates a
group, they name it. "The planning chat" or "Trio" or "Roommates." No
auto-generated "ronin, ada, leo" garbage. The name shows in the
sidebar, in the chat header, in notifications. The user can rename
it at any time. The name is metadata the group owns, not metadata the
server computes.

**Membership is explicit and participant-driven.** A group has
members. Adding a member requires one of the existing members to
invite. The new member gets a notification ("you were added to X")
and a choice to accept or leave. Members can leave at any time. No
member can be forcibly removed by a non-owner (see below). A removed
member can be re-invited.

**One role: participant. Plus owner.** A group message has no
moderation hierarchy beyond "owner" and "participant." No admin
class, no sub-roles, no permission tiers. The owner is the person who
created the group (or a transferred ownership). The owner can: rename
the group, set the retention policy, add/remove members, delete the
group. Participants can: send messages, send files, leave. That's
it. If the group needs more than that, it's a channel, not a group
message.

**Server admin cannot see group message contents.** Same as DMs:
structurally encrypted, server holds ciphertext. Group message
metadata (who's in the group, when it was created) is visible to the
server because the server routes the messages, but message bodies
are not.

**Read state is shared, not per-person.** In a one-on-one DM, "I
haven't read this yet" is personal. In a group, "has anyone read
this?" is collective. The unread count is the number of participants
who haven't read it. The message is "read" when everyone has read
it, or when the retention timer expires. This matches the Snapchat
group chat model.

**Typing and presence are the same as one-on-one DMs.** If someone's
typing in a group, the group knows. If someone's online, the group
sees. The model is the same: real-time, real-signal, no special
treatment for groups.

**Group messages have the same retention ladder as one-on-one DMs.**
View once, 30s, 1min, 5min, 10min, 30min, 1h, 1d, 1w, 1mo, forever.
The retention is set by the group owner and applies to the whole
group. Participants can see the current retention in the group info.
A participant who wants different retention can leave and start a
one-on-one DM, or ask the owner to change it. (Participants don't get
per-message override. The retention is a group property.)

**Group messages are searchable locally, like DMs.** Per-user,
per-device. The server doesn't see plaintext. "What did we decide
about the party?" returns hits across the user's groups and DMs
together, with the source tagged.

**Group messages can be promoted to channels.** A group that needs
formal structure (multiple moderators, public visibility, history of
different audiences) is a channel. Wabi should make that promotion
one click: "make this a channel in <server>." The members stay
(those who are on the server), the messages transfer, the retention
policy becomes the server's default. This is the escape hatch for
groups that outgrow the group-message model.

**Group messages can also be the *opposite*: a channel can be
demoted to a group.** A channel with no public visibility, no
historical membership churn, no formal moderation needs, can become
a group. "Move this to my DMs" is one click. The members come along,
the messages transfer, the server forgets the channel ever existed.

The point: groups and channels are not in a fixed hierarchy. They're
two points on a spectrum, and the user moves between them as the
conversation's needs change.

**The conversation has a memory.** A DM isn't a scrollback. It's a
relationship. Recent messages matter more than old ones. Search
matters. "What did we talk about in March?" should be answerable.
The history should feel owned — when I leave a server, I take my
DMs with me. (Or at minimum, I get to choose whether I do.)

---

## The personal-DM section (LINE mode)

Some users don't care about servers. Some users don't care about
channels. Some users just want to talk to their friends. LINE is the
canonical example: a chat app that *is* a personal messenger first,
and a group/community thing second. Wabi should support this use case
fully. Not as an "extra," not as a feature flag buried in settings —
as a first-class layout option, visible in the sidebar, opt-in by
default for new users.

What this means:

**The home view can be People + DMs only.** A user picks "personal
messenger" as their home layout. The sidebar shows: the People list
at the top, pinned DMs below, the Notes quick-capture, and a single
"browse servers" entry at the bottom. No channel tree by default.
Servers and channels are still accessible — they're just not the
default.

**Customization is per-user, not per-server.** The personal section
has its own theme, its own layout density, its own notification rules,
independent of whatever server the user is currently active in. A user
can be in five servers and have their personal section look exactly the
same across all of them. The server's theme touches channels, not the
People list or DMs.

**The personal section travels with the account, not the device.**
If the user signs in on a different machine, their People list and DM
layout come with them. (Tied to their account identity, not their
browser profile.) The customizations are stored server-side but are
private to the user — the server admin can see *that* a user has
customizations, not *what* they are.

**Server channels are still there, just not in the way.** A user in
LINE mode can still browse servers, join channels, see what's
happening in communities. The mode is about the *default home view*,
not about removing server functionality.

**LINE mode is a personality, not a lock-in.** A user can switch
between "personal messenger" home and "server browser" home at any
time. Some days you want to chat. Some days you want to lurk in a
community. Both should be one tap away.

---

## What makes a DM a DM (the relationship layer)

Treating DMs the same as channels is the single biggest mistake chat
apps make. A channel is a room; a DM is a relationship. The visual
language, the notification model, the social dynamics, the read
state, the search — all of it is different.

The model: every DM is a *pair of people* (or a small named group)
with their own state, their own visual identity, their own history.
The DM exists because those specific people chose to talk. When one
person leaves or deletes their account, the other side gets a real
moment, not a silenced ghost.

DMs have a tone, not a brand. Channels can have a server's
personality. DMs shouldn't. The visual language of a DM is the visual
language of two people talking. The server's theme touches it lightly
(accent color, surface token) but doesn't dominate.

---

## What makes notes different from chat

Notes are not messages to yourself. Messages are conversations; notes
are thoughts. A conversation is shared; a thought is owned. A
conversation has social pressure (am I replying fast enough?); a note
has none. A conversation fades; a note accumulates.

The model: notes are a *single-user scratchpad* that lives in the
same product as the chat. The integration is the value — you can
promote a chat message to a note, you can drop a note into a DM, you
can find a note when you need it while looking at a conversation. But
the note itself is personal, persistent, and not social.

What this means for the experience:

**Quick capture is the entire UX.** Most note-taking apps optimize
for power users writing long documents. Wabi notes should optimize for
"I just thought of something" — a single keyboard shortcut, a
single text field, autosave, done. No title, no tags, no format
picker. Open, type, close. The note exists.

**Notes are local-first.** They live in the user's IndexedDB before
they sync anywhere. If the server is down, the note is saved. If the
network drops mid-typing, the note is saved. Sync is a background
process, not a precondition. The user should never see a "saving..."
spinner on a note.

**Notes are searchable but not indexed by the server.** A note's
contents are the user's. Server-side search across notes would mean
the server can read them, which it shouldn't. Search is a client-side
operation, full-text, over the user's own notes. The server stores
the ciphertext, not the plaintext.

**Notes are not chat.** No reactions, no threads, no @mentions, no
"someone is typing", no read receipts. A note is a thing you wrote,
not a thing you sent. If you want to send a note to someone, that's a
separate action: "send this note to a DM." Sending a note to a DM
makes it a message. A note is private by default, always.

**Notes are append-mostly, not documents.** A note grows. Sometimes
it gets edited. Almost never does it get rewritten. The UI should
reflect this: a chronological view, soft version history (last few
states), no "track changes" nonsense. If a note gets long enough to
be a document, the user can promote it to a doc. Until then, it's a
stream.

**The friction to start a note is the friction to capture a thought.**
The current "Notes tab in the right sidebar" treatment makes notes
feel like a chat channel. Don't do that. Notes need their own entry
point — a global hotkey, a quick-capture input somewhere always
reachable, a slash command from any chat. They should feel like a
system-level feature, not a tab in a panel.

**Notes integrate with DMs at the edges.** A user should be able to:
- Promote a DM message to a note ("save to my notes")
- Send a note into a DM as a message ("share this with <person>")
- See, in a DM, the notes that are attached to that conversation
  (manually, not automatically)
- Search across notes and DMs together, with the result tagged by
  source

These are the cross-features. They make the personal-data surfaces
*useful together* without making them *the same thing*.

**Voice notes and transcription.** In a self-hosted product, voice
memos that transcribe locally (in the browser) are a real
differentiator versus cloud competitors. A future local-only mode
should keep audio away from the server and send text only when the user
opts in. That behavior is not guaranteed by the current implementation.

**A note is not a database row.** Notes don't have required fields.
There's no `created_at` the user has to see. There's no `updated_at`
that implies a workflow. There's text. The system tracks the rest.
The user sees a stream of their own thinking.

---

## The cross-cutting theme

The People list, DMs, and Notes are all *user state* in a product
that's mostly about *server state* (channels, roles, permissions,
integrations). Every design decision in these three surfaces should
ask: who owns this? If the answer is the user, the feature is a
personal-data feature. If the answer is the server, it's an admin
feature. The two should be visually and architecturally separable.

Practically:

- **A "My Stuff" surface.** Separate from the channel tree. Contains
  the People list, DMs, and Notes. The user's stuff, not the server's.
- **Server admin cannot read DMs or notes.** Not "we promise not to
  look." Structurally. The DMs and notes columns are encrypted with
  keys the server doesn't hold, or stored in a way the server's data
  export doesn't include. The user is in control of what the server
  can see.
- **The personal section is portable across servers.** A user in
  five servers has one People list, one set of DMs, one set of Notes.
  Server boundaries don't fragment the personal layer.
- **Search is per-user.** Cmd-F searches the user's view. The server
  doesn't see the search query. The server doesn't see the results.
- **Sync is the user's choice.** Some users want DMs and notes on
  multiple devices. Some want them locked to one device. The default
  is one-device-local; sync is opt-in.
- **Delete is real.** When a user deletes a DM or a note, it's gone
  from the user's view, from search, from sync, from backup exports.
  Soft-delete with admin recovery is the wrong default.

---

## Practical product ideas (a starter list, not a roadmap)

For the People list:
- Flat sorted list (online first, then alphabetical) with a search
  field at the top
- Honest status (online / away / busy / offline) reported through
  presence
- Per-person privacy controls (block / mute / hide) from a small
  inline menu
- "New conversation" button that opens a DM with the selected person
- The list is the first surface after sign-in, before channels
- Custom groups, favorites, drag-to-reorder: deferred. Get the basics
  right first.

For DMs:
- DM-first sidebar layout: People + DMs at the top, server channels
  below
- Per-DM retention setting: 5 seconds, 1 hour, 1 day, 1 week,
  1 month, forever. Default 1 week. Changeable per-conversation at
  any time.
- "Forever" tier uses a local sidecar (IndexedDB on web, file-backed
  on Tauri). Web's "forever" is best-effort, Tauri is the real thing.
- Multiple transport options: STDB calling (current default),
  P2P/WebRTC (future), offline queue (future). The user shouldn't
  have to care which transport a given DM is using.
- Target end-to-end encryption of message bodies, gated on verified
  client encryption and server downgrade rejection. Current DMs are
  server-readable. The user must be told what metadata is exposed.
- Per-DM read state that travels with the user
- Real-time typing and presence in DMs only
- Voice and screen share as DM-first features
- Verbose, trustworthy file transfer (inherited from existing Wabi
  product spec)
- Group DMs: explicit name, equal read state, no @mention semantics
- Search across DM message bodies, attachment names, and links
- DM requests: opt-in DMs by default, with a request/accept flow
- Voice notes as a first-class message type
- "Send to note" and "Save to note" actions on every DM message
- DM-specific notification rules: who can ping, when, how loud
- Group messages: explicit naming, one-owner-many-participants model,
  promote-to-channel and demote-from-channel escape hatches
- Group message retention is a group property set by the owner
- Group messages can be created from the People list ("new
  conversation with N people") or from any existing DM ("add
  someone to this conversation")

For Notes:
- Global hotkey to open a quick-capture note
- Notes live in IndexedDB, sync to STDB as encrypted blobs
- Inline search across notes, with a fast local index
- Promote a note to a DM message: drag, button, or /note-to-dm slash
- Free-form `#tag` for categorization, no folder hierarchy
- Voice notes: record in the browser, transcribe locally, save as text
- A "Daily" view: notes created or edited today, chronological
- A "Pinned" surface: notes the user explicitly pinned
- Export: a single `.zip` of all notes, plain text + markdown
- Versioning: keep last N revisions (say, 10), accessible from a small
  "history" affordance
- No required fields. No mandatory titles. No public-by-default.

For the personal section (LINE mode):
- A "home layout" setting: "personal messenger" or "server browser"
- Personal layout shows: People + DMs at the top, Notes entry point,
  a single "browse servers" link at the bottom
- Personal layout has its own theme and density, independent of the
  current server's theme
- Customizations are tied to the account, not the device
- Switching layouts is one tap, no confirmation dialog

For the integration between them:
- DM message → note (one click)
- Note → DM message (one click)
- DM view shows "notes attached to this conversation" if any
- Search results show whether a hit is a DM or a note, with a clear
  visual distinction

---

## What NOT to build

The features that betray the principle:

- **Mandatory note titles.** A note is a stream, not a document.
- **Reactions on notes.** Notes are not social. No thumbs-up, no
  heart, no "someone is viewing this." A note is one person's.
- **Read receipts on notes.** Same. A note doesn't know if it's been
  read. The user reads it and the system records that locally, on
  their machine.
- **A "team notes" or "shared notes" surface.** That's a different
  product. Wabi has channels for shared writing. Notes are personal.
- **AI features that send note contents to a third party.** Any "AI
  summarize my notes" feature should be local-only, opt-in, and
  never phone home. Same for transcription.
- **Notifications for "someone viewed your note."** A note has no
  viewers. The user knows they wrote it.
- **A social feed of public notes.** That's Medium. That's not Wabi.
- **Server-side full-text search of notes.** Same — the server
  shouldn't see plaintext notes.
- **A "default to forever" retention policy.** Forever is a
  user-chosen tier, not the default. The default is 1 week.
- **A single rigid DM layout.** LINE users, Discord users, Signal
  users, and "I just want a phone number pad" users all exist.
  Customization is per-user, not a developer choice.

---

## The bar

A user who opens Wabi should see, first, *people*. Their people. The
ones they talk to. Then their conversations — recent ones, real
ones, set to the retention they chose. Then their notes — captured
fast, searchable locally, never visible to anyone but them.

A user who leaves Wabi for a year and comes back should find their
People list intact, their DMs held to the retention they set, their
notes exactly where they left them, untouched, still theirs. That
promise is the whole product.

---

## One last thing

The architectural work to back this up — encryption with keys the
server doesn't hold, local-first sync with conflict resolution, the
storage layer that can't read plaintext, multiple transport options
(STDB calling, p2p, offline queue) — is real and should not be
deferred forever. But the *product design* should not wait for the
architecture. Ship the People list, ship the DMs with the retention
knob, ship the Notes with local-first capture. The architecture will
follow. The reverse is also true: shipping the wrong product and
hoping the architecture saves it has never worked.

And: this document is a set of ideas, not a contract. When the user
opens Wabi in two years and the product feels right, this doc is a
success. When they open it and feel nothing, the doc is wrong. Re-read
it after every user test. Update it when the user disagrees.
