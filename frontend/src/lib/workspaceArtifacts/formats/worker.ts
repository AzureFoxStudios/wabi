/** One owned worker per explicit file operation; no startup timers or services. */
export function inWorker<T>(worker: Worker, payload: unknown, transfer: Transferable[] = [], signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown, result?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(result as T);
    };
    const abort = () => finish(new DOMException('File operation cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('File operation exceeded its 45 second limit')), 45_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => {
      const response = event.data;
      if (response?.error) finish(new Error(String(response.error))); else finish(undefined, response?.result as T);
    };
    worker.onerror = event => finish(new Error(event.message || 'File worker failed'));
    if (signal?.aborted) abort();
    else try { worker.postMessage(payload, transfer); } catch (error) { finish(error); }
  });
}
