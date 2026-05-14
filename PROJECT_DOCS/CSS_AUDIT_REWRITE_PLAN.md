# DESIGN / CSS AUDIT AND REWRITE PLAN
## Wabi Frontend — Living Document

---

## 1. THE PROBLEM IN ONE SENTENCE

The frontend has approximately **three parallel design systems** competing in the same DOM, none of which owns the full surface area.

---

## 2. INVENTORY OF ALL STYLE SURFACES

| Surface | File(s) | Lines | Role | State |
|---------|---------|-------|------|-------|
| **Design Tokens (attempt 1)** | `frontend/src/app.css` | ~995 | Global CSS custom properties, resets, utility classes, button variants, scrollbar, mobile queries, animation presets, per-theme override blocks | ACTIVE but overloaded |
| **Design Tokens (attempt 2)** | `frontend/src/lib/theme/themes.ts` | ~1,155 | 14 complete theme definitions as TS objects with 69 color fields + 15 gradients each | ACTIVE but duplicated |
| **Design Tokens (attempt 3)** | `frontend/src/lib/business/theme.css` | ~82 | Business hub dashboard uses entirely separate `biz-*` variable namespace | ACTIVE but isolated |
| **Component Scoped Styles** | 98 `.svelte` files with `<style>` blocks | ~55,000+ est. | Every component invents its own layout, spacing, colors, borders | ACTIVE and inconsistent |
| **Backend Theme Persistence** | `backend/src/api/themeRoutes.ts`, `themeRepository.ts` | ~200 | Validates and persists theme IDs + custom JSON | Active |
| **Theme Engine Runtime** | `frontend/src/lib/theme/themeManager.ts` | ~123 | Applies theme to `:root` by iterating TS object keys and setting CSS vars at runtime | Active |
| **Prism Theme** | `frontend/src/lib/prism-theme.css` | ~? | Syntax highlighting for code blocks | Separate concern |

**Total estimated CSS in the project: ~57,000+ lines** scattered across 3 token systems + 98 component files.

---

## 3. THE 3 DESIGN SYSTEMS DETAIL

### System A: app.css (vanilla CSS tokens)
Defines:
```
--color-background-primary: #1a1a2e
--color-background-primary-rgb: 26, 26, 46
--color-text-primary: #e0e0ff
--color-accent-primary: #ff00ff
--font-size-1 through --font-size-6
--space-1 through --space-16
--radius-sm, --radius-md, --radius-lg
--shadow-sm, --shadow-md, --shadow-lg
--z-base through --z-lightbox
```

AND also defines:
```
--bg-primary: linear-gradient(...)
--bg-secondary: #1a1a2e
--text-primary: #e0e0ff
--accent: linear-gradient(...)
```

**Problem**: Two naming conventions for the same concepts. Components import from both.

### System B: themes.ts (TypeScript theme objects)
Each of 14 themes exports an object with:
- 69 color properties (`bgPrimary`, `bgSecondary`, `textPrimary`, `accent`, `modalBg`, etc.)
- 15 gradient properties (`primary`, `accent`, `fadeBottomDark`, `lineGlow`, etc.)

**Duplication math:**
- 14 themes × 84 properties = **1,176 hardcoded values**
- Changing a single base palette requires editing all 14
- `bgPrimary`, `bgSecondary`, `bgHover` are recalculated by hand per theme instead of derived

### System C: business theme.css
Entirely separate namespace:
```
--biz-bg-primary: #0f1419
--biz-accent: #f59e0b
--biz-text-primary: #f1f5f9
```
The business hub (Kanban, Calendar, Projects, Diary, Todo) doesn't participate in the main theme system.

---

## 4. ARCHITECTURAL DEFICIENCIES

### Deficiency 1: No Single Source of Truth for Color
- `app.css` hardcodes `#1a1a2e` for `--color-background-primary`
- `themes.ts` hardcodes `#1a1a2e` as `darkTheme.bgSecondary`
- Component styles hardcode `rgba(0,0,0,0.6)` in `<style>` blocks
- If the default theme changes, `app.css` must be manually updated

