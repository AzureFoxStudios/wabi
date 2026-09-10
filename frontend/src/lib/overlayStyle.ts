import type { User } from './socket-types';

type OverlayAlignmentLike = Pick<User, 'overlayUrl' | 'overlayScale' | 'overlayOffsetX' | 'overlayOffsetY'> | null | undefined;

function num(v: unknown, fallback: number): number {
	const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
	return Number.isFinite(n) ? n : fallback;
}

/** Inline style for an avatar overlay span: image + scale/offset custom properties. */
export function overlayStyle(user: OverlayAlignmentLike): string {
	if (!user?.overlayUrl) return '';
	const scale = Math.min(3, Math.max(0.5, num(user.overlayScale, 1)));
	const ox = Math.min(200, Math.max(-200, num(user.overlayOffsetX, 0)));
	const oy = Math.min(200, Math.max(-200, num(user.overlayOffsetY, 0)));
	return `background-image: url(${user.overlayUrl}); --overlay-scale: ${scale}; --overlay-offset-x: ${ox}px; --overlay-offset-y: ${oy}px;`;
}
