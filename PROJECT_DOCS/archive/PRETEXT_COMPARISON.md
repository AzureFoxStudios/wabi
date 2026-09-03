# Pretext Comparison For Wabi

Date: 2026-03-29

This note compares the local `pretext-main` snapshot from Downloads against Wabi and answers the practical question: could this help Wabi, including the main chat?

## Bottom Line

Pretext is not a memory system, retrieval layer, vector database, or semantic chat context engine.

It is a client-side text layout engine. Its value is that it can:

- measure multiline text without DOM reflow
- return exact line breaks and heights for plain text
- support custom layouts that CSS and normal DOM flow do badly

That makes it potentially useful for Wabi's rendering layer, especially note-like or virtualized text surfaces. It does not overlap with Wabi's message/state storage model.

## What Pretext Actually Is

From the inspected source and docs, Pretext is built around a two-phase model:

- `prepare(text, font, options?)`: one-time analysis and measurement
- `layout(prepared, maxWidth, lineHeight)`: cheap arithmetic-only relayout

It also exposes richer APIs:

- `prepareWithSegments()`
- `layoutWithLines()`
- `walkLineRanges()`
- `layoutNextLine()`

Those richer APIs are the interesting part for Wabi, because they enable:

- exact text height prediction before rendering
- custom line-by-line rendering
- shrink-wrapped multiline text bubbles/cards
- flowing text around obstacles or across columns

The library is strong on multilingual layout. The checked-in logic and tests cover:

- CJK
- Thai
- Khmer
- Myanmar
- Arabic
- Urdu
- mixed bidi
- emoji
- `pre-wrap` behavior with spaces, tabs, and hard breaks

## What Pretext Is Not

Pretext does not provide:

- semantic memory
- embeddings
- retrieval
- conversation summarization
- server-side message indexing
- chat history persistence

So if the original intuition was "DOM-loaded text memory", the "text" part is right and the "memory" part is misleading. It is about text measurement and layout, not knowledge retention.

## Relevant Verified Findings

I verified the local snapshot directly:

- `bun test` passed: `60` tests, `0` failures
- `bun run check` passed after `bun install`
- `bun run package-smoke-test` failed on Windows because the package `prepack` script uses Unix `rm -rf`

That means the library logic looks healthy, but the repo's packaging scripts are still Unix-biased for Windows contributors.

## The Useful Technical Properties

Pretext has several properties that are genuinely interesting for Wabi:

### 1. It avoids DOM measurement in the hot path

The central design is: pay once during `prepare()`, then relayout cheaply during resize or width changes.

The checked-in benchmark snapshot reports roughly:

- Chrome: `prepare()` about `18.85ms`, `layout()` about `0.09ms` for the shared 500-text batch
- Chrome DOM batch: `4.05ms`
- Chrome DOM interleaved: `43.50ms`
- Safari DOM interleaved: `149.00ms`

The important takeaway is not "Pretext is always faster than the DOM". The real takeaway is:

- it wins when many text blocks would otherwise be measured repeatedly
- it wins more when reads and writes interleave and force layout thrash
- it shines on resize-driven relayout and custom text geometry

### 2. It exposes line geometry, not just height

This is the real differentiator. Wabi could use it not only to know a paragraph height, but to:

- precompute exact message bubble widths/heights
- flow text around avatars or overlays
- make custom note cards or annotation systems
- build precise virtualization later

### 3. It supports `pre-wrap`

This matters for chat-like and note-like inputs because it can preserve:

- ordinary spaces
- tabs
- hard line breaks

That makes it more relevant to Wabi than a normal paragraph-only layout helper.

### 4. It has no runtime dependency chain

The package has no runtime dependencies. For Wabi, that lowers adoption risk.

## Comparison To Wabi Today

### Concrete Wabi Touchpoints

The comparison above is based mainly on these current Wabi surfaces:

- `frontend/src/lib/components/MessageList.svelte`
  - current message render window, history loading behavior, and dynamic font styling
- `frontend/src/lib/components/Chat.svelte`
  - composer auto-resize via `textarea.scrollHeight`
- `frontend/src/lib/socket-manager.ts`
  - frontend message arrays and history-loading stores
- `backend/src/server.ts`
  - backend in-memory message maps and channel history preload paths
- `frontend/src/lib/notesStore.ts`
  - local note persistence
- `frontend/src/lib/components/NotesWorkspace.svelte`
  - plain-text notes editing surface
- `frontend/src/app.css`
  - default font stack

### 1. Wabi already has message/state storage. Pretext does not compete with that.

Wabi's frontend keeps message arrays in `channelMessages`, and the backend also maintains in-memory channel message maps with history loading and persistence paths. Pretext is orthogonal to that. It would sit in the UI layer, not the state plane.

So the comparison is:

- Wabi: stores and transports conversation state
- Pretext: predicts how text will lay out on screen

### 2. Wabi main chat is DOM-driven, but not currently doing full variable-height virtualization

Wabi's main message list currently uses a coarse render window and history pagination instead of exact text-height virtualization.

Observed behavior:

