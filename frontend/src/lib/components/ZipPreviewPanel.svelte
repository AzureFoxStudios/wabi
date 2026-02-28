<script context="module" lang="ts">
	import type { ZipPreviewMetadata as ZipPreviewCacheValue } from '$lib/zip/zipPreview';

	const CACHE_TTL_MS = 10 * 60 * 1000;
	const CACHE_MAX_ITEMS = 120;

	interface ZipPreviewCacheEntry {
		metadata: ZipPreviewCacheValue;
		cachedAt: number;
	}

	const previewCache = new Map<string, ZipPreviewCacheEntry>();

	function readPreviewCache(key: string): ZipPreviewCacheValue | null {
		const cacheEntry = previewCache.get(key);
		if (!cacheEntry) return null;
		if (Date.now() - cacheEntry.cachedAt > CACHE_TTL_MS) {
			previewCache.delete(key);
			return null;
		}

		previewCache.delete(key);
		previewCache.set(key, cacheEntry);
		return cacheEntry.metadata;
	}

	function writePreviewCache(key: string, metadata: ZipPreviewCacheValue): void {
		if (previewCache.has(key)) {
			previewCache.delete(key);
		}
		previewCache.set(key, {
			metadata,
			cachedAt: Date.now()
		});

		while (previewCache.size > CACHE_MAX_ITEMS) {
			const oldestKey = previewCache.keys().next().value as string | undefined;
			if (!oldestKey) return;
			previewCache.delete(oldestKey);
		}
	}
</script>

