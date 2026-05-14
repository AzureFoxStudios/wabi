<!--
  SpringPanel.svelte
  Reusable panel with spring-physics drag and settle.
  Falls back to CSS ease-out when animationQuality.cssOnly is true.

  Props:
    openWidth  — panel width in px
    direction  — 'left' | 'right'
    open       — bind:open to control from parent
    ontoggle   — callback fired when open state changes
-->
<script lang="ts">
  import { onDestroy, createEventDispatcher } from 'svelte';
  import { animationQuality } from '$lib/motion/animationQuality';
  import { prefersReducedMotion } from '$lib/motion/reducedMotion';

  export let openWidth: number = 280;
  export let direction: 'left' | 'right' = 'left';
  export let open: boolean = false;
  export let disabled: boolean = false;

  const dispatch = createEventDispatcher<{ toggle: boolean }>();

  let panelEl: HTMLElement;
  let isDragging = false;
  let dragStartX = 0;
  let velocityX = 0;
  let pointerPositions: { x: number; t: number }[] = [];
  let settled = true;
  let rafId: number | null = null;
  let cssTransitionTimeout: ReturnType<typeof setTimeout> | null = null;

  const VELOCITY_WINDOW = 80;
  const VELOCITY_THRESHOLD = 300;
  const OPEN_THRESHOLD = 0.4;

  const CSS_DURATION = 180; // ms for CSS fallback transition

  // --- CSS vs Spring mode ---
  // cssOnly is read reactively so it updates if user toggles in real-time
  $: cssOnly = $animationQuality.cssOnly;

  function getX(): number {
    if (!panelEl) return 0;
    const matrix = new DOMMatrixReadOnly(window.getComputedStyle(panelEl).transform);
    return direction === 'left' ? matrix.m41 : -matrix.m41;
  }

  function applyX(x: number) {
    if (!panelEl) return;
    const clamped = direction === 'left' ? x : -x;
    panelEl.style.transform = `translateX(${clamped}px)`;
  }

  function clearTransition() {
    if (cssTransitionTimeout) clearTimeout(cssTransitionTimeout);
    if (panelEl) panelEl.style.transition = '';
    cssTransitionTimeout = null;
  }

  // --- CSS mode: simple ease-out transition ---
  function cssTo(target: number) {
    if (!panelEl) return;
    clearTransition();
    panelEl.style.transition = `transform ${CSS_DURATION}ms ease-out`;
    requestAnimationFrame(() => {
      applyX(target);
      cssTransitionTimeout = setTimeout(() => {
        panelEl.style.transition = '';
        cssTransitionTimeout = null;
        settled = true;
      }, CSS_DURATION + 10);
    });
    settled = false;
  }

  // --- Spring mode: rAF physics loop ---
  function springTo(target: number, vel: number = 0) {
    if (!panelEl) return;
    if (prefersReducedMotion() || cssOnly) {
      cssTo(target);
      return;
    }

    if (rafId) cancelAnimationFrame(rafId);

    settled = false;
    const stiffness = Math.abs(vel) > VELOCITY_THRESHOLD ? 400 : 280;
    const damping = Math.abs(vel) > VELOCITY_THRESHOLD ? 35 : 40;
    const restSpeed = 0.5;

    let lastValue = getX();
    let lastTime = performance.now();
    let velocity = vel;
    let settled_ = false;

    function tick() {
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const displacement = lastValue - target;
      const springForce = -stiffness * displacement;
      const dampingForce = -damping * velocity;
      velocity += (springForce + dampingForce) * dt;
      lastValue += velocity * dt;

      applyX(lastValue);

      const speed = Math.abs(velocity);
      const distance = Math.abs(lastValue - target);
      if (speed < restSpeed && distance < 0.5) {
        applyX(target);
        settled_ = true;
        settled = true;
        return;
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
  }

  // --- Velocity tracking ---
  function trackVelocity(x: number, t: number) {
    pointerPositions.push({ x, t });
    const cutoff = t - VELOCITY_WINDOW;
    pointerPositions = pointerPositions.filter(p => p.t > cutoff);
    if (pointerPositions.length >= 2) {
      const oldest = pointerPositions[0];
      const newest = pointerPositions[pointerPositions.length - 1];
      const dt = (newest.t - oldest.t) / 1000;
      if (dt > 0) {
        velocityX = (newest.x - oldest.x) / dt;
      }
    }
  }

  // --- Gesture handlers ---
  function onPointerDown(e: PointerEvent) {
    if (disabled) return;
    if (e.button !== 0) return;
    isDragging = true;
    settled = false;
    dragStartX = e.clientX;
    velocityX = 0;
    pointerPositions = [{ x: e.clientX, t: performance.now() }];
    clearTransition();
    panelEl.setPointerCapture(e.pointerId);
    panelEl.style.willChange = 'transform';
  }

  function onPointerMove(e: PointerEvent) {
    if (!isDragging || !panelEl) return;
    if (!cssOnly) trackVelocity(e.clientX, performance.now());

    let delta = direction === 'left'
      ? e.clientX - dragStartX
      : -(e.clientX - dragStartX);

    const openLimit = 0;
    if (delta > openLimit) {
      delta = openLimit + (delta - openLimit) * 0.15;
    }

    const closedLimit = -openWidth;
    if (delta < closedLimit) {
      delta = closedLimit + (delta - closedLimit) * 0.15;
    }

    applyX(delta);
  }

  function onPointerUp(e: PointerEvent) {
    if (!isDragging) return;
    isDragging = false;
    panelEl.releasePointerCapture(e.pointerId);
    panelEl.style.willChange = 'auto';

    const currentX = getX();
    const towardOpen = direction === 'left' ? velocityX > 0 : velocityX < 0;
    const towardClose = direction === 'left' ? velocityX < 0 : velocityX > 0;
    const pastThreshold = direction === 'left'
      ? currentX < -(openWidth * OPEN_THRESHOLD)
      : currentX > -(openWidth * (1 - OPEN_THRESHOLD));

    let target: number;
    if (!cssOnly && Math.abs(velocityX) > VELOCITY_THRESHOLD) {
      if (towardOpen) target = 0;
      else if (towardClose) target = -openWidth;
      else target = pastThreshold ? 0 : -openWidth;
    } else {
      // In CSS mode or slow release: always use position threshold
      target = pastThreshold ? 0 : -openWidth;
    }

    springTo(target, velocityX);
    const newOpen = target === 0;
    if (newOpen !== open) {
      open = newOpen;
      dispatch('toggle', open);
    }
  }

  // Reactive: open prop drives panel position
  $: if (panelEl && !isDragging && settled) {
    springTo(open ? 0 : -openWidth);
  }

  // Exposed API
  export function springOpen() {
    if (isDragging) return;
    springTo(0);
    open = true;
  }
  export function springClose() {
    if (isDragging) return;
    springTo(-openWidth);
    open = false;
  }
  export function springToggle() {
    open ? springClose() : springOpen();
  }

  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
    clearTransition();
  });
</script>

<div
  class="spring-panel"
  class:css-mode={cssOnly}
  class:drag={isDragging}
  class:disabled
  style="
    --panel-width: {openWidth}px;
    --direction: {direction};
  "
  bind:this={panelEl}
  on:pointerdown={onPointerDown}
  on:pointermove={onPointerMove}
  on:pointerup={onPointerUp}
  on:pointercancel={onPointerUp}
>
  <slot />
</div>

<style>
  .spring-panel {
    position: relative;
    width: var(--panel-width);
    height: 100%;
    flex-shrink: 0;
    touch-action: pan-y;
    user-select: none;
    will-change: transform;
    transform: translateX(var(--panel-offset, -100%));
  }
</style>
