export type ScrollMetrics = {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
};

export const MESSAGE_BOTTOM_FOLLOW_THRESHOLD_PX = 128;

/**
 * True when a conversation viewport is close enough to the newest message that
 * incoming messages may safely keep it pinned to the bottom.
 *
 * Reading history is deliberate state: once the user moves farther away than
 * this threshold, new messages must not steal their scroll position.
 */
export function isNearMessageBottom(
	metrics: ScrollMetrics,
	threshold = MESSAGE_BOTTOM_FOLLOW_THRESHOLD_PX
): boolean {
	const scrollHeight = Number.isFinite(metrics.scrollHeight) ? Math.max(0, metrics.scrollHeight) : 0;
	const scrollTop = Number.isFinite(metrics.scrollTop) ? Math.max(0, metrics.scrollTop) : 0;
	const clientHeight = Number.isFinite(metrics.clientHeight) ? Math.max(0, metrics.clientHeight) : 0;
	const distance = Math.max(0, scrollHeight - scrollTop - clientHeight);
	return distance <= Math.max(0, threshold);
}
