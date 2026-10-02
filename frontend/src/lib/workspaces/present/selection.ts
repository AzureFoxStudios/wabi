import * as Y from 'yjs';
import { parseAnchor } from '../anchors';

/** Resolve stable IDs, never fallback indexes. A removed target remains visibly unavailable. */
export function resolveSlideSelection(data: Y.Map<unknown>, raw?: string): { slideId: string; objectId: string | null } | null {
    const anchor = parseAnchor(raw);
    if (!anchor || (anchor.kind !== 'slide' && anchor.kind !== 'object')) return null;
    const slides = data.get('slides');
    const slide = slides instanceof Y.Map ? slides.get(anchor.slideId) : null;
    if (!(slide instanceof Y.Map) || slide.get('removed')) throw new Error('The referenced slide was removed. The deck is open, but the reference was not redirected to another slide.');
    if (anchor.kind === 'slide') return { slideId: anchor.slideId, objectId: null };
    const design = slide.get('design');
    const objects = design instanceof Y.Map ? design.get('objects') : null;
    const object = objects instanceof Y.Map ? objects.get(anchor.objectId) : null;
    if (!(object instanceof Y.Map) || object.get('removed')) throw new Error('The referenced object was removed. The reference was not redirected to a different object.');
    return { slideId: anchor.slideId, objectId: anchor.objectId };
}