- `MessageList.svelte` renders a window of `120` messages by default
- it grows to `360`
- older content is loaded with explicit pagination and top-scroll history loading

That means Wabi is already limiting DOM pressure in a simple way. It is not currently doing the kind of "measure 500 message heights every frame" workload that Pretext is built to solve.

Practical consequence:

- dropping Pretext into main chat today would not automatically produce a big speed-up
- the current chat architecture would need a more invasive redesign to fully benefit

### 3. Wabi composer and notes are still native textarea/localStorage flows

Current relevant surfaces:

- main chat composer auto-resizes from `textarea.scrollHeight`
- Keep Notes / DM notes are stored in `localStorage`
- notes editing is still a normal `<textarea>`

Pretext could replace some textarea height prediction logic, but that is not where the big payoff is.

### 4. Wabi's typography is dynamic, which makes exact measurement harder

Wabi uses:

- a system-style app font stack by default
- chat font scaling
- uniform font overrides
- per-user username font overrides

Pretext requires the JS font string and CSS typography to stay in sync. It also documents `system-ui`-style font resolution as unsafe on macOS for perfect accuracy.

That means a Wabi integration would need a careful font-resolution utility and a cache policy, not just a direct import.

## Where Pretext Could Help Wabi

### High-confidence fit

#### 1. Notes, drafts, plain-text cards, and preview lists

This is the best first target.

Why:

- text-heavy
- relatively plain compared with chat rows
- local and client-only already
- useful if Wabi wants denser note previews, masonry note boards, or exact preview heights

#### 2. Future exact-height virtualization for text-only or mostly-text feeds

If Wabi later wants:

- much deeper channel history in one scrolling surface
- exact scroll anchoring
- zero-jump virtualization

then Pretext becomes much more compelling.

This is especially true if Wabi wants to keep rich multilingual support without guessing row heights.

#### 3. Plugin and business surfaces

Pretext is especially good for nonstandard layout work. Wabi already has plugin/business surfaces where this could matter more than chat:

- dashboards
- task cards
- annotations
- map labels
- floating note widgets
- editorial or poster-like pages

This matches Pretext's richer manual-line APIs much better than a standard chat DOM tree does.

#### 4. Message bubble shrink-wrap experiments

If Wabi ever moves toward tighter bubble sizing, compact layouts, or custom line-balanced message cards, Pretext could help compute:

- best-fit bubble widths
- balanced multiline widths
- stable pre-render heights

### Medium-confidence fit

#### 5. Main chat, but only as a scoped subsystem

It could help the main chat if Wabi decides to build:

- exact text height caches for plain text messages
- future virtualization
- custom canvas/SVG/absolute-position text rendering

But that is a real architecture project, not a drop-in package win.

## Where Pretext Does Not Fit Wabi Well

### 1. It will not solve "memory" for the chat model

No semantic recall, no indexing, no embeddings, no retrieval.

### 2. It does not solve rich message row height by itself

Wabi messages can include more than text:

- markdown
- file attachments
- embeds
- reactions
- pinned state
- edit state
- translation UI
- plugin surfaces

Pretext only solves the text portion. A real chat-row measurement system would still need additional height accounting around all non-text UI.

### 3. It is not backend-ready today

The source still expects `OffscreenCanvas` or a DOM canvas context. So this is a frontend/webview library today, not a backend service for message preprocessing.

### 4. The repo tooling is not fully Windows-friendly

The core code ran fine here, but packaging scripts still assume Unix tools like `rm`.

## Recommendation

Do not treat Pretext as a candidate replacement for Wabi's state, history, or "memory" systems.

Do treat it as a strong candidate for a targeted rendering spike.

Best adoption order:

1. Prototype it in a plain-text Wabi surface first.
2. Build a tiny Wabi wrapper that derives exact `font` and `lineHeight` values from current theme/font settings.
3. Use that wrapper for note previews or another text-heavy card surface.
4. Only evaluate main-chat integration after proving value in a smaller surface.

## Best First Experiment

If I were choosing one spike, I would start here:

- build a small `frontend/src/lib/textLayout/` wrapper around Pretext
- feed it Wabi note text plus current font settings
- use it to precompute exact preview heights for note cards or a denser notes list

Why this first:

- low risk
- plain text
- no need to solve attachments/embeds/reactions
- immediately tests whether font sync and cache behavior are manageable inside Wabi

## Main Chat Verdict

Could Pretext be used for the main chat?

Yes, but only in a limited and deliberate way.

Reasonable interpretation:

- useful for future exact text measurement inside chat
- useful for virtualization work if Wabi outgrows the current `120 -> 360` render-window approach
- useful for custom message bubble layout experiments

Unreasonable interpretation:

- it is not a drop-in "make the chat smarter" or "give Wabi memory" package
- it is not the first thing I would wire into today's message list

## Final Assessment

Pretext is legitimately strong and unusually useful.

For Wabi, it is best understood as:

- not a memory engine
- not a storage engine
- not a backend feature
- a high-quality frontend text-layout primitive

That makes it worth keeping on the radar, but the right entry point is notes/cards/custom layouts first, not a direct main-chat replacement.
