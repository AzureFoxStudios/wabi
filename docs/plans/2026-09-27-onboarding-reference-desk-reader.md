# Server arrival, Reference Desk, and interactive Reader

**Date:** 2026-09-27  
**Status:** implementation started in the current worktree; the full plan is incomplete and unmerged.  
**Scope:** the complete member arrival and return experience, operator authoring, interactive posters, and a bounded Reader annotation foundation.

This expands the arrival section of [Moderation and arrival](2026-09-27-moderation-and-arrival.md). That document retains ownership of bans, reports, raid controls, and moderation enforcement. This plan proposes replacing the need for a Reception channel with a server-level Reference Desk. Existing worktree features and proposed work are distinguished below.

**Current implementation checkpoint:** the Reference Desk opens in center stage with rules, selected roles, actionable rooms, help, personal visibility, and reversible role choices. Registration enters welcome without a forced Community/Conversations question. New accounts receive an Authority-side pending marker so interrupted welcome can resume; completion clears it. New Authorities no longer create a mandatory Reception channel; existing channels remain intact. Server Branding publishes welcome/help text, a resource link, a suggested starting text room, authored text/link/role poster blocks, moving/still artwork, and an optional focused first-visit view. The optional opening surface selects Reference Desk or Messages per account/server on this device. Role changes detect stale concurrent edits. Guest entry now obtains the Authority guest credential, allowing guests to read the desk and rules while member role choices remain unavailable; a reload starts a fresh guest visit because the Authority reaps disconnected guest accounts. Imported Reader images use content-derived IDs and support locally saved vector strokes, highlights, text notes, erasure, undo/redo, and export. Frontend/server static checks and disposable desktop/mobile browser acceptance of welcome, returning desk, poster role choice, and guest guide pass. Multiple resources, operator guest/narrow preview controls, general forms/polls, full invite-destination restoration, and media crop/processing polish remain later work. Reader marks reattach when the same image is reimported; imported image bytes themselves are not yet retained across app restart.

## 1. Product decisions

- **Reference Desk is the server's reusable information page.** It belongs to the server, is available independently of channel membership, and opens in center stage.
- **The returning view leads with “You’re on [server name].”** Show the server's identity and ambiance, readable rules, selected roles, and a channel list with the member's current on/off visibility. An explicit “Edit my choices” action reveals role and room-visibility controls; ordinary visits open the overview.
- **Reception is the first-visit presentation of that desk.** The introduction, rules, roles, and room descriptions have one source of truth. Returning members land on the desk, rather than replaying a welcome wizard.
- **Use the server name/logo as the primary way back.** The current sidebar already opens Server Hub there. Evolve that surface into Reference Desk and add a small visible “Reference Desk” label to make the destination discoverable. Avoid introducing another floating corner control. On mobile, expose the same destination in the server header/menu within Browse; keep it reachable when desktop navigation is collapsed through the existing navigation reveal control.
- **Community role choices apply immediately after server confirmation.** They are optional, reversible member choices. Moderator/admin roles and separate service-access grants remain staff controlled.
- **Room guidance explains access.** Each listed room has a purpose, a current access state, and any self-selectable role needed to open it. Personal sidebar visibility is a separate setting.
- **The welcome presentation can be plain or a designed poster.** A useful default must work with just the server name and existing channel descriptions. Custom artwork and questionnaires are optional.
- **Server Branding owns the desk's visual identity.** Add welcome/Reference Desk presentation there, including optional animated backgrounds, alongside the existing server identity controls.
- **Reader annotations are ordinary marks and notes.** People may use them for informal sign-offs. Wabi adds no signing ceremony, identity certification, contract lifecycle, or signature-specific record in this scope.
- **Privacy follows each kind of data.** No onboarding click trail, silent message retention extension, or questionnaire history is required to operate the desk.

Recommended defaults in this plan are implementation choices to review, not claims that every detail has already been approved or shipped.

## 2. Current source and gaps

