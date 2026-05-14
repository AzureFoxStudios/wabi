import { browser } from '$app/environment';
import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { addMediaAlbumItem, type MediaAlbumScopeType, type MediaAlbumItem } from './api';
import { channels, currentChannel } from './socket';
import { getAuthToken } from './authSession';
import { getServerUrl } from './serverUrl';
import { isDesktopTauri } from './tauri-platform';

export interface GameScreenshotDirectoryCandidate {
	path: string;
	label: string;
	exists: boolean;
}

export interface GameScreenshotFile {
	path: string;
	fileName: string;
	fileSize: number;
	modifiedAt: number;
	mimeType: string;
}

export interface GameScreenshotFilePayload {
	path: string;
	fileName: string;
	mimeType: string;
	base64: string;
}

export interface BatchGameScreenshotPayload {
	files: GameScreenshotFilePayload[];
	errors: string[];
}

export interface GameScreenshotPipeSettings {
	enabled: boolean;
	screenshotDirectoryPath: string;
}

export interface GameScreenshotPipeImportEventDetail {
	scopeKey: string;
	scopeType: MediaAlbumScopeType;
	scopeId: string;
	albumId: number;
	fileName: string;
	sourcePath: string;
	uploadedAt: number;
}

export interface GameScreenshotPipeRunResult {
	imported: number;
	skipped: number;
	scopeKey: string | null;
	albumId: number | null;
	sourceDirectoryPath: string | null;
}

const SETTINGS_KEY = 'wabi.gameScreenshotPipe.settings.v1';
const TARGETS_KEY = 'wabi.gameScreenshotPipe.targets.v1';
// Content hashes instead of path-based tracking
const HASH_TRACKING_KEY = 'wabi.gameScreenshotPipe.fileHashes.v1';
const PROCESSED_META_KEY = 'wabi.gameScreenshotPipe.processedMeta.v1';
export const GAME_SCREENSHOT_PIPE_REFRESH_EVENT = 'wabi:game-screenshot-pipe-refresh';

// Content hash tracking type
interface FileHashEntry {
	hash: string;
	timestamp: number;
	fileSize: number;
}

let scanInFlight = false;
let scanQueued = false;

