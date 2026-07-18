/**
 * Minimal global toast for socket / async errors.
 * Opt-in listen: components call `startSocketErrorToasts()` once at app boot.
 */
import { writable } from 'svelte/store';

export type SocketToast = { id: number; message: string; event: string };

export const socketToasts = writable<SocketToast[]>([]);
let seq = 0;
let listening = false;

export function pushSocketToast(event: string, message: string) {
	const id = ++seq;
	socketToasts.update((list) => [...list, { id, message, event }].slice(-5));
	setTimeout(() => {
		socketToasts.update((list) => list.filter((t) => t.id !== id));
	}, 5000);
}

export function startSocketErrorToasts() {
	if (listening || typeof window === 'undefined') return;
	listening = true;
	window.addEventListener('wabi-socket-error', ((e: CustomEvent) => {
		const detail = e.detail || {};
		pushSocketToast(String(detail.event || 'error'), String(detail.message || 'Something went wrong'));
	}) as EventListener);
}