### Deficiency 2: themes.ts is Duplication Hell
Every theme repeats the same structure. There is no separation between:
- **Base palette** (what colors exist in the theme)
- **Semantic mapping** (what those colors mean for UI surfaces)
- **Component-specific overrides** (what a button or modal should look like)

This means the theme system is actually a **color lookup table**, not a design system.

### Deficiency 3: app.css is 6 Files in a Trenchcoat
Current sections:
1. Design tokens (colors, typography, spacing, radii, shadows, z-index)
2. Global base styles (reset, body, headings, links, focus)
3. Scrollbar styles
4. Utility classes (`.sr-only`, `.panel-header`, `.panel-content`, `.panel-footer`)
5. Button variants (`.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.btn-icon`, sizes)
6. Input/textarea styles
7. Spoiler, emoji, emote, avatar styles
8. Layout utilities (panel headers/footers)
9. Mobile responsive styles (768px, 480px)
10. Touch improvements
11. Safe area support
12. High contrast mode
13. Uniform font mode
14. Theme-specific overrides (`vscode-high-contrast`, `slate-signal`)
15. Animation presets (`wabi-pop-in`, `balanced`, `full`)
16. Reduced motion preferences

This file should be **8 separate files minimum**.

### Deficiency 4: Component Styles Have No Boundaries
The largest components by line count:

| Component | Total Lines | Likely CSS Lines | Problem |
|-----------|-------------|------------------|---------|
| `Settings.svelte` | 9,842 | ~3,000 | Settings modal with inline form styling, tab styling, color picker CSS, animation toggles |
| `MessageList.svelte` | 5,749 | ~2,000 | Message rendering, embeds, reactions, audio player CSS, media previews, message density |
| `Chat.svelte` | 4,873 | ~1,500 | Chat layout, input area, typing indicators, message bubble styles |
| `ChannelSidebar.svelte` | 3,915 | ~2,000 | Channel list, category headers, unread badges, server header, hover states |
| `MainLayout.svelte` | 1,701 | ~600 | Grid layout, panel resizing, mobile transitions, server rail |

Each of these components embeds its own CSS for buttons, scrollbars, borders, and spacing. There is no shared `.btn` or `.card` or `.surface` class that components import.

### Deficiency 5: Theme Overrides Live in app.css
These blocks:
```css
:root[data-theme='vscode-high-contrast'] .channel-sidebar { ... }
:root[data-theme='slate-signal'] .channel-sidebar { ... }
```

Should be generated by the theme system at runtime, not hardcoded in app.css. Adding a new "frosted glass" theme requires editing app.css.

### Deficiency 6: No Spacing / Sizing System in Components
Components use arbitrary pixel values:
- Some buttons: `padding: 0.25rem 0.75rem`
- Others: `padding: var(--space-2) var(--space-4)`
- Others: hardcoded `32px` for icon buttons
- Panel header: `height: 52px` (but also `--app-chrome-height: 54px`)

### Deficiency 7: Z-Index Chaos
app.css declares 20 z-index tiers. Components may or may not use them. Call shell wants `z-call-shell: 1700`. But a modal in Settings might just use `z-index: 999`. Without enforcement, the tiers are aspirational.

---

## 5. THE AUDIT FINDINGS, SURFACE BY SURFACE

### A. app.css
**Verdict:** Keep but split into 8 files.

| Section | Where it goes | Priority |
|---------|--------------|----------|
| `:root` design tokens (colors, typography, spacing, radii, shadows, motion, z-index) | `frontend/src/styles/tokens.css` | P0 |
| Global reset (box-sizing, html, body, headings, paragraphs, links) | `frontend/src/styles/base.css` | P0 |
| Focus visible standard | `frontend/src/styles/base.css` | P0 |
| Scrollbar styles | `frontend/src/styles/scrollbars.css` | P1 |
| Button variants (btn-primary, secondary, ghost, danger, icon, sizes) | `frontend/src/styles/components/buttons.css` | P0 |
| Input/textarea styles | `frontend/src/styles/components/inputs.css` | P1 |
| Spoiler, emoji, emote, avatar | `frontend/src/styles/components/content.css` | P2 |
| Panel header/content/footer utilities | `frontend/src/styles/components/panels.css` | P1 |
| Mobile responsive queries | `frontend/src/styles/mobile.css` | P2 |
| Touch improvements | `frontend/src/styles/mobile.css` | P2 |
| Safe area support | `frontend/src/styles/mobile.css` | P2 |
| High contrast mode | `frontend/src/styles/accessibility.css` | P3 |
| Uniform font mode | `frontend/src/styles/accessibility.css` | P3 |
| Theme-specific overrides (vscode, slate) | REMOVE — generate from theme system | P1 |
| Animation presets | `frontend/src/styles/animations.css` | P2 |
| Reduced motion | `frontend/src/styles/accessibility.css` | P3 |

