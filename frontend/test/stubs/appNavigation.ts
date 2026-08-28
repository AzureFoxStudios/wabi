export const goto = (_url: string) => Promise.resolve();
export const invalidate = (_resource?: string) => Promise.resolve();
export const invalidateAll = () => Promise.resolve();
export const prefetch = (_url: string) => Promise.resolve();
export const prefetchRoutes = (_routes?: string[]) => Promise.resolve();
export const beforeNavigate = (_cb: unknown) => {};
export const afterNavigate = (_cb: unknown) => {};
export const onNavigate = (_cb: unknown) => Promise.resolve(() => {});
