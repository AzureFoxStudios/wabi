# Roofing / Boiler-Insulation Business Deployment (Thailand)

**Date:** 2026-11-23
**Status:** Working plan. Nothing in the "To build" sections exists yet.
**Direction change:** Wabi is being fitted to one real business (a Thai roofing and boiler-insulation company) instead of being published for the public. That can be a set of curated addons on this repo or a private fork; the addon route keeps both options open.

Builds on, and does not replace:

- [`../proposals/business-ops-adaptation-roofing-thailand.md`](../proposals/business-ops-adaptation-roofing-thailand.md) – product framing (Wabi is the coordination layer, not the accounting system).
- [`../features/PLUGIN_SPEC_CAMERAS_AND_3D.md`](../features/PLUGIN_SPEC_CAMERAS_AND_3D.md) – camera plugin design (Part 1).
- [`../ADDONS.md`](../ADDONS.md) – extension levels. These integrations are **curated addons** in `core/addons/`, not runtime plugins (plugin sandboxing is not enforced).

## 1. Done so far

| Item | State |
|---|---|
| Wabi rebuilt on the live host with Docs, Sheets and Present (`WABI_WORKSPACE_ADDONS=all`) | Deployed |
| Sheets import keeps cell fills, number formats and column widths | Deployed |
| Sheets text color and true conditional formatting (14 conditions, up to 50 rules per sheet, shared, display-only) | Deployed; **uncommitted** in the shared checkout on `fix/server-rail-i18n` |
| Starter workbook for the business (`~/Documents/wabi-business-workbook/business-starter.xlsx`) | Built; validated with Wabi's own formula engine |

Known Sheets gaps: conditional rules are not exported to xlsx; text color, bold and borders are not imported from xlsx (SheetJS CE does not expose fonts); data-validation dropdowns are not imported; dark fills are dropped on import because text color cannot be set on them.

## 2. CCTV (Hikvision NVR)

**Goal:** view the cameras in Wabi, decoded on the GPU instead of the CPU, so the business PC can leave Windows 10 for Linux. iVMS-4200 stays the vendor's client; Wabi does not replace its recording.

### Facts that shape the design

- Hikvision NVRs serve standard RTSP: `rtsp://user:pass@NVR_IP:554/Streaming/channels/101` (channel 1 main stream; `102` is its sub-stream; channel 2 is `201`/`202`, and so on).
- ISAPI gives still snapshots (`/ISAPI/Streaming/channels/101/picture`) and device lists (`/ISAPI/System/Video/inputs`). It is not a video transport.
- NVR stream encryption can block third-party RTSP; it must be off or its key supplied.
- Browsers cannot play RTSP, and H.265 support is uneven. H.264 decodes in hardware everywhere.

### CGNAT

Thailand ISPs commonly use CGNAT, so the office has no reachable public IP. This does not matter for the main case: the viewing PC and the NVR share the office LAN. It only matters for remote viewing, and the answer there is a Tailscale node at the office (outbound connections, works through CGNAT). Nothing has to go through the main Wabi host, and no port forwarding or cloud relay is needed. Hik-Connect also works through CGNAT but puts the feeds on Hikvision's servers; not recommended.

### Delivery paths (both, in this order)

1. **Desktop app (preferred, per the existing spec):** native RTSP in the Tauri app, hardware decode (NVDEC/VAAPI), lowest latency, no relay.
2. **Browser fallback:** a relay on the office LAN (go2rtc or MediaMTX, one binary, passthrough with no re-encode) turns RTSP into WebRTC/HLS. The browser decodes on the GPU. Grid view uses the H.264 sub-stream; full-screen uses the main stream.

### To build

- `core/addons/` camera addon: NVR config (admin only, credentials stored server-side and never sent to normal users), camera list, grid and full-screen view, snapshots, online/offline status, role-gated per branch.
- Camera-offline and motion events into a protected `#security` channel (as in the existing spec).
- Test against a fake RTSP source before any real NVR; one real-hardware round on site.

### Open questions

- NVR model, address, codec (H.264 or H.265), and whether stream encryption is on.
- Is the viewing PC on the same LAN as the NVR?
- GPU in the business PC. The existing camera spec assumes a GTX 1080, but that spec was written for a different business (architecture); **do not assume it is this machine's GPU.**

## 3. Forthtrack GPS

**Goal:** live vehicle map and a fleet panel on a Wabi dashboard, as far as the data allows.