### B. themes.ts
**Verdict:** Refactor into base palette + derivation functions.

Current: 14 monolithic theme objects.
Target:
```typescript
// base-palettes.ts
const darkPalette = {
  bg: { primary: '#1a1a2e', secondary: '#24243e', tertiary: '#302b63' },
  text: { primary: '#e0e0ff', secondary: '#b3b3ff', tertiary: '#9999ff' },
  accent: { primary: '#ff00ff', secondary: '#ff69b4', hover: '#ff1493' },
  status: { online: '#00ff7f', away: '#ffd700', busy: '#ff0000', offline: '#708090' },
  semantic: { success: '#00ff7f', info: '#00bfff', warning: '#ffd700', danger: '#ff0000' }
};

// Derive UI semantic colors from palette
function deriveTheme(palette, name, id): Theme { ... }
```

This collapses 1,176 hardcoded values into ~14 base palettes of ~20 colors each.

**P1 priority.**

### C. business/theme.css
**Verdict:** Merge into the main theme system.

The business hub should receive the same CSS custom properties as the rest of the app. If it needs distinct surfaces (card, dashboard, kanban column), those should be semantic roles in the global token system, not a separate `biz-*` namespace.

**P2 priority.**

### D. Component `<style>` blocks
**Verdict:** Audit top 20 components, extract shared patterns into classes.

The biggest wins:

| Component | CSS to extract | Where it goes |
|-----------|----------------|---------------|
| `Settings.svelte` | Settings modal chrome, tab switcher, form rows, color picker | `frontend/src/styles/components/settings.css` or shared modal/form classes |
| `MessageList.svelte` | Message bubble shapes, embed cards, reaction pills, audio player | `frontend/src/styles/components/messages.css` |
| `Chat.svelte` | Chat layout (header, messages, input), typing indicator | `frontend/src/styles/components/chat.css` |
| `ChannelSidebar.svelte` | Channel row, category header, unread badge, server header | `frontend/src/styles/components/sidebar.css` |
| `MainLayout.svelte` | Grid definition, panel resizing handles, server rail | `frontend/src/styles/layout.css` |
| `CallModal.svelte` | Call shell, participant grid, video container | `frontend/src/styles/components/calls.css` |
| `DMTab.svelte` / `DMMessageView.svelte` | DM sidebar, DM conversation | shared with `messages.css` and `sidebar.css` |

**Goal:** No component should define "button" or "card" or "surface" styles. Those are imported classes.

**P1 for top 10 components. P2 for remainder.**

---

## 6. TARGET ARCHITECTURE: THE SINGLE DESIGN SYSTEM

### Directory Restructure

```
frontend/src/styles/
  tokens.css          : All CSS custom properties (the ONLY file that defines tokens)
  base.css            : Global reset, html, body, typography defaults
  layout.css          : App grid, panel system, resizing handles
  animations.css      : Shared keyframes, animation presets, reduced motion
  scrollbars.css      : Webkit scrollbar styling
  mobile.css          : All responsive breakpoints, touch improvements
  accessibility.css     : High contrast, reduced motion, color assist, uniform font
  
  components/
    buttons.css       : btn-primary, btn-secondary, btn-ghost, btn-danger, btn-icon, sizes
    inputs.css        : input, textarea, select, focus states
    panels.css          : panel-header, panel-content, panel-footer
    messages.css        : Message bubble, embed, reaction pill, audio player
    chat.css            : Chat layout surfaces
    sidebar.css         : Channel row, category, unread badge, server header
    calls.css           : Call shell, video grid, participant cards
    modals.css          : Modal overlay, modal content, modal sizes
    cards.css           : Generic card surfaces
    settings.css        : Settings modal chrome
    content.css         : Avatar, emoji, emote, spoiler, code blocks
    
  themes/
    (generated at build time or runtime)
    No per-theme CSS files needed — the theme system generates tokens.
```

