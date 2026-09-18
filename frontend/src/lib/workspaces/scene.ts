/** Lightweight audience primitives. No authoring library or workbook reference is permitted here. */
export type SceneKind = 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'table' | 'chart';
export type SceneTheme = 'paper' | 'night' | 'ocean';
export interface SceneObject {
    id: string; kind: SceneKind; x: number; y: number; w: number; h: number; z: number;
    text: string; image: string | null; fill: string; color: string; fontSize: number;
    align: 'left' | 'center' | 'right'; fit: 'contain' | 'cover'; cropX: number; cropY: number;
}
export interface SlideDesign { theme: SceneTheme; objects: SceneObject[]; }
export const scenePalette = {
    paper: { background: '#F4F1E9', foreground: '#242836', accent: '#557A95' },
    night: { background: '#172033', foreground: '#F4F1E9', accent: '#99BBDD' },
    ocean: { background: '#E7F3F1', foreground: '#173F48', accent: '#348080' }
} as const;
const kinds = new Set(['text', 'image', 'rect', 'ellipse', 'line', 'table', 'chart']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = new Set(['id','kind','x','y','w','h','z','text','image','fill','color','fontSize','align','fit','cropX','cropY']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const color = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
export function cleanSceneObject(value: unknown): SceneObject {
    if (!record(value) || Object.keys(value).some(key => !keys.has(key))) throw new Error('Unsupported slide object property.');
    const v = value;
    if (typeof v.id !== 'string' || !uuid.test(v.id) || typeof v.kind !== 'string' || !kinds.has(v.kind)) throw new Error('Invalid slide object identity or kind.');
    if (!bounded(v.x, 0, 1) || !bounded(v.y, 0, 1) || !bounded(v.w, .02, 1) || !bounded(v.h, .02, 1) || v.x + v.w > 1.000001 || v.y + v.h > 1.000001 || !bounded(v.z, -1000000, 1000000)) throw new Error('Slide object is outside the canvas.');
    if (typeof v.text !== 'string' || v.text.length > 6000 || !color(v.color) || !(v.fill === 'transparent' || color(v.fill)) || !bounded(v.fontSize, 12, 72) || !['left','center','right'].includes(String(v.align)) || !['contain','cover'].includes(String(v.fit)) || !bounded(v.cropX, 0, 1) || !bounded(v.cropY, 0, 1)) throw new Error('Unsupported slide object style or text.');
    if (v.image !== null && (typeof v.image !== 'string' || v.image.length > 2 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v.image))) throw new Error('Slide images must be bounded inline raster images.');
    return { id:v.id, kind:v.kind as SceneKind, x:v.x, y:v.y, w:v.w, h:v.h, z:v.z, text:v.text, image:v.image as string|null, fill:v.fill as string, color:v.color, fontSize:v.fontSize, align:v.align as SceneObject['align'], fit:v.fit as SceneObject['fit'], cropX:v.cropX, cropY:v.cropY };
}
export function cleanDesign(value: unknown): SlideDesign {
    if (!record(value) || Object.keys(value).some(key => !['theme','objects'].includes(key)) || !Object.hasOwn(scenePalette, String(value.theme)) || !Array.isArray(value.objects) || value.objects.length > 64) throw new Error('Unsupported slide design.');
    const objects = value.objects.map(cleanSceneObject);
    if (new Set(objects.map(object => object.id)).size !== objects.length) throw new Error('Duplicate slide object identity.');
    return { theme:value.theme as SceneTheme, objects:objects.sort((a,b) => a.z-b.z || a.id.localeCompare(b.id)) };
}
export function publicDesign(value:unknown):SlideDesign {
    const design=cleanDesign(value);
    if(design.objects.some(object=>object.kind==='image'&&object.image&&object.fit==='cover'))throw new Error('Finalize each image crop before presenting or exporting the audience version.');
    return design;
}
export function tableRows(text: string): string[][] {
    const rows = text.split(/\r?\n/).filter(line => line.length).map(line => line.split('\t'));
    return rows.length <= 20 && rows.every(row => row.length <= 8) ? rows : [];
}
export function chartRows(text: string): {label:string;value:number}[] {
    const rows = tableRows(text);
    if (!rows.length || rows.some(row => row.length !== 2 || !row[1].trim() || !Number.isFinite(Number(row[1])))) return [];
    return rows.map(([label,value]) => ({label, value:Number(value)}));
}
