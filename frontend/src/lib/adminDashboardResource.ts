import { parseDashboardStats, type DashboardStats } from './adminDashboard';

export interface AdminDashboardSnapshot {
	stats: DashboardStats | null;
	loading: boolean;
	error: string | null;
	receivedAt: number | null;
}

export const emptyAdminSnapshot = (): AdminDashboardSnapshot => ({ stats: null, loading: false, error: null, receivedAt: null });

export class AdminDashboardAccessError extends Error {}

/** One mounted account/server owns one bounded read. No overlapping poll can
 * overwrite newer data, and a retired view cannot publish after logout/close. */
export function createAdminDashboardResource(options: {
	read: (signal: AbortSignal) => Promise<unknown>;
	onChange: (snapshot: AdminDashboardSnapshot) => void;
	now?: () => number;
	timeoutMs?: number;
}) {
	let state = emptyAdminSnapshot();
	let disposed = false;
	let inFlight: Promise<void> | null = null;
	let controller: AbortController | null = null;
	const publish = (next: AdminDashboardSnapshot) => { if (!disposed) { state = next; options.onChange(next); } };
	return {
		refresh(): Promise<void> {
			if (disposed) return Promise.resolve();
			if (inFlight) return inFlight;
			inFlight = Promise.resolve().then(async () => {
				if (disposed) return;
				const request = new AbortController();
				controller = request;
				publish({ ...state, loading: true });
				if (disposed) return;
				let timeout: ReturnType<typeof setTimeout>;
				let removeAbortListener = () => {};
				const cancelled = new Promise<never>((_, reject) => {
					const abort = () => reject(new Error('Administration view closed.'));
					request.signal.addEventListener('abort', abort, { once: true });
					removeAbortListener = () => request.signal.removeEventListener('abort', abort);
				});
				const deadline = new Promise<never>((_, reject) => {
					timeout = setTimeout(() => {
						reject(new Error('The server did not respond in time. Try refreshing.'));
						request.abort();
					}, options.timeoutMs ?? 10_000);
				});
				try {
					const payload = await Promise.race([options.read(request.signal), deadline, cancelled]);
					if (disposed || request.signal.aborted) return;
					const stats = parseDashboardStats(payload);
					publish({ stats, loading: false, error: null, receivedAt: (options.now ?? Date.now)() });
				} catch (error) {
					publish({ ...(error instanceof AdminDashboardAccessError ? emptyAdminSnapshot() : state), loading: false, error: error instanceof Error ? error.message : 'Could not read server status.' });
				} finally {
					clearTimeout(timeout!);
					removeAbortListener();
					controller = null;
					inFlight = null;
				}
			});
			return inFlight;
		},
		dispose(): void {
			disposed = true;
			controller?.abort();
		},
	};
}
