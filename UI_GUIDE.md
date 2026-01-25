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

### Adaptive Clarity

**Core Principle**: The interface adapts to user mood (chill ↔ focused) and context (chat, draw, share) while maintaining clarity and usability.

**Guiding Principles**:

- **Content-first**: Messages and content receive maximum screen space. Chrome (UI scaffolding) is minimal and contextual.
- **VSCode-inspired theming**: Well-defined CSS variables with predictable customization boundaries. Professional, not restrictive.
- **Purposeful motion**: Every animation serves UX—guide attention, provide feedback, reduce cognitive load. Never decorative.
- **Flexible personality**: Support both "late-night hangout" and "focused work session" moods through theming.
- **Trust through simplicity**: Privacy-focused clarity without sterility. Signal's ethos, Discord's efficiency.

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

### Color Architecture

Based on the existing theme system (`frontend/src/lib/theme/`), Wabi uses a layered color architecture with **semantic roles** for consistency across themes.

#### Background Layers (Depth Through Subtle Contrast)

```css
--bg-primary: #1a1a1d;      /* Main canvas (darkest in dark mode) */
--bg-secondary: #25252a;    /* Raised surfaces (sidebars, panels) */
--bg-tertiary: #2f2f35;     /* Elevated elements (hover states, modals) */
```

**Purpose**: Create visual depth without heavy shadows. Layers guide the eye: primary (background) → secondary (containers) → tertiary (interactive elements).

#### Text Hierarchy (Scannable Information Architecture)

```css
--text-primary: #ffffff;    /* Main content (messages, usernames) */
--text-secondary: #b0b0b5;  /* Supporting info (timestamps, descriptions) */
--text-tertiary: #70707a;   /* Subtle hints (placeholders, disabled states) */
```

**Purpose**: Clear hierarchy helps users scan quickly. Primary for content, secondary for metadata, tertiary for hints.

#### Accent System (Personality and Focus)

```css
--accent: #6366f1;          /* Primary brand color (links, active states, CTAs) */
--accent-hover: #4f46e5;    /* Interaction feedback (hover, focus) */
--accent-muted: rgba(99, 102, 241, 0.1);  /* Subtle highlights, backgrounds */
```

**Purpose**: Single accent color creates visual consistency. Use sparingly for focus and brand identity.

#### Semantic Colors (Instant Recognition)

```css
--status-online: #43b581;   /* Green - user online, success states */
--status-away: #faa61a;     /* Yellow/amber - user away, warnings */
--status-offline: #747f8d;  /* Gray - user offline, neutral */
--error: #f04747;           /* Red - destructive actions, errors */
--success: #43b581;         /* Green - confirmations, success */
--warning: #faa61a;         /* Orange - caution, important notices */
```

**Purpose**: Colors carry meaning. Green = positive, red = destructive, yellow = caution. Consistent across all themes.

#### Borders and Dividers

```css
--border: rgba(255, 255, 255, 0.1);  /* Subtle dividers, component outlines */
```

**Purpose**: Subtle, not heavy. Borders provide structure without visual noise.

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

### Main Chat Layout (Three-Zone Adaptive)

```
┌───────────────────────────────────────────────────────────────┐
│ [Channel Sidebar]  │  [Messages (primary)]  │  [Context Panel] │
│  (collapsible)     │   (fluid, max space)   │    (optional)    │
│   200-240px        │     flex-grow: 1       │    240-280px     │
└───────────────────────────────────────────────────────────────┘
```

**Behavior**:
- **Channel Sidebar**: Channels/DMs list. Collapses to icons on narrow screens or user preference.
- **Messages**: Primary focus. Expands to fill available space.
- **Context Panel**: User list, pinned messages, thread view. Appears contextually, not always visible.

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

### Spacing Scale (8px Base Unit)

Consistent spacing creates rhythm and predictability.

