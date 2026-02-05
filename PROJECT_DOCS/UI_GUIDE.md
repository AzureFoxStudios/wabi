# Wabi UI Guide

**Version 1.0** | **Last Updated: 2026-01-25**

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Color System](#2-color-system)
3. [Typography](#3-typography)
4. [Layout & Spatial System](#4-layout--spatial-system)
5. [Component Patterns](#5-component-patterns)
6. [Motion & Animation](#6-motion--animation)
7. [Iconography](#7-iconography)
8. [Theming Integration](#8-theming-integration)
9. [Accessibility](#9-accessibility)
10. [Anti-Patterns](#10-anti-patterns)

---

## 1. Design Philosophy

### Core Principle: Adaptive Clarity

The interface adapts to user mood (chill ↔ focused) and context (chat, draw, share) while maintaining clarity and usability. **This guide is theme-agnostic**—it provides design principles that work with any theme.

### Guiding Principles

- **Content-first**: Messages and content receive maximum screen space. Chrome (UI scaffolding) is minimal and contextual.
- **CSS-variable-driven**: All theming happens through well-defined CSS variables. Components never hardcode colors. This enables flexible, user-customizable themes.
- **Purposeful motion**: Every animation serves UX—guide attention, provide feedback, reduce cognitive load. Never decorative.
- **Flexible personality**: Support both "late-night hangout" and "focused work session" moods through theming. The default Nebula Cosmic theme provides vibrant personality; alternative themes can be professional, minimal, or anything else.
- **Trust through simplicity**: Privacy-focused clarity without sterility. Signal's ethos, Discord's efficiency.
- **Accessible by default**: WCAG AA minimum for all themes, with guidance for custom themes.

### Design Inspirations

**Discord** - Efficient information density, clear hierarchy, responsive interactions
**Line** - Playful elements that enhance (not hinder) function, emotional resonance
**Signal** - Privacy-focused clarity, trust through simplicity, minimal chrome
**VSCode** - Excellent theming system, professional aesthetic, developer-friendly

### What Makes Wabi Unique

- **Ephemeral by design**: No database, no persistence. The UI should feel lightweight, temporary, freeing.
- **Privacy-first**: Visual design reinforces trust—no dark patterns, no tracking hints, no corporate bloat.
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

**Guideline**: Create visual depth through layering. Primary (background) → secondary (containers) → tertiary (interactive). This works for any color scheme: dark modes use lighter layers, light modes invert the pattern.

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

### Color Contrast Requirements

**WCAG 2.1 AA Compliance** (minimum):

- **Text on background**: 4.5:1 minimum (7:1 for AAA)
- **Large text (18px+)**: 3:1 minimum
- **UI components**: 3:1 against adjacent colors
- **Status indicators**: Distinguishable by shape + color (colorblind-friendly)

**Testing**: Use [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/) or browser DevTools.

### Theme Personality Guidelines

**"Chill" Themes** (Late-night hangout vibes):
- Warmer hues (purples, teals, warm grays)
- Softer contrast (not harsh)
- Playful accents (rounded corners, friendly colors)
- Example: Midnight Blue (default)

**"Focused" Themes** (Productivity, developer-friendly):
- Cooler hues (blues, grays, desaturated)
- Higher contrast (crisp, readable)
- Professional accents (minimal saturation)
- Example: High Contrast (VSCode-inspired)

**Custom Themes**:
- Users can override all CSS variables via ThemeCustomizer
- Presets follow guidelines; custom themes can break rules (user's choice)

### What to Avoid

❌ **Pure black backgrounds** (#000000) - Harsh, cheap-looking, increases eye strain
❌ **Over-saturated colors** - Fatiguing for long sessions, unprofessional
❌ **Low-contrast grays** - Inaccessible, "modern" trend that harms readability
❌ **Too many accent colors** - Visual chaos, no clear focus

✅ **Rich near-blacks** (#1a1a1d, #0d1117 GitHub-style) - Professional, easier on eyes
✅ **Balanced saturation** - Vibrant but not neon
✅ **Single primary accent** - Clear focus, semantic colors for meaning
✅ **High contrast by default** - Accessibility first, aesthetics second

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

**Why**: Native, fast, familiar. Users are comfortable with their OS fonts.

#### Uniform Font Override

Users can set a custom font family via the Uniform Font Mode (`UniformFontMode.svelte`). All text inherits this override.

#### Monospace (Code, Technical Content)

```css
font-family: 'JetBrains Mono', 'Fira Code', 'Consolas',
             'SF Mono', Monaco, monospace;
```

**Usage**: Code blocks, technical metadata, timestamps (optional), file paths.

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

**Why**: 14px is the sweet spot for chat—dense enough to see history, large enough to read comfortably. 1.5 line-height prevents text from feeling cramped.

#### 2. Usernames (Quick Scanning)

```css
font-size: var(--text-base);     /* 14px or 16px */
font-weight: 600;                 /* Semibold or bold */
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
/* Modal/page headings */
font-size: var(--text-xl);       /* 20px */
font-weight: 600;                 /* Semibold */
color: var(--text-primary);
margin-bottom: 16px;              /* Generous spacing */
```

**Never**: Overly large headings (>24px for modals). This isn't a website hero section.

### What to Avoid

❌ **Thin fonts** (200-300 weight) for body text - Trendy but unreadable, especially on low-DPI screens
❌ **All-caps headings** - Accessibility issue, harder to scan, SHOUTY
❌ **Overly large headings** - Website thinking, wastes space
❌ **Low line-height** (<1.4) - Text feels cramped, hard to read

✅ **Regular (400) or medium (500) weight** for body - Readable for hours
✅ **Sentence case** - Natural, easy to scan
✅ **Appropriate sizing** - 20-24px max for headings
✅ **Generous line-height** (1.5) - Comfortable reading

---

## 4. Layout & Spatial System

### Grid Philosophy: Messages-First, Context-Aware Chrome

**Core Principle**: Content (messages, drawings, shared screens) gets maximum space. Navigation and metadata are minimal, collapsible, and context-aware.

### Main Chat Layout (Three-Column Adaptive)

```
┌─────────────────────────────────────────────────────────────────┐
│ [Channels]  │  [Messages (primary)]  │  [DM Panel]             │
│  200-240px  │    flex-grow: 1        │  240-300px              │
│             │                        │  ┌─────────────────────┐│
│ • general   │ [Message Thread]       │ │ Direct Messages  [+]││
│ • random    │                        │ ├─────────────────────┤│
│ • design    │ Alice: Hey there!      │ │Messages  │ Users   ││
│             │ Bob: Hey!              │ ├─────────────────────┤│
│ ─────────   │ Carol: How's it going? │ │• Alice   last msg...││
│ ● Alice     │                        │ │• Bob     you there? ││
│ ● Bob       │ [Input box]            │ │• Carol   lol ok     ││
│ ○ Carol     │                        │ ├─────────────────────┤│
│             │                        │ │You (you) ● active   ││
│             │                        │ └─────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

**Three-Column Layout**:
- **Left**: Channel sidebar (channels/DMs) - collapsible
- **Center**: Message thread (primary content) - flex-grow to fill space
- **Right**: Direct Message panel (DMs + users + current user) - optional, 240-300px

**DM Panel (Right)**:
- **Top**: Messages tab (DMs you're in)
- **Alternative**: Users tab (online users)
- **Bottom**: Current user context (fixed footer)

### Responsive Breakpoints

```css
/* Desktop (wide) */
@media (min-width: 1280px) {
  /* Three-column layout (if context panel active) */
}

/* Laptop */
@media (min-width: 1024px) and (max-width: 1279px) {
  /* Two-column: sidebar + messages, context panel overlays */
}

/* Tablet */
@media (min-width: 768px) and (max-width: 1023px) {
  /* Single column, hamburger menu for sidebar */
}

/* Mobile */
@media (max-width: 767px) {
  /* Full-screen messages, slide-out sidebar */
}
```

### Spacing System (Rem-Based)

Wabi uses **rem-based spacing** for scalable, accessible spacing. The base system is flexible—components use rem units, which scale with user preferences.

**Common spacing values**:

```css
0.5rem = 8px
0.75rem = 12px
1rem = 16px
1.5rem = 24px
2rem = 32px
3rem = 48px
```

**Usage patterns** (not strict rules, adapt as needed):
- **Inline spacing** (icons, small gaps): 0.5rem (8px)
- **Component padding** (buttons, inputs): 0.75rem (12px)
- **Message gaps**: 0.5rem (8px) same user, 1rem (16px) user change
- **Section padding**: 1rem–1.5rem (16px–24px)
- **Modal/panel padding**: 1.5rem (24px)
- **Large gaps**: 2rem+ (32px+)

**Why rem-based**:
- Scales with user font-size preferences (accessibility)
- Consistent with web standards
- Easier to adjust global spacing if needed
- Still creates visual rhythm and predictability

**Don't hardcode pixels everywhere**—use rem units and let CSS variables handle it.

### Layout Patterns

#### 1. Message List (Vertical Rhythm)

```
┌────────────────────────────────────────────────────────────┐
│  [Avatar]  Username • Timestamp                           │
│            Message text content here...                    │
│                                                     1rem   │ ← Gap for user change
│  [Avatar]  OtherUser • Timestamp                          │
│            Another message...                              │
│                                                   0.5rem   │ ← Gap for same user
│            Follow-up message from same user...             │
└────────────────────────────────────────────────────────────┘
```

**Specs** (actual implementation):
- **Avatar**: 40px × 40px, left-aligned, top of message
- **Message padding**: 0.75rem (12px)
- **Gap between avatar/content**: 0.75rem (12px)
- **Message spacing**: 0.5rem (8px) same user, 1rem (16px) user change
- **Max width**: 680px (optimal reading length ~70 characters)

#### 2. Sidebar (Channels/DMs) - Efficient Scanning

```
┌──────────────────────────┐
│ # general          [99]  │  ← Unread badge
│ # random                 │
│ # design                 │
│ ─────────────────────    │  ← Divider
│ ● Alice             [2]  │  ← Online indicator + unread
│ ● Bob                    │
│ ○ Carol                  │  ← Offline
└──────────────────────────┘
```

**Specs**:
- **Item height**: 36-40px (compact but touch-friendly)
- **Icon**: 20px, left-aligned with 12px padding
- **Text**: Single line, ellipsis overflow
- **Hover**: Full-width background change (`--bg-tertiary`)
- **Active**: Left border (4px `--accent`) OR accent background tint
- **Unread badge**: Right-aligned, accent background, white text, 18px height

#### 3. Direct Message Panel (Three-Zone Layout)

Located in right sidebar. Consists of three fixed zones with scrollable middle:

```
┌─────────────────────────────┐
│ Direct Messages        [+]  │  ← Fixed Header (52px)
├─────────────────────────────┤
│ Messages      │ Users       │  ← Fixed Tabs
├─────────────────────────────┤
│ [Alice]  Hey, how are...    │
│ [Bob]    Got it!            │  ← Scrollable Content
│ [Carol]  See you later      │     (active tab)
├─────────────────────────────┤
│ [Avatar] You (you)          │  ← Fixed Footer
│ ● active                    │     (current user context)
└─────────────────────────────┘
```

**Three-Zone Architecture**:
1. **Header** (fixed): Title + add DM button (if Messages tab active)
2. **Tabs** (fixed): Messages | Users toggle
3. **Content** (scrollable): Active tab content (DM list or users list)
4. **Footer** (fixed): Current user info + status

**Messages Tab**:
- Shows DM conversations (most recent first)
- Each item: Avatar + name + last message preview
- Click to open conversation

**Users Tab**:
- Shows online users (excludes current user)
- Each item: Avatar + name + status indicator
- Click to start/open DM with user
- Empty state: "No users online" if list empty

**Footer (Current User)**:
- Always visible
- Shows: Avatar + username "(you)" badge + status
- Context-sensitive info (not clickable navigation)

**Specs**:
- **Avatar**: 32-36px circular
- **Name**: 14px, medium weight
- **Status**: 8px colored dot + text
- **Message preview**: Truncated to ~50 chars, secondary text color
- **Spacing**: 8-12px padding, consistent gaps

#### 4. Modals (Focused, Escapable)

```css
.modal {
  max-width: 540px;           /* Readable, not overwhelming */
  padding: var(--space-6);    /* 24px */
  border-radius: 12px;
  background: var(--bg-secondary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

.modal-backdrop {
  background: rgba(0, 0, 0, 0.6);  /* Semi-transparent overlay */
}
```

**Interaction**:
- **Close**: X button (top-right), ESC key, click backdrop
- **Focus**: First interactive element on open
- **Return focus**: To trigger element on close

### What to Avoid

❌ **Centered layouts for everything** - Website thinking, breaks scanning patterns
❌ **Excessive whitespace** - Wastes screen real estate, reduces information density
❌ **Fixed pixel values everywhere** - Breaks responsiveness
❌ **Floating cards with heavy shadows** - Dated, cluttered

✅ **Left-aligned content** - Follows western reading patterns
✅ **Functional density** - Discord-style information packing
✅ **Consistent spacing scale** - 8px system for rhythm
✅ **Flat or subtle shadows** - Elevation, not decoration

---

## 5. Component Patterns

### 5.1 Message Components

#### Message Item Structure

```
┌──────────────────────────────────────────────────────────┐
│ [Avatar]  Username • Timestamp                  [hover]  │
│           Message text content here...                   │
│           Multi-line messages maintain readable          │
│           line length and comfortable spacing.           │
│           ┌──────────────────────────┐                   │
│           │ [Attachment/Embed]       │                   │
│           └──────────────────────────┘                   │
│           [👍 2] [❤️ 1]  [+ React] [Edit] [Delete]       │
└──────────────────────────────────────────────────────────┘
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
  flex-shrink: 0;                 /* Prevent avatar compression */
}

.message-content {
  flex: 1;
  max-width: 680px;               /* Optimal reading length ~70 characters */
}

.message-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;                    /* 8px */
  margin-bottom: 4px;
}

.message-username {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent);
  cursor: pointer;
}

.message-timestamp {
  font-size: 11px;
  color: var(--text-secondary);
}

.message-text {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  word-wrap: break-word;
}

.message-actions {
  display: flex;
  gap: 0.5rem;                    /* 8px */
  margin-top: 4px;
  opacity: 0;
  transition: opacity 200ms ease-out;  /* 200ms matches actual implementation */
}

.message:hover .message-actions {
  opacity: 1;                     /* Reveal on hover */
}
```

**Actual measurements** (from `frontend/src/lib/components/MessageList.svelte`):
- Avatar: 40px × 40px
- Padding: 0.75rem (12px)
- Gap: 0.75rem (12px)
- Message spacing: 0.5rem (8px) same user, 1rem (16px) different user
- Hover action transition: 200ms ease-out

#### Message States

**Sending**:
```css
.message.sending {
  opacity: 0.6;
}
/* Show spinner next to message */
```

**Sent**: Full opacity (default)

**Failed**:
```css
.message.failed {
  border-left: 3px solid var(--error);
}
/* Show retry button */
```

**Edited**:
```html
<span class="edited-label">(edited)</span>
```
```css
.edited-label {
  font-size: 11px;
  color: var(--text-tertiary);
  margin-left: 4px;
}
```

**Deleted** (tombstone):
```html
<div class="message deleted">
  <span class="deleted-text">Message deleted</span>
</div>
```
```css
.message.deleted {
  font-style: italic;
  color: var(--text-secondary);
}
```

**Pinned**:
```css
.message.pinned {
  background: var(--accent-muted);
  border-left: 3px solid var(--accent);
}
/* Show pin icon in header */
```

#### Own Messages (Optional Visual Distinction)

```css
.message.own {
  background: rgba(var(--accent-rgb), 0.05);  /* Subtle tint */
}

/* OR right-align (less common in group chats) */
.message.own .message-content {
  margin-left: auto;
  text-align: right;
}
```

### 5.2 Input Components

#### Message Input Field

```css
.message-input-container {
  position: sticky;
  bottom: 0;
  padding: 16px;
  background: var(--bg-primary);
  border-top: 1px solid var(--border);
}

.message-input {
  width: 100%;
  min-height: 44px;               /* Touch-friendly */
  max-height: 200px;              /* Auto-expand up to 10 lines */
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  resize: none;                   /* Use auto-expand script */
  transition: border-color 150ms ease;
}

.message-input::placeholder {
  color: var(--text-tertiary);
}

.message-input:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-muted);  /* Focus ring */
}

.message-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

#### Toolbar (Attachments, Emoji, Formatting)

```html
<div class="input-toolbar">
  <button class="toolbar-button" aria-label="Attach file">
    <Icon name="paperclip" size={20} />
  </button>
  <button class="toolbar-button" aria-label="Add emoji">
    <Icon name="smile" size={20} />
  </button>
  <button class="toolbar-button" aria-label="Add GIF">
    <Icon name="image" size={20} />
  </button>
</div>
```

```css
.input-toolbar {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}

.toolbar-button {
  width: 32px;
  height: 32px;
  padding: 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 100ms ease;
}

.toolbar-button:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.toolbar-button:active {
  transform: scale(0.95);
}
```

### 5.3 Button Components

#### Button Hierarchy

**Primary** (Main CTAs):
```css
.button-primary {
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  background: var(--accent);
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 100ms ease;
}

.button-primary:hover {
  background: var(--accent-hover);
  transform: translateY(-1px);    /* Subtle lift */
}

.button-primary:active {
  transform: translateY(0) scale(0.98);
}

.button-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}
```

**Secondary** (Alternative actions):
```css
.button-secondary {
  padding: 10px 20px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 100ms ease;
}

.button-secondary:hover {
  background: var(--bg-tertiary);
  border-color: var(--text-secondary);
}
```

**Danger** (Destructive actions):
```css
.button-danger {
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  background: var(--error);
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 100ms ease;
}

.button-danger:hover {
  background: #d93d3d;            /* Darker red */
}
```

**Ghost** (Subtle, icon buttons):
```css
.button-ghost {
  padding: 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 100ms ease;
}

.button-ghost:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
```

#### Button Sizes

```css
/* Small (inline actions) */
.button-sm {
  height: 28px;
  padding: 4px 12px;
  font-size: 13px;
}

/* Medium (standard) */
.button-md {
  height: 36px;
  padding: 8px 16px;
  font-size: 14px;
}

/* Large (primary CTAs, mobile-friendly) */
.button-lg {
  height: 44px;
  padding: 12px 24px;
  font-size: 16px;
}
```

#### Loading State

```css
.button.loading {
  position: relative;
  color: transparent;             /* Hide text */
  pointer-events: none;
}

.button.loading::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

### 5.4 Navigation Components

#### Sidebar Item (Channels/DMs)

```html
<button class="sidebar-item" aria-current="page">
  <span class="item-icon">#</span>
  <span class="item-name">general</span>
  <span class="item-badge">99</span>
</button>
```

```css
.sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 6px 12px;
  border: none;
  border-left: 3px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
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

.sidebar-item.unread {
  font-weight: 600;
  color: var(--text-primary);
}

.item-icon {
  width: 20px;
  flex-shrink: 0;
  text-align: center;
}

.item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-badge {
  padding: 2px 6px;
  border-radius: 10px;
  background: var(--accent);
  color: white;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
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
  z-index: 1000;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background 100ms ease;
}

.context-menu-item:hover {
  background: var(--bg-tertiary);
}

.context-menu-item.danger {
  color: var(--error);
}

.context-menu-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--border);
}
```

---

## 6. Motion & Animation

### Philosophy: Purposeful, Not Decorative

Every animation should:
1. **Guide attention** - Show users where to look after an action
2. **Provide feedback** - Confirm interactions (button press, message sent)
3. **Reduce cognitive load** - Smooth transitions prevent jarring changes
4. **Respect user preferences** - Honor `prefers-reduced-motion`

**Never**: Animate for decoration. No spinning logos, pulsing elements, or parallax scrolling.

### Timing Standards (Fast, Snappy)

```css
/* Micro-interactions (hover, focus, button press) */
--duration-instant: 100ms;

/* Transitions (panel open/close, navigation) */
--duration-fast: 200ms;

/* Animations (modals, toasts, complex state changes) */
--duration-normal: 300ms;

/* Never exceed 500ms (feels sluggish) */
```

### Easing Functions

```css
/* Elements entering (decelerating) */
--ease-out: cubic-bezier(0, 0, 0.2, 1);

/* Elements exiting (accelerating) */
--ease-in: cubic-bezier(0.4, 0, 1, 1);

/* Position changes */
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
```

### Animation Patterns

#### 1. Message Appearance (New Message Arrives)

```css
@keyframes slideInMessage {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message.new {
  animation: slideInMessage 200ms var(--ease-out);
}
```

**Why**: Subtle slide-in guides attention to new content without disrupting reading.

#### 2. Modal Enter/Exit

```css
@keyframes modalEnter {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(-10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@keyframes modalExit {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.95);
  }
}

.modal.entering {
  animation: modalEnter 250ms var(--ease-out);
}

.modal.exiting {
  animation: modalExit 200ms var(--ease-in);
}
```

**Why**: Scale + fade creates focus. Slight Y-translation feels natural.

#### 3. Toast Notification (Success, Error Messages)

```css
@keyframes toastSlide {
  from {
    transform: translateX(400px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

.toast {
  animation: toastSlide 250ms var(--ease-out);
}

.toast.dismissing {
  animation: toastSlide 200ms var(--ease-in) reverse;
}
```

**Why**: Slide from edge feels like a notification entering the space.

#### 4. Typing Indicator (Someone Is Typing...)

```css
@keyframes typing {
  0%, 60%, 100% { opacity: 0.3; }
  30% { opacity: 1; }
}

.typing-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-secondary);
  animation: typing 1.4s infinite;
}

.typing-dot:nth-child(1) { animation-delay: 0s; }
.typing-dot:nth-child(2) { animation-delay: 0.2s; }
.typing-dot:nth-child(3) { animation-delay: 0.4s; }
```

**Why**: Pulsing dots are universally recognized as "activity happening".

#### 5. Loading Spinner

```css
@keyframes spin {
  to { transform: rotate(360deg); }
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}
```

**Why**: Continuous rotation signals ongoing activity.

### Hover Micro-Interactions

```css
/* Button */
.button:hover {
  transform: translateY(-1px);
  transition: transform 100ms var(--ease-out);
}

.button:active {
  transform: translateY(0) scale(0.98);
  transition: transform 50ms var(--ease-out);
}

/* Sidebar item */
.sidebar-item {
  transition: background 150ms ease;
}

.sidebar-item:hover {
  background: var(--bg-tertiary);
}

/* Message actions reveal */
.message-actions {
  opacity: 0;
  transition: opacity 150ms ease;
}

.message:hover .message-actions {
  opacity: 1;
}
```

### Reduced Motion Support

**Critical for accessibility**. Some users experience motion sickness or distraction from animations.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

**Respect the user's OS-level preference**. Animations become instant, transitions are minimal.

### What to Avoid

❌ **Slow animations** (>500ms) - Feels sluggish, frustrating
❌ **Decorative animations** - Spinning logos, pulsing buttons (no purpose)
❌ **Inconsistent easing** - Random cubic-bezier values feel unprofessional
❌ **Animations on scroll** - Parallax, fade-ins (website thinking, distracting)
❌ **Auto-playing animations** - Looping GIFs, videos (provide controls)

✅ **Fast animations** (<300ms) - Snappy, responsive feel
✅ **Purposeful only** - Guide attention, provide feedback
✅ **Consistent timing/easing** - Professional, predictable
✅ **Reduced motion support** - Accessibility requirement
✅ **User-initiated** - Triggered by interaction, not automatic

---

## 7. Iconography

### Style: Consistent, Semantic, Functional

Icons should be **instantly recognizable** and **visually consistent** across the app.

### Design Specs

- **Stroke weight**: 2px (or 1.5px for 16px icons)
- **Style**: Outlined (not filled) for default states, filled for active/selected
- **Corner radius**: Slightly rounded (not sharp, not overly round)
- **Grid**: 24x24px base canvas
- **Alignment**: Pixel-perfect, centered in bounding box

### Icon Sizes

```css
--icon-sm: 16px;      /* Inline with text, metadata */
--icon-md: 20px;      /* Buttons, toolbar (default) */
--icon-lg: 24px;      /* Navigation, prominent actions */
--icon-xl: 32px;      /* Empty states, illustrations */
```

### Recommended Libraries

- **Lucide** - Consistent, modern, clean (recommended)
- **Heroicons** - Well-designed, Tailwind-friendly
- **Feather Icons** - Minimal, elegant
- **Custom** - Design custom icons for brand-specific actions (keep style consistent)

### Usage Patterns

#### 1. Navigation Icons

```html
<button class="nav-item">
  <Icon name="home" size={20} />
  <span>Home</span>
</button>
```

**Specs**:
- Size: 20px
- Position: Left-aligned, 8px gap from text
- Color: `--text-secondary`, hover to `--text-primary`
- Active state: Filled icon + accent color

#### 2. Action Icons (Edit, Delete, Pin)

```html
<button class="action-button" aria-label="Edit message">
  <Icon name="edit" size={16} />
</button>
```

**Specs**:
- Size: 16px (compact)
- Color: `--text-secondary`, hover to `--text-primary`
- Appear on hover (message actions)
- Ghost button style (transparent, hover background)

#### 3. Status Indicators (Online, Away, Offline)

```html
<span class="status-indicator status-online" aria-label="Online"></span>
```

```css
.status-indicator {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-online {
  background: var(--status-online);
}

.status-away {
  background: var(--status-away);
}

.status-offline {
  background: var(--status-offline);
}
```

**Accessibility**: Use shape + color. Consider adding border or different shapes for colorblind users.

#### 4. Message Toolbar Icons

```html
<button class="toolbar-button" aria-label="Attach file">
  <Icon name="paperclip" size={20} />
</button>
```

**Specs**:
- Size: 20px
- Color: `--text-secondary`, hover to accent
- Even spacing (4-8px gap)
- Ghost button style

### What to Avoid

❌ **Mixing icon styles** - Outlined + filled in same context (inconsistent)
❌ **Inconsistent sizing** - Random 14px, 18px, 21px (unprofessional)
❌ **Over-detailed icons** - Too many strokes, hard to read at small sizes
❌ **Icon-only buttons without labels** - Poor accessibility (use `aria-label`)

✅ **Consistent library** - One style throughout (e.g., all Lucide)
✅ **Standard sizes** - 16, 20, 24px
✅ **Simple, recognizable shapes** - Universally understood
✅ **Accessible** - Labels for screen readers, shape + color for colorblind users

---

## 8. Theming Integration

### Working with the Existing Theme System

Wabi's theme system (`frontend/src/lib/theme/`) is robust and well-architected. All theming happens through CSS variables defined in `themes.ts` and applied to `:root` at runtime.

**Key files**:
- `themeStore.ts` - Svelte store for theme state
- `themes.ts` - Theme definitions (presets + custom) with `ThemeColors` and `ThemeGradients`
- `themeManager.ts` - Applies themes to DOM via CSS variables
- `themeApi.ts` - HTTP client for theme persistence
- `initTheme.ts` - Theme initialization on app load

### How Components Use Themes

**All color, spacing, and typography must use CSS variables** for theme compatibility.

```css
/* ❌ Bad - hardcoded colors don't theme */
.button {
  background: #6366f1;
}

/* ✅ Good - uses CSS variable */
.button {
  background: var(--accent);
}

/* ✅ Good - RGB variant for opacity */
.button:hover {
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.2);
}
```

**Never hardcode colors in component CSS.** Always use CSS variables from the theme system.

### Default Theme: Nebula Cosmic

Wabi ships with **Nebula Cosmic** as the default theme—a vibrant, space-inspired aesthetic with gradients and glowing accents.

**Characteristics**:
- **Gradients**: Used for backgrounds and accents to create visual depth
- **Color Palette**: Purples, magentas, electric cyans with high saturation
- **Accent**: Magenta-to-hot-pink gradient (`#ff00ff` → `#ff69b4`)
- **Status colors**: Neon green online, gold away, deep gray offline
- **Personality**: Chill, creative, unique (avoids generic AI aesthetic)

**Key variables** (see `app.css` for complete list):
```css
--bg-primary: linear-gradient(to right, #0f0c29 0%, #302b63 100%);
--accent: linear-gradient(to right, #ff00ff 0%, #ff69b4 100%);
--accent-hex: #ff00ff; /* For non-gradient uses */
--status-online: #00ff7f; /* Neon green */
```

**When to use Nebula Cosmic**:
- Default for new users (no preference yet)
- Great for "chill" / creative contexts
- Emphasizes personality and uniqueness

### Adding Alternative Themes

To create additional theme presets, follow this pattern in `themes.ts`:

#### Example: Professional Theme (Minimal, High Contrast)

```typescript
export const professionalTheme: Theme = {
  id: 'professional',
  name: 'Professional',
  description: 'Clean, minimal, high-contrast for work',
  colors: {
    bgPrimary: 'linear-gradient(to right, #f5f5f5 0%, #efefef 100%)',
    bgSecondary: '#ffffff',
    bgTertiary: '#f0f0f0',
    bgHover: '#e8e8e8',

    textPrimary: '#1a1a1d',
    textSecondary: '#4a4a6a',
    textTertiary: '#7a7a8a',

    accent: 'linear-gradient(to right, #4f46e5 0%, #4338ca 100%)',
    accentHex: '#4f46e5',
    accentHover: 'linear-gradient(to right, #4338ca 0%, #3730a3 100%)',

    statusOnline: '#059669', /* Muted green */
    statusAway: '#d97706', /* Muted amber */
    statusBusy: '#dc2626',
    statusOffline: '#6b7280',

    colorSuccess: '#059669',
    colorInfo: '#0284c7',
    colorWarning: '#d97706',
    colorDanger: '#dc2626',

    // ... other colors
  },
  gradients: {
    primary: 'linear-gradient(to right, #f5f5f5 0%, #efefef 100%)',
    accent: 'linear-gradient(to right, #4f46e5 0%, #4338ca 100%)',
    // ... minimal gradients, mostly for consistency
  }
};
```

**Key decisions**:
- **Gradients**: Minimal (only where necessary for visual consistency)
- **Colors**: Muted saturation for professional contexts
- **Contrast**: Higher contrast for readability
- **Personality**: Clean, minimal, developer-friendly

#### Example: Minimal Theme (Solid Colors Only)

For a theme with no gradients:

```typescript
export const minimalTheme: Theme = {
  // ...
  colors: {
    bgPrimary: '#f8f8f8', /* Solid instead of gradient */
    accent: '#2563eb', /* Solid blue */
    accentHex: '#2563eb',
    accentHover: '#1d4ed8',
    // ...
  },
  gradients: {
    primary: '#f8f8f8', /* Can be solid color too */
    accent: '#2563eb', /* Solid fallback */
    // ... minimal or no gradients
  }
};
```

### Guidelines for Creating Cohesive Themes

1. **Choose a color palette** (3-5 primary colors + 2-3 accent colors)
2. **Define all semantic colors** (online, away, offline, success, danger, etc.)
3. **Maintain contrast ratios** (4.5:1 text minimum, test with [WebAIM](https://webaim.org/resources/contrastchecker/))
4. **Decide on gradients early** (yes/no/minimal—stay consistent)
5. **Test with real content**:
   - Open a message list with multiple users
   - Send/receive messages with reactions
   - Check hover states and focus indicators
   - Verify low-vision users can read text
6. **Document the theme philosophy** (why these colors, what mood it evokes)

### Custom Themes (User-Defined)

Users can override all CSS variables via the **ThemeCustomizer** UI (`ThemeCustomizer.svelte`).

**User guidelines**:
- Any CSS variable can be customized (colors, spacing, gradients)
- Contrast checker warns if text falls below WCAG AA (but allows override)
- Test themes with actual message content
- Reset to defaults if theme breaks usability

**App behavior**:
- Show warnings for low-contrast, allow user choice
- Persist custom themes to backend
- Restore on next login

### Theme Application Flow

```typescript
// 1. User selects theme in Settings/ThemeCustomizer
themeStore.setTheme('professional');

// 2. themeManager reads theme definition from themes.ts
// 3. Converts all theme colors/gradients to CSS variables
// 4. Applies variables to :root element
applyTheme(theme);

// 5. Theme is saved to backend
POST /api/user/theme { theme_id: 'professional' }

// 6. On page reload, theme is restored
initTheme() → GET /api/user/theme → applyTheme()
```

### Adding New Theme Variables

If you need a new CSS variable (e.g., `--shadow-focus`):

1. **Update `themes.ts` ThemeColors interface**:
   ```typescript
   export interface ThemeColors {
     // ... existing colors
     shadowFocus: string; // New variable
   }
   ```

2. **Add to all theme presets**:
   ```typescript
   export const darkTheme: Theme = {
     colors: {
       // ... existing colors
       shadowFocus: '0 0 0 3px rgba(255, 0, 255, 0.2)',
     }
   };
   ```

3. **Use in CSS**:
   ```css
   .button:focus-visible {
     box-shadow: var(--shadow-focus);
   }
   ```

4. **Document in this guide** (add to relevant section)

### Testing Themes

- **Contrast**: [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- **Vision simulation**: [Coblis](https://www.color-blindness.com/coblis-color-blindness-simulator/)
- **Content**: Use real messages, reactions, and status indicators
- **Accessibility**: Chrome DevTools > Lighthouse > Accessibility audit

---

## 9. Accessibility

### WCAG 2.1 AA Compliance (Minimum)

Wabi aims for **WCAG 2.1 Level AA** as a baseline, with some AAA targets (contrast, focus indicators).

### Color Contrast

**Requirements**:
- **Text on background**: 4.5:1 minimum (7:1 for AAA)
- **Large text (18px+)**: 3:1 minimum
- **UI components**: 3:1 against adjacent colors
- **Focus indicators**: 3:1 against background

**Testing**:
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- Chrome DevTools (Lighthouse audit)
- Axe DevTools browser extension

**Enforcement**: Theme presets must pass AA. Custom themes show warnings but allow user override.

### Keyboard Navigation

All interactive elements must be keyboard-accessible.

**Focus Order**: Logical, follows visual flow (top to bottom, left to right).

**Focus Indicators**: Visible, high contrast, minimum 3px outline or glow.

```css
*:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Or custom focus ring */
.button:focus-visible {
  box-shadow: 0 0 0 3px var(--accent-muted);
}
```

**Never**: Remove focus outlines without replacing with a visible alternative.

**Keyboard Shortcuts**:
- `/` - Focus search/quick switcher
- `Ctrl+K` / `Cmd+K` - Command palette
- `Esc` - Close modals, cancel actions
- `Arrow keys` - Navigate lists, channels
- `Enter` - Select/activate
- `Space` - Toggle checkboxes, play/pause
- `Tab` - Navigate interactive elements
- `Shift+Tab` - Reverse navigation

**Document shortcuts** in a help modal or settings panel.

### Screen Readers

**Semantic HTML**: Use proper elements, not `<div>` with click handlers.

```html
<!-- ❌ Bad -->
<div onclick="sendMessage()">Send</div>

<!-- ✅ Good -->
<button type="button" onclick="sendMessage()">Send</button>
```

**ARIA Labels**: For icons, image buttons, and non-obvious controls.

```html
<button aria-label="Delete message">
  <Icon name="trash" size={16} />
</button>
```

**ARIA Live Regions**: For dynamic content (new messages, typing indicators).

```html
<div aria-live="polite" aria-atomic="true">
  Alice is typing...
</div>
```

**Alt Text**: For images, avatars.

```html
<img src="/avatars/alice.png" alt="Alice" />
```

### Focus Management

**Modals**:
- When opened: Focus first interactive element (input, button)
- When closed: Return focus to trigger element

```javascript
// Open modal
modal.show();
modal.querySelector('input').focus();

// Close modal
modal.hide();
triggerButton.focus();
```

**Trap focus inside modals**: Prevent Tab from escaping modal while open.

### Motion & Animation

**Respect `prefers-reduced-motion`**:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

**No auto-play**: Videos, GIFs should have controls or be paused by default.

**Flashing content**: Avoid (seizure risk). No flashing faster than 3 times per second.

### Form Accessibility

**Labels**: All inputs have associated `<label>`.

```html
<label for="username">Username</label>
<input id="username" type="text" />
```

**Error messages**: Clear, associated with field.

```html
<input id="email" type="email" aria-describedby="email-error" />
<span id="email-error" role="alert">Please enter a valid email</span>
```

**Required fields**: Indicate visually + `aria-required`.

```html
<label for="password">Password <span aria-label="required">*</span></label>
<input id="password" type="password" required aria-required="true" />
```

**Validation**: Inline, real-time feedback. Don't wait for form submit.

### Touch Targets (Mobile-Friendly)

**Minimum size**: 44x44px (Apple HIG), 48x48px (Material Design).

```css
.button {
  min-width: 44px;
  min-height: 44px;
  padding: 12px 16px;
}
```

**Spacing**: Minimum 8px between interactive elements.

**Interactive area**: Can be larger than visual size (use padding).

```css
.icon-button {
  width: 20px;        /* Visual size */
  height: 20px;
  padding: 12px;      /* Interactive area: 44x44px */
}
```

### Testing Checklist

- [ ] All text meets 4.5:1 contrast ratio
- [ ] All interactive elements keyboard-accessible
- [ ] Focus indicators visible (3px minimum, high contrast)
- [ ] Screen reader announces all content and state changes
- [ ] Forms have labels, error messages, required indicators
- [ ] Modals trap focus, return focus on close
- [ ] Respects `prefers-reduced-motion`
- [ ] Touch targets minimum 44x44px
- [ ] No keyboard traps (can Tab out of everything)
- [ ] No color-only indicators (use shape + color)

---

## 10. Anti-Patterns

### Generic AI Website Aesthetics (What to Avoid)

AI-generated websites often share a predictable, sterile aesthetic. Wabi avoids these patterns.

#### ❌ Don't Do This

**Excessive whitespace everywhere**
- Wastes screen space
- Reduces information density
- Makes app feel empty, not focused

**Centered layouts for all content**
- Breaks natural scanning patterns (western readers scan left-to-right)
- Hard to skim long content
- Website thinking, not app thinking

**Overly large headings**
- Hero section vibes (`font-size: 48px` in a modal)
- Wastes vertical space
- Draws attention away from content

**Gradient backgrounds on everything**
- Visual noise, distracting
- Hard to theme
- Feels dated (early 2010s)

**Floating cards with heavy shadows**
- Cluttered, busy
- Dated aesthetic
- Reduces content area

**Thin fonts (200-300 weight) for body text**
- Trendy but unreadable
- Especially bad on low-DPI screens
- Accessibility nightmare

**All-caps headings**
- Harder to read (no ascenders/descenders)
- Accessibility issue (screen readers may spell out)
- SHOUTY, unprofessional

**Auto-playing animations everywhere**
- Distracting, fatiguing
- Accessibility issue (motion sickness)
- No clear purpose

#### ✅ Do This Instead

**Functional density**
- Discord/Slack pattern: pack information efficiently
- Use whitespace purposefully (breathing room, not emptiness)
- Maximize content area

**Left-aligned, scannable content**
- Follows natural reading patterns
- Easy to skim
- Professional, app-like

**Appropriate heading sizes**
- 20-24px max for modals
- Content is king, headings are signposts

**Solid colors or very subtle gradients**
- Clean, timeless
- Easy to theme
- No visual noise

**Flat or minimal shadows**
- Subtle elevation (1-2px shadows)
- Depth through background layers, not heavy shadows

**Regular (400) or medium (500) weight for body**
- Readable for hours
- Works on all screens

**Sentence case for headings**
- Natural, easy to read
- Professional

**Purposeful animations on interaction only**
- Triggered by user, not automatic
- Provides feedback, not decoration

### Theme System Anti-Patterns

#### ❌ Don't Do This

**Hardcoding colors in component CSS**
```css
/* ❌ Bad - breaks theming */
.button {
  background: #6366f1;
  color: #ffffff;
  border: 1px solid #4f46e5;
}
```

This breaks theming—users can't customize colors, and theme presets can't be applied.

**Inconsistent use of CSS variables**
```css
/* ❌ Bad - mixes hardcoded and variables */
.card {
  background: var(--bg-secondary); /* Variable */
  border: 1px solid #404050; /* Hardcoded - breaks theming */
  color: #ffffff; /* Hardcoded - breaks theming */
}
```

**Using color values directly instead of RGB variants for opacity**
```css
/* ❌ Bad - must recalculate hex to RGBA */
.button:hover {
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2); /* Hardcoded RGB */
}

/* ✅ Good - uses CSS variable */
.button:hover {
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.2);
}
```

#### ✅ Do This Instead

**Always use CSS variables for colors**
```css
.button {
  background: var(--accent);
  color: var(--text-primary);
  border: none;
}

.button:hover {
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb), var(--opacity-medium));
}
```

**RGB variants for dynamic opacity**
```css
/* Use RGB variants + opacity scale */
background: rgba(var(--accent-rgb), var(--opacity-light));
border: 1px solid rgba(var(--text-secondary-rgb), var(--opacity-subtle));
```

**Theme-aware styling**
```css
/* Check which theme, apply accordingly */
[data-theme="dark"] .element {
  /* Use high contrast for dark mode */
}

[data-theme="light"] .element {
  /* Use different styling for light mode */
}
```

### Chat-Specific Anti-Patterns

#### ❌ Don't Do This

**Bubble messages for all users**
- iMessage clone, not original
- Wastes horizontal space
- Confusing in group chats with many users

**Alternating left/right messages**
- Hard to track in group chats (who's on which side?)
- Breaks scanning pattern

**No timestamps or hidden on hover**
- Context loss (when was this sent?)
- Frustrating for users

**Overly playful emojis in UI chrome**
- Unprofessional for work contexts
- Visual clutter
- Emojis belong in content, not UI scaffolding

**Auto-scroll interrupting reading**
- Jarring when scrolled up reading history
- No "new messages" indicator

**Tiny avatars (<24px) or no avatars**
- Hard to track who's speaking
- Reduces personality

#### ✅ Do This Instead

**Consistent left-aligned messages**
- Or subtle visual distinction for own messages (background tint)
- Clear, scannable
- Professional

**Clear timestamps**
- Relative ("2m ago") with absolute on hover
- Always visible or easily accessible

**Emojis in content, not UI**
- Keep UI professional
- Unless intentional (status emojis, reactions)

**Smart auto-scroll**
- Only if user is at bottom
- Show "new messages" indicator if scrolled up
- Don't interrupt reading

**32-36px avatars**
- Recognizable, adds personality
- Not overwhelming

---

## Conclusion

This guide provides a foundation for Wabi's UI/UX. It's not a rigid rulebook—adapt as needed—but it establishes principles to maintain consistency, accessibility, and personality.

**Core Principles Recap**:
1. **Content-first**: Messages get max space, chrome is minimal
2. **UX before aesthetics**: Never sacrifice usability for uniqueness
3. **Accessible by default**: WCAG AA minimum, AAA where possible
4. **Purposeful motion**: Animations serve UX, not decoration
5. **Flexible personality**: Support both "chill" and "focused" moods

**Integration**:
- This guide complements `ARCHITECTURE.md` (technical docs)
- Works with existing theme system (`frontend/src/lib/theme/`)
- Reference when building components (`frontend/src/lib/components/`)

**Questions or improvements?** This is a living document. Update as patterns evolve.

---

**Happy building!**
