export interface LongPressOptions {
	duration?: number;
	cancelOnMove?: number;
	onLongPress: (event: TouchEvent) => void;
}

export function longpress(node: HTMLElement, options: LongPressOptions) {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let startX = 0;
	let startY = 0;
	let fired = false;

	const duration = options.duration ?? 500;
	const cancelOnMove = options.cancelOnMove ?? 10;
	let onLongPress = options.onLongPress;

	function handleTouchStart(event: TouchEvent) {
		const touch = event.touches[0];
		startX = touch.clientX;
		startY = touch.clientY;
		fired = false;

		timer = setTimeout(() => {
			fired = true;
			onLongPress(event);
		}, duration);
	}

	function handleTouchMove(event: TouchEvent) {
		if (!timer) return;
		const touch = event.touches[0];
		const dx = touch.clientX - startX;
		const dy = touch.clientY - startY;
		if (Math.sqrt(dx * dx + dy * dy) > cancelOnMove) {
			cancel();
		}
	}

	function handleTouchEnd() {
		cancel();
	}

	function handleContextMenu(event: Event) {
		if (fired) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	function cancel() {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	node.addEventListener('touchstart', handleTouchStart, { passive: true });
	node.addEventListener('touchmove', handleTouchMove, { passive: true });
	node.addEventListener('touchend', handleTouchEnd, { passive: true });
	node.addEventListener('touchcancel', handleTouchEnd, { passive: true });
	node.addEventListener('contextmenu', handleContextMenu);

	return {
		update(newOptions: LongPressOptions) {
			onLongPress = newOptions.onLongPress;
		},
		destroy() {
			cancel();
			node.removeEventListener('touchstart', handleTouchStart);
			node.removeEventListener('touchmove', handleTouchMove);
			node.removeEventListener('touchend', handleTouchEnd);
			node.removeEventListener('touchcancel', handleTouchEnd);
			node.removeEventListener('contextmenu', handleContextMenu);
		}
	};
}
