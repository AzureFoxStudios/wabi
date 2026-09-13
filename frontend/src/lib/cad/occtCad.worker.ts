/// <reference lib="webworker" />

const OCCT_MODULE_URL = 'https://esm.sh/@sunbox/occt-import-js@0.0.28';
const OCCT_WASM_URL = 'https://cdn.jsdelivr.net/npm/@sunbox/occt-import-js@0.0.28/dist/occt-import-js.wasm';

interface ImportMessage {
	id: string;
	format: 'step' | 'iges';
	buffer: ArrayBuffer;
}

interface RawNode {
	name?: string;
	meshes?: number[];
	children?: RawNode[];
}

interface RawFace {
	first?: number;
	last?: number;
	color?: number[] | null;
}

interface RawMesh {
	name?: string;
	color?: number[];
	brep_faces?: RawFace[];
	attributes?: {
		position?: { array?: number[] };
		normal?: { array?: number[] };
	};
	index?: { array?: number[] };
}

interface RawResult {
	success?: boolean;
	root?: RawNode;
	meshes?: RawMesh[];
}

let occtPromise: Promise<any> | null = null;

async function getOcct(): Promise<any> {
	if (!occtPromise) {
		occtPromise = (async () => {
			const [module, wasmResponse] = await Promise.all([
				import(/* @vite-ignore */ OCCT_MODULE_URL),
				fetch(OCCT_WASM_URL)
			]);
			if (!wasmResponse.ok) throw new Error(`Could not load OpenCascade WASM (${wasmResponse.status}).`);
			const factory = (module as any).default || module;
			if (typeof factory !== 'function') throw new Error('OpenCascade importer module did not expose an initializer.');
			const wasmBinary = await wasmResponse.arrayBuffer();
			return factory({ wasmBinary });
		})();
		occtPromise.catch(() => { occtPromise = null; });
	}
	return occtPromise;
}

function finiteColor(value: unknown): [number, number, number] | null {
	if (!Array.isArray(value) || value.length < 3) return null;
	const color = value.slice(0, 3).map(Number);
	if (!color.every(Number.isFinite)) return null;
	return [color[0], color[1], color[2]];
}

function normalizeNode(node: RawNode | undefined): { name: string; meshes: number[]; children: any[] } {
	return {
		name: typeof node?.name === 'string' ? node.name : '',
		meshes: Array.isArray(node?.meshes) ? node.meshes.filter((index) => Number.isInteger(index) && index >= 0) : [],
		children: Array.isArray(node?.children) ? node.children.map(normalizeNode) : []
	};
}

function normalizeResult(result: RawResult): { root: ReturnType<typeof normalizeNode>; meshes: any[]; transfers: Transferable[] } {
	if (!result?.success || !Array.isArray(result.meshes)) throw new Error('OpenCascade could not import this CAD file.');
	const transfers: Transferable[] = [];
	const meshes = result.meshes.map((mesh, meshIndex) => {
		const positionValues = mesh.attributes?.position?.array;
		const indexValues = mesh.index?.array;
		if (!Array.isArray(positionValues) || positionValues.length < 3 || positionValues.length % 3 !== 0) {
			throw new Error(`Imported mesh ${meshIndex + 1} has invalid vertex data.`);
		}
		if (!Array.isArray(indexValues) || indexValues.length < 3 || indexValues.length % 3 !== 0) {
			throw new Error(`Imported mesh ${meshIndex + 1} has invalid triangle data.`);
		}
		const position = new Float32Array(positionValues);
		const normalsRaw = mesh.attributes?.normal?.array;
		const normal = Array.isArray(normalsRaw) && normalsRaw.length === positionValues.length
			? new Float32Array(normalsRaw)
			: null;
		const index = new Uint32Array(indexValues);
		transfers.push(position.buffer, index.buffer);
		if (normal) transfers.push(normal.buffer);
		return {
			name: typeof mesh.name === 'string' ? mesh.name : `CAD mesh ${meshIndex + 1}`,
			color: finiteColor(mesh.color),
			faces: Array.isArray(mesh.brep_faces) ? mesh.brep_faces.map((face) => ({
				first: Number.isInteger(face.first) ? Math.max(0, face.first as number) : 0,
				last: Number.isInteger(face.last) ? Math.max(0, face.last as number) : 0,
				color: finiteColor(face.color)
			})) : [],
			position: position.buffer,
			normal: normal?.buffer ?? null,
			index: index.buffer
		};
	});
	return { root: normalizeNode(result.root), meshes, transfers };
}

self.addEventListener('message', (event: MessageEvent<ImportMessage>) => {
	const payload = event.data;
	if (!payload || typeof payload.id !== 'string' || (payload.format !== 'step' && payload.format !== 'iges') || !(payload.buffer instanceof ArrayBuffer)) return;
	void (async () => {
		try {
			const occt = await getOcct();
			const bytes = new Uint8Array(payload.buffer);
			const raw: RawResult = payload.format === 'step'
				? occt.ReadStepFile(bytes, null)
				: occt.ReadIgesFile(bytes, null);
			const normalized = normalizeResult(raw);
			self.postMessage({ id: payload.id, ok: true, root: normalized.root, meshes: normalized.meshes }, normalized.transfers);
		} catch (reason) {
			self.postMessage({
				id: payload.id,
				ok: false,
				error: reason instanceof Error ? reason.message : 'OpenCascade import failed.'
			});
		}
	})();
});

export {};
