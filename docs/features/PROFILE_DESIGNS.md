# Profile designs and presentation

## Maturity

This is a **2026-09-28 working-tree candidate**, not a deployed or released
feature claim. It extends the existing Profile settings, name-style addon and
profile cards. Independent Wabi Authorities still own separate accounts and
profile media; importing a design does not federate identities or files.

The artist-facing export recipe and downloadable templates are in the
[artist guide](PROFILE_ARTIST_GUIDE.md). The same guide is available from Profile
settings without requiring an artist to browse the repository.

## Create, preview, publish and share

Profile settings now contains a name-design studio with editable typography,
two-color gradients, bounded glow, slow shimmer and solid, gradient or outline
nameplates. Five starting designs can be edited. Previews show the draft in a
message, People row and profile context. Saving remains an explicit action.

**Export design** produces a version 1 Wabi design JSON file; **Import design**
loads a local draft. The file contains a title and declarative name/plate values,
with no account identifier, biography, media URLs or executable CSS. Files are
limited to 16 KiB and accepted values are validated in the client and server.
Banner and decoration images are shared separately. The artist guide includes
two bundled example looks with artwork and portable name/plate designs. There
is no public design gallery, marketplace, image bundle, painting tool or animation
timeline in this candidate.

Profile text and design saves wait for a correlated server receipt before
showing success. Disconnection, rejection and unknown timeout outcomes are
visible. Bio, status and media fields can be explicitly cleared. Profile media
patches preserve the existing layout container and old typography/preset values.
The profile update is broadcast to other connected viewers after saving; the
request correlation identifier is private to the requester.

The design remains JSON inside the existing username-font storage field, and
profile media remains inside the existing layout JSON container. This work does
not change a Postcard durable record layout. User and layout writes are separate
commands; a later failure is reported, rather than claiming an atomic save.

## Artist export contract

| Asset | Recommended canvas | Export accepted by the editor | Limit |
| --- | --- | --- | --- |
| Banner | 1200 × 400, 3:1 | PNG, JPEG, GIF, WebP | 10 MiB |
| Avatar decoration | 512 × 512, transparent center | PNG, GIF, WebP | 10 MiB |
| Avatar picture | Square image | Existing avatar uploader | 5 MiB |
| Name/plate design | No bitmap canvas | Wabi design JSON, version 1 | 16 KiB |

Pixel dimensions are recommendations, not upload requirements. Profile and
editor banners use centered 3:1 cover scaling; compact sidebar artwork can crop
more tightly. The guides mark the avatar overlap, edge margins and circular
small-avatar safe area. Animated WebP and GIF preserve their original image
bytes. APNG playback remains browser-dependent. Profile media uploads sniff
the image signature, bound streamed size and use a matching stored extension.

## Viewer controls

Appearance has one **Show profiles plainly** switch, plus separate controls for
styled names, plates, banners/decorations and animation. The profile studio also
links these shared controls. They belong to the viewer's device, preserve the
individual choices when plain mode is toggled, and react immediately in mounted
messages, People, sidebar cards and profile popouts. Friends and DM directories
use the same renderer when current-server profile data is available. A friend
summary without that data stays plain; the client does not borrow appearance
from another Authority.

The person's avatar and readable identity remain visible. Disabling animation,
app reduced motion or OS reduced motion displays one decoded image frame in a
canvas and stops name shimmer. CSS alone cannot pause GIF/WebP. The selected
still frame is not guaranteed to be identical across browsers. Artist draft
previews show the draft even when the viewer hides published cosmetics, while
still respecting motion preferences.

## Profile cards

Compact cards and full profiles use the same name and media rendering. Full
profiles are wider centered dialogs with bounded scrolling, a visible close
control, Escape dismissal and a keyboard focus loop. They open at the top and
are available for your own profile as well as another member's profile. Editing
your profile is a separate action. The full card shows community role and a join
date when one is available; it does not show internal user IDs as profile content.

**Keep in side panel** opens that complete profile in the existing optional dock
alongside the conversation. Its registered Profile destination uses the shared
pin, stub, resizing and mobile presentation. **View Full Profile** opens the
larger dialog from the dock; closing it or choosing **Return to side panel**
restores the dock. A docked profile stays live through reconnects using the
account identity and clears on server/account/logout changes. Personal-note
drafts remain independent between the popout and dock. Targets stay in session
memory; they are not a cross-server profile directory or a persisted public link.

Presence and optional status text are distinct from the biography. Links parsed
from the bio are labeled **Links from bio**, without implying verified account
connections. **Copy handle** describes the existing copy action accurately and
shows clipboard failures.