### Token System (The One Naming Convention)

**Kill both `--color-text-primary` AND `--text-primary`.** Use one:

```css
:root {
  /* Core palette (set by theme system) */
  --palette-bg-base: #1a1a2e;
  --palette-bg-raised: #24243e;
  --palette-bg-sunken: #0f0c29;
  --palette-text-primary: #e0e0ff;
  --palette-text-secondary: #b3b3ff;
  --palette-text-muted: #9999ff;
  --palette-accent: #ff00ff;
  --palette-accent-secondary: #ff69b4;
  --palette-danger: #ff1493;
  --palette-success: #00ff7f;
  --palette-warning: #ffd700;
  --palette-info: #00bfff;
  
  /* Semantic mapping (rarely overridden per-theme) */
  --surface-app: var(--palette-bg-base);
  --surface-sidebar: var(--palette-bg-raised);
  --surface-chat: var(--palette-bg-base);
  --surface-message: var(--palette-bg-raised);
  --surface-modal: var(--palette-bg-sunken);
  --surface-card: var(--palette-bg-raised);
  
  --text-heading: var(--palette-text-primary);
  --text-body: var(--palette-text-primary);
  --text-secondary: var(--palette-text-secondary);
  --text-placeholder: var(--palette-text-muted);
  --text-link: var(--palette-accent);
  
  --border-subtle: rgba(var(--palette-bg-raised-rgb), 0.5);
  --border-strong: rgba(var(--palette-text-secondary-rgb), 0.2);
  
  /* Sizing */
  --space-xs: 0.125rem;  /* 2px */
  --space-sm: 0.25rem;   /* 4px */
  --space-md: 0.5rem;    /* 8px */
  --space-lg: 0.75rem;   /* 12px */
  --space-xl: 1rem;      /* 16px */
  --space-2xl: 1.25rem;  /* 20px */
  --space-3xl: 1.5rem;   /* 24px */
  --space-4xl: 2rem;     /* 32px */
  
  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', Consolas, Monaco, monospace;
  --font-size-xs: 0.6875rem;   /* 11px */
  --font-size-sm: 0.8125rem;   /* 13px */
  --font-size-base: 0.875rem;  /* 14px */
  --font-size-lg: 1rem;        /* 16px */
  --font-size-xl: 1.25rem;     /* 20px */
  --font-size-2xl: 1.5rem;     /* 24px */
  
  /* Radii */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-full: 9999px;
  
  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.1);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
  --shadow-lg: 0 10px 15px rgba(0,0,0,0.1);
  
  /* Z-Index */
  --z-sticky: 100;
  --z-dropdown: 200;
  --z-popout: 1200;
  --z-modal: 1500;
  --z-call: 1700;
  --z-toast: 2000;
  --z-settings: 2100;
  --z-lightbox: 12000;
}
```

### Theme Derivation (from base palette)

```typescript
// themes.ts becomes a palette registry, not a value registry
interface Palette {
  name: string;
  id: string;
  colors: {
    bg: { base: string; raised: string; sunken: string };
    text: { primary: string; secondary: string; muted: string };
    accent: { primary: string; secondary: string; hover: string };
    status: { online: string; away: string; busy: string; offline: string };
    semantic: { success: string; info: string; warning: string; danger: string };
  };
}

function buildTokens(palette: Palette): CSSVars {
  // Derive rgb variants automatically
  // Derive border colors from bg/text automatically
  // Derive gradient stops from accent automatically
  // Return flat CSS var object
}
```

This means:
- Adding a new theme = one 15-line palette object
- The gradient strings, rgb variants, and semantic mappings are computed
- No more 84-property objects

