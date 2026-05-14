/**
 * Spring physics panel composable.
 * Attach to a panel element for drag-to-slide with velocity-based spring settling.
 *
 * Usage:
 *   const { panelRef, isOpen, open, close, toggle } = useSpringPanel({
 *     openWidth: 280,
 *     direction: 'left' | 'right',
 *   });
 */

import { prefersReducedMotion, safeDuration } from './reducedMotion';
import { panelOpen, panelSettle, magnetSnap, instant } from './springs';

export interface SpringPanelOptions {
  openWidth: number;          // Width of panel in open state (px)
  direction: 'left' | 'right'; // Which edge the panel slides from
  initialOpen?: boolean;
  openThreshold?: number;     // 0–1, fraction of width to trigger open on release (default 0.4)
  velocityThreshold?: number; // px/s to skip threshold check (default 300)
}

export interface SpringPanel {
  panelRef: HTMLElement | null;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  attach: (el: HTMLElement) => void;
  detach: () => void;
}

export function useSpringPanel(options: SpringPanelOptions): SpringPanel {
  const {
    openWidth,
    direction,
    initialOpen = false,
    openThreshold = 0.4,
    velocityThreshold = 300,
  } = options;

  let panelRef: HTMLElement | null = null;
  let isOpen = initialOpen;
  let isDragging = false;
  let dragStartX = 0;
  let dragCurrentX = 0;
  let pointerStartTime = 0;
  let pointerLastX = 0;
  let pointerLastTime = 0;
  let velocityX = 0;
  let isAnimating = false;
  let pointerPositions: { x: number; t: number }[] = [];

  // Rolling velocity window (ms)
  const VELOCITY_WINDOW = 80;

  function getTranslateX(): number {
    if (!panelRef) return isOpen ? 0 : -openWidth;
    const style = window.getComputedStyle(panelRef);
    const matrix = new DOMMatrixReadOnly(style.transform);
    return direction === 'left' ? matrix.m41 : -matrix.m41;
  }

  function setTranslateX(x: number) {
    if (!panelRef) return;
    const clamped = direction === 'left' ? x : -x;
    panelRef.style.transform = `translateX(${clamped}px)`;
  }

  function open() {
    if (!panelRef) return;
    if (prefersReducedMotion()) {
      setTranslateX(0);
      isOpen = true;
      return;
    }
    const from = getTranslateX();
    const to = 0;
    const s = isDragging ? (Math.abs(velocityX) > velocityThreshold ? panelOpen : panelSettle) : panelOpen;
    spring(from, to, {
      ...s,
      onUpdate: (v: number) => setTranslateX(v),
      onComplete: () => { isOpen = true; },
    });
  }

  function close() {
    if (!panelRef) return;
    if (prefersReducedMotion()) {
      setTranslateX(-openWidth);
      isOpen = false;
      return;
    }
    const from = getTranslateX();
    const to = -openWidth;
    const s = isDragging ? (Math.abs(velocityX) > velocityThreshold ? panelOpen : panelSettle) : panelOpen;
    spring(from, to, {
      ...s,
      onUpdate: (v: number) => setTranslateX(v),
      onComplete: () => { isOpen = false; },
    });
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  // Pointer velocity tracker
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

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return; // Left click / touch only
    isDragging = true;
    isAnimating = false;
    dragStartX = e.clientX;
    dragCurrentX = e.clientX;
    pointerStartTime = performance.now();
    pointerLastX = e.clientX;
    pointerLastTime = performance.now();
    velocityX = 0;
    pointerPositions = [{ x: e.clientX, t: performance.now() }];

    panelRef!.setPointerCapture(e.pointerId);
    panelRef!.style.willChange = 'transform';
  }

  function onPointerMove(e: PointerEvent) {
    if (!isDragging || !panelRef) return;
    dragCurrentX = e.clientX;
    trackVelocity(e.clientX, performance.now());

    let delta = direction === 'left'
      ? dragCurrentX - dragStartX
      : -(dragCurrentX - dragStartX);

    // Rubber-band resistance past open limit
    const openLimit = 0;
    if (delta > openLimit) {
      delta = openLimit + (delta - openLimit) * 0.15;
    }
    // Allow drag past closed limit (overscroll)
    const closedLimit = -openWidth;
    if (delta < closedLimit) {
      delta = closedLimit + (delta - closedLimit) * 0.15;
    }

    setTranslateX(delta);
  }

  function onPointerUp(e: PointerEvent) {
    if (!isDragging) return;
    isDragging = false;
    panelRef!.releasePointerCapture(e.pointerId);
    panelRef!.style.willChange = 'auto';

    const currentX = getTranslateX();
    const towardOpen = direction === 'left' ? velocityX > 0 : velocityX < 0;
    const towardClose = direction === 'left' ? velocityX < 0 : velocityX > 0;
    const pastThreshold = direction === 'left'
      ? currentX < -(openWidth * openThreshold)
      : currentX > -(openWidth * (1 - openThreshold));

    if (Math.abs(velocityX) > velocityThreshold) {
      if (towardOpen) open();
      else if (towardClose) close();
      else pastThreshold ? open() : close();
    } else {
      pastThreshold ? open() : close();
    }
  }

  function attach(el: HTMLElement) {
    panelRef = el;
    el.style.willChange = 'transform';
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    // Initial position
    setTranslateX(initialOpen ? 0 : -openWidth);
    isOpen = initialOpen;
  }

  function detach() {
    if (!panelRef) return;
    panelRef.removeEventListener('pointerdown', onPointerDown);
    panelRef.removeEventListener('pointermove', onPointerMove);
    panelRef.removeEventListener('pointerup', onPointerUp);
    panelRef.removeEventListener('pointercancel', onPointerUp);
  }

  return {
    get panelRef() { return panelRef; },
    get isOpen() { return isOpen; },
    open,
    close,
    toggle,
    attach,
    detach,
  };
}