| Surface | Current worktree baseline | Work proposed here |
|---|---|---|
| Server entry | `ChannelSidebar.svelte` opens `ServerHub.svelte` through the server identity button | Make the hub the permanent desk, with readable navigation and a reliable return path |
| Server Hub | Identity, description, channel/member counts, and navigation buttons | Introduction, rules, room guide, community role choices, resources/help, and personal view controls |
| Reception | `ReceptionBoard.svelte` is rendered as a channel surface | Reuse its useful content in the desk and retire the mandatory channel dependency |
| Role choices | Server Center stores member community roles and filters room access; Reception exposes immediate selection | Harden request ownership, concurrent changes, stale definitions, and explain access in the desk |
| Rules | Versioned policy and acknowledgments; `CommunityRulesNotice.svelte` opens a dialog | A shared readable rules view, coordinated first-visit flow, and unobtrusive change notices |
| Reader | Text/image reading, focus mode, local document editing, notes/bookmarks | Interactive poster blocks and document-anchored pen/text annotations |
| Reader publishing | Local workbench Share/Go Live controls currently explain unavailable remote publishing | Explicitly scoped server-owned welcome content first; general Reader sharing remains a separate phase |
| Whiteboard | Vector strokes, pressure, rendering, and pointer sampling are implemented | Extract small drawing primitives for Reader without coupling its state to a board |

These are source findings on a heavily modified worktree. They do not establish merge, release, or runtime acceptance. In particular, `openServerHub()` currently selects Messages and closes the center DM; preserving and restoring the previous workspace needs deliberate work.

## 3. First arrival: member journey

### A. Arrive at the right server

An invite or saved server opens that Authority's entry flow. Show its identity and use existing sign-in, registration, invitation, and guest admission controls. Explain invite-only, closed, or temporarily restricted admission using the real server result. A welcome poster cannot override admission or an active ban.

Preserve an invite's intended room as a pending destination. After authentication and server-state hydration, decide whether to show the first-visit introduction. Do not infer a new member from a briefly empty channel list during reconnect.

### B. Welcome

The default welcome occupies center stage with the surrounding server shell visible. It contains:

1. Server identity, a short introduction, and optional artwork.
2. A clear “Get started” action and “Explore first” alternative.
3. A brief indication that rules and roles are available later from Reference Desk.

Allow a server to choose a focused first-visit presentation using the same content. That option may fill the app viewport, has an obvious exit, supports Escape/back, and restores the shell afterward. It does not enter browser fullscreen automatically. Reduced-motion preferences apply to any fade or transition.

### C. Read the rules

Present rules in a readable Reader-style view with headings, links, adjustable reading size, and an explicit acknowledgment when configured. Do not require scroll-to-bottom tricks or a quiz to prove reading.

If acknowledgment is required before participating, explain the exact restriction: “You can look around. Read and acknowledge the rules before posting.” Closing the view or choosing Explore first leaves the restriction in force. Reading rules, reporting, and help remain reachable. Reuse the canonical rules revision and acknowledgment endpoint.

Do not stack a rules popup on top of the welcome presentation. The welcome coordinator owns the first-visit sequence; the same rules component also opens independently from the desk and from a blocked participation action.

### D. Find rooms and choose roles

Use a short optional question such as “What are you here for?” The operator supplies the role labels and descriptions; Coding, Research, Hobby, and Artist are examples, not built-in identities.

Each option explains which rooms it opens. Selecting it saves the role immediately and shows success only after the Authority accepts it. Multiple choices are allowed. A visible pending/error state prevents a failed request from looking like access was granted. Members can skip the choices or change them later.

Room cards show a short purpose and one relevant action:

| State | What the member sees |
|---|---|
| Accessible | Room description and “Open room” |
| Requires a self-selectable community role | “Choose Artist to open this room” with the role action |
| Accessible but hidden in this person's sidebar | “Show in my sidebar” and “Open room” |
| Unavailable after a permission change | Clear unavailable state with another accessible destination |

The guide may advertise only rooms explicitly intended for discovery. Staff-only rooms, private conversations, banned-room details, and other restricted metadata must not leak through the guide. Room access still comes from server checks on reads, writes, subscriptions, and joins.

### E. Enter the community

Offer “Open [suggested room]” and “Browse rooms.” Prefer the original invite destination when access allows; otherwise use the operator's chosen starting room, then an accessible text room. Never auto-join voice or request microphone/camera access during onboarding.