```css
--space-1: 4px;       /* Tight (icon padding, inline spacing) */
--space-2: 8px;       /* Standard (between related elements) */
--space-3: 12px;      /* Comfortable (component padding) */
--space-4: 16px;      /* Generous (section padding, message gaps) */
--space-6: 24px;      /* Separated (modal padding, section breaks) */
--space-8: 32px;      /* Distinct (large gaps, page padding) */
--space-12: 48px;     /* Hero (marketing pages, rarely used in app) */
```

**Usage**:
- **Inline spacing** (icons, badges): `--space-1` (4px)
- **Component padding** (buttons, inputs): `--space-3` (12px)
- **Message gaps**: `--space-2` (8px) same user, `--space-4` (16px) user change
- **Modal/panel padding**: `--space-6` (24px)

### Layout Patterns

#### 1. Message List (Vertical Rhythm)

```
┌────────────────────────────────────────────────────────────┐
│  [Avatar]  Username • Timestamp                       8px  │
│            Message text content here...                    │
│                                                       16px  │ ← Gap for user change
│  [Avatar]  OtherUser • Timestamp                      8px  │
│            Another message...                              │
│                                                        8px  │ ← Gap for same user
│            Follow-up message from same user...             │
└────────────────────────────────────────────────────────────┘
```

**Specs**:
- **Avatar**: 32-36px, left-aligned, top of message
- **Message spacing**: 8px (same user), 16px (user change)
- **Max width**: 680px (optimal reading length ~70 chars)
- **Padding**: 16px horizontal, 8px vertical

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

#### 3. User Panel (Contextual, Collapsible)

Located in context panel (right sidebar) or bottom of channel sidebar.

```
┌────────────────────────────┐
│  [Avatar]  Alice           │
│  ● Online                  │
│  [Settings] [Logout]       │
└────────────────────────────┘
```

**Specs**:
- **Avatar**: 32px circular
- **Name**: 14px, bold
- **Status**: 8px dot + text or icon
- **Actions**: Icon buttons (20px icons)
- **Collapse**: On narrow screens, show icon-only or move to dropdown

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
  gap: 12px;                      /* Space between avatar and content */
  padding: 8px 16px;
  margin-bottom: 8px;             /* Same user */
}

.message:not(.same-user) {
  margin-top: 16px;               /* Different user */
}

.message:hover {
  background: var(--bg-tertiary); /* Subtle highlight */
}

.message-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;                 /* Don't compress avatar */
}

.message-content {
  flex: 1;
  max-width: 680px;               /* Optimal reading length */
}

.message-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.message-username {
  font-size: 16px;
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
  gap: 8px;
  margin-top: 4px;
  opacity: 0;                     /* Hidden by default */
  transition: opacity 150ms ease;
}

.message:hover .message-actions {
  opacity: 1;                     /* Reveal on hover */
}
```

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

Wabi's theme system (`frontend/src/lib/theme/`) is robust and well-architected. The UI guide leverages this system.

**Key files**:
- `themeStore.ts` - Svelte store for theme state
- `themes.ts` - Theme definitions (presets + custom)
- `themeManager.ts` - Applies themes to DOM via CSS variables
- `themeApi.ts` - HTTP client for theme persistence
- `initTheme.ts` - Theme initialization on app load

### CSS Variables (Set on `:root`)

All colors, spacing, and typography should use CSS variables for theme compatibility.

```css
:root {
  /* Backgrounds */
  --bg-primary: #1a1a1d;
  --bg-secondary: #25252a;
  --bg-tertiary: #2f2f35;

  /* Text */
  --text-primary: #ffffff;
  --text-secondary: #b0b0b5;
  --text-tertiary: #70707a;

  /* Accent */
  --accent: #6366f1;
  --accent-hover: #4f46e5;
  --accent-muted: rgba(99, 102, 241, 0.1);

  /* Semantic colors */
  --status-online: #43b581;
  --status-away: #faa61a;
  --status-offline: #747f8d;
  --error: #f04747;
  --success: #43b581;
  --warning: #faa61a;

  /* Borders */
  --border: rgba(255, 255, 255, 0.1);

  /* Spacing (optional, can hardcode) */
  --space-2: 8px;
  --space-4: 16px;
  /* ... */

  /* Typography */
  --text-base: 14px;
  --text-lg: 16px;
  /* ... */
}

