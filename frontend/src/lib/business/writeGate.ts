// Hydration alone may write while ownership is changing. User writes require
// the currently admitted account, including synchronous logout retirement.
let admission: () => boolean = () => typeof window === 'undefined';
let hydrationDepth = 0;
export function setPlannerAdmission(check: () => boolean): void { admission = check; }
export function canWritePlanner(): boolean { return hydrationDepth > 0 || admission(); }
export function hydratePlanner<T>(run: () => T): T {
	hydrationDepth++;
	try { return run(); } finally { hydrationDepth--; }
}