If no room is accessible, stay at the desk with an honest explanation and available role/help actions. A server with no roles or no published rules skips those empty steps; blank starter layouts still have a usable desk.

“Shape my view” is an optional expandable section after the essentials, also available from the desk. It exposes existing sidebar visibility, workspace/panel choices, and the desktop server rail preference. Show how these affect the user's own view. Opening a suggested panel requires the member's action and preserves their existing layout.

## 4. Returning to Reference Desk

Clicking the server identity opens the desk directly in overview mode. Lead with “You’re on [server name],” the server icon/banner or poster, and its short introduction. This is a recognizable place to return to, with room for the community's visual character. Keep text readable over artwork and use the server's existing branding and semantic theme tokens.

The main content shows readable rules or a short excerpt with “Read all rules,” the member's selected community roles, and a channel list with descriptions and current visibility. Label the list states “On in your sidebar” and “Off in your sidebar,” rather than implying that Off revokes access. Display role-required rooms separately with their access explanation; only intentionally discoverable rooms may appear.

A clear “Edit my choices” button opens editing within this same center-stage page. It exposes self-selectable roles and personal room visibility, with an explanation that removing a role can remove access to its linked rooms. Role changes still apply immediately after server confirmation, and each control shows its pending/saved/error state. “Done” returns to the overview; it does not imply a second save or rollback of already confirmed choices. A confirmed role choice remains saved if a later visibility preference fails. An ordinary visit never toggles roles or room visibility accidentally.

The desk organizes its content into these sections:

| Section | Purpose |
|---|---|
| About | Server introduction, optional welcome poster, and “Replay welcome” |
| Rooms & roles | Selected roles and room descriptions with current on/off visibility; “Edit my choices” reveals immediate role changes and visibility controls |
| Rules | Current readable rules, acknowledgment state, and a material-change notice when needed |
| Resources & help | Operator-selected guides, links, and an existing help room or contact route |
| My view | Personal room visibility, layout entry points, and server rail preference |

Use a compact section navigation or anchors within one center-stage surface. Avoid a grid of empty dashboards. Hide unconfigured resources. For operators, label the separate administration entry “Edit server welcome” and open the existing Admin workspace, so it cannot be confused with “Edit my choices.” Do not expose nonfunctional contact buttons or invent a staffed support service.

Opening the desk records the prior location through the shared navigation mechanism. “Back to [room/workspace]” returns there with drafts and reading position preserved. Calls continue under their existing owners. If access to the prior room was revoked, fall back to an accessible room or remain at the desk with a clear explanation. Right panels and stubs keep their independent state; the desk is never required to open as a right panel.

On phones, use a full center-stage page with one scroll owner, large controls, a short section selector, and the normal back behavior. The desk remains available when the optional desktop server rail is hidden or docked on the other side.

### When to interrupt returning members

- Ordinary reconnect or server switching restores their prior location.
- A cosmetic welcome/poster edit does not replay onboarding.
- A material rules revision shows a compact notice linking to the changed rules; affected participation actions enforce acknowledgment on the server. Do not steal focus from a call or editor.
- New role options are visible at the desk; they do not create a compulsory questionnaire.
- “Replay welcome” is always an explicit member action and retains current role choices.

Store only a small per-Authority/member completion or dismissal marker to suppress repeated introductions across devices. Store it independently of rules acknowledgment and role membership. Guest dismissal is scoped to the current guest identity/session. Existing members upgrading to this feature see a discoverable desk entry rather than a mass forced welcome; do not manufacture rules acceptance for them.

## 5. Operator setup and authoring

Owner setup offers editable starter **channel layouts**: basic, project, community, or blank. Templates preview actual channel names/descriptions and let the owner edit or remove them. No template silently changes admission, logging, bans, or security policy.

Add a Welcome & Reference Desk section under **Server Branding** in the existing Admin workspace. This is the canonical entry for its introduction, artwork, background, and presentation. Link to the existing rules, role, and channel editors for their respective policies rather than duplicating their state inside branding. The operator can:

1. Edit the introduction, optional welcome artwork, and static or animated background.
2. Choose plain or poster presentation and an optional focused first visit.
3. Publish rules using the existing rules editor and material/cosmetic revision controls.
4. Define non-staff community roles and link rooms through the existing role controls.
5. Write room descriptions, choose the suggested starting room, and add resources/help links.
6. Preview as newcomer, returning member, guest, and narrow-screen visitor before publishing.

