# Card V1 — Calling UX polish (frontend) — Report

## Status: DONE

## Files changed

1. `frontend/src/lib/components/CallControls.svelte` — Added visible text labels to all primary control buttons (Mute, Deafen, Camera, Share, Annotate, Capture, Whiteboard, Record, End Call). Changed button shape from circular icon-only to pill-shaped with icon + text. Added hover states, improved `title` attributes, added responsive mobile behavior (labels hidden on <640px). Updated CSS to use design tokens consistently.

2. `frontend/src/lib/components/CallView.svelte` — Added visible text labels to all control bar buttons (Mute, Deafen, Camera, Stop Share, End Call). Replaced bare icon-only circular buttons with labeled pill-shaped buttons. Improved `title` attributes. Updated inline `<style>` to match the new layout.

3. `frontend/src/styles/components/call-view.css` — Replaced circular icon-only `.control-btn` styles with pill-shaped labeled button styles. Added `.control-btn-label` class. Added hover states, active states using accent tokens. Added responsive mobile behavior (labels hidden on <768px).

4. `frontend/src/lib/components/CallModal.svelte` — Added text label to the docked bar "End" button (previously icon-only). Improved `title` attributes on docked bar buttons (e.g., "Unmute microphone" instead of "Unmute").

5. `frontend/src/styles/components/call-modal-part1.css` — Updated `.dock-btn.end` from fixed 30x30px circle to flexible pill shape with gap spacing. Added `.dock-btn-label` class with responsive mobile behavior.

## What was fixed

### Before
- All call control buttons were bare icon-only circles (40px/48px) with only `title` attributes for labeling
- No visible text labels on mute, camera, screenshare, end call, record buttons
- Inconsistent button shapes (circular in CallView, pill in CallControls)
- Bare browser-default appearance on some buttons
- No hover states on most buttons

### After
- All primary control buttons now have visible text labels alongside icons
- Consistent pill-shaped button design across CallControls and CallView
- Proper hover states with `transform: translateY(-1px)` and background changes
- Active states use accent color tokens
- Responsive: text labels hidden on mobile (<640px in CallControls, <768px in CallView) to save space
- End call button clearly labeled with red danger styling
- Record button clearly labeled with recording status states
- Screenshare button toggles between "Share" and "Stop" labels

## Verification

- `npx svelte-check --output machine`: 0 errors in changed files (1 pre-existing error in GalleryChannel.svelte is unrelated)
- `npx vite build --mode production`: Build succeeds

## What remains for true screenshare/spatial/recording

These are backend/protocol features outside the scope of this card:

1. **True screenshare**: The UI toggle exists and is labeled, but the actual screen sharing protocol (WebRTC getDisplayMedia + SFU forwarding) is in `callingScreenShare.ts` and the backend media server. Not touched.

2. **Spatial audio**: The spatial audio runtime and engine are in `callingSpatialRuntime.ts` and `audio/spatialEngine.ts`. The debug overlay toggle in CallView works but the actual spatial positioning requires the audio engine. Not touched.

3. **Call recording**: The recording UI is labeled and functional, but the actual recording capture (MediaRecorder API + audio mixing) is in `callRecording.ts` and `callRecordingPresence.ts`. The recording icon visibility toggle (per-user local setting) needs to be wired in settings. Not touched.

4. **SFU/WebRTC protocol**: Not modified. The transport layer (`callingTransport.ts`, `callingStorefwd.ts`) was left untouched.
