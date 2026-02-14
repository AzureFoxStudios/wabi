# Wabi UI Guide

**Version 2.0** | **Last Updated: 2026-02-11**

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Color System](#2-color-system)
3. [Typography](#3-typography)
4. [Layout & Spatial System](#4-layout--spatial-system)
5. [Component Patterns](#5-component-patterns)
6. [Visual Tone & Personality](#6-visual-tone--personality)
7. [Motion & Animation](#7-motion--animation)
8. [Iconography](#8-iconography)
9. [Z-Index Layering System](#9-z-index-layering-system)
10. [Theming Integration](#10-theming-integration)
11. [Accessibility](#11-accessibility)
12. [Anti-Patterns](#12-anti-patterns)

---

## 1. Design Philosophy

### Core Principle: Adaptive Clarity

The interface adapts to user mood (chill / focused) and context (chat, draw, share) while maintaining clarity and usability. **This guide is theme-agnostic** -- it provides design principles that work with any theme.

### Guiding Principles

- **Content-first**: Messages and content receive maximum screen space. Chrome (UI scaffolding) is minimal and contextual.
- **CSS-variable-driven**: All theming happens through well-defined CSS variables. Components never hardcode colors. This enables flexible, user-customizable themes.
- **Purposeful motion**: Every animation serves UX -- guide attention, provide feedback, reduce cognitive load. Never decorative.
- **Flexible personality**: Support both "late-night hangout" and "focused work session" moods through theming. The default Nebula Cosmic theme provides vibrant personality; alternative themes can be professional, minimal, or anything else.
- **Trust through simplicity**: Privacy-focused clarity without sterility. Signal's ethos, Discord's efficiency.
- **Accessible by default**: WCAG AA minimum for all themes, with guidance for custom themes.

### Design Inspirations

**Discord** -- Efficient information density, clear hierarchy, responsive interactions
**Line** -- Playful elements that enhance (not hinder) function, emotional resonance
**Signal** -- Privacy-focused clarity, trust through simplicity, minimal chrome
**VSCode** -- Excellent theming system, professional aesthetic, developer-friendly

### What Makes Wabi Unique

- **Ephemeral by design**: No database, no persistence. The UI should feel lightweight, temporary, freeing.
- **Privacy-first**: Visual design reinforces trust -- no dark patterns, no tracking hints, no corporate bloat.
- **Highly customizable**: Users control color, typography, layout. The guide provides guardrails, not walls.
- **Context-aware**: UI adapts to what you're doing (chatting, drawing, screen sharing). No one-size-fits-all.

---

## 2. Color System

### CSS Variable Architecture (Theme-Agnostic)

Wabi uses **CSS variables** to enable flexible theming while maintaining consistency. Themes define values for these variables; components use variables, never hardcoded colors.

#### Variable Categories

**Background Layers** (Create visual hierarchy)

```css
--bg-primary: /* Main canvas - base surface */
--bg-secondary: /* Raised surfaces (sidebars, panels) */
--bg-tertiary: /* Elevated elements (hover states, modals) */
--bg-hover: /* Interactive element hover state */
```

**Guideline**: Create visual depth through layering. Primary (background) -> secondary (containers) -> tertiary (interactive). This works for any color scheme: dark modes use lighter layers, light modes invert the pattern.

**Text Layers** (Clear information hierarchy)

```css
--text-primary: /* Main content (messages, usernames) */
--text-secondary: /* Supporting info (timestamps, descriptions) */
--text-tertiary: /* Subtle hints (placeholders, disabled states) */
```

**Guideline**: Use primary for content, secondary for metadata, tertiary for disabled/hint text. Ensures scannable information architecture regardless of color choice.

**Accent Colors** (Personality and focus)

```css
--accent: /* Primary brand color (links, active states, CTAs) */
--accent-hex: /* Hex fallback for non-gradient uses */
--accent-hover: /* Interaction feedback (hover, focus) */
```

**Guideline**: Single accent for consistency. Use `--accent-hex` for places where gradients don't work (borders, dots, small indicators).

**Semantic Colors** (Universal meaning across themes)

```css
--status-online: /* User online, success states */
--status-away: /* User away, warnings */
--status-busy: /* User busy, active action needed */
--status-offline: /* User offline, neutral/inactive */
--color-success: /* Confirmations, success messages */
--color-info: /* Information, help text */
--color-warning: /* Caution, warnings */
--color-danger: /* Errors, destructive actions */
```

**Guideline**: These colors carry **universal meaning**. Green always = positive, red always = error. Maintain this across all themes. Users rely on this consistency.

**UI-Specific Variables**

```css
--ui-bg-light: /* Lighter UI element backgrounds */
--ui-bg-lighter: /* Even lighter UI backgrounds */
--ui-text: /* UI text (buttons, labels) */
--ui-text-dark: /* UI text (inverse) */
--border: /* Dividers, component outlines */
```

**Modal-Specific Variables**

```css
--modal-bg: /* Modal background */
--modal-header-bg: /* Modal header background */
--modal-text: /* Modal text */
--modal-overlay: /* Backdrop overlay */
--modal-border: /* Modal borders */
```

### RGB Variants System

Every color variable has an `-rgb` variant for `rgba()` usage:

```css
--accent: #6366f1;
--accent-rgb: 99, 102, 241;

/* Usage */
background: rgba(var(--accent-rgb), 0.1); /* 10% opacity */
box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.2); /* Focus ring */
```

**Why**: Allows flexible opacity without repeating hex calculations. Use RGB variants everywhere you need `rgba()`.

### Opacity Scale System

```css
--opacity-subtle: 0.1;    /* 10% - very light, barely visible */
--opacity-light: 0.15;    /* 15% - light tint */
--opacity-medium: 0.25;   /* 25% - moderate tint */
--opacity-strong: 0.5;    /* 50% - strong tint */
--opacity-heavy: 0.75;    /* 75% - very strong tint */
```

**Usage**: Apply to colors for consistent opacity levels:

```css
background: rgba(var(--accent-rgb), var(--opacity-subtle)); /* 10% accent tint */
border: 1px solid rgba(var(--text-primary-rgb), var(--opacity-light)); /* 15% text border */
```

### Gradients (Optional Design Feature)

Wabi's theme system optionally supports **gradients** for visual richness:

```css
--gradient-primary: linear-gradient(...);
--gradient-accent: linear-gradient(...);
--gradient-accent-hover: linear-gradient(...);
```

**Important**: Gradients are **optional**. Themes can use:
- **Gradient-based**: Nebula Cosmic uses gradients for visual depth and personality
- **Solid color-based**: Professional themes use solid colors for clarity
- **Mixed approach**: Combine both (solid backgrounds + gradient accents)

When designing themes, decide your gradient approach early and stay consistent.

### Color Contrast Requirements

**WCAG 2.1 AA Compliance** (minimum):

- **Text on background**: 4.5:1 minimum (7:1 for AAA)
- **Large text (18px+)**: 3:1 minimum
- **UI components**: 3:1 against adjacent colors
- **Status indicators**: Distinguishable by shape + color (colorblind-friendly)

**Testing**: Use [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/) or browser DevTools.

### Theme Consistency Guidelines

**Maintain across all themes**:
- Semantic color meanings (green = success, red = error)
- Text layer hierarchy (primary > secondary > tertiary)
- Sufficient contrast for accessibility
- Consistent accent usage (don't use multiple brands)

**Can vary by theme**:
- Specific hex/RGB values (adapt to theme palette)
- Whether to use gradients (cosmic yes, professional no)
- Background layer saturation (vibrant vs. muted)
- Accent intensity (subtle vs. bold)

### Theme Personality Guidelines

**"Chill" Themes** (Late-night hangout vibes):
- Warmer hues (purples, teals, warm grays)
- Softer contrast (not harsh)
- Playful accents (rounded corners, friendly colors)
- Example: Nebula Cosmic (default)

**"Focused" Themes** (Productivity, developer-friendly):
- Cooler hues (blues, grays, desaturated)
- Higher contrast (crisp, readable)
- Professional accents (minimal saturation)
- Example: VS Code High Contrast

**Custom Themes**:
- Users can override all CSS variables via ThemeCustomizer
- Presets follow guidelines; custom themes can break rules (user's choice)

### What to Avoid

- **Pure black backgrounds** (#000000) -- Harsh, cheap-looking, increases eye strain (exception: high-contrast accessibility themes)
- **Over-saturated colors** -- Fatiguing for long sessions, unprofessional
- **Low-contrast grays** -- Inaccessible, "modern" trend that harms readability
- **Too many accent colors** -- Visual chaos, no clear focus

---

## 3. Typography

### Typography Philosophy

**Legibility over style**. Body text should be effortless to read for hours. Hierarchy should be clear through size and weight, not decoration.

### Font Stacks

#### Default (System Fonts)

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
             'Roboto', 'Helvetica Neue', Arial, sans-serif;
```

**Why**: Native, fast, familiar. Users are comfortable with their OS fonts. Zero web font load time.

#### Uniform Font Override

Users can set a custom font family via the Uniform Font Mode (`UniformFontMode.svelte`). All text inherits this override via CSS variables:

```css
--uniform-font-family: inherit | [custom font];
--uniform-font-size: inherit | [custom size];
--uniform-font-weight: inherit | [custom weight];
--uniform-font-style: inherit | [custom style];
```

#### Monospace (Code, Technical Content)

```css
font-family: 'JetBrains Mono', 'Fira Code', 'Consolas',
             'SF Mono', Monaco, monospace;
```

**Usage**: Code blocks, technical metadata, file paths.

### Type Scale

**1.25 ratio** for clear hierarchy:

```css
--text-xs: 11px;      /* Timestamps, metadata */
--text-sm: 13px;      /* Secondary info, captions */
--text-base: 14px;    /* Body text, messages (default) */
--text-lg: 16px;      /* Usernames, headings */
--text-xl: 20px;      /* Modal titles, page headings */
--text-2xl: 24px;     /* Hero elements (rare, use sparingly) */
```

### Typography Treatments

#### 1. Messages (Primary Content)

```css
font-size: var(--text-base);     /* 14px */
line-height: 1.5;                 /* Readable, not cramped */
color: var(--text-primary);
font-weight: 400;                 /* Regular */
max-width: 680px;                 /* Optimal reading ~70 characters */
```

**Why**: 14px is the sweet spot for chat -- dense enough to see history, large enough to read comfortably. 1.5 line-height prevents text from feeling cramped.

#### 2. Usernames (Quick Scanning)

```css
font-size: var(--text-base);     /* 14px */
font-weight: 600;                 /* Semibold */
color: var(--accent);             /* Or user-specific color */
```

**Interaction**: Hover shows subtle underline or color change. Clickable for profile/mention.

**Never**: All-caps (accessibility issue, harder to read).

#### 3. Timestamps (Contextual, Non-Intrusive)

```css
font-size: var(--text-xs);       /* 11px */
color: var(--text-secondary);     /* Low contrast */
font-weight: 400;
```

**Format**:
- Relative: "2m ago", "1h ago", "Yesterday"
- Absolute on hover: "3:45 PM" or "Jan 24, 3:45 PM"

**Position**: Adjacent to message, right-aligned or inline. Never hidden by default.

#### 4. System Messages (Distinct from User Content)

```css
font-size: var(--text-sm);       /* 13px */
color: var(--text-secondary);
font-style: italic;               /* Or distinct background */
```

**Examples**: "Alice joined the channel", "Bob pinned a message", "Carol is typing..."

#### 5. Headings (Navigation, Modals)

```css
font-size: var(--text-xl);       /* 20px */
font-weight: 600;                 /* Semibold */
color: var(--text-primary);
margin-bottom: 16px;              /* Generous spacing */
```

**Never**: Overly large headings (>24px for modals). This isn't a website hero section.

### What to Avoid

- **Thin fonts** (200-300 weight) for body text -- Trendy but unreadable, especially on low-DPI screens
- **All-caps headings** -- Accessibility issue, harder to scan
- **Overly large headings** -- Website thinking, wastes space
- **Low line-height** (<1.4) -- Text feels cramped, hard to read

---

## 4. Layout & Spatial System

### Grid Philosophy: Messages-First, Context-Aware Chrome

**Core Principle**: Content (messages, drawings, shared screens) gets maximum space. Navigation and metadata are minimal, collapsible, and context-aware.

### Main Chat Layout (Three-Column Adaptive)

```
+---------------------------------------------------------------------+
| [Channels]  |       [Messages (primary)]       |  [Right Panel]     |
|   280px     |          flex-grow: 1             |     320px          |
|             |                                   |                    |
| # general   | [Message Thread]                  | [Users] [DMs] [x] |
| # random    |                                   | +-----------------+|
| # design    | Alice: Hey there!                 | | Alice  [online] ||
|             | Bob: Hey!                          | | Bob    [online] ||
| ----------- | Carol: How's it going?            | | Carol  [away]   ||
| [Profile]   |                                   | |                 ||
| [Settings]  | [Input box]                       | |                 ||
|             |                                   | +-----------------+|
+---------------------------------------------------------------------+
```

**Three-Column Layout**:
- **Left (280px default)**: Channel sidebar -- channels, profile card, settings. Collapsible to 60px (compact/icons-only) or 0px (hidden). Max drag width: 400px.
- **Center (flex: 1)**: Message thread (primary content) -- fills all remaining space.
- **Right (320px default)**: Tabbed panel with Users and DMs tabs. Collapsible to 0px (hidden). Min snap width: 250px, max drag width: 500px.

### Panel Interaction Contracts

#### Channel Sidebar (Left Panel)

| Property | Value |
|----------|-------|
| Default width | 280px |
| Compact width | 60px (icons only) |
| Hidden width | 0px |
| Max drag width | 400px |
| Snap behavior | <30px -> 0, <170px -> 60px, else -> 280px |
| Resize handle | Right edge, 6px hit area |
| Mobile behavior | Full-screen overlay, z-index 1500 |
| Persistence | Width snaps on mouse-up, no localStorage persistence |

#### Right Panel

| Property | Value |
|----------|-------|
| Default width | 320px |
| Min snap width | 250px |
| Hidden width | 0px (auto-closes rightPanelView) |
| Max drag width | 500px |
| Snap behavior | <30px -> close, <200px -> 250px |
| Resize handle | Left edge, 6px hit area |
| Toggle button | Right screen edge, visible at 0.3 opacity when panel closed |
| Mobile behavior | Full-screen overlay, z-index 1500 |
| Tab state | Remembers last active tab (Users/DMs) on reopen |
| Persistence | Panel view state not persisted across sessions |

#### Right Panel Toggle (Desktop)

The toggle button sits on the right edge of the viewport when the panel is closed:
- **Dimensions**: 24px wide x 64px tall
- **Position**: Vertically centered, right: 0
- **Resting opacity**: 0.3 (visible but unobtrusive)
- **Hover opacity**: 1.0 with accent background
- **Mobile**: Hidden (bottom nav handles panel toggling)

### Responsive Breakpoints

Wabi uses two breakpoints:

```css
/* Tablet / Mobile */
@media (max-width: 768px) {
  /* Single-column layout
   * Side panels become full-screen overlays (z-index 1500)
   * Bottom navigation bar appears (56px, z-index 2000)
   * App container height: calc(100dvh - 56px)
   * iOS zoom prevention: input font-size forced to 16px
   * Touch improvements: touch-action: manipulation */
}

/* Small phones */
@media (max-width: 480px) {
  /* Reduced padding and font sizes for compact screens */
}
```

**Mobile Bottom Navigation** (56px):
- Four tabs: Chat, Channels, Users, Hub
- Only one panel visible at a time (mutual exclusion)
- Channels and Users are full-screen overlays
- Safe area support for notched devices

### Spacing System (Rem-Based, 4px Base Unit)

```css
--space-1: 0.25rem;  /* 4px */
--space-2: 0.5rem;   /* 8px */
--space-3: 0.75rem;  /* 12px */
--space-4: 1rem;     /* 16px */
--space-5: 1.25rem;  /* 20px */
--space-6: 1.5rem;   /* 24px */
--space-8: 2rem;     /* 32px */
--space-10: 2.5rem;  /* 40px */
--space-12: 3rem;    /* 48px */
--space-16: 4rem;    /* 64px */
```

**Usage patterns**:
- **Inline spacing** (icons, small gaps): `var(--space-2)` (8px)
- **Component padding** (buttons, inputs): `var(--space-2) var(--space-4)` (8px 16px)
- **Message gaps**: `var(--space-2)` same user, `var(--space-4)` user change
- **Section padding**: `var(--space-3)` to `var(--space-6)` (12-24px)
- **Modal/panel padding**: `var(--space-6)` (24px)

**Always use spacing tokens** -- don't hardcode arbitrary rem or px values.

### Layout Patterns

#### 1. Message List (Vertical Rhythm)

```
+---------------------------------------------------------+
|  [Avatar]  Username * Timestamp                         |
|            Message text content here...                  |
|                                                  1rem    | <- Gap for user change
|  [Avatar]  OtherUser * Timestamp                        |
|            Another message...                            |
|                                                0.5rem    | <- Gap for same user
|            Follow-up message from same user...           |
+---------------------------------------------------------+
```

**Specs** (actual implementation):
- **Avatar**: 40px x 40px, left-aligned, top of message
- **Message padding**: 0.75rem (12px)
- **Gap between avatar/content**: 0.75rem (12px)
- **Message spacing**: 0.5rem (8px) same user, 1rem (16px) user change
- **Max width**: 680px (optimal reading length ~70 characters)

#### 2. Sidebar (Channels) -- Efficient Scanning

```
+--------------------------+
| # general          [99]  |  <- Unread badge
| # random                 |
| # design                 |
| -----------------------  |  <- Divider
| [Profile Card]           |
| [Mute] [Deafen]         |
+--------------------------+
```

**Specs**:
- **Item height**: 36-40px (compact but touch-friendly)
- **Icon**: 20px, left-aligned with 12px padding
- **Text**: Single line, ellipsis overflow
- **Hover**: Full-width background change (`--bg-tertiary`)
- **Active**: Left border (4px `--accent`) or accent background tint
- **Unread badge**: Right-aligned, accent background, white text

#### 3. Right Panel (Tabbed: Users | DMs)

The right panel uses a simple two-zone layout: **tabs + content**.

```
+-----------------------------+
| [Users] [DMs]         [x]  |  <- Tab bar (flex, border-bottom)
+-----------------------------+
| [Avatar] Alice  [online]    |
| [Avatar] Bob    [online]    |  <- Scrollable content
| [Avatar] Carol  [away]      |     (active tab)
|                              |
+-----------------------------+
```

**Tab Bar**:
- Flex row with tab buttons + spacer + close button
- Active tab: accent color text + 2px accent bottom border
- Background: `var(--bg-tertiary)`

**Content Area**:
- `flex: 1; min-height: 0; overflow: hidden`
- Renders either `UserListTab` or `DMTab` based on active tab

**Users Tab**: Role-grouped list (Owner > Admin > Mod > Online > Guest), click to start DM.
**DMs Tab**: Two sub-views -- conversation list (sorted by recency) and active DM chat view.

#### 4. Modals (Focused, Escapable)

```css
.modal-content {
  max-width: 540px;
  border-radius: var(--radius-lg);  /* 12px */
  background: var(--modal-bg);
  border: 1px solid rgba(179, 179, 255, 0.2);
  box-shadow: 0 8px 32px rgba(255, 0, 255, 0.15);
  backdrop-filter: blur(8px);       /* On overlay */
}
```

**Variants**:
- **Center** (default): Centered in viewport, max-width 540px
- **Right-panel**: Slides in from right, 400px wide, full height
- **Full-screen**: 100% width/height

**Interaction**:
- **Close**: X button (top-right), ESC key, click backdrop
- **Focus**: First interactive element on open
- **Return focus**: To trigger element on close

### What to Avoid

- **Centered layouts for everything** -- Website thinking, breaks scanning patterns
- **Excessive whitespace** -- Wastes screen real estate, reduces information density
- **Fixed pixel values everywhere** -- Breaks responsiveness; use spacing tokens
- **Floating cards with heavy shadows** -- Dated, cluttered

---

## 5. Component Patterns

### 5.1 Message Components

#### Message Item Structure

```
+---------------------------------------------------------+
| [Avatar]  Username * Timestamp                  [hover]  |
|           Message text content here...                   |
|           Multi-line messages maintain readable           |
|           line length and comfortable spacing.            |
|           +----------------------------+                 |
|           | [Attachment/Embed]         |                 |
|           +----------------------------+                 |
|           [React] [Edit] [Delete]                        |
+---------------------------------------------------------+
```

#### Design Specs

```css
.message {
  display: flex;
  gap: 0.75rem;                   /* 12px - Space between avatar and content */
  padding: 0.75rem;               /* 12px - Compact message padding */
  margin-bottom: 0.5rem;          /* 8px - Same user spacing */
  border-radius: 0;               /* Sharp corners (theme override to 6px) */
}

.message:not(.same-user) {
  margin-top: 16px;               /* Different user - larger gap */
}

.message:hover {
  background: rgba(var(--bg-secondary-rgb), 0.6);  /* Subtle hover tint */
}

.message-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  flex-shrink: 0;
}

.message-content {
  flex: 1;
  max-width: 680px;
}

.message-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 4px;
  opacity: 0;
  transition: opacity 200ms ease-out;
}

.message:hover .message-actions {
  opacity: 1;                     /* Reveal on hover */
}
```

#### Message States

- **Sending**: `opacity: 0.6` with spinner
- **Sent**: Full opacity (default)
- **Failed**: `border-left: 3px solid var(--error)` with retry button
- **Edited**: `(edited)` label in `--text-tertiary` at 11px
- **Deleted**: Tombstone with italic `--text-secondary` text
- **Pinned**: `border-left: 3px solid var(--accent)` with accent background tint

### 5.2 Input Components

#### Message Input Field

```css
.message-input {
  width: 100%;
  min-height: 44px;               /* Touch-friendly */
  max-height: 200px;              /* Auto-expand up to ~10 lines */
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  resize: none;
}

.message-input:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: var(--shadow-focus-ring);
}
```

### 5.3 Button Components

#### Button Hierarchy

Wabi defines five button variants in `app.css`:

| Variant | Class | Background | Use Case |
|---------|-------|------------|----------|
| Primary | `.btn-primary` | `var(--accent)` | Main CTAs |
| Secondary | `.btn-secondary` | transparent + border | Alternative actions |
| Ghost | `.btn-ghost` | transparent | Subtle, icon buttons |
| Danger | `.btn-danger` | `var(--color-danger)` | Destructive actions |
| Icon | `.btn-icon` | transparent (32x32px) | Icon-only buttons |

**Sizes**: `.btn-sm` (28px), default (36px), `.btn-lg` (44px)

**Padding**: All variants use spacing tokens -- `var(--space-2) var(--space-4)` for standard, `var(--space-2)` for ghost/icon.

#### Button Interaction

```css
button:hover { background: var(--bg-hover); }
button:active { transform: scale(0.98); }
button:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-primary:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-sm);
}
```

### 5.4 Navigation Components

#### Sidebar Item (Channels)

```css
.sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 6px 12px;
  border-left: 3px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  transition: all 100ms ease;
}

.sidebar-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.sidebar-item[aria-current="page"] {
  background: var(--bg-tertiary);
  border-left-color: var(--accent);
  color: var(--text-primary);
  font-weight: 600;
}
```

#### Context Menu

```css
.context-menu {
  position: absolute;
  min-width: 200px;
  padding: 4px;
  border-radius: 8px;
  background: var(--bg-secondary);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  z-index: var(--z-modal);
}
```

---

## 6. Visual Tone & Personality

### Philosophy: Alive Without Being Noisy

Wabi is a communication tool people live in for hours. The UI should feel **warm and lived-in**, not sterile or corporate. But personality must never compete with content.

### Where Personality Belongs

**Accent color**: The single strongest expression of personality. Nebula Cosmic's magenta gradient says "creative, bold, fun" without touching content readability.

**Transitions and micro-interactions**: A button that lifts 1px on hover, a tab underline that slides into place, a modal that scales up gently -- these moments of polish add character.

**Empty states**: When there's no content, the UI can be more expressive. A friendly message, a subtle illustration, a playful copy line. "No messages yet -- say something!" is better than a blank void.

**Status indicators**: Small touches like pulsing online dots, smooth presence transitions, and typed-out "is typing..." indicators add life.

### Where Personality Does NOT Belong

**Message content area**: Zero decorative elements. Messages are sacred -- the only visual treatment should be functional (hover actions, selection highlight, edited label).

**Navigation chrome**: Sidebar items, tab buttons, panel headers. These are tools, not canvases. Keep them clean and scannable.

**Loading states**: A spinner is fine. An animated mascot is not. Keep loading indicators functional and fast.

### Controlled Flair Guidelines

| Element | Allowed | Not Allowed |
|---------|---------|-------------|
| Hover effects | translateY(-1px), subtle glow | Bounce, shake, rotate |
| Active states | scale(0.98), color shift | Flash, pulse, ripple |
| Panel transitions | 200-300ms slide/fade | Spring physics, overshoot |
| Tab underlines | Smooth color transition | Animated slide between tabs |
| Status dots | Solid color, optional fade-in | Pulsing, breathing, blinking |
| Accent usage | Borders, text, backgrounds | Gradients on everything, neon glow |

### Long-Session Comfort

These choices directly impact usability during long sessions:

- **Low-saturation backgrounds**: Rich near-blacks (#1a1a2e range), never pure black or over-saturated
- **High-contrast text**: `--text-primary` should always be clearly legible
- **Generous line-height**: 1.5 for body text, 1.25 for headings
- **Consistent visual rhythm**: One spacing scale, applied everywhere
- **Minimal unprompted animation**: No blinking, pulsing, or decorative motion
- **User-initiated interactions only**: Animations respond to clicks/hovers, never auto-play

---

## 7. Motion & Animation

### Philosophy: Purposeful, Not Decorative

Every animation should:
1. **Guide attention** -- Show users where to look after an action
2. **Provide feedback** -- Confirm interactions (button press, message sent)
3. **Reduce cognitive load** -- Smooth transitions prevent jarring changes
4. **Respect user preferences** -- Honor `prefers-reduced-motion`

**Never**: Animate for decoration. No spinning logos, pulsing elements, or parallax scrolling.

### Timing Standards (Fast, Snappy)

```css
--duration-instant: 100ms;   /* Micro-interactions (hover, focus, button press) */
--duration-fast: 150ms;      /* Quick transitions (original micro timing) */
--duration-normal: 250ms;    /* Transitions (panel open/close, navigation) */
--duration-slow: 300ms;      /* Animations (modals, toasts, complex state changes) */

/* Never exceed 500ms (feels sluggish) */
```

### Easing Functions

```css
--ease-out: cubic-bezier(0, 0, 0.2, 1);      /* Elements entering (decelerating) */
--ease-in: cubic-bezier(0.4, 0, 1, 1);       /* Elements exiting (accelerating) */
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1); /* Position changes */
```

### Animation Patterns

#### Message Appearance
```css
@keyframes slideInMessage {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
.message.new { animation: slideInMessage 200ms var(--ease-out); }
```

#### Modal Enter/Exit
```css
@keyframes modalEnter {
  from { opacity: 0; transform: scale(0.95) translateY(-10px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
/* Enter: 200ms ease-out, Exit: 200ms ease-in */
```

#### Toast Notification
```css
@keyframes toastSlide {
  from { transform: translateX(400px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
/* Enter: 250ms ease-out, Dismiss: 200ms ease-in reverse */
```

### Hover Micro-Interactions

```css
/* Button */
.button:hover { transform: translateY(-1px); }
.button:active { transform: translateY(0) scale(0.98); }

/* Message actions reveal */
.message-actions { opacity: 0; transition: opacity 150ms ease; }
.message:hover .message-actions { opacity: 1; }
```

### Controlled Flair in Motion

Tasteful motion adds personality. These are explicitly encouraged:

- **Tab underlines**: Smooth `border-color` transition on tab switch (150ms)
- **Panel toggle**: Fade-in from low opacity to full on hover
- **Button lift**: 1px translateY on hover for primary buttons
- **Modal backdrop**: Blur(8px) with fade-in creates depth
- **Active press**: `scale(0.98)` gives tactile feedback

What to avoid: spring/bounce physics, overshoot animations, auto-playing decorative loops.

### Reduced Motion Support

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 8. Iconography

### Style: Inline SVG, Consistent, Functional

Wabi uses **inline SVG** exclusively for UI icons. No external icon libraries (Lucide, Heroicons, etc.) are loaded -- all icons are embedded directly in component markup.

### Why Inline SVG

- **Zero network requests** -- Icons render immediately
- **Full CSS control** -- `stroke`, `fill`, `color` inherit from parent via `currentColor`
- **No dependency** -- No library version management or bundle bloat
- **Pixel-perfect** -- SVGs at exact sizes, no scaling artifacts

### Icon Sizes

```css
--icon-sm: 16px;      /* Inline with text, metadata, tab icons */
--icon-md: 20px;      /* Buttons, toolbar, navigation (default) */
--icon-lg: 24px;      /* Prominent actions, mobile nav, modal close */
```

### SVG Conventions

All inline SVGs in Wabi follow this pattern:

```html
<svg width="20" height="20" viewBox="0 0 24 24"
     fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
  <!-- paths here -->
</svg>
```

- **viewBox**: Always `0 0 24 24` (standard 24x24 grid)
- **width/height**: Set to desired display size (16, 20, or 24)
- **stroke**: `currentColor` so icons inherit text color
- **fill**: `none` for outlined style (default)
- **stroke-width**: 2 (standard), 1.5 for 16px icons

### Icon States

- **Default**: `color: var(--text-secondary)`
- **Hover**: `color: var(--text-primary)` or `color: var(--accent-hex)`
- **Active**: Filled variant or accent color
- **Disabled**: `opacity: 0.5`

### Usage Patterns

#### Navigation Icons (Mobile Bottom Nav)
- Size: 20-24px
- Color: `currentColor` inheriting from button
- Active: `color: var(--accent)`

#### Action Icons (Message Actions, Toolbars)
- Size: 16-20px
- Appear on hover (`opacity: 0 -> 1`)
- Ghost button wrapper for hit area

#### Status Indicators
- Size: 8-10px circles (CSS, not SVG)
- Colors: `--status-online`, `--status-away`, etc.
- Must be distinguishable by shape + color for colorblind users

### What to Avoid

- **External icon libraries** -- Don't add Lucide, Heroicons, etc. as dependencies
- **Mixing icon styles** -- Keep all icons outlined with consistent stroke-width
- **Inconsistent sizing** -- Use only 16, 20, 24px sizes
- **Icon-only buttons without labels** -- Always add `aria-label` for accessibility

---

## 9. Z-Index Layering System

### Tier System

Wabi defines z-index tiers as CSS tokens to prevent the chaos of arbitrary values:

```css
--z-base: 0;          /* Default stacking context */
--z-sticky: 100;      /* Sticky headers, resize handles */
--z-dropdown: 200;    /* Dropdowns, mobile panel overlays */
--z-overlay: 1000;    /* Modals, popovers, context menus */
--z-modal: 1500;      /* Call modals, mobile panel overlays */
--z-toast: 2000;      /* Toasts, mobile bottom nav, top-level notifications */
```

### Layer Map

| Z-Index Range | Token | Used For |
|---------------|-------|----------|
| 0 | `--z-base` | Default content, message list, backgrounds |
| 1-50 | (component internal) | Internal stacking within components |
| 100 | `--z-sticky` | Resize handles, sticky headers, dropdowns |
| 200 | `--z-dropdown` | Mobile panel overlays (old), emoji picker |
| 999-1000 | `--z-overlay` | Context menus, modals (BaseModal), popovers |
| 1001 | -- | Avatar editor (above modal) |
| 1500 | `--z-modal` | Call modal, mobile sidebar/panel overlays |
| 2000 | `--z-toast` | Mobile bottom nav, PureRef viewer, call views |
| 3000+ | -- | Hamburger menu (emergency full-screen) |
| 9000-10000 | -- | Auth error banner, login page (page-level) |

### Rules

1. **Always use tier tokens** for new z-index values in components
2. **Never invent arbitrary z-index values** (no `z-index: 9999` to "make sure it's on top")
3. **Create new stacking contexts** with `isolation: isolate` when a component needs internal layering
4. **Document exceptions** -- if a component needs a value outside the tiers, comment why
5. **Mobile overlays** share z-index 1500; mutual exclusion is handled by JavaScript (only one visible at a time), not z-index stacking

---

## 10. Theming Integration

### Working with the Existing Theme System

Wabi's theme system (`frontend/src/lib/theme/`) is robust and well-architected. All theming happens through CSS variables defined in `themes.ts` and applied to `:root` at runtime.

**Key files**:
- `themeStore.ts` -- Svelte store for theme state
- `themes.ts` -- Theme definitions (presets + custom) with `ThemeColors` and `ThemeGradients`
- `themeManager.ts` -- Applies themes to DOM via CSS variables
- `themeApi.ts` -- HTTP client for theme persistence
- `initTheme.ts` -- Theme initialization on app load

### Available Themes

| ID | Name | Personality |
|----|------|------------|
| `dark` | Nebula Cosmic | Vibrant, space-inspired, gradient-heavy (default) |
| `light` | Light | Clean, bright, purple accent |
| `midnight-blue` | Midnight Blue | Deep navy, cyan accent, calm |
| `vscode-high-contrast` | VS Code High Contrast | Pure black, electric blue borders, accessibility-first |
| `professional` | Professional | Light gray, indigo accent, business-friendly |
| `minimal` | Minimal | Off-white, blue accent, distraction-free |

### How Components Use Themes

**All color must use CSS variables** for theme compatibility.

```css
/* Never hardcode colors */
.button { background: var(--accent); }
.button:hover { box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.2); }
```

### Theme Application Flow

```typescript
// 1. User selects theme in Settings/ThemeCustomizer
themeStore.setTheme('professional');

// 2. themeManager reads theme definition
// 3. Converts all theme colors/gradients to CSS variables
// 4. Applies variables to :root element + sets data-theme attribute
applyTheme(theme);

// 5. Persistence: server-side for registered users, localStorage for guests
```

### Default Theme: Nebula Cosmic

**Characteristics**:
- **Gradients**: Background and accent use `linear-gradient` for depth
- **Color Palette**: Deep blues (#0f0c29, #1a1a2e), magenta accent (#ff00ff -> #ff69b4)
- **Status**: Neon green online, gold away, slate gray offline
- **Personality**: Creative, bold, unique

### Custom Themes (User-Defined)

Users can override all CSS variables via the **ThemeCustomizer** UI. The app shows contrast warnings for low-contrast combinations but allows user override. Custom themes persist to backend for registered users.

---

## 11. Accessibility

### WCAG 2.1 AA Compliance (Minimum)

Wabi aims for **WCAG 2.1 Level AA** as a baseline, with some AAA targets.

### Color Contrast

- **Text on background**: 4.5:1 minimum (7:1 for AAA)
- **Large text (18px+)**: 3:1 minimum
- **UI components**: 3:1 against adjacent colors
- **Focus indicators**: 3:1 against background

### Keyboard Navigation

All interactive elements must be keyboard-accessible.

- **Focus Order**: Logical, follows visual flow (top to bottom, left to right)
- **Focus Indicators**: `box-shadow: var(--shadow-focus-ring)` -- 3px accent ring

**Keyboard Shortcuts**:
- `Esc` -- Close modals, cancel actions
- `Enter` -- Select/activate, send message
- `Tab` / `Shift+Tab` -- Navigate interactive elements

**Never**: Remove focus outlines without replacing with a visible alternative.

### Screen Readers

- **Semantic HTML**: Use `<button>`, `<nav>`, `<main>`, not `<div>` with click handlers
- **ARIA Labels**: For icon-only buttons (`aria-label="Delete message"`)
- **ARIA Live Regions**: For dynamic content (new messages, typing indicators)
- **Alt Text**: For images and avatars

### Focus Management

**Modals**: Focus first interactive element on open, return focus to trigger on close. Trap focus inside modal while open.

### Reduced Motion

Respect `prefers-reduced-motion` -- all animations become effectively instant.

### Touch Targets (Mobile)

- **Minimum size**: 44x44px
- **Spacing**: Minimum 8px between interactive elements
- **Safe area**: Support `env(safe-area-inset-bottom)` for notched devices

---

## 12. Anti-Patterns

### Generic AI Website Aesthetics

AI-generated websites share a predictable, sterile aesthetic. Wabi avoids:

- **Excessive whitespace** -- Wastes screen space, reduces information density
- **Centered layouts** -- Breaks natural scanning patterns; chat apps are left-aligned
- **Overly large headings** -- Hero section vibes don't belong in modals (20-24px max)
- **Gradient backgrounds on everything** -- Visual noise. Use gradients selectively (accent, background) or not at all
- **Heavy box shadows** -- Dated. Use flat layering with subtle background shade differences
- **Thin fonts (200-300 weight)** -- Trendy but unreadable for long sessions
- **All-caps headings** -- Harder to read, accessibility issue
- **Auto-playing animations** -- Distracting, fatiguing, motion sickness risk

### Theme System Anti-Patterns

```css
/* Never hardcode colors */
.button { background: #6366f1; }          /* Breaks theming */

/* Never mix hardcoded and variables */
.card { background: var(--bg-secondary); border: 1px solid #404050; }

/* Use RGB variants for opacity, not hardcoded values */
.button:hover { box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.2); }  /* Correct */
```

### Chat-Specific Anti-Patterns

**Message display**:
- Avoid alternating left/right messages in group chats -- breaks scanning
- Don't hide timestamps entirely -- context matters
- Don't use tiny avatars (<24px) -- harder to track speakers

**Subtle bubbles are OK**: The blanket "no bubbles" rule is overstated. A subtle background tint on own messages (like `rgba(var(--accent-rgb), 0.05)`) aids readability without the iMessage-clone problem. What to avoid is heavy rounded bubbles with tails in group chats.

**Smart auto-scroll**: Only auto-scroll if user is at bottom. Show "new messages" indicator if scrolled up.

---

## Conclusion

This guide provides a foundation for Wabi's UI/UX. It establishes principles to maintain consistency, accessibility, and personality while leaving room for creative expression.

**Core Principles**:
1. **Content-first**: Messages get max space, chrome is minimal
2. **UX before aesthetics**: Never sacrifice usability for uniqueness
3. **Accessible by default**: WCAG AA minimum
4. **Purposeful motion**: Animations serve UX, not decoration
5. **Controlled personality**: Express character through accent color, micro-interactions, and empty states -- never through noise

**Integration**:
- This guide complements `ARCHITECTURE.md` (technical docs)
- Works with existing theme system (`frontend/src/lib/theme/`)
- Reference when building components (`frontend/src/lib/components/`)

**This is a living document.** Update as patterns evolve.
