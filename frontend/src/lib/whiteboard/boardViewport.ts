export interface WhiteboardViewport {
	x: number;
	y: number;
	zoom: number;
}

export interface BoardState {
	viewport: WhiteboardViewport;
}

export function setViewport(state: BoardState, vp: WhiteboardViewport): BoardState {
	return { ...state, viewport: vp };
}

export function panBy(state: BoardState, dx: number, dy: number): BoardState {
	return {
		...state,
		viewport: { ...state.viewport, x: state.viewport.x + dx, y: state.viewport.y + dy }
	};
}

export function zoomTo(state: BoardState, zoom: number, cx: number, cy: number): BoardState {
	const clamped = Math.max(0.1, Math.min(10, zoom));
	const ratio = clamped / state.viewport.zoom;
	return {
		...state,
		viewport: {
			x: cx - (cx - state.viewport.x) / ratio,
			y: cy - (cy - state.viewport.y) / ratio,
			zoom: clamped
		}
	};
}
