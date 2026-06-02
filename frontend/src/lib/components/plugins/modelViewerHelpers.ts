export type ThreadMode = 'auto' | 'always' | 'off';
export type ViewMode = 'textured' | 'normal' | 'wireframe-lines';
export type AnimationLoopMode = 'repeat' | 'once' | 'pingpong';

export type RigOverlay = {
	bones: any[];
	pairs: Array<[any, any]>;
	line: any;
	lineGeometry: any;
	lineMaterial: any;
	linePositions: Float32Array;
	sticks: any[];
	stickGeometry: any;
	stickMaterial: any;
	joints: any[];
	jointGeometry: any;
	jointMaterial: any;
};

export const materialTextureKeys = ['map', 'emissiveMap', 'specularColorMap', 'sheenColorMap'];

const THREAD_MODE_KEY = 'wabi:model-viewer-thread-mode';
const AUTO_WORKER_THRESHOLD_BYTES = 8 * 1024 * 1024;

export function getThreadMode(): ThreadMode {
	const raw = localStorage.getItem(THREAD_MODE_KEY);
	if (raw === 'single') return 'off';
	if (raw === 'always' || raw === 'off' || raw === 'auto') return raw;
	return 'auto';
}

export function persistThreadMode(mode: ThreadMode): void {
	localStorage.setItem(THREAD_MODE_KEY, mode);
}

async function getRemoteFileSize(url: string): Promise<number | null> {
	try {
		const response = await fetch(url, { method: 'HEAD' });
		const rawLength = response.headers.get('content-length');
		if (!rawLength) return null;
		const parsed = Number.parseInt(rawLength, 10);
		return Number.isFinite(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function workerSupportedForExt(ext: string): boolean {
	return ext === 'stl';
}

export async function resolveWorkerDecision(
	src: string,
	ext: string,
	threadMode: ThreadMode
): Promise<{ useWorker: boolean; notice: string }> {
	if (!workerSupportedForExt(ext) || threadMode === 'off') {
		return { useWorker: false, notice: '' };
	}
	if (threadMode === 'always') {
		return { useWorker: true, notice: '' };
	}

	const sizeBytes = await getRemoteFileSize(src);
	if (sizeBytes === null) {
		return {
			useWorker: false,
			notice: 'Auto mode could not determine file size. Using main-thread path.'
		};
	}

	const sizeLabel = `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
	if (sizeBytes >= AUTO_WORKER_THRESHOLD_BYTES) {
		return { useWorker: true, notice: `Auto selected worker mode (${sizeLabel}).` };
	}

	return { useWorker: false, notice: `Auto selected main-thread mode (${sizeLabel}).` };
}

export function clearSkeletonHelpers(skeletonHelpers: any[]): void {
	for (const helper of skeletonHelpers) {
		helper?.parent?.remove?.(helper);
		helper?.geometry?.dispose?.();
		helper?.material?.dispose?.();
	}
	skeletonHelpers.length = 0;
}

export function clearRigOverlays(rigOverlays: RigOverlay[]): void {
	for (const overlay of rigOverlays) {
		overlay.line?.parent?.remove?.(overlay.line);
		overlay.lineGeometry?.dispose?.();
		overlay.lineMaterial?.dispose?.();
		for (const stick of overlay.sticks) {
			stick?.parent?.remove?.(stick);
		}
		overlay.stickGeometry?.dispose?.();
		overlay.stickMaterial?.dispose?.();
		for (const joint of overlay.joints) {
			joint?.parent?.remove?.(joint);
		}
		overlay.jointGeometry?.dispose?.();
		overlay.jointMaterial?.dispose?.();
	}
	rigOverlays.length = 0;
}

export function disposeMaterialLike(materialLike: any): void {
	if (Array.isArray(materialLike)) {
		for (const mat of materialLike) mat?.dispose?.();
	} else {
		materialLike?.dispose?.();
	}
}

export function clearOverlayLines(
	overlayLines: Array<{ line: any; geometry: any; material: any }>
): void {
	for (const overlay of overlayLines) {
		overlay.line?.parent?.remove?.(overlay.line);
		overlay.geometry?.dispose?.();
		overlay.material?.dispose?.();
	}
	overlayLines.length = 0;
}

export function disposeRuntimeMaterials(runtimeMaterials: any[]): void {
	for (const material of runtimeMaterials) {
		material?.dispose?.();
	}
	runtimeMaterials.length = 0;
}

export function setColorTextureSpace(texture: any, THREE: any): void {
	if (!texture) return;
	if (typeof THREE?.SRGBColorSpace !== 'undefined' && 'colorSpace' in texture) {
		texture.colorSpace = THREE.SRGBColorSpace;
	} else if (typeof THREE?.sRGBEncoding !== 'undefined' && 'encoding' in texture) {
		texture.encoding = THREE.sRGBEncoding;
	}
	texture.needsUpdate = true;
}