Use one draft/publish boundary for welcome content. Preview cannot mutate real membership, submit answers, or acknowledge rules. Keep unsaved drafts recoverable after a failed publish. Use revision checks for concurrent operator edits and retain the last valid publication when an update fails.

### Animated backgrounds

Offer image and short looping animation/video backgrounds for the welcome and returning desk. Preview desktop and phone crops, let the operator set a focal point, and provide a dim/contrast treatment behind readable content. The background belongs to this server surface; opening the desk does not replace the member's app-wide theme.

Serve uploaded assets through the existing server asset system. Support only formats validated by the media pipeline, with documented upload, dimension, and duration limits. Prefer muted inline video for controllable playback; animated-image inputs need a controllable conversion path or a still fallback so pausing is reliable. Publishing an animation requires a usable still image, supplied by the operator or generated during processing. Failed processing retains the draft and the previous publication.

Play without audio, and expose a small Pause background control. Honor reduced motion and the member's saved animation preference by showing the still image before animation starts. Where a data-saving preference is available, load the still image first and let the member opt into motion. Pause playback when the page/tab is hidden, release it when the desk closes, and show the still image if autoplay or decoding fails. Artwork must not intercept document links, choice controls, or pen input. Background changes are cosmetic and never replay onboarding or invalidate rules acknowledgment.

Server defaults produce a useful plain desk with no authoring required. Operators can later export/import the presentation and layout template; imported role/room references require explicit mapping on the destination server. Templates never carry member answers, role memberships, rules acknowledgments, or security policies.

## 6. Interactive posters and forms

A poster consists of artwork or readable content plus structured blocks. The first authoring tools place text, links, and role-choice controls. Members can interact with a designed “clipboard” or welcome board while the underlying controls remain ordinary accessible UI.

- Store a poster's logical size and block positions independently of screen pixels.
- Keep labels, descriptions, reading order, and button semantics as text data; do not bake essential information solely into the background image.
- Support moving/resizing blocks and keyboard/property controls for precise placement. Narrow views reflow the same choices into a readable list under the artwork.
- Bind role choices to current role IDs, room links to current room IDs, and rules controls to the canonical rules view. Validate bindings at publication and at use.
- Keep external links explicit and sanitize imported content. Arbitrary HTML/JavaScript cannot define permission-granting actions.
- Missing artwork falls back to the plain document. Removed roles/rooms produce a clear unavailable control and an operator repair notice.

**Forms are a later reuse of these blocks.** Add checkboxes, single/multiple choice, short/long text answers, and polls after the desk and poster path work. Reception role selection is an account action, not a poll vote or a stored questionnaire answer.

Before enabling form submission, implement who receives answers, whether a member can edit/withdraw them, a retention/expiry policy, and a real server receipt. Label whether poll answers identify the member and whether results are visible. A hidden voter name in the UI is not a promise that the Authority cannot identify the voter. Required general-purpose questions and approval queues are outside the first arrival release.

## 7. Reader annotations from existing drawing code

Extract the smallest useful shared stroke primitives from `whiteboard/elementTypes.ts`, `boardRenderer.ts`, and pointer-sampling logic in `WhiteboardCanvas.svelte`/`tools.ts`. Retain the existing whiteboard behavior while making the drawing core independent of board stores, layers, networking, math/code rendering, and board UI.

The first Reader annotation controls are Pen, Highlight, Text note, Erase, Undo, and Redo, with a small color/width selector. Erase initially removes a whole stroke; partial stroke cutting is optional later work. Default Reader mode still scrolls, selects text, and follows links. Entering annotation mode makes drawing intentional; touch scrolling and pen handling need explicit behavior and a visible way back to reading.

Start with imported images and fixed-layout posters. Store vector points in page/image coordinates, pressure when available, style, annotation ID, document/page identity, and source revision. Zoom and layout changes transform the overlay rather than rewriting the stored points. No marks attach to a temporary object URL or a screenshot of the viewport.

