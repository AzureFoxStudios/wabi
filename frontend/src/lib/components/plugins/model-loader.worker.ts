type ParseStlRequest = {
  type: 'parse-stl';
  src: string;
};

type WorkerRequest = ParseStlRequest;

type WorkerSuccess = {
  ok: true;
  position: ArrayBuffer;
  normal: ArrayBuffer | null;
  index: ArrayBuffer | null;
};

type WorkerFailure = {
  ok: false;
  error: string;
};

type WorkerResponse = WorkerSuccess | WorkerFailure;

async function parseStlInWorker(src: string): Promise<WorkerResponse> {
  try {
    const loadModule = async (url: string): Promise<any> => import(/* @vite-ignore */ url);
    const threeBase = 'https://esm.sh/three@0.181.1';
    await loadModule(threeBase);
    const { STLLoader } = await loadModule(`${threeBase}/examples/jsm/loaders/STLLoader`);

    const response = await fetch(src);
    if (!response.ok) {
      return { ok: false, error: `Failed to fetch STL (${response.status})` };
    }

    const raw = await response.arrayBuffer();
    const loader = new STLLoader();
    const geometry = loader.parse(raw);

    if (!geometry.getAttribute('normal')) {
      geometry.computeVertexNormals();
    }

    const positionAttr = geometry.getAttribute('position');
    const normalAttr = geometry.getAttribute('normal');
    const indexAttr = geometry.getIndex();

    const position = positionAttr?.array?.buffer
      ? (positionAttr.array.buffer as ArrayBuffer).slice(0)
      : new ArrayBuffer(0);
    const normal = normalAttr?.array?.buffer
      ? (normalAttr.array.buffer as ArrayBuffer).slice(0)
      : null;
    const index = indexAttr?.array?.buffer
      ? (indexAttr.array.buffer as ArrayBuffer).slice(0)
      : null;

    return { ok: true, position, normal, index };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'STL worker parse failed' };
  }
}

const workerSelf = self as any;

workerSelf.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const payload = event.data;
  if (!payload || payload.type !== 'parse-stl') {
    workerSelf.postMessage({ ok: false, error: 'Unsupported worker request' } satisfies WorkerFailure);
    return;
  }

  const result = await parseStlInWorker(payload.src);
  if (!result.ok) {
    workerSelf.postMessage(result);
    return;
  }

  const transfer: ArrayBuffer[] = [result.position];
  if (result.normal) transfer.push(result.normal);
  if (result.index) transfer.push(result.index);
  workerSelf.postMessage(result, transfer);
};