## Emoji and reaction fixes in this candidate

- A server emoji snapshot replaces the previous custom catalog, including an
  empty snapshot, while retaining bundled emoji. Relative asset URLs resolve
  against the active Authority.
- New emoji/sticker uploads validate bounded metadata and actual image headers,
  with a 2 MiB asset limit and a bounded multipart request. Existing shortcodes
  return a conflict instead of silently replacing another asset. Concurrent
  creation of the same shortcode publishes one asset.
- Upload errors are shown in settings, and failed bulk items remain available
  to retry. An empty quick-reaction selection hides that strip.
- Reaction selection and tooltips use known user identities; an unknown reactor
  is not presented as the current viewer.

These fixes do not add a super-reaction renderer or a new reaction event model.
The existing server emoji upload path permits registered members to create new
shortcodes; this work does not redesign server asset moderation or replacement.

## Showcase gaps and competitor comparison

Current Discord features extend beyond fancy names and profile banners. Keep
these distinctions clear when planning a showcase:

| Feature | Wabi candidate / remaining work |
| --- | --- |
| Editable names and plates | Candidate implemented, with portable files and viewer controls |
| Animated banners and avatar decorations | Upload/display implemented; artist templates and downloadable examples documented |
| Large profile cards and complete profile side panel | Candidate implemented; live multi-account and native acceptance remain open |
| Super reactions | Not implemented; an animated reaction effect is more than a server emoji |
| Emoji confetti | Separate effect, not implemented |
| Profile-wide effects and profile frames | No creator schema/editor in this candidate |
| Dedicated links, verified connections, profile widgets and server-specific profile variants | Not implemented by this work |
| Custom typing effects | Optional later work, not part of this 1.0 profile pass |

Discord already offers a viewer switch for display-name styles. Its nameplate
FAQ says plates cannot currently be disabled, though reduced motion is
available. The accurate showcase claim is free editable designs, portable
sharing and a consistent viewer opt-out across names, plates and artwork.
Sources: [Display Name Styles](https://support.discord.com/hc/en-us/articles/33833879643927-Discord-Display-Name-Styles-FAQ)
and [Nameplates](https://support.discord.com/hc/en-us/articles/30408457944215-Nameplates-FAQ).

Discord's [Super Reactions](https://support.discord.com/hc/en-us/articles/12102061808663-Reactions-and-Super-Reactions-FAQ)
animate the selected reaction. [Emoji Confetti](https://support.discord.com/hc/en-us/articles/29133681590679-Emoji-Confetti-FAQ)
is a separate experimental message-hover effect. Its
[Shop](https://support.discord.com/hc/en-us/articles/17162747936663-Shop-FAQ) also
lists profile effects and frames; [Profile Widgets](https://support.discord.com/hc/en-us/articles/35344672307607-Profile-Widgets-FAQ)
and [Custom Typing Indicators](https://support.discord.com/hc/en-us/articles/42962943077271-Custom-Typing-Indicator-FAQ)
are additional surfaces. These references were checked on 2026-09-28; they are
not Wabi feature claims.

## Validation boundary

Focused frontend tests cover design validation/round trips, correlated save
success/failure/timeout cleanup, catalog replacement, reaction identity and
upload error handling. The side-panel controller tests cover live/reconnected
identity, malformed account IDs, server/account/logout clearing, independent
note drafts and existing pin/stub behavior. Bundled design downloads import the
same values shown in the example gallery. A focused run of these profile and
stub suites passes 44 top-level tests. Isolated viewer tests cover master/granular choices,
legacy migration, app/OS reduced motion, device persistence and storage changes.
Rust protocol tests cover the bounded wire design; five profile integration cases
cover durable replay, clears, failure/rejection, owner receipt/observer broadcast
and renamed display names after reconnect. Three emoji API contract tests pass.
The final static frontend build passes, and Svelte check reports **0 errors and
90 existing warnings**. Scoped whitespace checks pass. No production release
binary, deployment or release tag was produced by this task.

Real in-app browser acceptance used an explicitly enabled local mock transport
and a disposable preview identity. It covered creation and save feedback,
consistent mounted nameplates, immediate plain mode, still-image canvas
rendering, and desktop/phone profile layouts. Additional checks at 1280 × 720
and 390 × 844 cover the complete profile dock, expanding/returning to the large
card, editing from the large card with focus in Settings, downloaded-art gallery,
animation playback and loading an example as an unpublished editor draft.
It is not a two-account live
Authority, mobile-device or native-webview acceptance claim. Production upload
and cross-viewer persistence are covered separately by the focused backend
contracts; a live showcase rehearsal remains necessary before release.