---

## 7. ARTIST-FRIENDLY CUSTOMIZATION GOALS

You said: *"Emotes, stickers, backgrounds, profile pictures, profiles — I really want users to customize everything."*

Current state:
- ✅ Background images: supported (url, opacity, blur, size, position, repeat, blend)
- ✅ 14 themes with distinct color palettes
- ✅ Uniform font settings (family, size, weight, style)
- ✅ Animation presets (slip, fade, scale, flip)
- ✅ Animation pass (balanced, full)
- ✅ Message density modes
- ✅ Chat font size slider
- ✅ Saturation/contrast filters
- ❌ Custom user-uploaded themes (no "share your color scheme" feature)
- ❌ Per-server themes (server branding)
- ❌ Per-channel themes
- ❌ Animated backgrounds (video/WebGL backgrounds)
- ❌ Particle effects / ambient atmosphere
- ❌ Custom CSS injection (user-safe subset)
- ❌ Soundpack theming (UI sound effects)
- ❌ Cursor theming
- ❌ Loading screen theming

### Theme Sharing Feature
```typescript
interface UserTheme {
  id: string;
  name: string;
  author: string;
  palette: Palette;
  backgroundImage?: BackgroundImage;
  animationPreset: AnimationPreset;
  shareCode: string; // short code like "wabi.gg/theme/abc123"
}
```

Backend table: `shared_themes` with schema matching Theme but normalized.

---

## 8. MIGRATION PLAN

### Phase 0: Establish New Token System (1 day)
1. Create `frontend/src/styles/` directory
2. Write `tokens.css` with the unified naming convention
3. Write `base.css` with global reset
4. Update `app.css` to `@import` the new files (or remove entirely)
5. Update `themeManager.ts` to set the new token names
6. **No component changes yet** — this just establishes the new convention

### Phase 1: themes.ts Refactor (1-2 days)
1. Define `Palette` interface
2. Convert current 14 themes into 14 `Palette` objects (delete ~80% of theme code)
3. Write `buildTokens()` to derive gradients, rgb, borders from palette
4. Update theme validation in backend
5. Verify all 14 themes render identically

### Phase 2: Component Audit — Top 10 (2-3 days)
1. `MainLayout.svelte` — extract layout grid to `layout.css`
2. `ChannelSidebar.svelte` — extract sidebar patterns to `components/sidebar.css`
3. `Chat.svelte` — extract chat surface to `components/chat.css`
4. `MessageList.svelte` — extract message patterns to `components/messages.css`
5. `Settings.svelte` — extract settings chrome to `components/settings.css`
6. `CallModal.svelte` / `CallView.svelte` — extract call UI to `components/calls.css`
7. `DMTab.svelte` / `DMMessageView.svelte` — share sidebar + messages styles
8. `RightPanel.svelte` — ensure it uses panel utilities
9. `ServerSwitcherPanel.svelte` — server rail styling
10. `UserSettings.svelte` / profile popout — card and avatar patterns to `components/cards.css`

Each component keeps only **layout-specific** styles in its `<style>` block. All color, spacing, shadow, border, typography uses tokens.

### Phase 3: Component Audit — Remaining 88 (3-5 days, parallelizable)
1. Audit each remaining component for hardcoded values
2. Extract shared patterns (tables, lists, forms, toolbars)
3. Write `components/tables.css`, `components/lists.css`, `components/forms.css`
4. Replace inline px values with token references

### Phase 4: Business Hub Merge (1 day)
1. Remove `business/theme.css`
2. Update business components to use `--surface-card`, `--surface-dashboard`, etc.
3. Add dashboard-specific semantic tokens to `tokens.css`

### Phase 5: Polish & Accessibility (1 day)
1. `accessibility.css` — high contrast, reduced motion, color assist
2. `mobile.css` — verify all responsive breakpoints still work
3. `scrollbars.css` — unify scrollbar styling
4. `animations.css` — ensure animation presets use tokens
5. Remove old `app.css` entirely

