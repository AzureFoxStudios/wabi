import { get } from 'svelte/store';
import { browser } from '$app/environment';
import { socket } from '$lib/socket';
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

// Sync state
let isSyncing = false;
let isOnline = browser && navigator.onLine;
let syncInterval: ReturnType<typeof setInterval> | null = null;
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
const SYNC_INTERVAL_MS = 30000; // Sync every 30 seconds when online
const DEBOUNCE_MS = 1000; // Wait 1 second after last change before syncing

// Server URL detection (same as other components)
function getServerUrl(): string {
	if (!browser) return 'http://localhost:3000';

	if (window.location.origin.includes(':5173') || window.location.origin.includes('tauri.localhost')) {
		return 'http://localhost:3000';
	} else if (window.location.origin.includes(':3000')) {
		// Docker deployment: if on port 3000 (frontend), connect to port 8080 (backend)
		return window.location.origin.replace(':3000', ':8080');
	} else {
		return window.location.origin;
	}
}

// Load business data from server
export async function pullFromServer(): Promise<boolean> {
	if (!browser || isSyncing) return false;

	try {
		isSyncing = true;
		const serverUrl = getServerUrl();

		const response = await fetch(`${serverUrl}/api/business/get`, {
			method: 'GET',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw new Error('Failed to fetch business data from server');
		}

		const result = await response.json();

		if (result.success && result.data) {
			const serverData = result.data;

			// Update stores with server data - only if data exists
			if (serverData.todos) todos.set(serverData.todos);
			if (serverData.calendarEvents) calendarEvents.set(serverData.calendarEvents);
			if (serverData.diaryEntries) diaryEntries.set(serverData.diaryEntries);
			if (serverData.projects) projects.set(serverData.projects);
			if (serverData.sprints) sprints.set(serverData.sprints);

			// Art Portal data - preserve local data if server is empty
			// Only sync resources/tags/edges if server actually has them
			const hasServerResources = serverData.resources && Array.isArray(serverData.resources) && serverData.resources.length > 0;
			const hasServerTags = serverData.tags && Array.isArray(serverData.tags) && serverData.tags.length > 0;
			const hasServerEdges = serverData.graphEdges && Array.isArray(serverData.graphEdges) && serverData.graphEdges.length > 0;

			if (hasServerResources) resources.set(serverData.resources);
			if (hasServerTags) tags.set(serverData.tags);
			if (hasServerEdges) graphEdges.set(serverData.graphEdges);

			if (hasServerResources || hasServerTags || hasServerEdges) {
				console.log('✅ Pulled business data from server');
			}
			return true;
		}

		return false;
	} catch (error) {
		console.error('❌ Failed to pull from server:', error);
		return false;
	} finally {
		isSyncing = false;
	}
}

// Push business data to server
export async function pushToServer(): Promise<boolean> {
	if (!browser || isSyncing) return false;

	try {
		isSyncing = true;
		const serverUrl = getServerUrl();

		const data = {
			todos: get(todos),
			calendarEvents: get(calendarEvents),
			diaryEntries: get(diaryEntries),
			projects: get(projects),
			sprints: get(sprints),
			// Art Portal data
			resources: get(resources),
			tags: get(tags),
			graphEdges: get(graphEdges)
		};

		const response = await fetch(`${serverUrl}/api/business/sync`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			throw new Error('Failed to sync business data to server');
		}

		const result = await response.json();

		if (result.success) {
			console.log('✅ Pushed business data to server');
			return true;
		}

		return false;
	} catch (error) {
		console.error('❌ Failed to push to server:', error);
		return false;
	} finally {
		isSyncing = false;
	}
}

// Sync: push then pull (local changes take priority)
export async function sync(pullFirst: boolean = false): Promise<boolean> {
	if (!isOnline) {
		console.log('⚠️ Offline - skipping sync');
		return false;
	}

	console.log('🔄 Syncing business data...');

	if (pullFirst) {
		// On initial sync, pull first to get server state
		const pulled = await pullFromServer();
		const pushed = await pushToServer();
		return pulled || pushed;
	} else {
		// During auto-sync, push first to save local changes
		// This prevents losing local changes that haven't been synced yet
		const pushed = await pushToServer();
		return pushed;
	}
}

// Trigger sync with debouncing - call this after any data change
export function triggerSync(): void {
	if (!browser || !isOnline) return;

	// Clear existing timeout
	if (debounceTimeout) {
		clearTimeout(debounceTimeout);
	}

	// Schedule sync after debounce period
	debounceTimeout = setTimeout(() => {
		sync(false); // Push changes immediately
	}, DEBOUNCE_MS);
}

// Online/offline detection
function handleOnline() {
	console.log('🌐 Connection restored - syncing...');
	isOnline = true;
	sync(true); // Pull first when coming back online
	startAutoSync();
}

function handleOffline() {
	console.log('📡 Connection lost - working offline');
	isOnline = false;
	stopAutoSync();
}

// Socket.io listeners for real-time updates
let socketListenerSetup = false;

function setupSocketListeners() {
	if (!browser || socketListenerSetup) return;

	try {
		const sock = socket.get();
		if (!sock) return;

		// Listen for business data updates from other clients or server
		sock.on('business-data-updated', (data: any) => {
			console.log('📡 Real-time business data update received', data);
			// Sync immediately when server sends update
			pullFromServer();
		});

		socketListenerSetup = true;
		console.log('✅ Socket.io business listeners initialized');
	} catch (error) {
		console.error('Failed to setup Socket.io listeners:', error);
	}
}

// Auto-sync when online
function startAutoSync() {
	if (syncInterval) return; // Already running

	syncInterval = setInterval(() => {
		if (isOnline) {
			sync();
		}
	}, SYNC_INTERVAL_MS);

	console.log('🔄 Auto-sync started (every 30s)');
}

function stopAutoSync() {
	if (syncInterval) {
		clearInterval(syncInterval);
		syncInterval = null;
		console.log('⏸️ Auto-sync stopped');
	}
}

// Initialize sync engine
export function initSync() {
	if (!browser) return;

	// Set up online/offline listeners
	window.addEventListener('online', handleOnline);
	window.addEventListener('offline', handleOffline);

	// Set up Socket.io listeners for real-time updates
	setupSocketListeners();

	// Initial sync if online
	if (isOnline) {
		console.log('🌐 Online - performing initial sync...');
		sync(true); // Pull first on initial load to get server state
		startAutoSync();
	} else {
		console.log('📡 Offline - working in offline mode');
	}
}

// Cleanup function
export function cleanupSync() {
	if (!browser) return;

	window.removeEventListener('online', handleOnline);
	window.removeEventListener('offline', handleOffline);
	stopAutoSync();
}
