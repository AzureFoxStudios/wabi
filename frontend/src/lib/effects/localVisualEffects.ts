export type LocalVisualEffectKind = 'image' | 'shader';
export type LocalVisualEffectSurface = 'pointer';

export type LocalVisualEffectRecord = {
	id: string;
	name: string;
	kind: LocalVisualEffectKind;
	surface: LocalVisualEffectSurface;
	createdAt: number;
	mimeType?: string;
	imageBlob?: Blob;
	shaderSource?: string;
	tileSize?: number;
};

export const LOCAL_VISUAL_EFFECTS_EVENT = 'wabi:local-visual-effects-changed';

export const POINTER_SHADER_TEMPLATE = `// Wabi pointer visual effect
// Available uniforms (provided by Wabi; do not redeclare them):
//   vec2  u_resolution  - shader surface size in pixels
//   vec2  u_viewport    - Wabi viewport size in CSS pixels
//   vec2  u_pointer     - pointer position in viewport pixels (origin bottom-left)
//   vec2  u_velocity    - pointer velocity in CSS pixels/second
//   float u_time        - seconds since this shader was loaded
//   float u_active      - 1.0 while the pointer is moving, 0.0 when paused
//   vec3  u_accent      - current Wabi accent color, normalized 0..1

void mainImage(out vec4 color, in vec2 fragCoord) {
    vec2 uv = fragCoord / u_resolution;
    vec2 center = vec2(0.5);
    float distanceFromPointer = distance(uv, center);
    float glow = 1.0 - smoothstep(0.05, 0.5, distanceFromPointer);
    color = vec4(u_accent, glow * 0.35);
}
`;

