/** Requests never retry mutations and never deliver into a retired account/view. */
export interface GameContext { server: string; userId: string; generation: number; token: string | null }
/** Only the callable HTTP interface is required; Bun's optional fetch.preconnect is not. */
export type GameFetch = (input: string, init?: RequestInit) => Promise<Response>;
export function createGameClient(context: () => GameContext, fetcher: GameFetch = fetch) {
  // Capture primitives, not the caller's mutable context object.
  const origin = { ...context() }; const controllers = new Set<AbortController>(); let disposed = false;
  const active = () => {
    const now = context();
    return !disposed && !!origin.token && now.server === origin.server && now.userId === origin.userId &&
      now.generation === origin.generation && now.token === origin.token;
  };
  return {
    active,
    async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      if (!active()) throw new Error('Session changed. Reopen Games.');
      if (!/^\/(games|steam)\//.test(path) || path.includes('..')) throw new Error('Invalid game request');
      const controller = new AbortController(); controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 16000);
      try {
        const response = await fetcher(`${origin.server.replace(/\/+$/, '')}/api${path}`, {
          method, headers: {Authorization:`Bearer ${origin.token}`, 'Content-Type':'application/json'},
          body: body === undefined ? undefined : JSON.stringify(body), cache:'no-store', credentials:'omit', signal:controller.signal
        });
        if (!active()) throw new Error('Session changed. Response discarded.');
        const payload = await response.json() as Record<string, unknown>;
        if (!active()) throw new Error('Session changed. Response discarded.');
        if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error.slice(0,400) : `Request failed (${response.status})`);
        return payload as T;
      } catch (error) {
        if (!active()) throw new Error('Session changed. Response discarded.');
        if (controller.signal.aborted || error instanceof TypeError) throw new Error(method==='GET'
          ? 'Could not load games. Check your connection.'
          : 'Could not confirm the result. Your draft remains here; reload before retrying a save.');
        throw error;
      } finally {clearTimeout(timer);controllers.delete(controller);}
    },
    dispose() {disposed=true;for (const c of controllers) c.abort();controllers.clear();}
  };
}
