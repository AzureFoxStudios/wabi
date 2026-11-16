# Office UX parity plan: Sheets, Documents, Present

Status: partly built. The tables in sections 2 to 5 are the **audit as it stood at the start** and are kept as the record of what was missing. Section 10 says what has since been done, how each piece was verified, and what is left. Read section 10 first for the current state.
Audit date: 2026-11-16, against `main` plus `fix/server-rail-i18n` (4f5a68b5).
Goal (Ronin): someone who brings Office into Wabi should feel at home. Clicks and keyboard behave the way Excel, Word and PowerPoint taught them, and "where is my file?" has one clear answer.

## 0. How to read this

Every row says what people expect, what Wabi does today (HAVE / PARTIAL / MISSING / DIFFERENT BY DESIGN), where in the code, and a tier.

- **T1** — people notice within a minute and call the tool half-baked. Do first.
- **T2** — daily-use polish. Do next.
- **T3** — power-user or "nice". Only after the above.

Sizes: S under a day, M a few days, L a week or more. They are estimates, not commitments.

Reference shortcuts come from Microsoft's own pages (see section 7 for what was and was not verifiable). Key combos are Windows; `Mod` means Ctrl on Windows/Linux and Cmd on Mac.

## 1. Decisions needed before building

These change the shape of the work. Recommendations are marked.

| # | Decision | Why it matters | Recommendation |
|---|---|---|---|
| D1 | Rebuild the Sheets edit state machine around an **in-cell editor** (modes: ready, enter, edit, point). | Today cells are edited only in the formula bar (`SheetsGrid.svelte:323`); typing in a cell moves focus there, and clicking another cell commits (`choose()` calls `commit()`, line ~110). Click-to-insert references, Enter/Tab commit-and-move, F2, and `=` autocomplete all depend on this. | **Yes.** It is the single biggest item; everything in Sheets T1 sits behind it. |
| D2 | Sheets clipboard model. Copy is deliberately values-only with leading `=+@-` escaped (`SheetsGrid.svelte` `copy()`), and paste inserts text as typed. | Excel copies formulas and shifts relative references on paste. The current design protects other apps from formula injection. | Add an in-app clipboard (custom MIME carrying formulas) while `text/plain` stays values-only and escaped. Keeps the safety, gains Excel behavior. |
| D3 | Documents: stay **Markdown with live preview** and add Word-style shortcuts, or go WYSIWYG. | Underline, font, size, colour, alignment, line spacing and real tables do not exist in Markdown. A WYSIWYG model changes the stored format (Yjs text) and is a rewrite. | Stay Markdown. Tell users plainly that Documents is a Markdown editor with Word's keys. Revisit WYSIWYG only as its own project. |
| D4 | `.docx` import/export, and editable `.pptx` import. | Documents accepts `.txt .md .html` only. PPTX/ODP import needs an optional LibreOffice sidecar and yields **static PDF page images**, not editable slides (`present/files.ts`, `workspace_conversion.rs`). | Decide whether "bring Office in" means *open and edit* or *view and convert*. Real DOCX/PPTX round-trip is a large separate item (L+). |
| D5 | Formula function set. 15 today. | Excel users reach for IFERROR, VLOOKUP/XLOOKUP, TEXT, LEFT/RIGHT/MID, TODAY and friends within minutes. | Target a core set of roughly 60 (list in section 3.3). Not Excel's full catalogue. |
| D6 | Desktop (Tauri) native file open/save. | The web build can only keep files in the browser. The desktop app could open and save real files, which answers "where is the file" most directly. | Decide whether the desktop app gets File > Open / Save As on top of the library. |
| D7 | Shortcut conflicts. Wabi Documents binds `Mod-e` to inline code and `Mod-Shift-k` to link; Word uses Ctrl+E for centre and Ctrl+K for link (Ctrl+Shift+K is small caps). | Muscle memory collides. | Adopt Word's keys where the meaning exists in Markdown (link on `Mod-k`); move code to another key. |

## 2. Cross-cutting work (all three tools)

### 2.1 "Where is the file?"

What is true today (verified in `session.ts`):
- A **private** document lives in this browser's IndexedDB (`wabi-workspace-artifacts-v1`), capped at 12 MB per artifact. Other devices cannot open it; clearing site data deletes it.
- A **shared** document is on the server and is readable by the server operator.
- Backup is `Backup (.wabi.json)` under ⋯ > Export.

