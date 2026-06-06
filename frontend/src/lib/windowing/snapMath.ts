import type { Rect, SnapZone } from './types';

const SNAP_THRESHOLD = 32;

export function getSnapZone(pointerX: number, pointerY: number, viewport: Rect, threshold = SNAP_THRESHOLD): SnapZone | null {
  const { x: vpX, y: vpY, width: vpW, height: vpH } = viewport;
  const rightEdge = vpX + vpW;
  const bottomEdge = vpY + vpH;

  const nearTop = pointerY - vpY <= threshold;
  const nearBottom = bottomEdge - pointerY <= threshold;
  const nearLeft = pointerX - vpX <= threshold;
  const nearRight = rightEdge - pointerX <= threshold;

  if (nearTop) {
    if (nearLeft) return 'top-left';
    if (nearRight) return 'top-right';
    return 'maximize';
  }

  if (nearBottom) {
    if (nearLeft) return 'bottom-left';
    if (nearRight) return 'bottom-right';
    return 'bottom';
  }

  if (nearLeft) return 'left';
  if (nearRight) return 'right';

  return null;
}

export function getSnapRect(zone: SnapZone, viewport: Rect): Rect {
  const { x: vpX, y: vpY, width: vpW, height: vpH } = viewport;
  const halfW = Math.floor(vpW / 2);
  const halfH = Math.floor(vpH / 2);

  switch (zone) {
    case 'left':
      return { x: vpX, y: vpY, width: halfW, height: vpH };
    case 'right':
      return { x: vpX + halfW, y: vpY, width: halfW, height: vpH };
    case 'top':
      return { x: vpX, y: vpY, width: vpW, height: halfH };
    case 'bottom':
      return { x: vpX, y: vpY + halfH, width: vpW, height: halfH };
    case 'top-left':
      return { x: vpX, y: vpY, width: halfW, height: halfH };
    case 'top-right':
      return { x: vpX + halfW, y: vpY, width: halfW, height: halfH };
    case 'bottom-left':
      return { x: vpX, y: vpY + halfH, width: halfW, height: halfH };
    case 'bottom-right':
      return { x: vpX + halfW, y: vpY + halfH, width: halfW, height: halfH };
    case 'maximize':
      return { x: vpX, y: vpY, width: vpW, height: vpH };
    default:
      return { x: vpX, y: vpY, width: vpW, height: vpH };
  }
}

export function clampRectToViewport(rect: Rect, viewport: Rect, minWidth = 320, minHeight = 240): Rect {
  const { x: vpX, y: vpY, width: vpW, height: vpH } = viewport;
  const maxX = vpX + vpW - minWidth;
  const maxY = vpY + vpH - minHeight;

  return {
    x: Math.max(vpX, Math.min(rect.x, maxX)),
    y: Math.max(vpY, Math.min(rect.y, maxY)),
    width: Math.max(minWidth, Math.min(rect.width, vpW)),
    height: Math.max(minHeight, Math.min(rect.height, vpH))
  };
}

export function getCascadeOffset(index: number, baseOffset = 24): number {
  return index * baseOffset;
}

export function createDefaultRect(viewport: Rect): Rect {
  const { x: vpX, y: vpY, width: vpW, height: vpH } = viewport;
  const width = Math.min(900, Math.floor(vpW * 0.7));
  const height = Math.min(600, Math.floor(vpH * 0.7));
  return {
    x: vpX + Math.floor((vpW - width) / 2),
    y: vpY + Math.floor((vpH - height) / 2),
    width,
    height
  };
}