/**
 * Load data for a screen and keep it fresh: re-fetches when reactive inputs
 * read by `fn` change, and whenever the server reports a change (SSE).
 * Keeps showing the previous data while reloading (no flicker).
 */
import { app } from './state.svelte.ts';

export function resource<T>(fn: () => Promise<T> | null) {
  const r = $state({ data: null as T | null, error: null as any, loading: true, reload: () => {} });
  let token = 0;
  const run = (p: Promise<T> | null) => {
    const my = ++token;
    if (!p) {
      r.loading = false;
      return;
    }
    r.loading = true;
    p.then((d) => {
      if (my !== token) return;
      r.data = d;
      r.error = null;
    }).catch((e) => {
      if (my !== token) return;
      r.error = e;
    }).finally(() => {
      if (my === token) r.loading = false;
    });
  };
  r.reload = () => run(fn());
  $effect(() => {
    void app.rev;
    run(fn());
  });
  return r;
}
