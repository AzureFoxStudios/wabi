/** Keep a model's GPU render loop alive only while its canvas can be seen. */
export function createModelRenderLoop(
	renderFrame: () => void,
	resetClock: () => void,
	schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
	cancel: (handle: number) => void = cancelAnimationFrame
) {
	let active = false;
	let disposed = false;
	let frame = 0;

	const tick = () => {
		frame = 0;
		if (!active || disposed) return;
		renderFrame();
		if (active && !disposed) frame = schedule(tick);
	};

	const setActive = (next: boolean) => {
		if (disposed || active === next) return;
		active = next;
		if (!next) {
			if (frame) cancel(frame);
			frame = 0;
			return;
		}
		resetClock();
		frame = schedule(tick);
	};

	return {
		setActive,
		dispose() {
			if (disposed) return;
			setActive(false);
			disposed = true;
		}
	};
}
