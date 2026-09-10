# Reader long-form redesign — 2026-09-10

## Intent

Implement the approved Reader mockups as a working long-form reading workspace. Keep Wabi's surrounding server/channel shell unchanged. The reading surface must not inherit chat colors or chat-message height limits.

## Implementation

- Full-height flex layout with one text scroll owner. Opaque paper, sepia, and night surfaces use Reader-local color tokens. Removed the chat `markdown-content` class and invalid Svelte `:global(...)` selectors from the plain CSS sheet.
- Editorial typography, comfortable 54/66/78ch widths, user-controlled font size/line height/typeface, responsive dark toolbar, progress and navigation footer.
- Continuous reading and real horizontally reflowed CSS-column pages. Text remains selectable; page count comes from actual scroll geometry rather than an estimated screen count.
- Document-local literal search, including phrases split by inline emphasis. Highlighting operates on text nodes, not HTML string replacement. Results are capped at 1,000 to bound work; the document itself is never truncated.
- Contents uses real headings only. Plain text without headings has an honest empty-outline state.
- Local bookmarks and notes link to block-anchored positions. Reopening the same document restores the passage. Font/layout/dock changes preserve the anchor. Storage failures are shown rather than falsely claiming persistence.
- Reader home has working file/paste/image actions and real recent documents, not fictional sample content. Recent document content remains session-only; local files are not uploaded.
- Existing image collections remain available with horizontal or vertical reading, width/height/original-size controls, navigation, and an accessible native-dialog viewer. The FileList is consumed before clearing the input.
- Focus mode, scoped Ctrl/Cmd+F, Page Up/Down, Home/End, and Escape. Import uses a native modal dialog and Svelte 5 bindable props.
- A separate Marked instance renders document Markdown rather than invoking chat parsing. DOMPurify sanitizes HTML and Markdown and strips source styling/classes that could compromise the reading surface. Reader links open safely and code-copy buttons exclude their own UI text.

## Supported formats and honest limits

Text, Markdown, HTML, and the existing image formats are supported. This change does not introduce PDF or EPUB parsing, OCR, server-side document storage, cross-device annotation sync, or collections. The UI must not advertise those as working imports. File imports have a 20 MB text limit with an explicit error; no silent truncation.

## Verification

- `cd frontend && bun test src/lib/components/readerDocumentTools.test.ts`
- `cd frontend && bun run check`
- `cd frontend && npm run build:static`
- `cd frontend && npx playwright install --with-deps chromium`
- `cd frontend && xvfb-run -a node scripts/reader-browser-smoke.mjs`

The browser smoke mounts the actual production Reader, CSS, parser, preferences, and annotation store. Only the outer tab queue is stubbed; it never contacts a Wabi server. It exercises a 100k+ word fixture, search across inline elements, sanitization, note/bookmark persistence, position restoration, real pagination, final-paragraph reachability, font changes, focus shortcuts, 390/320px docks, image import, and modal Escape handling. It intentionally uses a headful browser under Xvfb because of the repository's documented headless Skia issue.

`Reader checks` runs this suite on relevant pull requests and uploads actual browser screenshots/results for seven days. Test artifacts are written under the operating-system temp directory, not into the repository. See the PR checks for execution results; adding a test is not equivalent to a passing run.

Production deployment is separate from committing or merging the Reader changes. No database, authentication, call transport, deployment configuration, or unrelated workspace behavior is changed here.