export function downloadPointerShaderTemplate(): void {
	if (typeof window === 'undefined') return;
	const blob = new Blob([POINTER_SHADER_TEMPLATE], { type: 'text/plain;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	try {
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = 'wabi-pointer-effect.frag';
		anchor.click();
	} finally {
		window.setTimeout(() => URL.revokeObjectURL(url), 0);
	}
}

const DB_NAME = 'wabi-local-visual-effects';
const DB_VERSION = 1;
const STORE_NAME = 'effects';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SHADER_BYTES = 64 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

function makeId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	return `effect-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emitLibraryChanged(): void {
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOCAL_VISUAL_EFFECTS_EVENT));
}

function openDb(): Promise<IDBDatabase> {
	if (typeof indexedDB === 'undefined') return Promise.reject(new Error('Local visual effects require IndexedDB'));
	if (dbPromise) return dbPromise;

	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onerror = () => reject(request.error || new Error('Failed to open visual effects database'));
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
				store.createIndex('createdAt', 'createdAt');
			}
		};
		request.onsuccess = () => {
			const db = request.result;
			db.onversionchange = () => {
				db.close();
				dbPromise = null;
			};
			resolve(db);
		};
	}).catch((error) => {
		dbPromise = null;
		throw error;
	});

	return dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
	});
}

async function putRecord(record: LocalVisualEffectRecord): Promise<LocalVisualEffectRecord> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readwrite');
		tx.objectStore(STORE_NAME).put(record);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error || new Error('Failed to save visual effect'));
		tx.onabort = () => reject(tx.error || new Error('Visual effect save aborted'));
	});
	emitLibraryChanged();
	return record;
}

export async function listLocalVisualEffects(): Promise<LocalVisualEffectRecord[]> {
	const db = await openDb();
	const tx = db.transaction(STORE_NAME, 'readonly');
	const records = await requestResult(tx.objectStore(STORE_NAME).getAll()) as LocalVisualEffectRecord[];
	return records.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getLocalVisualEffect(id: string): Promise<LocalVisualEffectRecord | null> {
	if (!id) return null;
	const db = await openDb();
	const tx = db.transaction(STORE_NAME, 'readonly');
	const record = await requestResult(tx.objectStore(STORE_NAME).get(id)) as LocalVisualEffectRecord | undefined;
	return record || null;
}

export async function removeLocalVisualEffect(id: string): Promise<void> {
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, 'readwrite');
		tx.objectStore(STORE_NAME).delete(id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error || new Error('Failed to remove visual effect'));
		tx.onabort = () => reject(tx.error || new Error('Visual effect removal aborted'));
	});
	emitLibraryChanged();
}

function displayNameFromFilename(filename: string): string {
	const withoutExtension = filename.replace(/\.[^.]+$/, '').trim();
	return withoutExtension || 'Local effect';
}

function imageMimeFromFile(file: File): string {
	if (file.type) return file.type.toLowerCase();
	const lower = file.name.toLowerCase();
	if (lower.endsWith('.png')) return 'image/png';
	if (lower.endsWith('.webp')) return 'image/webp';
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
	if (lower.endsWith('.gif')) return 'image/gif';
	if (lower.endsWith('.svg')) return 'image/svg+xml';
	return '';
}

function containsUnsafeCssResource(value: string): boolean {
	if (/\@import\b/i.test(value)) return true;
	const urlPattern = /url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi;
	let match: RegExpExecArray | null;
	while ((match = urlPattern.exec(value))) {
		const target = match[2].trim();
		if (!target.startsWith('#')) return true;
	}
	return false;
}

async function sanitizeSvg(file: File): Promise<Blob> {
	const source = await file.text();
	if (/<!DOCTYPE\b/i.test(source)) throw new Error('SVG DOCTYPE declarations are not allowed');

	const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
	if (doc.querySelector('parsererror')) throw new Error('Invalid SVG');

	const blockedTags = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed']);
	for (const element of Array.from(doc.querySelectorAll('*'))) {
		const tagName = element.tagName.toLowerCase();
		if (blockedTags.has(tagName)) {
			throw new Error(`SVG contains unsupported <${tagName}> content`);
		}
		if (tagName === 'style' && containsUnsafeCssResource(element.textContent || '')) {
			throw new Error('SVG external style resources are not allowed');
		}

		for (const attribute of Array.from(element.attributes)) {
			const name = attribute.name.toLowerCase();
			const value = attribute.value.trim();
			if (name.startsWith('on')) throw new Error('SVG event handlers are not allowed');
			if ((name === 'href' || name === 'xlink:href' || name === 'src') && value && !value.startsWith('#')) {
				throw new Error('SVG external resources are not allowed');
			}
			if (containsUnsafeCssResource(value)) {
				throw new Error('SVG external resources are not allowed');
			}
		}
	}

	const serialized = new XMLSerializer().serializeToString(doc.documentElement);
	return new Blob([serialized], { type: 'image/svg+xml' });
}

export async function importLocalImageEffect(file: File): Promise<LocalVisualEffectRecord> {
	if (file.size <= 0) throw new Error('Image is empty');
	if (file.size > MAX_IMAGE_BYTES) throw new Error('Image is larger than 10 MB');

	const mimeType = imageMimeFromFile(file);
	const allowed = new Set(['image/png', 'image/webp', 'image/jpeg', 'image/gif', 'image/svg+xml']);
	if (!allowed.has(mimeType)) throw new Error('Use PNG, WebP, JPEG, GIF, or SVG');

	const imageBlob = mimeType === 'image/svg+xml' ? await sanitizeSvg(file) : file.slice(0, file.size, mimeType);
	return putRecord({
		id: makeId(),
		name: displayNameFromFilename(file.name),
		kind: 'image',
		surface: 'pointer',
		createdAt: Date.now(),
		mimeType,
		imageBlob,
		tileSize: 96
	});
}

export async function importLocalShaderEffect(file: File): Promise<LocalVisualEffectRecord> {
	if (file.size <= 0) throw new Error('Shader is empty');
	if (file.size > MAX_SHADER_BYTES) throw new Error('Shader is larger than 64 KB');
	const lower = file.name.toLowerCase();
	if (!(lower.endsWith('.frag') || lower.endsWith('.glsl'))) throw new Error('Use a .frag or .glsl shader file');

	const shaderSource = (await file.text()).trim();
	if (!/\bvoid\s+mainImage\s*\(/.test(shaderSource)) {
		throw new Error('Shader must define void mainImage(out vec4 color, in vec2 fragCoord)');
	}
	if (/^\s*#\s*extension\b/m.test(shaderSource)) {
		throw new Error('Shader extensions are not enabled in local visual effects');
	}

	return putRecord({
		id: makeId(),
		name: displayNameFromFilename(file.name),
		kind: 'shader',
		surface: 'pointer',
		createdAt: Date.now(),
		shaderSource
	});
}