- A web search found **no public API documentation** for Forthtrack. The console is a single-page web app, so it calls a backend.
- **Preferred route:** the business asks Forthtrack support for API access or an export (key or token, endpoints, rate limits, terms).
- **Fallback:** while the business owner is logged in to the console, inspect the requests the console itself makes and call the same endpoints with her token. This is brittle (can break on any console update), may be against Forthtrack's terms, and the token must be treated as a password. Do not do this without her say-so.
- Either way, the addon design is the same: server-side poller holding the credential, normalized `{vehicle, position, speed, ignition, timestamp}` records, a map panel, and stale-data labelling ("last seen …"). A position is the tracker's report, not proof of anything; follow the wording rules in [`2026-09-27-field-coordination-addon.md`](2026-09-27-field-coordination-addon.md).
- Vehicle location of staff is workplace monitoring. Show it role-gated, and tell staff that it is active (see the cautions in the business-ops proposal).

## 4. Approvals

The business-ops proposal lists "document approval workflows" as an addon. Recommendation: **split it.** Base owns a small generic approval primitive that other addons plug into; business meaning (limits, routing) stays in addons.

### Two shapes it must serve

1. **Ask and answer:** "Spend 4,200 THB on the new inventory shipment?" The decision is recorded and the requesting addon acts on it.
2. **Access gate:** "USERB wants to edit '2026 tax form Zebra'." Approval has to *unlock* something, so it creates a **grant**: scoped to the one subject, to the requester, to an action, and either single-use or expiring (default: expires). The feature that owns the resource (here, the workspace code) checks for a live grant server-side at the mutation boundary. The approvals module only records decisions and grants; it never enforces access on another feature's behalf.

### How other addons tap in

Addon crates under `core/addons/*/backend` are libraries that `wabi-server` depends on, so they cannot call into the server. The module therefore lives in `wabi-server` (`api/approvals.rs`, mounted in `api/routes.rs`), and addons reach it two ways:

- **In-process (server-side glue):** `approvals::request(...)` and `approvals::grant_for(...)`, called by the server code that wires an addon in.
- **HTTP/socket:** a route for frontend or runtime-plugin callers, with the same validation.

A request carries:

| Field | Rule |
|---|---|
| `kind` | Namespaced by the addon, for example `inventory.purchase`, `workspace.edit`. Registered by the addon so the card knows its label. |
| `subject` | Reference to the thing concerned (message, file, workspace doc, job). |
| `title` | Plain text, length-bounded. Never rendered as markup. |
| `payload` | Structured and **immutable**. Money is currency plus minor units, never a display string. A changed amount is a **new request**, not an edit. The decision stores a hash of the payload. |
| `approvers` | Existing role names (`owner`, `admin`, `mod`, `member`, `guest`; lower-case, as in [`../architecture/POLICY_SYSTEM.md`](../architecture/POLICY_SYSTEM.md)) or named users, plus how many must agree. |
| `idempotency_key` | So an addon retry cannot create duplicates. |
| `expires_at` | Pending requests lapse; grants expire. |

The **requester is always the authenticated caller**; an addon supplies only the `kind`. Decisions are checked server-side, are immutable once made, forbid self-approval by default, and bots do not approve unless explicitly allowed. A change of requester, approver or amount is never silently accepted.

### What base ships

- The primitive (store, state machine, grants).
- One generic **Approve / Reject card** and one socket event, so an addon ships no UI of its own to take part.
- Its own decision log: who asked, who decided, when, the payload hash. **Correction to an earlier statement:** the repo has a WabiDB audit projection, but the admin code describes it as "deliberately not a comprehensive moderation log", so approvals must not assume a general audit trail already exists.
- No business meaning: no amounts policy, suppliers or thresholds.

### Addons built on it

- **Inventory/purchasing:** "Spend 4,200 THB?" with its own thresholds (for example, over a set amount needs the owner).
- **Workspaces (Docs, Sheets, Present):** edit-access requests; the first real consumer, since the grant check belongs in code that already exists.
- Quote discount sign-off, expense claims.

### Build notes

- Storage: follow the existing WabiDB command, event and projection path rather than a JSON sidecar, because decisions are records the business may need later.
- Ship the primitive with **one real consumer** (workspace edit request) to prove the interface; the spend example has no home addon yet.
- Do the work on its own branch or worktree, not on top of the uncommitted Sheets changes in the shared checkout.

## 5. Suggested order

1. Commit the Sheets work (needs the owner's go-ahead; shared checkout, noreply commit email).
2. Camera addon against a fake RTSP source.
3. Approvals primitive in base.
4. One on-site test round for cameras; add the Tailscale node for remote viewing.
5. Forthtrack, once API access or an explicit go-ahead for the fallback exists.
6. Odoo/dashboard work from the business-ops proposal, if the business uses Odoo.