Reflowing Markdown/text needs a separate anchoring strategy: attach text highlights/notes to stable content anchors and quote context. Do not claim a freehand circle will keep surrounding the same words after font changes or pagination. Offer freehand markup on an explicit fixed-layout snapshot, or defer freehand on reflowing prose until that behavior is solved. Preserve older annotations when the source changes, label them as belonging to the older revision, and avoid silently projecting them onto unrelated content.

Personal annotations save locally, scoped by server/account and document identity. Show local save/error state and allow an explicit portable annotation export containing page dimensions, source identity/revision, and vector data. They do not silently mark up the server's original poster. Publishing an annotated copy or sharing marks requires a later explicit audience/storage flow; it must not pretend the current Reader Share/Go Live buttons are working publication.

Signing workflows, identity verification, contract records, and PDF/EPUB importer work are not prerequisites. General shared annotation sessions can be planned after local markup and document publication have real persistence and permission contracts.

## 8. Data, privacy, and compatibility

| Data | Owner and persistence contract |
|---|---|
| Welcome/desk content and poster | Authority-owned publication with schema version, revision checks, asset lifecycle, and backup/recovery coverage |
| Rules and acknowledgment | Existing canonical Authority policy; only an explicit acknowledgment changes the member's accepted revision |
| Community role membership | Existing Authority record; self-selection limited to configured community roles |
| Introduction completion | Minimal member marker on this Authority; no page-view/click chronology |
| Sidebar and layout choices | Existing personal preference stores with their actual device/account scope; no new parallel layout store |
| Personal Reader marks | Local document/account scope until explicit export or a future sharing action |
| Future form/poll responses | Separate submission data with disclosed audience, retention, edit/delete behavior, and permissions |

The welcome flow explains Live, timed, and retained rooms using actual room policy. It links to fuller privacy details and explains that an explicit report can preserve selected content. It does not label ephemeral content confidential or turn universal logging on to support moderation.

Use the existing Server Center policy persistence pattern for bounded welcome configuration where appropriate; keep binary artwork in the established asset system. Record any added sidecar or aggregate in backup/recovery documentation. New durable WabiDB events need registered projections, restart/replay evidence, and versioned compatibility. Do not change Postcard record layout or remove/reorder a ChannelKind variant casually.

All asynchronous work captures server, account, and session generation before awaiting. Cancel/retire requests when that ownership changes; compare-and-set membership or another explicit conflict mechanism prevents two tabs from silently overwriting each other's role choices. Never replay queued role grants or acknowledgments as another account. Completion markers do not authorize content access.

### Existing Reception channels

Stop creating a mandatory Reception channel for new servers once the desk is available independently. Preserve existing Reception records and links. Initially render them as an entry to the same desk content; do not silently delete, renumber, or repurpose stored channels. If operators later hide/archive that channel through existing controls, Reference Desk still works. This changes the planned UX ownership without rewriting historical channel data.

## 9. Implementation sequence and completion criteria

Each phase needs a reviewable working result and an updated status record. Later Reader/form work must not block completion of the member arrival path.

| Phase | Deliverable | Completion criteria |
|---|---|---|
| 1. Permanent desk | Evolve Server Hub into the “You’re on [server]” overview; selected roles, room on/off summary, rules/help, Edit my choices, and previous-location return | Implemented in worktree with a return action, help/resource link, and desktop/mobile browser checks; broader draft/layout restoration still needs acceptance |
| 2. First arrival | Welcome → rules → optional role choices → destination; completion marker; returning-member change notices | New/existing/guest behavior is deliberate; deep-link destinations survive; skipping optional steps never bypasses server gates |
| 3. Operator authoring | Welcome editor under Server Branding, static/animated background, preview/publish, links to policy editors, starting room, resources, and editable layout templates | Welcome text, link, starting room, moving/still artwork, poster placement, and focused view are implemented in worktree; guest/narrow previews and asset processing remain open |
| 4. Poster presentation | Artwork plus placeable text/link/role controls; plain/narrow fallback; focus option | Poster and ordinary list perform identical actions; keyboard, image failure, zoom, and small-screen use work |
| 5. Reader annotation foundation | Shared vector primitive extraction; local image/poster marks, notes, eraser, undo, save/export | Whiteboard behavior preserved; marks remain anchored across zoom/reload; account isolation and failed-save recovery work |
| 6. Optional form expansion | Text answers, polls, submission storage, audience/retention controls | Real receipts, permission checks, response lifecycle, and truthful privacy labels before publication |

