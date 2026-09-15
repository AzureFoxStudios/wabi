import { browser } from '$app/environment';
import { getAuthToken } from '$lib/authSession';
import { getBusinessDataSnapshot, applyBusinessDataSnapshot } from '$lib/business/snapshot';
import { parsePlannerBackup, mergePlannerBackup } from '$lib/business/backup';
import { capturePlannerSession, flushBusinessStorage } from '$lib/business/deviceStorage';
import { grantLocalMockGuestAccess, isLocalMockApiMode } from '$lib/localMockApi';
import { switchChannel } from '$lib/socket';
import { showToast } from '$lib/toast';

export type MainView = 'calendar' | 'journal' | 'projects' | 'kanban';

export interface GuestAccessState {
	isGuest: boolean;
	hasGuestAccess: boolean;
	showGuestPrompt: boolean;
	guestReadOnly: boolean;
}

export interface QuickStats {
	totalTasks: number;
	completedTasks: number;
	overdueCount: number;
	todayCount: number;
	upcomingEvents: number;
}

export function initGuestAccess(): GuestAccessState {
	if (!browser) {
		return { isGuest: false, hasGuestAccess: false, showGuestPrompt: false, guestReadOnly: false };
	}
	const authToken = getAuthToken();
	const isGuest = !authToken;
	if (isGuest && isLocalMockApiMode()) {
		grantLocalMockGuestAccess();
		return { isGuest: true, hasGuestAccess: true, showGuestPrompt: false, guestReadOnly: false };
	}
	if (!isGuest) {
		return { isGuest: false, hasGuestAccess: false, showGuestPrompt: false, guestReadOnly: false };
	}
	const guestCode = sessionStorage.getItem('guestAccessCode');
	const hasGuestAccess = !!guestCode;
	return {
		isGuest: true,
		hasGuestAccess,
		showGuestPrompt: !hasGuestAccess,
		guestReadOnly: false
	};
}

export function restoreActiveView(): MainView {
	const savedView = localStorage.getItem('businessHubView') as MainView;
	if (savedView && ['calendar', 'journal', 'projects', 'kanban'].includes(savedView)) {
		return savedView;
	}
	return 'calendar';
}

export function persistActiveView(view: MainView): void {
	if (typeof window !== 'undefined') {
		localStorage.setItem('businessHubView', view);
	}
}

export function computeQuickStats(
	todos: Array<{ status: string }>,
	overdueTodos: unknown[],
	todaysTodos: unknown[],
	calendarEvents: Array<{ startDate: number }>
): QuickStats {
	const now = Date.now();
	const weekFromNow = now + 7 * 24 * 60 * 60 * 1000;
	return {
		totalTasks: todos.length,
		completedTasks: todos.filter((t) => t.status === 'done').length,
		overdueCount: overdueTodos.length,
		todayCount: todaysTodos.length,
		upcomingEvents: calendarEvents.filter((e) => e.startDate >= now && e.startDate <= weekFromNow).length
	};
}

export function exportBusinessData(): void {
	const captured = capturePlannerSession();
	const data = {
		sourceScope: captured.session.scope,
		...getBusinessDataSnapshot(),
		exportedAt: new Date().toISOString(),
		version: '1.0'
	};
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `business-hub-export-${new Date().toISOString().split('T')[0]}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

export function importBusinessData(data: unknown): void {
	const captured = capturePlannerSession();
	const incoming = parsePlannerBackup(JSON.stringify(data), captured.session.scope);
	applyBusinessDataSnapshot(mergePlannerBackup(getBusinessDataSnapshot(), incoming).data);
}

export async function handleImportFileInput(event: Event, onImport: (data: unknown) => void): Promise<void> {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (!file) return;
	try {
		const captured = capturePlannerSession();
		if (file.size > 20 * 1024 * 1024) throw new Error('Planner imports must be at most 20 MB.');
		const text = await file.text();
		parsePlannerBackup(text, captured.session.scope);
		const data = JSON.parse(text);
		if (!captured.isCurrent()) throw new Error('Your Planner account changed. Select the file again.');
		onImport(data);
		const saved = await flushBusinessStorage();
		if (captured.isCurrent()) showToast(saved ? 'Planner import saved.' : 'Import remains in your draft; saving failed.', saved ? 'info' : 'error');
	} catch (error) { showToast(error instanceof Error ? error.message : 'Planner import failed.', 'error'); }
}

export function handleChatChannelSwitch(channelId: string): void {
	switchChannel(channelId);
}
