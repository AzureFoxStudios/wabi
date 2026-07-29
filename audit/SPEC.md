# Wabi Motion Design SPEC

## Overview

Wabi's animation system targets fluid, physics-based motion that feels confident and responsive — not mechanical. Panels and drawers slide with momentum, settle with subtle spring overshoot, and respond immediately to touch velocity. The system is designed around GPU-composited transforms (no layout thrashing) and naturally scales to any refresh rate (60Hz → 120Hz → unlimited).

## Animation Philosophy

| Principle | Implementation |
|---|---|
| **Velocity-sensitive** | Drag speed determines animation trajectory, not just speed |
| **Physics-based** | Spring dynamics for settle; inertia for release momentum |
| **Zero jank** | `transform` + `opacity` only; `will-change` during animation |
| **Graceful degradation** | Falls back to CSS transitions if Motion is unavailable |
| **Accessibility-aware** | Respects `prefers-reduced-motion`; disables spring/overshoot |

## Spring Configurations

### Panel Slide (primary — channel sidebar, drawers)

```
stiffness: 400      // Responsive, snappy. Higher = stiffer = faster settle
damping: 35         // Light overshoot. Lower = more bounce. ~30 = Discord feel
restSpeed: 0.5      // Considered "at rest" below this px/s
```

Visual feel: Fast open (~200ms), small rubber-band overshoot on close.

### Panel Settle (release without explicit snap)

```
stiffness: 280
damping: 40
restSpeed: 2
```

Visual feel: Heavier, more deliberate. Used when velocity is low.

### Magnet Snap (swipe-to-dismiss threshold)

```
stiffness: 500
damping: 30
```

Visual feel: Locks into position decisively.

## Easing Reference (non-spring)

```
ease-out:      cubic-bezier(0, 0, 0.58, 1)     // Fast start, slow end. Message appear.
ease-in-out:   cubic-bezier(0.42, 0, 0.58, 1)  // Symmetric. Panel open.
decelerate:    cubic-bezier(0, 0, 0.58, 1)      // Signal feel — no bounce.
sharp:         cubic-bezier(0.4, 0, 0.6, 1)     // Crisp. Resize handles.
```

## Duration Guidelines

| Interaction | Duration |
|---|---|
| Panel slide open/close | Driven by spring (not time-based) |
| Panel snap to edge | Driven by spring |
| Fly-in (tooltip, small element) | 150-200ms |
| Fade (modal, overlay) | 200ms |
| Scale-up (modal open) | 250ms |
| Message appear | 120ms |

Duration is a **ceiling**, not a target. Spring animations terminate when `restSpeed` threshold is reached, which varies with initial velocity.

## Gesture Rules

### Panel Drag
1. Touch/mousedown on panel edge or handle → capture pointer
2. Track `velocityX` over last 5 pointer positions (rolling average)
3. Panel follows finger 1:1 via `translateX` (no animation, direct transform)
4. `will-change: transform` active during drag
5. On release:
   - If `velocityX > 300px/s` toward open → spring open
   - If `velocityX > 300px/s` toward close → spring close
   - If `velocityX < 300px/s` → evaluate position (past 40% threshold = open, else close)
6. On release past threshold → spring toward open
7. On release before threshold → spring toward closed

### Rubber-band at edges
When panel is dragged past open limit (overscroll):
- Apply resistance: `clampedX = openLimit + (dragX - openLimit) * 0.15`
- On release: spring back to open limit with magnet config

### Snap Points
- Closed: `translateX = 0`
- Open: `translateX = sidebarWidth`
- No intermediate snap points for panels (not a carousel)

## Accessibility

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

When reduced motion is preferred:
- All spring animations become instant (`duration: 0`)
- Fly/fade transitions drop to `50ms`
- Drag becomes binary open/close at 40% threshold

## Mobile-Specific

- `touch-action: pan-y` on draggable panels (allows vertical scroll, blocks horizontal)
- Pointer events used, not touch events (unified mouse/touch/pen)
- Android: `overscroll-behavior: contain` prevents page scroll interference
- iOS: `-webkit-overflow-scrolling: touch` not needed (transform-only animation)

## Performance Rules

1. **Never animate**: `width`, `height`, `top`, `left`, `margin`, `padding`
2. **Always animate**: `transform`, `opacity`
3. **`will-change` lifecycle**:
   ```
   drag start  → will-change: transform
   animation end → will-change: auto  (after 500ms settle)
   ```
4. **Avoid reading layout in animation loop** (no `getBoundingClientRect` in rAF)
5. **Use `contain: layout style`** on animated containers to isolate paint

## File Structure

```
src/lib/motion/
  springs.ts      # Spring presets (panelOpen, panelSettle, magnetSnap)
  easings.ts      # Non-spring easing curves as CSS strings
  reducedMotion.ts # Helper: returns true if user prefers reduced motion
  useSpringPanel.ts # Composable: drag + spring logic for a panel element

src/lib/components/
  SpringPanel.svelte  # Reusable panel wrapper with spring physics
```

## Prototype Scope (current)

- Replace `MainLayout` channel sidebar CSS transition with spring physics
- Drag handle on sidebar edge responds to pointer velocity
- Spring open/close with overshoot
- Mobile touch-friendly (swipe from edge to open)
- Falls back to instant on reduced motion