Phase 1 should begin with the existing server-hub navigation and preserve its useful member/settings links. Do not duplicate Reception's requests and local state across two components; move shared data/actions behind one scoped interface. Use Svelte 5 runes and semantic theme tokens for the new UI.

Primary source map:

- `frontend/src/lib/components/ServerHub.svelte`, `ChannelSidebar.svelte`, `MainLayout.svelte`: server entry and center-stage ownership.
- `frontend/src/lib/workspaceNavigationState.ts` and related shared navigation helpers: return/restore behavior.
- `frontend/src/lib/components/ReceptionBoard.svelte`, `CommunityRulesNotice.svelte`, `communityRulesUi.ts`: reusable arrival content and rules flow.
- `frontend/src/lib/components/admin/CommunityRolesPanel.svelte`, `CommunityRulesPanel.svelte`: existing policy editing.
- `core/crates/wabi-server/src/api/server_center.rs`, `channel_access.rs`: canonical role/rules state and enforcement.
- `frontend/src/lib/components/ReaderTabImpl.svelte`, `ReaderDocumentWorkbench.svelte`, `readerWorkspace.ts`, `readerDocuments.ts`, `readerLibrary.ts`: Reader rendering, source identity, local storage, and publication limits.
- `frontend/src/lib/whiteboard/` and `components/WhiteboardCanvas.svelte`: stroke primitive extraction.

## 10. Acceptance plan

Run focused checks for changed behavior, then real browser acceptance with disposable Authority data. Compilation alone cannot validate placement, input, media continuity, or mobile navigation.

- **Entry:** fresh member, returning member, old account upgrading, guest, closed/invite/raid admission, room invite, no rules, no roles, no accessible rooms, and artwork failure.
- **Return:** desktop and phone, hidden/right-docked server rail, browser back, Escape from focus, Reader/DM draft restoration, an active call, and independent right panels.
- **Overview/edit:** reopening the hub shows confirmed choices; on/off labels reflect sidebar visibility rather than access; Edit my choices and Edit server welcome have distinct destinations; Done retains confirmed changes and failed controls remain truthful.
- **Rules:** required and optional acknowledgment, failed save, exact revision race, material versus cosmetic change, second device, and blocked writes over both HTTP and sockets. Reading/help/reporting remain possible where authorized.
- **Roles:** immediate assignment/removal, invalid/staff role injection, removed role definition, concurrent tabs, account/server switch during a request, failed persistence, reconnect, restart, and subscription eviction after permission loss.
- **Privacy:** correct room labels; no automatic evidence hold, answer collection, or content logging; personal annotation data does not cross account/server scopes.
- **Authoring:** draft/published distinction, stale revision, preview isolation, missing/deleted asset, imported references, interrupted upload, restore of the policy plus artwork.
- **Poster accessibility:** logical tab order, screen-reader labels, high zoom, keyboard placement, reduced motion, narrow fallback, and essential text readable without the image.
- **Animated branding:** muted playback, pause/resume, reduced motion on first paint, still fallback, autoplay/decode failure, hidden-tab suspension, cleanup on navigation, readable contrast, mobile crop, and constrained asset sizes.
- **Annotations:** mouse, touch, stylus pressure, pointer cancel, scroll versus draw, resizing/zoom, horizontal/vertical reading, reload/export, source revision change, quota/error recovery, and whiteboard regression coverage.

For implementation, follow the repository-pinned build/toolchain and meaningful focused regression tests. Record implemented, build-checked, browser-accepted, merged, and deployed separately. Update PROJECT_STATUS and operator/privacy docs only when behavior and its limits actually change.

## 11. Review points resolved by recommendation

The recommended starting design is: existing server-name entry → Reference Desk; embedded welcome by default with an optional focused presentation; optional immediate community roles; existing members keep their place; personal annotations begin on fixed-layout content. These are concrete defaults so implementation can proceed without a second planning round. General forms, shared annotation transport, and any signature-specific add-on remain later work with their own persistence requirements.
