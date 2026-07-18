import { writable, get } from 'svelte/store';
import { getAuthToken } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import { users, type User } from '$lib/socket';

export interface GalleryFeedback {
	feedbackId: string;
	workId: string;
	channelId: string;
	authorUserId: number;
	comment: string;
	xPercent: number;
	yPercent: number;
	createdAtMicros: number;
	isDeleted: boolean;
}

const feedbackByWork = writable<Map<string, GalleryFeedback[]>>(new Map());
const feedbackLoading = writable(false);
const feedbackError = writable<string | null>(null);

export const feedbackByWorkStore = feedbackByWork;
export const feedbackLoadingStore = feedbackLoading;
export const feedbackErrorStore = feedbackError;

function galleryApiBase(): string {
	return `${getServerUrl()}/api/gallery`;
}

function headers(): Record<string, string> {
	const token = getAuthToken();
	return {
		'Content-Type': 'application/json',
		...(token ? { Authorization: `Bearer ${token}` } : {}),
	};
}

export async function loadFeedback(channelId: string, workId: string): Promise<void> {
	if (!channelId || !workId) return;
	feedbackLoading.set(true);
	feedbackError.set(null);
	try {
		const res = await fetch(
			`${galleryApiBase()}/${encodeURIComponent(channelId)}/works/${encodeURIComponent(workId)}/feedback`,
			{ headers: headers() }
		);
		if (!res.ok) throw new Error(`Failed to load feedback: ${res.statusText}`);
		const data = await res.json();
		const items: GalleryFeedback[] = (data.feedback || []).map((f: Record<string, unknown>) => ({
			feedbackId: String(f.feedbackId ?? ''),
			workId: String(f.workId ?? ''),
			channelId: String(f.channelId ?? ''),
			authorUserId: Number(f.authorUserId ?? 0),
			comment: String(f.comment ?? ''),
			xPercent: Number(f.xPercent ?? 0),
			yPercent: Number(f.yPercent ?? 0),
			createdAtMicros: Number(f.createdAtMicros ?? 0),
			isDeleted: Boolean(f.isDeleted),
		}));
		feedbackByWork.update((map) => {
			const next = new Map(map);
			next.set(workId, items);
			return next;
		});
	} catch (err) {
		feedbackError.set(err instanceof Error ? err.message : 'Failed to load feedback');
		feedbackByWork.update((map) => {
			const next = new Map(map);
			next.set(workId, []);
			return next;
		});
	} finally {
		feedbackLoading.set(false);
	}
}

export async function addFeedback(
	channelId: string,
	workId: string,
	comment: string,
	xPercent: number,
	yPercent: number
): Promise<string | null> {
	if (!channelId || !workId) return null;
	try {
		const res = await fetch(
			`${galleryApiBase()}/${encodeURIComponent(channelId)}/works/${encodeURIComponent(workId)}/feedback`,
			{
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ comment, xPercent, yPercent }),
			}
		);
		if (!res.ok) throw new Error(`Failed to add feedback: ${res.statusText}`);
		const data = await res.json();
		// Re-load to get the full updated list
		await loadFeedback(channelId, workId);
		return String(data.feedbackId ?? '');
	} catch (err) {
		feedbackError.set(err instanceof Error ? err.message : 'Failed to add feedback');
		return null;
	}
}

export async function deleteFeedback(channelId: string, workId: string, feedbackId: string): Promise<boolean> {
	if (!channelId || !workId || !feedbackId) return false;
	try {
		const res = await fetch(
			`${galleryApiBase()}/${encodeURIComponent(channelId)}/works/${encodeURIComponent(workId)}/feedback/${encodeURIComponent(feedbackId)}`,
			{ method: 'DELETE', headers: headers() }
		);
		if (!res.ok) throw new Error(`Failed to delete feedback: ${res.statusText}`);
		await loadFeedback(channelId, workId);
		return true;
	} catch (err) {
		feedbackError.set(err instanceof Error ? err.message : 'Failed to delete feedback');
		return false;
	}
}

export function findFeedbackAuthor(userId: number): User | undefined {
	return get(users).find((u) => u.dbUserId === userId);
}
