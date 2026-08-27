# Visual-junk hunts: stray glyphs, duplicated text, wrong headers

Session-validated 2026-08-21 (three Wabi bugs fixed in one pass, commit `724a09f`).

## Case 1 — literal ">" painting into every channel

**Symptom:** Ronin: "this symbol > is in almost every single channel."

**Root cause:** an orphaned `>` at `Chat.svelte` inside the shared `.messages` container:

```svelte
	>
		>{#if isLiveChannel}   <!-- first > closes the div; second is a TEXT NODE -->
```

Svelte renders the stray `>` as literal text at the top of the container — visible in every surface that mounts Chat (nearly all channels). It had ridden along through many commits (introduced around the planner/gear-icons commit).

**Hunt technique (validated, zero false positives tree-wide):** flag any line whose trimmed content STARTS with `>` while the previous non-blank line already ENDS with `>`. Legitimate multi-line attribute closers follow attribute lines (which don't end in `>`), so only true orphans match. Script: `scripts/scan-orphan-gt.py`.

Do NOT mass-edit plain grep hits of `^\s*>` — most are legitimate closers (`>` alone ending a multi-line tag) or `>text</button>` content lines.

## Case 2 — server tagline rendered twice ("A test of wabing" ×2)

**Symptom:** Server hub showcase showed name, then the SAME sentence twice.

**Root cause (two layers):**
1. `savedServerUtils.ts deriveServerView()`: `effectiveTagline` fell back to `metadata.description` → when no distinct tagline exists, both fields carry the identical string.
2. `ServerSwitcherPanel.svelte` showcase rendered BOTH `effectiveDescription` and `effectiveTagline` as separate paragraphs.

**Fix rule:** kill the alias at the SOURCE (tagline = its own field only, never fall back to description) AND drop the redundant render site. Fixing only the render site leaves the aliasing trap for the next consumer (ChannelSidebar also reads `effectiveTagline`).

**Related find in the same panel:** the close button contained a literal letter `x` (`>x</button>`) — replaced with a stroked SVG X (`M18 6L6 18` + `M6 6l12 12`) plus flex centering + `.switcher-close svg { width/height 16px; fill:none; stroke:currentColor }` matching the panel's other icons. When a user says "an icon isn't rendering," check whether the button ever contained an icon at all vs a broken image/SVG.

## Case 3 — Code/Project view header boilerplate instead of channel name

**Symptom:** "code view has strange text above and below like ':Code / code-repo / Versioned repositories for this server' || should be 'code-repo' because that's the channel name."

**Root cause:** `Chat.svelte` workspace header derivations hardcoded lore-specific strings:
- `workspaceSurfaceLabel` case 'lore' returned `'Project'` → label ABOVE the title.
- `workspaceHeaderSubtitle` case 'lore' returned `'Versioned repositories for this server'` → boilerplate BELOW the title, regardless of channel.

**Fix rule:** workspace headers derive from the active channel:
- title = `channelDisplayName` (already was),
- subtitle = `channelDescription` (channel's own description; empty string when unset — NO fallback prose; ChatHeader already hides empty subtitles via `{#if !isDMChannel && workspaceHeaderSubtitle}`),
- no surface label above the title when the title IS the channel name.

Generalizes: any per-channel view must not hardcode server-wide marketing copy into its header.

## Verification without a browser

1. Compile each touched component with the project's own compiler (parse alone misses errors):
   `node -e "const {compile}=require('svelte/compiler');compile(fs.readFileSync(f,'utf8'),{generate:'dom'})"`
2. Project-wide `npx svelte-check --tsconfig ./tsconfig.json`.
3. Triage its output: errors in untracked/pre-existing peer files are NOT yours — confirm with `git log -1 -- <file>` + `git status --short -- <file>` before touching or reporting. (This pass: the single project error was in peer's untracked `authRefresh.ts`.)

## Peer-commit sweep hazard

In the shared Wabi tree the concurrent peer session may commit YOUR fix inside THEIR feature commit before you stage it. This session: the scoped-commit attempt found a clean tree because peer's `47aa78c` (lore relabel) had swept the one-line `>` fix in. Response pattern: if `git status` is clean on your file but the fix should exist, `git log -p -1 -- <file>` and verify content on disk; report it as committed-under-peer-message rather than re-fixing.
