import type { WhiteboardLayer } from './boardTypes';

const transforms = new Set(['x', 'y', 'width', 'height', 'rotation', 'points', 'layerId']);
/** Local editing aids. Remote authoritative state must still be applied. */
export function layerAllowsUpdate(layer: WhiteboardLayer | undefined, changes: Record<string, unknown>): boolean {
 if (layer?.locked) return false;
 const keys = Object.keys(changes);
 if (layer?.lockPosition && keys.some(key => transforms.has(key))) return false;
 if (layer?.lockPixels && keys.some(key => !transforms.has(key) && key !== 'updatedAt')) return false;
 return true;
}
export function layerAllowsNewContent(layer: WhiteboardLayer | undefined): boolean {
 return !!layer && layer.visible !== false && !layer.locked && !layer.lockPixels;
}
