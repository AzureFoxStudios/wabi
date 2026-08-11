export type LoreArtifactKind = 'code' | 'prose' | 'image' | 'model-3d' | 'binary';

const CODE_EXTENSIONS = new Set(['c','cc','cpp','cs','css','go','h','hpp','html','java','js','json','jsx','kt','lua','mdx','php','py','rb','rs','sh','sql','swift','toml','ts','tsx','vue','xml','yaml','yml','glsl','hlsl','shader']);
const PROSE_EXTENSIONS = new Set(['md','txt','rtf','adoc','org','story','dialogue','script']);
const IMAGE_EXTENSIONS = new Set(['apng','bmp','gif','jpeg','jpg','png','svg','tif','tiff','webp']);
const MODEL_EXTENSIONS = new Set(['blend','fbx','gltf','glb','obj','stl','dae','abc','ply']);

export function loreArtifactKind(path: string, mimeType = ''): LoreArtifactKind {
	const normalizedMime = mimeType.toLowerCase();
	if (normalizedMime.startsWith('image/')) return 'image';
	if (normalizedMime.startsWith('text/')) return PROSE_EXTENSIONS.has(extension(path)) ? 'prose' : 'code';
	if (normalizedMime.includes('gltf') || normalizedMime.includes('model')) return 'model-3d';

	const ext = extension(path);
	if (IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (MODEL_EXTENSIONS.has(ext)) return 'model-3d';
	if (PROSE_EXTENSIONS.has(ext)) return 'prose';
	if (CODE_EXTENSIONS.has(ext)) return 'code';
	return 'binary';
}

export function loreCompareLabel(kind: LoreArtifactKind): string {
	switch (kind) {
		case 'code': return 'Compare code';
		case 'prose': return 'Read changes';
		case 'image': return 'Compare artwork';
		case 'model-3d': return 'Inspect 3D changes';
		default: return 'Compare versions';
	}
}

function extension(path: string): string {
	const name = path.split(/[\\/]/).pop() ?? path;
	const dot = name.lastIndexOf('.');
	return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export const loreArtifactExtensions = {
	code: [...CODE_EXTENSIONS],
	prose: [...PROSE_EXTENSIONS],
	image: [...IMAGE_EXTENSIONS],
	model3d: [...MODEL_EXTENSIONS]
} as const;
