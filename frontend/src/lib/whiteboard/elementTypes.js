// ---------------------------------------------------------------------------
// Default style applied to new elements
// ---------------------------------------------------------------------------
export const DEFAULT_STYLE = {
    strokeColor: '#1f2937',
    strokeWidth: 2,
    fillColor: 'transparent'
};
// ---------------------------------------------------------------------------
// ID generation (no deps)
// ---------------------------------------------------------------------------
export function generateElementId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}`;
}
// ---------------------------------------------------------------------------
// Transport serialization
// ---------------------------------------------------------------------------
export function toTransportElement(el) {
    return { ...el };
}
export function fromTransportElement(raw) {
    return { ...raw };
}
