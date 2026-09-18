import type { AudienceSlide } from '../bridge';
import {cleanDesign} from '../scene';

export interface ApprovedEdition {
    slides: AudienceSlide[];
    aspect: number;
    fingerprint: string;
    destination: string;
    currentMissing: boolean;
}

/** Fingerprint only the audience DTO, not notes, source history, or hidden slides. */
export function editionFingerprint(slides: AudienceSlide[], aspect: number): string {
    return JSON.stringify({ aspect, slides: slides.map(({ id, title, body, layout, image, design }) => ({ id, title, body, layout, image, ...(layout==='canvas'&&design?{design:cleanDesign(design)}:{}) })) });
}

export function prepareEdition(slides: AudienceSlide[], aspect: number, currentSlideId: string): ApprovedEdition {
    if (!Number.isFinite(aspect) || aspect < 0.5 || aspect > 3) throw new Error('Unsupported presentation aspect ratio.');
    if (!slides.length || slides.length > 100) throw new Error('Publish between 1 and 100 visible slides.');
    if (new Set(slides.map(slide => slide.id)).size !== slides.length) throw new Error('Duplicate slide identity.');
    const fingerprint = editionFingerprint(slides, aspect);
    const copy = JSON.parse(fingerprint) as { slides: AudienceSlide[]; aspect: number };
    const exists = copy.slides.some(slide => slide.id === currentSlideId);
    return { ...copy, fingerprint, destination: exists ? currentSlideId : '', currentMissing: !exists };
}

export function verifyEdition(approved: ApprovedEdition, slides: AudienceSlide[], aspect: number, destination: string): void {
    if (approved.fingerprint !== editionFingerprint(slides, aspect)) throw new Error('The deck changed after this preview. Review the new version before updating the audience.');
    if (!approved.slides.some(slide => slide.id === destination)) throw new Error('Choose a published destination slide. The previous slide was removed or hidden.');
}