<script lang="ts">
	import { onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { _ } from '$lib/i18n';
	import {
		extractZipEntryBytes,
		parseZipPreviewMetadata,
		type ZipPreviewEntry,
		type ZipPreviewMetadata
	} from '$lib/zip/zipPreview';
	import {
		setZipPreviewSortMode,
		zipPreviewSettingsStore,
		type ZipPreviewSortMode
	} from '$lib/zip/zipPreviewSettings';

	const MAX_PREVIEW_ARCHIVE_BYTES = 25 * 1024 * 1024;
	const MAX_RENDER_ENTRIES = 200;
	const FETCH_TIMEOUT_MS = 4000;
	const INLINE_TEXT_PREVIEW_MAX_BYTES = 64 * 1024;
	const INLINE_TEXT_PREVIEW_MAX_CHARS = 4000;
	const INLINE_IMAGE_PREVIEW_MAX_BYTES = 1024 * 1024;

	const TEXT_EXTENSIONS = new Set([
		'txt',
		'md',
		'json',
		'csv',
		'tsv',
		'xml',
		'html',
		'log',
		'yml',
		'yaml',
		'ini'
	]);
	const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

	export let fileUrl = '';
	export let fileName = '';
	export let fileSize: number | undefined;
	export let encrypted = false;

	let isExpanded = false;
	let isLoading = false;
	let errorMessage = '';
	let metadata: ZipPreviewMetadata | null = null;
	let archiveBytes: Uint8Array | null = null;
	let filterQuery = '';
	let normalizedFilter = '';
	let filteredEntries: ZipPreviewEntry[] = [];
	let sortedEntries: ZipPreviewEntry[] = [];
	let activeController: AbortController | null = null;
	let fetchTimeoutId: number | undefined;
	let previousIdentity = '';

	let inlinePreviewPath: string | null = null;
	let inlinePreviewKind: 'text' | 'image' | null = null;
	let inlinePreviewText = '';
	let inlinePreviewImageUrl = '';
	let inlinePreviewError = '';
	let inlinePreviewLoadingPath: string | null = null;

	function t(key: string, values?: Record<string, unknown>): string {
		if (values) return get(_)(key, { values } as any);
		return get(_)(key);
	}

	function formatBytes(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function describeCompression(method: number): string {
		if (method === 0) return t('messages.zip_preview.method_store');
		if (method === 8) return t('messages.zip_preview.method_deflate');
		return t('messages.zip_preview.method_other', { method });
	}

	function getPathExtension(path: string): string {
		const slashIndex = path.lastIndexOf('/');
		const name = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
		const dotIndex = name.lastIndexOf('.');
		if (dotIndex < 0) return '';
		return name.slice(dotIndex + 1).toLowerCase();
	}

	function getEntrySortName(path: string): string {
		const slashIndex = path.lastIndexOf('/');
		return (slashIndex >= 0 ? path.slice(slashIndex + 1) : path).toLowerCase();
	}

	function sortEntries(entries: ZipPreviewEntry[], mode: ZipPreviewSortMode): ZipPreviewEntry[] {
		const sorted = entries.slice();
		sorted.sort((a, b) => {
			if (mode === 'name_desc') {
				const byName = getEntrySortName(b.path).localeCompare(getEntrySortName(a.path));
				if (byName !== 0) return byName;
				return b.path.localeCompare(a.path);
			}
			if (mode === 'size_desc') {
				const bySize = b.uncompressedSize - a.uncompressedSize;
				if (bySize !== 0) return bySize;
				return a.path.localeCompare(b.path);
			}
			if (mode === 'size_asc') {
				const bySize = a.uncompressedSize - b.uncompressedSize;
				if (bySize !== 0) return bySize;
				return a.path.localeCompare(b.path);
			}
			const byName = getEntrySortName(a.path).localeCompare(getEntrySortName(b.path));
			if (byName !== 0) return byName;
			return a.path.localeCompare(b.path);
		});
		return sorted;
	}

	function getEntryIcon(entry: ZipPreviewEntry): string {
		if (entry.isDirectory) return 'DIR';
		const ext = getPathExtension(entry.path);
		if (IMAGE_EXTENSIONS.has(ext)) return 'IMG';
		if (TEXT_EXTENSIONS.has(ext)) return 'TXT';
		if (ext === 'zip' || ext === 'rar' || ext === '7z' || ext === 'tar' || ext === 'gz') return 'ARC';
		if (ext === 'pdf' || ext === 'doc' || ext === 'docx') return 'DOC';
		if (ext === 'mp4' || ext === 'mov' || ext === 'webm' || ext === 'mkv') return 'VID';
		if (ext === 'mp3' || ext === 'wav' || ext === 'flac' || ext === 'ogg') return 'AUD';
		return 'FILE';
	}

	function cacheKey(): string {
		return `${fileUrl}::${fileName || 'unnamed'}::${fileSize ?? 'unknown'}`;
	}

	function stopActiveRequest(): void {
		if (activeController) {
			activeController.abort();
			activeController = null;
		}
		if (typeof window !== 'undefined' && fetchTimeoutId !== undefined) {
			window.clearTimeout(fetchTimeoutId);
		}
		fetchTimeoutId = undefined;
	}

	function revokeInlinePreviewImage(): void {
		if (!inlinePreviewImageUrl) return;
		try {
			URL.revokeObjectURL(inlinePreviewImageUrl);
		} catch {
			// no-op
		}
		inlinePreviewImageUrl = '';
	}

	function resetInlinePreviewState(): void {
		revokeInlinePreviewImage();
		inlinePreviewPath = null;
		inlinePreviewKind = null;
		inlinePreviewText = '';
		inlinePreviewError = '';
		inlinePreviewLoadingPath = null;
	}

	function normalizeError(error: unknown): string {
		const raw = error instanceof Error ? error.message : String(error ?? '');
		if (raw.toLowerCase().includes('abort')) return t('messages.zip_preview.errors.timeout');
		return raw || t('messages.zip_preview.errors.failed');
	}

	async function fetchArchiveBytes(): Promise<Uint8Array> {
		if (!fileUrl) {
			throw new Error(t('messages.zip_preview.errors.failed'));
		}
		if (typeof fileSize === 'number' && fileSize > MAX_PREVIEW_ARCHIVE_BYTES) {
			throw new Error(
				t('messages.zip_preview.errors.too_large', {
					limit: formatBytes(MAX_PREVIEW_ARCHIVE_BYTES)
				})
			);
		}

		stopActiveRequest();
		const controller = new AbortController();
		activeController = controller;
		fetchTimeoutId = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		try {
			const response = await fetch(fileUrl, { signal: controller.signal });
			if (!response.ok) {
				throw new Error(`Failed to fetch archive (${response.status}).`);
			}
			const contentLength = Number(response.headers.get('content-length') ?? NaN);
			if (Number.isFinite(contentLength) && contentLength > MAX_PREVIEW_ARCHIVE_BYTES) {
				throw new Error(
					t('messages.zip_preview.errors.too_large', {
						limit: formatBytes(MAX_PREVIEW_ARCHIVE_BYTES)
					})
				);
			}

			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength > MAX_PREVIEW_ARCHIVE_BYTES) {
				throw new Error(
					t('messages.zip_preview.errors.too_large', {
						limit: formatBytes(MAX_PREVIEW_ARCHIVE_BYTES)
					})
				);
			}
			return bytes;
		} finally {
			if (activeController === controller) {
				stopActiveRequest();
			}
		}
	}

	async function ensureArchiveBytes(): Promise<Uint8Array> {
		if (archiveBytes && archiveBytes.byteLength > 0) return archiveBytes;
		archiveBytes = await fetchArchiveBytes();
		return archiveBytes;
	}

	function isInlineTextPreviewable(entry: ZipPreviewEntry): boolean {
		if (entry.isDirectory || entry.encrypted) return false;
		if (entry.uncompressedSize > INLINE_TEXT_PREVIEW_MAX_BYTES) return false;
		return TEXT_EXTENSIONS.has(getPathExtension(entry.path));
	}

	function isInlineImagePreviewable(entry: ZipPreviewEntry): boolean {
		if (entry.isDirectory || entry.encrypted) return false;
		if (entry.uncompressedSize > INLINE_IMAGE_PREVIEW_MAX_BYTES) return false;
		if (entry.compressedSize > INLINE_IMAGE_PREVIEW_MAX_BYTES) return false;
		return IMAGE_EXTENSIONS.has(getPathExtension(entry.path));
	}

	function isInlinePreviewable(entry: ZipPreviewEntry): boolean {
		if (!$zipPreviewSettingsStore.inlinePreviewEnabled) return false;
		return isInlineTextPreviewable(entry) || isInlineImagePreviewable(entry);
	}

	function imageMimeFromPath(path: string): string {
		const ext = getPathExtension(path);
		if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
		if (ext === 'gif') return 'image/gif';
		if (ext === 'webp') return 'image/webp';
		return 'image/png';
	}

	async function toggleInlinePreview(entry: ZipPreviewEntry): Promise<void> {
		if (inlinePreviewPath === entry.path && !inlinePreviewLoadingPath) {
			resetInlinePreviewState();
			return;
		}

		resetInlinePreviewState();
		inlinePreviewPath = entry.path;
		inlinePreviewLoadingPath = entry.path;

		try {
			const bytes = await ensureArchiveBytes();
			if (isInlineTextPreviewable(entry)) {
				const payload = await extractZipEntryBytes(bytes, entry, {
					maxOutputBytes: INLINE_TEXT_PREVIEW_MAX_BYTES
				});
				const decoded = new TextDecoder('utf-8').decode(payload);
				inlinePreviewText = decoded.slice(0, INLINE_TEXT_PREVIEW_MAX_CHARS);
				inlinePreviewKind = 'text';
				return;
			}
			if (isInlineImagePreviewable(entry)) {
				const payload = await extractZipEntryBytes(bytes, entry, {
					maxOutputBytes: INLINE_IMAGE_PREVIEW_MAX_BYTES
				});
				const normalizedPayload = new Uint8Array(payload.byteLength);
				normalizedPayload.set(payload);
				const blob = new Blob([normalizedPayload.buffer], {
					type: imageMimeFromPath(entry.path)
				});
				inlinePreviewImageUrl = URL.createObjectURL(blob);
				inlinePreviewKind = 'image';
				return;
			}
			throw new Error('Inline preview is not available for this entry.');
		} catch (error) {
			inlinePreviewError = normalizeError(error);
			inlinePreviewKind = null;
		} finally {
			inlinePreviewLoadingPath = null;
		}
	}

	$: normalizedFilter = filterQuery.trim().toLowerCase();
	$: filteredEntries = metadata
		? normalizedFilter.length === 0
			? metadata.entries
			: metadata.entries.filter((entry) => entry.path.toLowerCase().includes(normalizedFilter))
		: [];
	$: sortedEntries = sortEntries(filteredEntries, $zipPreviewSettingsStore.sortMode);

	$: {
		const identity = `${fileUrl}::${fileName || 'unnamed'}::${fileSize ?? 'unknown'}::${encrypted ? '1' : '0'}`;
		if (identity !== previousIdentity) {
			previousIdentity = identity;
			stopActiveRequest();
			isExpanded = false;
			isLoading = false;
			errorMessage = '';
			metadata = null;
			archiveBytes = null;
			filterQuery = '';
			resetInlinePreviewState();
		}
	}

	onDestroy(() => {
		stopActiveRequest();
		resetInlinePreviewState();
	});

	async function loadPreview(): Promise<void> {
		if (metadata || isLoading) return;
		if (!fileUrl) {
			errorMessage = t('messages.zip_preview.errors.failed');
			return;
		}
		if (encrypted) {
			errorMessage = t('messages.zip_preview.errors.encrypted');
			return;
		}
		if (typeof fileSize === 'number' && fileSize > MAX_PREVIEW_ARCHIVE_BYTES) {
			errorMessage = t('messages.zip_preview.errors.too_large', {
				limit: formatBytes(MAX_PREVIEW_ARCHIVE_BYTES)
			});
			return;
		}

		const key = cacheKey();
		const cached = readPreviewCache(key);
		if (cached) {
			metadata = cached;
			archiveBytes = null;
			return;
		}

		isLoading = true;
		errorMessage = '';
		try {
			const bytes = await fetchArchiveBytes();
			archiveBytes = bytes;
			const parsed = parseZipPreviewMetadata(bytes, { maxEntries: MAX_RENDER_ENTRIES });
			metadata = parsed;
			writePreviewCache(key, parsed);
		} catch (error) {
			errorMessage = normalizeError(error);
		} finally {
			isLoading = false;
		}
	}

	async function retryPreview(): Promise<void> {
		if (isLoading) return;
		errorMessage = '';
		metadata = null;
		archiveBytes = null;
		resetInlinePreviewState();
		await loadPreview();
	}

	async function togglePreview(): Promise<void> {
		isExpanded = !isExpanded;
		if (isExpanded) {
			await loadPreview();
			return;
		}
		stopActiveRequest();
		isLoading = false;
		filterQuery = '';
		resetInlinePreviewState();
	}

	function handleSortModeChange(event: Event): void {
		const target = event.currentTarget as HTMLSelectElement;
		setZipPreviewSortMode(target.value as ZipPreviewSortMode);
	}
</script>

{#if $zipPreviewSettingsStore.enabled}
	<div class="zip-preview">
		<button class="zip-preview-toggle" type="button" on:click={togglePreview} aria-expanded={isExpanded}>
			{isExpanded ? $_('messages.zip_preview.hide') : $_('messages.zip_preview.show')}
		</button>

		{#if isExpanded}
			<div class="zip-preview-panel">
				{#if isLoading}
					<div class="zip-status">{$_('messages.zip_preview.loading')}</div>
				{:else if errorMessage}
					<div class="zip-status zip-status-error">{errorMessage}</div>
					<button class="zip-retry-btn" type="button" on:click={retryPreview}>
						{$_('messages.zip_preview.retry')}
					</button>
				{:else if metadata}
					<div class="zip-meta">
						<span>{$_('messages.zip_preview.entries', { values: { count: metadata.entryCount } })}</span>
						<span>{$_('messages.zip_preview.uncompressed', { values: { size: formatBytes(metadata.totalUncompressedSize) } })}</span>
						<span>{$_('messages.zip_preview.compressed', { values: { size: formatBytes(metadata.totalCompressedSize) } })}</span>
					</div>
					{#if metadata.encryptedEntryCount > 0}
						<div class="zip-status zip-status-warning">
							{$_('messages.zip_preview.encrypted_entries', { values: { count: metadata.encryptedEntryCount } })}
						</div>
					{/if}

					{#if metadata.entries.length === 0}
						<div class="zip-status">{$_('messages.zip_preview.empty')}</div>
					{:else}
						<div class="zip-controls-row">
							<input
								class="zip-filter-input"
								type="search"
								bind:value={filterQuery}
								placeholder={$_('messages.zip_preview.filter_placeholder')}
								aria-label={$_('messages.zip_preview.filter_placeholder')}
							/>
							<select
								class="zip-sort-select"
								value={$zipPreviewSettingsStore.sortMode}
								on:change={handleSortModeChange}
							>
								<option value="name_asc">{$_('messages.zip_preview.sort.name_asc')}</option>
								<option value="name_desc">{$_('messages.zip_preview.sort.name_desc')}</option>
								<option value="size_desc">{$_('messages.zip_preview.sort.size_desc')}</option>
								<option value="size_asc">{$_('messages.zip_preview.sort.size_asc')}</option>
							</select>
						</div>
						{#if normalizedFilter.length > 0}
							<div class="zip-status">
								{$_('messages.zip_preview.filter_results', { values: { shown: sortedEntries.length, total: metadata.entries.length } })}
							</div>
						{/if}

						{#if sortedEntries.length === 0}
							<div class="zip-status">{$_('messages.zip_preview.no_matches')}</div>
						{:else}
							<ul class="zip-entry-list">
								{#each sortedEntries as entry (`${entry.path}-${entry.localHeaderOffset}`)}
									<li class="zip-entry">
										<div class="zip-entry-row">
											<div class="zip-entry-main" title={entry.path}>
												<span class="zip-entry-icon">{getEntryIcon(entry)}</span>
												<span class="zip-entry-path">{entry.path}</span>
											</div>
											<div class="zip-entry-actions">
												<div class="zip-entry-meta">
													<span>{formatBytes(entry.uncompressedSize)}</span>
													<span>{describeCompression(entry.compressionMethod)}</span>
												</div>
												{#if isInlinePreviewable(entry)}
													<button
														type="button"
														class="zip-inline-btn"
														on:click={() => void toggleInlinePreview(entry)}
													>
														{inlinePreviewPath === entry.path ? $_('messages.zip_preview.preview.hide') : $_('messages.zip_preview.preview.show')}
													</button>
												{/if}
											</div>
										</div>

										{#if inlinePreviewPath === entry.path}
											<div class="zip-inline-preview">
												{#if inlinePreviewLoadingPath === entry.path}
													<div class="zip-status">{$_('messages.zip_preview.preview.loading')}</div>
												{:else if inlinePreviewError}
													<div class="zip-status zip-status-error">{inlinePreviewError}</div>
												{:else if inlinePreviewKind === 'text'}
													<pre class="zip-inline-text">{inlinePreviewText}</pre>
												{:else if inlinePreviewKind === 'image' && inlinePreviewImageUrl}
													<img
														src={inlinePreviewImageUrl}
														alt={entry.path}
														class="zip-inline-image"
														loading="lazy"
														decoding="async"
													/>
												{:else}
													<div class="zip-status">{$_('messages.zip_preview.preview.unavailable')}</div>
												{/if}
											</div>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					{/if}

					{#if metadata.truncated}
						<div class="zip-status">{$_('messages.zip_preview.truncated', { values: { count: metadata.entries.length } })}</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.zip-preview {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin-top: 0.45rem;
	}

	.zip-preview-toggle {
		align-self: flex-start;
		background: rgba(255, 255, 255, 0.06);
		border: 1px solid var(--border, #3a3a3a);
		color: var(--text-primary, #f5f5f5);
		border-radius: 8px;
		padding: 0.3rem 0.55rem;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.zip-preview-toggle:hover {
		background: rgba(255, 255, 255, 0.12);
	}

	.zip-preview-panel {
		border: 1px solid var(--border, #3a3a3a);
		border-radius: 8px;
		padding: 0.5rem;
		background: rgba(0, 0, 0, 0.22);
		max-width: min(92vw, 640px);
	}

	.zip-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.65rem;
		font-size: 0.72rem;
		color: var(--text-secondary, #b8b8b8);
		margin-bottom: 0.45rem;
	}

	.zip-controls-row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.4rem;
		margin-bottom: 0.4rem;
	}

	.zip-filter-input,
	.zip-sort-select {
		border: 1px solid var(--border, #3a3a3a);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.03);
		color: var(--text-primary, #f5f5f5);
		font-size: 0.75rem;
		padding: 0.3rem 0.45rem;
	}

	.zip-filter-input::placeholder {
		color: var(--text-secondary, #b8b8b8);
	}

	.zip-entry-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		max-height: 280px;
		overflow: auto;
	}

	.zip-entry {
		display: flex;
		flex-direction: column;
		gap: 0.28rem;
		border: 1px solid rgba(255, 255, 255, 0.06);
		border-radius: 8px;
		padding: 0.38rem 0.42rem;
		background: rgba(255, 255, 255, 0.02);
	}

	.zip-entry-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.55rem;
	}

	.zip-entry-main {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}

	.zip-entry-icon {
		min-width: 32px;
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		color: var(--text-secondary, #b8b8b8);
	}

	.zip-entry-path {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.78rem;
	}

	.zip-entry-actions {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	.zip-entry-meta {
		display: inline-flex;
		gap: 0.45rem;
		font-size: 0.7rem;
		color: var(--text-secondary, #b8b8b8);
	}

	.zip-inline-btn,
	.zip-retry-btn {
		border: 1px solid var(--border, #3a3a3a);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.06);
		color: var(--text-primary, #f5f5f5);
		font-size: 0.7rem;
		padding: 0.24rem 0.45rem;
		cursor: pointer;
	}

	.zip-inline-btn:hover,
	.zip-retry-btn:hover {
		background: rgba(255, 255, 255, 0.12);
	}

	.zip-inline-preview {
		padding: 0.42rem;
		border: 1px dashed var(--border, #3a3a3a);
		border-radius: 7px;
		background: rgba(0, 0, 0, 0.22);
	}

	.zip-inline-text {
		margin: 0;
		max-height: 180px;
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		font-size: 0.72rem;
		line-height: 1.3;
		color: var(--text-primary, #f5f5f5);
	}

	.zip-inline-image {
		display: block;
		max-width: min(100%, 280px);
		max-height: 180px;
		object-fit: contain;
		border-radius: 6px;
	}

	.zip-status {
		font-size: 0.75rem;
		color: var(--text-secondary, #b8b8b8);
	}

	.zip-status-error {
		color: #ff8a8a;
	}

	.zip-status-warning {
		color: #f3ca69;
		margin-bottom: 0.35rem;
	}

	.zip-retry-btn {
		margin-top: 0.35rem;
	}

	@media (max-width: 600px) {
		.zip-controls-row {
			grid-template-columns: 1fr;
		}

		.zip-entry-row {
			flex-direction: column;
			align-items: flex-start;
		}

		.zip-entry-actions {
			width: 100%;
			justify-content: space-between;
		}
	}
</style>
