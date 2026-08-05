import { browser } from '$app/environment';
import { getAuthToken } from '$lib/authSession';
import { getBusinessDataSnapshot, applyBusinessDataSnapshot } from '$lib/business/snapshot';
import { sanitizeBusinessData } from '$lib/business/validation';
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
	const data = {
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
	applyBusinessDataSnapshot(sanitizeBusinessData(data));
}

export function handleImportFileInput(event: Event, onImport: (data: unknown) => void): void {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file) return;
	const reader = new FileReader();
	reader.onload = (e) => {
		try {
			const data = JSON.parse(e.target?.result as string);
			onImport(data);
			showToast('Data imported successfully!', 'info');
		} catch (error) {
			console.error('Import error:', error);
			showToast('Failed to import data. Please check the file format.', 'error');
		}
	};
	reader.readAsText(file);
	input.value = '';
}

export function handleChatChannelSwitch(channelId: string): void {
	switchChannel(channelId);
}