Done: the private-file chip's tooltip now says this (commit 4f5a68b5). **That is not enough.** The tooltip is hover-only, and below 760px the chip collapses to a dot.

Still to do:
- **T1 (M)** A visible, always-readable location and save state in the header: "On this device only · Saved" / "Shared on this server · Saved". No hover required, readable at phone width.
- **T1 (S)** `Mod-S` does something honest everywhere: confirm "Saved on this device" and offer Backup, instead of the browser's Save Page dialog.
- **T1 (S)** Put "Download a copy" in the primary UI, not only under ⋯.
- **T2 (S)** Ask the browser for persistent storage (`navigator.storage.persist()`) so private files are less likely to be evicted, and say if it is denied.
- **T2 (S)** The library line "Private on this device until you share" should say "this browser" (three locales).
- **T3 (L)** Desktop native open/save, if D6 says yes.

### 2.2 Undo and redo

`Ctrl+Z` is **not bound** in Sheets or Present. The ⋯ menu shows "Ctrl Z" / "Ctrl Shift Z" (`ArtifactShell.svelte:283-284`), but `shortcut` on menu entries is display-only text (`ContextMenu.svelte`), and no global handler takes it; a repo-wide search found Ctrl+Z only in the whiteboard. Documents works only because CodeMirror's `yUndoManagerKeymap` is installed (`CollaborativeText.svelte:71`).
- **T1 (S)** One shell-level binding using `session.undo`, scoped to the focused editor so it never fights CodeMirror or an `<input>`'s own undo. Also bind `Mod-Y` and `Mod-Shift-Z`.

### 2.3 One shortcut registry

- **T2 (M)** A single typed table of shortcuts per tool, as pure TypeScript with tests. It feeds the handlers, the menu hints (so labels cannot lie), and a "Keyboard shortcuts" help sheet (`Mod-/`).
- Honour IME composition (`event.isComposing` is already checked in `SheetsGrid.svelte` keydown; keep that in the in-cell editor, important for Thai).

### 2.4 Keys the browser keeps on the web

