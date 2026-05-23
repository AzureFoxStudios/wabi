import type { WhiteboardLayer } from './boardTypes';
import type { BoardElement } from './elementTypes';

export interface BoardState {
	elements: BoardElement[];
	layers: WhiteboardLayer[];
	selection: Set<string>;
}

export function select(state: BoardState, ids: string[]): BoardState {
	return { ...state, selection: new Set(ids) };
}

export function selectAll(state: BoardState): BoardState {
	return {
		...state,
		selection: new Set(
			state.elements
				.filter((e) => {
					const layer = state.layers.find((candidate) => candidate.id === e.layerId);
					return !e.locked && layer?.visible !== false && layer?.locked !== true;
				})
				.map((e) => e.id)
		)
	};
}

export function clearSelection(state: BoardState): BoardState {
	return { ...state, selection: new Set() };
}

export function toggleSelection(state: BoardState, id: string): BoardState {
	const next = new Set(state.selection);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return { ...state, selection: next };
}