### Phase 6: Artist Customization Features (ongoing)
1. Theme sharing backend (`shared_themes` table)
2. Theme marketplace UI (browse, install, rate)
3. Background video support
4. Particle/ambient effect system
5. Safe custom CSS subset (whitelist properties)

---

## 9. SPECIFIC FILES TO CREATE/MODIFY

### New Files
```
frontend/src/styles/tokens.css
frontend/src/styles/base.css
frontend/src/styles/layout.css
frontend/src/styles/animations.css
frontend/src/styles/scrollbars.css
frontend/src/styles/mobile.css
frontend/src/styles/accessibility.css
frontend/src/styles/components/buttons.css
frontend/src/styles/components/inputs.css
frontend/src/styles/components/panels.css
frontend/src/styles/components/messages.css
frontend/src/styles/components/chat.css
frontend/src/styles/components/sidebar.css
frontend/src/styles/components/calls.css
frontend/src/styles/components/modals.css
frontend/src/styles/components/cards.css
frontend/src/styles/components/settings.css
frontend/src/styles/components/content.css
frontend/src/lib/theme/palettes.ts          // replaces themes.ts structure
frontend/src/lib/theme/buildTokens.ts       // derivation function
```

### Modified Files
```
frontend/src/app.css                         // Delete after migration
frontend/src/lib/theme/themes.ts             // Refactor to palettes
frontend/src/lib/theme/themeManager.ts       // Update token names
frontend/src/lib/business/theme.css          // Delete after merge
frontend/src/lib/components/MainLayout.svelte      // Extract layout
frontend/src/lib/components/ChannelSidebar.svelte    // Extract sidebar
frontend/src/lib/components/Chat.svelte              // Extract chat
frontend/src/lib/components/MessageList.svelte       // Extract messages
frontend/src/lib/components/Settings.svelte          // Extract settings
frontend/src/lib/components/CallModal.svelte          // Extract calls
frontend/src/lib/components/CallView.svelte          // Extract calls
frontend/src/lib/components/RightPanel.svelte        // Ensure panel tokens
backend/src/api/themeRoutes.ts                        // Validate new schema
backend/src/db/repositories/themeRepository.ts         // Update types
```

### Backend Migrations
No breaking migration needed if the theme schema stays flat (key-value pairs stored as JSON). The `buildTokens` function produces the same shape as current themes. Only the authoring format changes.

---

## 10. VERIFICATION CHECKLIST

After each phase:
- [ ] All 14 themes render identically (pixel-perfect before/after screenshots)
- [ ] Mobile breakpoints preserved (test 768px, 480px)
- [ ] Accessibility features preserved (high contrast, reduced motion, color assist)
- [ ] Business hub renders correctly
- [ ] No hardcoded hex values in component `<style>` blocks (search for `#`)
- [ ] All buttons use `.btn-*` classes
- [ ] All inputs use `.input` class
- [ ] All panels use `.panel-*` classes
- [ ] Z-index tiers respected (no random `z-index: 999`)
- [ ] Build succeeds with no new warnings
- [ ] Dark/light mode toggle works
- [ ] Custom themes (user-created) still load

---

## 11. ESTIMATED EFFORT

| Phase | Time | Risk |
|-------|------|------|
| 0: Token system | 1 day | Low — just moving vars around |
| 1: themes.ts refactor | 1-2 days | Medium — must preserve all 14 theme visuals |
| 2: Top 10 components | 2-3 days | Medium — large components, easy to break |
| 3: Remaining 88 | 3-5 days | Low — small components, repetitive |
| 4: Business hub merge | 1 day | Low |
| 5: Polish | 1 day | Low |
| **Total** | **9-13 days** | |
| 6: Artist features | Ongoing | Varies |

---

## 12. WHAT WE DO NEXT

This is your plan. You can start any phase independently.

The highest-impact, lowest-risk starting point is **Phase 0 + Phase 1** together:
1. Write the new `tokens.css`
2. Refactor `themes.ts` into `palettes.ts` + `buildTokens`
3. Update `themeManager.ts` once to use new names
4. Verify all 14 themes still look right

That alone will delete ~1,000 lines of duplicated code and establish the foundation everything else builds on.

Want me to start writing Phase 0+1?
