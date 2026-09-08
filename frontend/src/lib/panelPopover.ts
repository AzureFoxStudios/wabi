/** Viewport coordinates: popovers must be portaled outside transformed docks. */
export function positionPanelPopover(
	anchor: { left: number; right: number; top: number },
	viewport: { width: number; height: number },
	content: { width: number; height: number },
	side: 'left' | 'right'
): { left: number; top: number; maxWidth: number; maxHeight: number } {
	const margin = 8;
	const maxWidth = Math.max(0, viewport.width - margin * 2);
	const maxHeight = Math.max(0, viewport.height - margin * 2);
	const width = Math.min(content.width, maxWidth);
	const height = Math.min(content.height, maxHeight);
	const preferredLeft = side === 'left' ? anchor.right + 4 : anchor.left - width - 4;
	return {
		left: Math.max(margin, Math.min(preferredLeft, viewport.width - margin - width)),
		top: Math.max(margin, Math.min(anchor.top, viewport.height - margin - height)),
		maxWidth,
		maxHeight
	};
}

/** Arrow movement wraps, and disabled/non-action rows are filtered by the caller. */
export function panelActionIndex(key: string, index: number, count: number): number | null {
	if (count === 0) return null;
	if (key === 'Home') return 0;
	if (key === 'End') return count - 1;
	if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
	if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
	return null;
}
