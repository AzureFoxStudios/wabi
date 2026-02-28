import { get } from 'svelte/store';
import { browser } from '$app/environment';
import { getSocket } from '$lib/socket';
import { getServerUrl } from '$lib/serverUrl';
import { getAuthToken } from '$lib/authSession';
import {
	todos,
	calendarEvents,
	diaryEntries,
	projects,
	sprints,
	resources,
	tags,
	graphEdges
} from './store';

type BusinessSyncMode = 'manual' | 'auto';

// Sync state
let isSyncing = false;
let isOnline = browser && navigator.onLine;
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 1000;
const BUSINESS_SYNC_MODE_KEY = 'wabi_business_sync_mode';
const BUSINESS_SYNC_DEBUG_KEY = 'wabi_debug_business_sync';
let pendingRemoteUpdate = false;

function logSync(...args: unknown[]): void {
	if (!browser) return;
	if (localStorage.getItem(BUSINESS_SYNC_DEBUG_KEY) !== 'true') return;
	console.log(...args);
}

export function getBusinessSyncMode(): BusinessSyncMode {
	if (!browser) return 'manual';
	const mode = localStorage.getItem(BUSINESS_SYNC_MODE_KEY);
	return mode === 'auto' ? 'auto' : 'manual';
}

export function setBusinessSyncMode(mode: BusinessSyncMode): void {
	if (!browser) return;
	localStorage.setItem(BUSINESS_SYNC_MODE_KEY, mode);
}

function isManualSyncMode(): boolean {
	return getBusinessSyncMode() === 'manual';
}

export function hasPendingRemoteBusinessUpdate(): boolean {
	return pendingRemoteUpdate;
}

function hasAuthToken(): boolean {
	return browser && !!getAuthToken();
}

export async function pullFromServer(): Promise<boolean> {
	if (!browser || isSyncing || !hasAuthToken()) return false;

	try {
		isSyncing = true;
		const serverUrl = getServerUrl();
		const token = getAuthToken();

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 8000);
		let response;
		try {
			response = await fetch(`${serverUrl}/api/business/get`, {
				method: 'GET',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {})
				},
				credentials: 'include',
				signal: controller.signal
			});
		} finally {
			clearTimeout(timeout);
		}

		if (!response.ok) {
			throw new Error('Failed to fetch business data from server');
		}

		const result = await response.json();

		if (result.success && result.data) {
			const serverData = result.data;

			if (serverData.todos) todos.set(serverData.todos);
			if (serverData.calendarEvents) calendarEvents.set(serverData.calendarEvents);
			if (serverData.diaryEntries) diaryEntries.set(serverData.diaryEntries);
			if (serverData.projects) projects.set(serverData.projects);
			if (serverData.sprints) sprints.set(serverData.sprints);
			if (Array.isArray(serverData.resources)) resources.set(serverData.resources);
			if (Array.isArray(serverData.tags)) tags.set(serverData.tags);
			if (Array.isArray(serverData.graphEdges)) graphEdges.set(serverData.graphEdges);

			pendingRemoteUpdate = false;
			logSync('[BusinessSync] Pulled business data from server');
			return true;
		}

		return false;
	} catch (error) {
		console.error('[BusinessSync] Failed to pull from server:', error);
		return false;
	} finally {
		isSyncing = false;
	}
}

export async function pushToServer(): Promise<boolean> {
	if (!browser || isSyncing || !hasAuthToken()) return false;

	try {
		isSyncing = true;
		const serverUrl = getServerUrl();
		const token = getAuthToken();
		const guestCode = sessionStorage.getItem('guestAccessCode');

		const data = {
			todos: get(todos),
			calendarEvents: get(calendarEvents),
			diaryEntries: get(diaryEntries),
			projects: get(projects),
			sprints: get(sprints),
			resources: get(resources),
			tags: get(tags),
			graphEdges: get(graphEdges)
		};

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 8000);
		let response;
		try {
			response = await fetch(`${serverUrl}/api/business/sync`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(token ? { Authorization: `Bearer ${token}` } : {}),
					...(guestCode && !token ? { 'X-Guest-Code': guestCode } : {})
				},
				credentials: 'include',
				body: JSON.stringify(data),
				signal: controller.signal
			});
		} finally {
			clearTimeout(timeout);
		}

		if (!response.ok) {
			throw new Error('Failed to sync business data to server');
		}

		const result = await response.json();
		if (result.success) {
			logSync('[BusinessSync] Pushed business data to server');
			return true;
		}

		return false;
	} catch (error) {
		console.error('[BusinessSync] Failed to push to server:', error);
		return false;
	} finally {
		isSyncing = false;
	}
}

export async function sync(pullFirst = false): Promise<boolean> {
	if (!isOnline || !hasAuthToken()) {
		return false;
	}

	logSync('[BusinessSync] Syncing business data', { pullFirst });

	if (pullFirst) {
		const pulled = await pullFromServer();
		const pushed = await pushToServer();
		return pulled || pushed;
	}

	const pushed = await pushToServer();
	return pushed;
}

export function triggerSync(): void {
	if (!browser || !isOnline || !hasAuthToken() || isManualSyncMode()) return;

	if (debounceTimeout) {
		clearTimeout(debounceTimeout);
	}

	debounceTimeout = setTimeout(() => {
		sync(false);
	}, DEBOUNCE_MS);
}

function handleOnline() {
	isOnline = true;
	logSync('[BusinessSync] Connection restored');
	if (!isManualSyncMode()) {
		sync(true);
	}
}

function handleOffline() {
	isOnline = false;
	logSync('[BusinessSync] Connection lost, working offline');
}

let currentSocketId: string | null = null;
let listenerCleanup: (() => void) | null = null;

function setupSocketListeners() {
	if (!browser) return;

	try {
		const sock = getSocket();
		if (!sock) return;

		if (currentSocketId === sock.id && listenerCleanup) {
			return;
		}

		if (listenerCleanup) {
			listenerCleanup();
			listenerCleanup = null;
		}

		const handleBusinessUpdate = (data: unknown) => {
			logSync('[BusinessSync] Real-time business update received', data);
			pendingRemoteUpdate = true;
			if (!isManualSyncMode()) {
				pullFromServer();
			}
		};

		sock.on('business-data-updated', handleBusinessUpdate);

		listenerCleanup = () => {
			sock.off('business-data-updated', handleBusinessUpdate);
		};

		currentSocketId = sock.id;
		logSync('[BusinessSync] Socket listeners initialized for socket', sock.id);
	} catch (error) {
		console.error('[BusinessSync] Failed to setup Socket.io listeners:', error);
	}
}

export function initSync() {
	if (!browser) return;

	if (!hasAuthToken()) {
		logSync('[BusinessSync] No auth token, skipping sync init');
		return;
	}

	window.addEventListener('online', handleOnline);
	window.addEventListener('offline', handleOffline);
	setupSocketListeners();

	if (isOnline && !isManualSyncMode()) {
		logSync('[BusinessSync] Online - performing initial sync');
		sync(true);
	} else {
		logSync('[BusinessSync] Manual mode enabled or offline - not auto-syncing on init');
	}
}

export function cleanupSync() {
	if (!browser) return;

	window.removeEventListener('online', handleOnline);
	window.removeEventListener('offline', handleOffline);

	if (debounceTimeout) {
		clearTimeout(debounceTimeout);
		debounceTimeout = null;
	}

	if (listenerCleanup) {
		listenerCleanup();
		listenerCleanup = null;
	}
	currentSocketId = null;
}