function safeReadJson<T>(key: string, fallback: T): T {
	if (!browser) return fallback;
	try {
		const raw = window.localStorage.getItem(key);
		if (!raw) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function safeWriteJson(key: string, value: unknown): void {
	if (!browser) return;
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// best-effort persistence
	}
}

function normalizePath(value: string): string {
	return value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function base64ToUint8Array(base64: string): Uint8Array {
	const sanitized = base64.includes(',') ? base64.split(',')[1] || '' : base64;
	const binary = atob(sanitized);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

// Generate content-aware file key instead of path-based
async function computeFileHash(file: GameScreenshotFile): Promise<string | null> {
	if (!isDesktopTauri()) return null;
	try {
		// Use Rust-side content hash
		const hash = await invoke<string>('get_screenshot_content_hash', { path: file.path });
		return hash;
	} catch {
		// Fallback to path-based if hash computation fails
		return `${file.fileSize}:${file.modifiedAt}`;
	}
}

function getScopeFromCurrentChannel(): { scopeType: MediaAlbumScopeType; scopeId: string; scopeKey: string } | null {
	if (!browser) return null;
	const channelId = get(currentChannel);
	if (!channelId) return null;
	const channel = get(channels).find((entry) => entry.id === channelId) || null;
	if (!channel) return null;
	const scopeType: MediaAlbumScopeType =
		channel.type === 'dm' || channel.type === 'group' ? 'dm' : 'channel';
	return {
		scopeType,
		scopeId: channel.id,
		scopeKey: `${scopeType}:${channel.id}`
	};
}

export function loadGameScreenshotPipeSettings(): GameScreenshotPipeSettings {
	return safeReadJson<GameScreenshotPipeSettings>(SETTINGS_KEY, {
		enabled: false,
		screenshotDirectoryPath: ''
	});
}

export function saveGameScreenshotPipeSettings(next: Partial<GameScreenshotPipeSettings>): GameScreenshotPipeSettings {
	const current = loadGameScreenshotPipeSettings();
	const settings: GameScreenshotPipeSettings = {
		enabled: typeof next.enabled === 'boolean' ? next.enabled : current.enabled,
		screenshotDirectoryPath:
			typeof next.screenshotDirectoryPath === 'string'
				? normalizePath(next.screenshotDirectoryPath)
				: current.screenshotDirectoryPath
	};
	safeWriteJson(SETTINGS_KEY, settings);
	return settings;
}

export function loadGameScreenshotPipeTargetMap(): Record<string, number> {
	const raw = safeReadJson<Record<string, unknown>>(TARGETS_KEY, {});
	const result: Record<string, number> = {};
	for (const [key, value] of Object.entries(raw || {})) {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (!key || !Number.isFinite(numeric) || numeric <= 0) continue;
		result[key] = Math.trunc(numeric);
	}
	return result;
}

export function getGameScreenshotPipeTargetAlbumId(scopeKey: string): number | null {
	const value = loadGameScreenshotPipeTargetMap()[scopeKey];
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

export function setGameScreenshotPipeTargetAlbumId(scopeKey: string, albumId: number | null): Record<string, number> {
	const current = loadGameScreenshotPipeTargetMap();
	if (!scopeKey) return current;
	if (albumId === null || !Number.isFinite(albumId) || albumId <= 0) {
		delete current[scopeKey];
	} else {
		current[scopeKey] = Math.trunc(albumId);
	}
	safeWriteJson(TARGETS_KEY, current);
	return current;
}

// Content hash tracking for deduplication
function loadFileHashMap(): Record<string, FileHashEntry> {
	return safeReadJson<Record<string, FileHashEntry>>(HASH_TRACKING_KEY, {});
}

function saveFileHashMap(next: Record<string, FileHashEntry>): void {
	safeWriteJson(HASH_TRACKING_KEY, next);
}

function trimHashMapEntries(map: Record<string, FileHashEntry>, maxSize: number): Record<string, FileHashEntry> {
	const entries = Object.entries(map);
	if (entries.length <= maxSize) return map;

	// Keep newest entries
	const sorted = entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
	const trimmed: Record<string, FileHashEntry> = {};
	for (let i = 0; i < Math.min(sorted.length, maxSize); i++) {
		const [key, value] = sorted[i];
		trimmed[key] = value;
	}
	return trimmed;
}

async function uploadScreenshotAsset(token: string, file: File): Promise<{
	fileUrl: string;
	fileName: string;
	fileSize: number;
}> {
	const formData = new FormData();
	formData.append('file', file, file.name);

	const response = await fetch(`${getServerUrl()}/api/upload`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`
		},
		body: formData
	});

	if (!response.ok) {
		let detail = '';
		try {
			const payload = await response.json();
			detail = payload?.error || '';
		} catch {
			detail = await response.text();
		}
		throw new Error(detail || `Upload failed (${response.status})`);
	}

	const payload = await response.json();
	const fileUrl = typeof payload?.fileUrl === 'string' ? payload.fileUrl : '';
	if (!fileUrl) {
		throw new Error('Upload did not return a file URL.');
	}

	return {
		fileUrl,
		fileName: typeof payload?.fileName === 'string' ? payload.fileName : file.name,
		fileSize:
			typeof payload?.fileSize === 'number' && Number.isFinite(payload.fileSize)
				? payload.fileSize
				: file.size
	};
}

// Parallel upload with concurrency limit
async function uploadMultipleAssets(
	token: string,
	files: { file: File; path: string; hash: string }[]
): Promise<{
	success: { path: string; hash: string; fileUrl: string; fileName: string; fileSize: number }[];
	failed: { path: string; error: string }[];
}> {
	const success: { path: string; hash: string; fileUrl: string; fileName: string; fileSize: number }[] = [];
	const failed: { path: string; error: string }[] = [];

	// Process in batches of 3 to avoid overwhelming the server
	const CONCURRENCY = 3;
	for (let i = 0; i < files.length; i += CONCURRENCY) {
		const batch = files.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			batch.map(async ({ file, path, hash }) => {
				try {
					const result = await uploadScreenshotAsset(token, file);
					return { success: true, path, hash, ...result };
				} catch (error) {
					return { success: false, path, error: error instanceof Error ? error.message : 'Unknown error' };
				}
			})
		);

		for (const result of results) {
			if (result.success) {
				const { success: _, ...rest } = result;
				success.push(rest as { path: string; hash: string; fileUrl: string; fileName: string; fileSize: number });
			} else {
				failed.push({ path: result.path, error: result.error });
			}
		}
	}

	return { success, failed };
}

async function resolveScreenshotSources(settings: GameScreenshotPipeSettings): Promise<string[]> {
	const configuredPath = normalizePath(settings.screenshotDirectoryPath);
	if (configuredPath) return [configuredPath];

	try {
		const candidates = await invoke<GameScreenshotDirectoryCandidate[]>(
			'list_game_screenshot_directories'
		);
		return candidates.filter((candidate) => candidate.exists).map((candidate) => candidate.path);
	} catch (error) {
		console.warn('[GameScreenshotPipe] Failed to detect directories:', error);
		return [];
	}
}

function dispatchImportEvent(detail: GameScreenshotPipeImportEventDetail): void {
	if (!browser) return;
	window.dispatchEvent(new CustomEvent<GameScreenshotPipeImportEventDetail>(GAME_SCREENSHOT_PIPE_REFRESH_EVENT, { detail }));
}

export async function detectGameScreenshotDirectory(): Promise<string | null> {
	if (!isDesktopTauri()) return null;
	try {
		const candidates = await invoke<GameScreenshotDirectoryCandidate[]>(
			'list_game_screenshot_directories'
		);
		return candidates.find((candidate) => candidate.exists)?.path?.trim() || null;
	} catch (error) {
		console.warn('[GameScreenshotPipe] Directory detection failed:', error);
		return null;
	}
}

export async function listGameScreenshotDirectoryCandidates(): Promise<GameScreenshotDirectoryCandidate[]> {
	if (!isDesktopTauri()) return [];
	try {
		return await invoke<GameScreenshotDirectoryCandidate[]>('list_game_screenshot_directories');
	} catch (error) {
		console.warn('[GameScreenshotPipe] Failed to list candidates:', error);
		return [];
	}
}

interface ImportBatch {
	files: GameScreenshotFile[];
	contentHashes: Map<string, string>; // path -> hash
}

async function prepareImportBatch(
	files: GameScreenshotFile[],
	existingHashes: Set<string>
): Promise<ImportBatch> {
	const hashes = new Map<string, string>();
	const toImport: GameScreenshotFile[] = [];

	for (const file of files) {
		const hash = await computeFileHash(file);
		if (!hash) {
			toImport.push(file);
			continue;
		}

		hashes.set(file.path, hash);

		// Skip if we've seen this content before
		if (!existingHashes.has(hash)) {
			toImport.push(file);
		}
	}

	return { files: toImport, contentHashes: hashes };
}

async function importAvailableGameScreenshotsOnce(): Promise<GameScreenshotPipeRunResult> {
	const scope = getScopeFromCurrentChannel();
	const settings = loadGameScreenshotPipeSettings();
	const result: GameScreenshotPipeRunResult = {
		imported: 0,
		skipped: 0,
		scopeKey: scope?.scopeKey || null,
		albumId: scope?.scopeKey ? getGameScreenshotPipeTargetAlbumId(scope.scopeKey) : null,
		sourceDirectoryPath: settings.screenshotDirectoryPath ? normalizePath(settings.screenshotDirectoryPath) : null
	};

	if (!isDesktopTauri() || !scope || !settings.enabled) {
		return result;
	}

	const token = getAuthToken(getServerUrl());
	if (!token) return result;

	const targetAlbumId = getGameScreenshotPipeTargetAlbumId(scope.scopeKey);
	if (!targetAlbumId) return result;

	const sourcePaths = await resolveScreenshotSources(settings);
	if (sourcePaths.length === 0) return result;

	// Load existing hash map (content-based deduplication)
	const hashMap = loadFileHashMap();
	const existingHashes = new Set(Object.values(hashMap).map((entry) => entry.hash));

	let files: GameScreenshotFile[] = [];
	try {
		files = await invoke<GameScreenshotFile[]>('list_game_screenshots', { paths: sourcePaths });
	} catch (error) {
		console.warn('[GameScreenshotPipe] Failed to enumerate screenshots:', error);
		return result;
	}

	// Filter out already-imported content
	const batch = await prepareImportBatch(files, existingHashes);

	if (batch.files.length === 0) {
		result.skipped = files.length;
		return result;
	}

	// Read files in batch with stability check
	let payloads: GameScreenshotFilePayload[] = [];
	try {
		// Use new batch read command
		const batchResult = await invoke<BatchGameScreenshotPayload>('read_game_screenshot_batch', {
			paths: batch.files.map((f) => f.path),
			requireStable: true // Wait for files to stabilize
		});
		payloads = batchResult.files;
		if (batchResult.errors.length > 0) {
			console.warn('[GameScreenshotPipe] Batch errors:', batchResult.errors);
		}
	} catch (error) {
		console.warn('[GameScreenshotPipe] Batch read failed:', error);
		return result;
	}

	// Prepare upload files
	const uploadQueue: { file: File; path: string; hash: string }[] = [];
	for (const payload of payloads) {
		const hash = batch.contentHashes.get(payload.path);
		if (!hash) continue;

		try {
			const bytes = base64ToUint8Array(payload.base64);
			const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
			const blob = new Blob([arrayBuffer], {
				type: payload.mimeType || 'application/octet-stream'
			});
			const uploadFile = new File([blob], payload.fileName, {
				type: blob.type
			});
			uploadQueue.push({ file: uploadFile, path: payload.path, hash });
		} catch (error) {
			console.warn('[GameScreenshotPipe] Failed to prepare file:', payload.path, error);
		}
	}

	// Upload in parallel batches
	const uploadResult = await uploadMultipleAssets(token, uploadQueue);

	// Add to album
	for (const uploaded of uploadResult.success) {
		try {
			const item: Pick<
				MediaAlbumItem,
				'attachmentUrl' | 'attachmentName' | 'attachmentSize' | 'attachmentMime' | 'caption'
			> = {
				attachmentUrl: uploaded.fileUrl,
				attachmentName: uploaded.fileName,
				attachmentSize: uploaded.fileSize,
				attachmentMime: 'application/octet-stream', // TODO: track mime from payload
				caption: 'Imported from FFXIV screenshot folder'
			};

			await addMediaAlbumItem(token, targetAlbumId, item);

			// Track by content hash
			hashMap[uploaded.hash] = {
				hash: uploaded.hash,
				timestamp: Date.now(),
				fileSize: uploaded.fileSize
			};

			result.imported += 1;
			dispatchImportEvent({
				scopeKey: scope.scopeKey,
				scopeType: scope.scopeType,
				scopeId: scope.scopeId,
				albumId: targetAlbumId,
				fileName: uploaded.fileName,
				sourcePath: uploaded.path,
				uploadedAt: Date.now()
			});
		} catch (error) {
			console.warn('[GameScreenshotPipe] Failed to add to album:', uploaded.fileName, error);
		}
	}

	// Track failures that were partially processed
	if (uploadResult.failed.length > 0) {
		console.warn('[GameScreenshotPipe] Failed uploads:', uploadResult.failed);
	}

	// Save updated hash map (keep last 2000 entries)
	saveFileHashMap(trimHashMapEntries(hashMap, 2000));

	result.skipped = files.length - result.imported - uploadResult.failed.length;
	return result;
}

export async function runGameScreenshotPipeOnce(): Promise<GameScreenshotPipeRunResult> {
	return importAvailableGameScreenshotsOnce();
}

export function startGameScreenshotPipe(): () => void {
	if (!browser) return () => {};

	let disposed = false;
	const intervalMs = 15000;

	const tick = () => {
		if (disposed) return;
		if (scanInFlight) {
			scanQueued = true;
			return;
		}
		scanInFlight = true;
		void importAvailableGameScreenshotsOnce()
			.catch((error) => {
				console.warn('[GameScreenshotPipe] Unexpected scan failure:', error);
			})
			.finally(() => {
				scanInFlight = false;
				if (scanQueued && !disposed) {
					scanQueued = false;
					tick();
				}
			});
	};

	const timeout = window.setTimeout(tick, 2500);
	const interval = window.setInterval(tick, intervalMs);

	return () => {
		disposed = true;
		window.clearTimeout(timeout);
		window.clearInterval(interval);
	};
}