Ctrl+N, Ctrl+W, Ctrl+T, Ctrl+P (print dialog is fine), F5 (reload), Ctrl+PageUp/PageDown (switch tab) cannot be reliably taken in a web page. Tauri can take them. Plan: do not bind these on web; provide the same actions through menus and give web-safe alternatives (for example Present's start-show on a button, plus `Mod-Shift-Enter`).

### 2.5 Same file open twice

The layout contract allows the same artifact in center stage and a right panel with independent editor drafts (`AGENTS.md`). New edit state (in-cell editor, selection, undo scope) must be **per instance**, not module-global.

### 2.6 Things to preserve

- Protected ranges, owner-only protection (`isProtected`, `permitted`).
- Private cell-draft recovery (`session.stageDraft`); the in-cell editor must still route through it.
- `#CONFLICT!` display when a cell has more than one head version.
- Grid semantics (`role=grid`, `aria-selected`, roving toolbar). The in-cell editor and autocomplete need proper announcements (combobox pattern).
- Coarse-pointer rows (40px) and touch use.
- Every new string in en, es and th.

## 3. Sheets

Files: `workspaces/sheets/SheetsGrid.svelte` (grid, keys, clipboard), `formula.ts` (parser and calculator), `model.ts`, `fileAdapter.ts`, `SheetsWorkspace.svelte`.

### 3.1 Editing and keyboard

| Expected (Excel) | Today | Tier | Size |
|---|---|---|---|
| Type in a cell to start editing; text appears **in the cell** | PARTIAL: typing starts an edit but focus jumps to the formula bar (`:147`) | T1 | D1 |
| F2 edits the active cell with the caret at the end | PARTIAL: starts an edit in the formula bar and selects all (`startEdit`) | T1 | D1 |
| Enter commits and selects the cell below; Shift+Enter above | PARTIAL: formula-bar Enter commits and returns focus to the grid, selection does not move (`:318` form submit) | T1 | S after D1 |
| Tab commits and moves right; Shift+Tab left | PARTIAL: moves selection when not editing; while editing it is the formula bar's Tab | T1 | S after D1 |
| Esc cancels the edit | HAVE (`cancelEdit`, formula input keydown) | n/a | |
| Delete clears contents; Backspace clears when selected | HAVE (`:146`) | n/a | |
| Alt+Enter new line in a cell | MISSING (formula bar is a single-line `<input>`) | T2 | M |
| Ctrl+Enter fills the range with the entry | MISSING | T2 | S |
| Double-click a cell to edit | HAVE (`ondblclick`, line ~368) | n/a | |
| Ctrl+D fill down, Ctrl+R fill right | PARTIAL: fill-down exists as a ⋯ menu item (`fillDown`), no key; fill-right missing. (Ctrl+R is not listed on the fetched Excel page; verify.) | T1 | S |
| Ctrl+; insert today's date, Ctrl+Shift+: time | MISSING | T3 | S |
| Ctrl+' copy formula from above, Ctrl+Shift+" copy value from above | MISSING | T3 | S |
| Ctrl+Z / Ctrl+Y | MISSING binding (see 2.2) | T1 | S |
| Ctrl+B / Ctrl+I / Ctrl+U | MISSING keys (toolbar buttons exist for B and I); **underline does not exist in the style model** | T1 (B, I) / T2 (U) | S |
| Ctrl+1 format cells | MISSING (formats via toolbar and ⋯ only) | T2 | S |
| Ctrl+Shift+$ % ~ ! # @ ^ number formats | MISSING (formats exist: general, number, currency, percent, date, text) | T2 | S |

### 3.2 Selection, navigation, mouse

| Expected | Today | Tier | Size |
|---|---|---|---|
| Click selects; Shift+click extends | HAVE (`choose(..., extend)`) | n/a | |
| **Click-drag selects a range** | MISSING: click events only, no pointer drag | T1 | M |
| **Click a column letter / row number selects it** | MISSING: headers are plain `<th>` with no handlers | T1 | S |
| Click the corner selects all; Ctrl+A selects all | PARTIAL: Ctrl+A selects the whole grid; corner click and Excel's "current region first" behavior missing | T2 | S |
| Ctrl+Space column, Shift+Space row | MISSING | T1 | S |
| Arrows move; Shift+Arrows extend | HAVE (`:143-145`) | n/a | |
| **Ctrl+Arrows jump to the edge of data; Ctrl+Shift+Arrows extend there** | MISSING | T1 | S |
| Home (row start), Ctrl+Home, Ctrl+End (last used cell) | MISSING | T1 | S |
| PageUp / PageDown | MISSING | T2 | S |
| Ctrl+PageUp/PageDown change sheet | MISSING (and a browser tab shortcut on web, see 2.4) | T3 | S |
| **Fill handle** (drag the corner to repeat or extend a series) | MISSING | T1 | M |
| **Drag a column border to resize; double-click to auto-fit** | MISSING: width is a numeric field in a side panel (`setColumnWidth`) | T1 | M |
| **Right-click a cell for a context menu** (also Shift+F10) | MISSING (only sheet tabs have one) | T1 | M |
| Name box: type `B7` or a range and press Enter to go there | DIFFERENT: it is a read-only `<output>` (`:319`) | T1 | S |
| Ctrl+9 / Ctrl+0 hide rows / columns | MISSING | T3 | M |
| Find (Ctrl+F) and replace (Ctrl+H) across the sheet | MISSING. Browser find cannot see rows outside the virtualised window | T2 | M |
| Sort and filter | DIFFERENT BY DESIGN: per-user view only, with an explicit "apply row order for everyone" action | n/a | |
| Status bar with sum, average, count of the selection | HAVE (`stats`) | n/a | |
| Freeze panes at the cursor | PARTIAL: a single "Freeze headers" toggle | T3 | M |

### 3.3 Formulas

Today (`formula.ts`): references with `$` absolute markers, ranges, cross-sheet refs, `+ - * / ^ & % = <> < > <= >=`, and exactly 15 functions: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, AND, OR, ROUND, COUNTIF, SUMIF, ABS, NOT, CONCAT. Calculation runs in a worker. Limits: 100,000 cells per range, 2,000,000 operations, depth 48. Unsupported text stays an error and never silently becomes zero. Keep that rule.

| Expected | Today | Tier | Size |
|---|---|---|---|
| **Click or arrow to a cell while typing a formula inserts its reference** ("point mode") | MISSING. Clicking commits the edit (`choose`). Microsoft's page documents only the F2 toggle for arrow-key point mode; click-to-insert is not on that page, but it is how Excel behaves. | T1 | L (D1) |
| **Drag over cells while typing a formula inserts a range** | MISSING | T1 | with the above |
| **Typing `=` and a letter shows matching function names**; Tab accepts; argument hint | MISSING | T1 | M |
| Referenced cells highlighted in the grid in matching colours while editing | MISSING | T2 | M |
| F4 cycles `A1 → $A$1 → A$1 → $A1` | MISSING (parser already understands `$`) | T1 | S |
| Fill/copy-paste shifts relative references | PARTIAL: `shiftFormula` exists for fill; paste inserts text unshifted | T1 | M (D2) |
| Ctrl+` show formulas instead of values | MISSING | T3 | S |
| Alt+= AutoSum | MISSING | T2 | S |
| Error messages explained on hover (`#REF!`, `#CYCLE!`...) | MISSING | T2 | S |

Proposed core function set (D5), each with tests against Excel's documented behavior: IFERROR, IFS, SWITCH, XLOOKUP, VLOOKUP, HLOOKUP, INDEX, MATCH, SUMIFS, COUNTIFS, AVERAGEIF(S), MEDIAN, MODE, STDEV, LARGE, SMALL, RANK, MIN/MAX variants, ROUNDUP, ROUNDDOWN, INT, MOD, POWER, SQRT, CEILING, FLOOR, LEFT, RIGHT, MID, LEN, TRIM, UPPER, LOWER, PROPER, SUBSTITUTE, FIND, SEARCH, TEXT, VALUE, TEXTJOIN, TODAY, NOW, DATE, YEAR, MONTH, DAY, WEEKDAY, EDATE, ISNUMBER, ISBLANK, ISERROR, ROW, COLUMN, ROWS, COLUMNS.

### 3.4 Clipboard and limits

| Expected | Today | Tier |
|---|---|---|
| Ctrl+C copies values and formulas | DIFFERENT BY DESIGN: values only, escaped (D2) | T1 |
| Ctrl+X cuts | MISSING | T1 |
| Ctrl+V pastes a block; formulas adjust | PARTIAL: TSV paste works up to 2,000 cells; clear is also limited to 2,000 | T1 |
| Paste special (values / formats) | MISSING | T3 |
| Cell styling: bold, italic, align, fill, border, wrap, number format | HAVE | n/a |
| Underline, font, size, text colour, merge, conditional formats, data validation | MISSING | T2 to T3 |

### 3.5 Import and export

HAVE: import `.csv .tsv .xlsx .ods`; export XLSX and CSV; imported formulas keep a "cached" result when Wabi cannot recalculate (with a visible Cached/Stale tag). Raising the function set (3.3) reduces how often that happens.

## 4. Documents

Files: `DocumentsWorkspace.svelte`, `CollaborativeText.svelte`, `lib/editor/writingSurface.ts` (keymap), `SelectionBubble.svelte`, `InsertMenu.svelte`.

**Correction to my earlier assumption:** Documents is not a bare text box. It is CodeMirror with live-preview Markdown, a selection bubble, a `/` Insert menu, an outline, and formatting keys. Its limits are the Markdown model (D3), not missing basics.

| Expected (Word) | Today | Tier | Size |
|---|---|---|---|
| **Click the big title to rename** | MISSING: the page title is a static `<h1>` (`DocumentsWorkspace.svelte:270`); only the small header field edits it. This is very likely the "untitlable" report. | T1 | S |
| Bold / italic | HAVE: `Mod-b`, `Mod-i` (`writingSurface.ts:491`) | n/a | |
| Underline `Mod-u` | MISSING; no underline in Markdown | T2 (see D3) | S |
| Insert link `Mod-k` | DIFFERENT: bound to `Mod-Shift-k` (Word: small caps) | T1 (D7) | S |
| Strikethrough / inline code | HAVE as `Mod-Shift-x`, `Mod-e` (Word: Ctrl+E is centre) | T2 (D7) | S |
| Headings `Ctrl+Alt+1/2/3`, Normal `Ctrl+Shift+N` | MISSING (headings by typing `#` or `/`) | T1 | S |
| Bulleted list `Ctrl+Shift+L` | MISSING key (menu and mobile bar exist) | T2 | S |
| Undo / redo | HAVE (`yUndoManagerKeymap`) | n/a | |
| Word and line movement, selection, Ctrl+Backspace/Delete word, Ctrl+A | HAVE via CodeMirror `defaultKeymap` | n/a | |
| Find `Ctrl+F`, replace `Ctrl+H` | MISSING (no search keymap; browser find works only on the visible page) | T1 | M |
| Save `Ctrl+S` | see 2.1 | T1 | S |
| Paste plain text `Ctrl+Shift+V`; rich paste from Word or web becomes Markdown | UNKNOWN: not audited | T2 | M |
| Print `Ctrl+P` with a clean print stylesheet | UNKNOWN | T2 | M |
| Zoom `Ctrl+ + / - / 0` | browser zoom only | T3 | S |
| Tables | PARTIAL: Markdown tables only; no table editing UI | T2 | L |
| Font, size, colour, alignment, line spacing, page layout | DIFFERENT BY DESIGN (D3) | decision | |
| Comments | HAVE for shared documents (selection bubble) | n/a | |
| Contents / outline | HAVE | n/a | |
| Import `.txt .md .html`; export Markdown, HTML, text | HAVE. `.docx` MISSING (D4) | T2 | L |

## 5. Present

Files: `present/PresentWorkspace.svelte`, `present/NativeSlideDesigner.svelte`, `present/files.ts`, `present/sceneExport.ts`.

| Expected (PowerPoint) | Today | Tier | Size |
|---|---|---|---|
| **Click text on a slide and type; Enter or double-click to edit text in place; Esc leaves the text** | MISSING: object text is edited only in the inspector textarea (`NativeSlideDesigner.svelte:408`) | T1 | L |
| Ctrl+Z / Ctrl+Y | MISSING binding (2.2) | T1 | S |
| Copy / cut / paste objects; Ctrl+D duplicate | MISSING | T1 | M |
| Ctrl+A select all objects; Tab cycles objects | MISSING (a dropdown in the inspector selects an object) | T2 | S |
| Select several objects (Shift+click, rubber band); group Ctrl+G | MISSING (single selection) | T2 | L |
| Drag to move, handles to resize | HAVE (`startDrag`, `startResize`) | n/a | |
| Arrow keys nudge | HAVE (`:150-154`) | n/a | |
| Shift+Arrow resizes | MISSING | T3 | S |
| Delete removes the object | HAVE (`:145`) | n/a | |
| Snap and alignment guides while dragging | MISSING (alignment is a menu: left, centre, right, middle) | T2 | M |
| Bold / italic / underline and per-word styling inside text | MISSING: one font size and colour per text object | T2 | L (rich text model) |
| New slide `Ctrl+M`; duplicate `Ctrl+Shift+D`; move slide `Ctrl+Up/Down` | PARTIAL: duplicate and move are menu items; menu shows `Alt ↑/↓` and `Delete` hints, whose bindings need confirming in `filmKeys` (`PresentWorkspace.svelte:193-202`) | T1 | S |
| Slide sorter drag to reorder | UNKNOWN: not audited | T2 | M |
| Start show `F5`, from this slide `Shift+F5`, end `Esc` | PARTIAL: Esc ends; start is a menu action. F5 is a browser reload on web (2.4) | T2 | S |
| In show: Right/PageDown/Space next, Left/PageUp previous, Home/End, `B` blank, `F` fullscreen | HAVE (`showKeys`, lines 367-374) | n/a | |
| In show: `N`/`P`, number+Enter jump, `W` white screen, pen, pause | UNVERIFIED reference (see section 7); not implemented | T3 | S |
| Presenter view with notes | PARTIAL: private speaker notes exist; no dual-window presenter view | T2 | L |
| Transitions, animations | MISSING | T3 | L |
| Import PDF, PNG, JPEG, WebP, native decks | HAVE | n/a | |
| Import PPTX/ODP as editable slides | MISSING: optional LibreOffice sidecar turns it into a static PDF of page images | decision (D4) | |
| Export editable PPTX subset, audience PDF, notes backup | HAVE (subset; no speaker notes in PPTX) | n/a | |

## 6. Suggested order

1. **Phase 0, quick wins (about a week).**
   - Undo and redo binding.
   - Editable page title in Documents.
   - Visible file location and save state, plus `Mod-S`.
   - Sheets: header click to select a row or column, `Mod-X`, `Mod-D`, Ctrl+Arrows, Home, Ctrl+Home/End, Ctrl+Space and Shift+Space.
2. **Phase 1, Sheets editing core (D1).** In-cell editor, edit-mode reducer, Enter/Tab commit and move, drag select, name box.
3. **Phase 2, Sheets formulas.** Point mode (click and drag), `=` autocomplete, F4, referenced-cell highlight, core functions.
4. **Phase 3, Sheets selection and clipboard.** Fill handle, column drag-resize, context menu, formula-aware clipboard (D2), find and replace.
5. **Phase 4, Documents.** Keys per D7 and D3, find and replace, rich paste, print, tables, DOCX per D4.
6. **Phase 5, Present.** On-canvas text editing, object clipboard and multi-select, snapping, slide keys and reorder, then rich text.
7. **Phase 6, polish.** Shortcut help sheet, phone and touch pass, i18n (en, es, th) sweep.

## 7. How each piece gets verified

- Key handling, the edit-mode reducer, reference insertion, autocomplete ranking, relative-reference shifting on paste, and the shortcut tables go into **pure TypeScript modules with `bun test`** (the repo already tests Sheets this way: `interaction.test.ts`, `formulaScale.test.ts`).
- AGENTS.md rule 7 applies: HTTP and compile tests do not prove visual or pointer behavior. Each row gets a manual checklist in a real browser (and the desktop app) before it is called done, including Thai IME input for cell and text editing.
- Before building on `main`, the existing unrelated test failures should be understood: component tests currently report 2 failures and 2 errors (`ensureE2eeDeviceRegistered` export and `initI18n`), identical on `main`.

## 8. Reference accuracy: what was and was not verified

Shortcuts were read from Microsoft's support pages by a fetch agent (2026-11-16), not written from memory.
- **Excel page:** only part was returned verbatim (about 39,900 of 91,900 characters); the rest was a summary. The Windows key combos above came from the verbatim part. Mac equivalents were **not** verified. The page documents F2 as the point-mode toggle for arrow keys but says nothing about click-to-insert, which is standard Excel behavior that must be checked by hand. `Ctrl+R` (fill right) did not appear on that page.
- **Word page:** Windows content read in full and verbatim.
- **PowerPoint page:** editing, slide, object and text shortcuts read verbatim. The page's link to the slide-show shortcut list returned **404**, so the in-show keys (`N`, `P`, number+Enter, `W`, pen, pause) are **not** verified and appear above as such.

## 9. Carried over from the earlier bug list (not part of this plan)

- Up arrow does not edit after changing channel, composer buttons staying after clicking off, message timers vanishing, DM field shape: none reproduced yet; the code paths read so far did not show a cause. Need a reproduction.
- Slow first-load thumbnails: not investigated.
- The timeout enforcement change (`channel_access.rs`) compiled in a release build but `cargo test` was not run and no test was added.
- Bun 1.3.12 is installed; HANDOFF.md requires 1.4.4 or later.

## 10. Progress and what is left (end of 2026-11-16)

All seven decisions in section 1 were approved. The work below is committed on `fix/server-rail-i18n`. "Browser" means a real Chromium driven by Playwright against the actual components, not only unit tests.

### Done

| Area | What now works | Verified |
|---|---|---|
| All tools | Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z undo and redo (were menu labels only in Sheets and Present); Ctrl+S saves where the file lives and says so instead of opening the browser's Save dialog; the save status says "this device only" / "on this server" in words; a one-click Download of the tool's first export in the header; the library line says the file is kept in this browser | unit and structure tests; not run in a browser (the shell is not mounted in a harness) |
| Documents | Click the page title to rename; Ctrl+K link (Ctrl+Shift+K kept), Ctrl+Alt+1/2/3 headings, Ctrl+Alt+0 and Ctrl+Shift+N Normal, Ctrl+Shift+L and Ctrl+Shift+8 bullets, Ctrl+Shift+7 numbers; Ctrl+F Find and Ctrl+H Find and replace (in-house panel, no new dependency), typing lands on the first match, Replace all is one undo step | browser: 18 checks |
| Sheets editing | Cells edit in place (Enter mode when typing, Edit mode on F2 or double click); Enter/Tab commit and move, Shift reverses; in the grid Enter and Tab move rather than edit; Esc cancels; point mode (click, drag or arrow keys write a reference or range while a formula expects one; typing ends it); `=` autocomplete with a signature hint and Tab to accept; F4 cycles `$`; formulas shown as typed, without added brackets | browser: 27 checks |
| Sheets selection | Click and drag to select; click a column letter or row number; corner selects all; Ctrl+Space and Shift+Space; Ctrl+Arrows jump; Home, Ctrl+Home, Ctrl+End, PageUp/PageDown; Shift extends; name box accepts `B7` or `B2:D9`; drag a column edge to resize, double-click to fit; right-click, Menu key or Shift+F10 opens a cell menu | browser: 15 + 4 checks |
| Sheets clipboard | Ctrl+C / X / V carry formulas inside Wabi and adjust relative references (other apps still get quoted values); one cell over a selection fills it; cut moves; dashed marquee; Ctrl+D / Ctrl+R fill; Ctrl+Shift+$ % ! # ~ number formats; Ctrl+B / Ctrl+I | browser: 17 checks |
| Sheets formulas | 82 functions (was 15): lookups (VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH), IFERROR/IFS/SWITCH, SUMIFS/COUNTIFS/AVERAGEIF(S), text, dates on Excel serials, ROW/COLUMN. Errors stay explicit | unit tests (63 for the functions) and the 200,000-cell benchmark unchanged |
| Sheets layout | Fixed: the table had no width, so the browser squeezed every column to fit the window; stored widths barely showed and the sheet could not scroll sideways. Default column width is now 100px | browser |
| Present | Enter, F2 or double click edits a text object on the slide itself, in the slide's own type; Esc returns to the object; Ctrl+C / X / V copy, cut and paste objects; Ctrl+D duplicates; Duplicate in Arrange | browser: 14 checks |

### Left, in the order I would do it

1. **Sheets**: the fill handle (drag the corner to repeat or extend a series); Find and Replace across the sheet (Ctrl+F / Ctrl+H); underline (needs a style field and an icon); Ctrl+; for today's date and Alt+= AutoSum; Alt+Enter for a new line in a cell (needs a multi-line editor); moving the active cell inside a multi-cell selection with Enter and Tab; auto-scroll while drag-selecting; type-to-start for IME input (Thai), which cannot start an edit by typing today; a cell editor wider than its cell; error explanations on hover.
2. **Present**: multi-select, Ctrl+A and group; snapping and alignment guides; Shift+Arrow resize; rich text inside a text object; Ctrl+M new slide, Ctrl+Shift+D duplicate slide and Ctrl+Up/Down to move slides (the menu shows Alt+Up/Down, whose binding is not verified); presenter view with notes; transitions.
3. **Documents**: underline, font and size (decision D3: stays Markdown); rich paste from Word; print stylesheet; a table editing UI; Tab and Shift+Tab to indent, and Enter continuing a list (neither is bound).
4. **Files**: `.docx` import and export and editable `.pptx` import (decision D4); desktop open and save (decision D6); asking for persistent browser storage.
5. **Cross-cutting**: a Keyboard shortcuts help sheet and one shortcut registry feeding the menu hints; the menus still print some hints (for example "Alt ↑") that are not verified against a real binding; i18n for the new Sheets strings (they are English, like the rest of that component).

### Things worth knowing

- **Ctrl+K**: Documents now binds it to Link. The app's jump palette also used it, and inside a Markdown page the editor takes the key first. Read-only pages still pass it to the palette. If that trade is not wanted, the alias Ctrl+Shift+K can stay and Ctrl+K can be given back.
- **Cut** moves the cells but does not rewrite formulas elsewhere that pointed at them (Excel does).
- **`formatValue`** shows date serials below 61 one day off (the Excel 1900 leap-year quirk); noted by the functions work, not fixed.
- **Browser coverage**: the Sheets grid, the slide designer and the Documents editor were each mounted on their own in a throwaway page. The surrounding shell (header, Ctrl+Z/S, Download) was not, so those are verified by tests only.