// --- Internal spring runner ---
// Motion v12's spring accepts (from, to, { onUpdate, onComplete }) as of the API we verified.

function spring(
  from: number,
  to: number,
  config: {
    stiffness?: number;
    damping?: number;
    restSpeed?: number;
    onUpdate: (v: number) => void;
    onComplete?: () => void;
  }
) {
  return new Promise<void>(resolve => {
    const { stiffness = 400, damping = 30, restSpeed = 0.5, onUpdate, onComplete } = config;

    // Last published value
    let lastValue = from;
    let lastTime = performance.now();
    let velocity = 0;
    let settled = false;
    let rafId: number;

    function tick() {
      if (settled) return;
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.064); // cap at ~15fps min
      lastTime = now;

      // Spring force
      const displacement = lastValue - to;
      const springForce = -stiffness * displacement;
      const dampingForce = -damping * velocity;
      const acceleration = springForce + dampingForce;

      velocity += acceleration * dt;
      lastValue += velocity * dt;

      onUpdate(lastValue);

      // Settle check
      const speed = Math.abs(velocity);
      const distance = Math.abs(lastValue - to);
      if (speed < restSpeed && distance < 0.5) {
        settled = true;
        onUpdate(to);
        onComplete?.();
        resolve();
        return;
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
  });
}

// Backwards compat — closeable promise-based animate using spring
export function animateSpring(
  el: HTMLElement,
  key: 'x',
  from: number,
  to: number,
  config: {
    stiffness: number;
    damping: number;
    restSpeed: number;
  }
): Promise<void> {
  return new Promise(resolve => {
    let lastValue = from;
    let lastTime = performance.now();
    let velocity = 0;
    let settled = false;
    const { stiffness, damping, restSpeed } = config;

    function tick() {
      if (settled) return;
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.064);
      lastTime = now;

      const displacement = lastValue - to;
      const springForce = -stiffness * displacement;
      const dampingForce = -damping * velocity;
      velocity += (springForce + dampingForce) * dt;
      lastValue += velocity * dt;

      el.style.transform = `translateX(${lastValue}px)`;

      const speed = Math.abs(velocity);
      const distance = Math.abs(lastValue - to);
      if (speed < restSpeed && distance < 0.5) {
        settled = true;
        el.style.transform = `translateX(${to}px)`;
        resolve();
        return;
      }

      requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  });
}