/* Light theme example */
[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f5;
  --bg-tertiary: #e8e8e8;
  --text-primary: #1a1a1d;
  --text-secondary: #70707a;
  --text-tertiary: #b0b0b5;
  --border: rgba(0, 0, 0, 0.1);
}
```

### Theme Presets

#### 1. Midnight Blue (Default, "Chill")

```typescript
{
  id: 'midnight-blue',
  name: 'Midnight Blue',
  colors: {
    background: {
      primary: '#1a1a2e',      // Rich dark blue-black
      secondary: '#16213e',    // Slightly lighter blue
      tertiary: '#0f3460',     // Elevated blue
    },
    text: {
      primary: '#ffffff',
      secondary: '#94a3b8',
      tertiary: '#64748b',
    },
    accent: {
      base: '#4f7cff',         // Bright blue
      hover: '#3d5acc',
      muted: 'rgba(79, 124, 255, 0.1)',
    },
    // ... semantic colors
  }
}
```

**Personality**: Calm, late-night hangout, warm but focused.

#### 2. High Contrast (VSCode-inspired, "Focused")

```typescript
{
  id: 'high-contrast',
  name: 'High Contrast',
  colors: {
    background: {
      primary: '#0d1117',      // GitHub dark
      secondary: '#161b22',
      tertiary: '#21262d',
    },
    text: {
      primary: '#f0f6fc',
      secondary: '#8b949e',
      tertiary: '#6e7681',
    },
    accent: {
      base: '#58a6ff',         // GitHub blue
      hover: '#4493e1',
      muted: 'rgba(88, 166, 255, 0.1)',
    },
    // ...
  }
}
```

**Personality**: Professional, developer-focused, maximum readability.

#### 3. Light Mode (Optional)

```typescript
{
  id: 'light',
  name: 'Light Mode',
  colors: {
    background: {
      primary: '#fafafa',
      secondary: '#f5f5f5',
      tertiary: '#e8e8e8',
    },
    text: {
      primary: '#1a1a1d',
      secondary: '#70707a',
      tertiary: '#b0b0b5',
    },
    accent: {
      base: '#4f46e5',         // Indigo
      hover: '#4338ca',
      muted: 'rgba(79, 70, 229, 0.1)',
    },
    // ...
  }
}
```

**Personality**: Daytime, clean, approachable.

### Custom Themes (User-Defined)

Users can override all CSS variables via the **ThemeCustomizer** UI (`ThemeCustomizer.svelte`).

**Guidelines for custom themes**:
- **Maintain contrast ratios**: Use contrast checker, enforce minimums
- **Test with content**: Don't just check empty states
- **Provide defaults**: If user breaks contrast, show warning but allow it (their choice)
- **Semantic consistency**: Green should still mean "online/success", red "error"

### Theme Application Flow

```typescript
// 1. User selects theme in ThemeCustomizer
themeStore.setTheme('high-contrast');

// 2. themeManager applies CSS variables to :root
applyTheme(theme);

// 3. Theme saved to backend
POST /api/user/theme { theme_id: 'high-contrast' }

// 4. On page reload, theme restored
initTheme() → GET /api/user/theme → applyTheme()
```

### Adding New Theme Variables

If you need a new CSS variable (e.g., `--shadow-lg`):

1. **Add to `themes.ts`**: Include in all theme presets
2. **Use in CSS**: Reference via `var(--shadow-lg)`
3. **Document in UI guide**: Add to this document

**Example**:
```typescript
// themes.ts
cssVariables: {
  '--shadow-lg': '0 10px 40px rgba(0, 0, 0, 0.3)',
}
```

```css
/* Component CSS */
.modal {
  box-shadow: var(--shadow-lg);
}
```

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
