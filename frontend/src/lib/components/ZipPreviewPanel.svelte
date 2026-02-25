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
	import { parseZipPreviewMetadata, type ZipPreviewMetadata } from '$lib/zip/zipPreview';

	const MAX_PREVIEW_ARCHIVE_BYTES = 25 * 1024 * 1024;
	const MAX_RENDER_ENTRIES = 200;
	const FETCH_TIMEOUT_MS = 4000;

	export let fileUrl = '';
	export let fileName = '';
	export let fileSize: number | undefined;
	export let encrypted = false;

	let isExpanded = false;
	let isLoading = false;
	let errorMessage = '';
	let metadata: ZipPreviewMetadata | null = null;
	let filterQuery = '';
	let normalizedFilter = '';
	let filteredEntries: ZipPreviewMetadata['entries'] = [];
	let activeController: AbortController | null = null;
	let fetchTimeoutId: number | undefined;
	let previousIdentity = '';

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

	function normalizeError(error: unknown): string {
		const raw = error instanceof Error ? error.message : String(error ?? '');
		if (raw.toLowerCase().includes('abort')) return t('messages.zip_preview.errors.timeout');
		return raw || t('messages.zip_preview.errors.failed');
	}

	$: normalizedFilter = filterQuery.trim().toLowerCase();
	$: filteredEntries = metadata
		? normalizedFilter.length === 0
			? metadata.entries
			: metadata.entries.filter((entry) => entry.path.toLowerCase().includes(normalizedFilter))
		: [];

	$: {
		const identity = `${fileUrl}::${fileName || 'unnamed'}::${fileSize ?? 'unknown'}::${encrypted ? '1' : '0'}`;
		if (identity !== previousIdentity) {
			previousIdentity = identity;
			stopActiveRequest();
			isExpanded = false;
			isLoading = false;
			errorMessage = '';
			metadata = null;
			filterQuery = '';
		}
	}

	onDestroy(() => {
		stopActiveRequest();
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
			return;
		}

		isLoading = true;
		errorMessage = '';
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

			const parsed = parseZipPreviewMetadata(bytes, { maxEntries: MAX_RENDER_ENTRIES });
			metadata = parsed;
			writePreviewCache(key, parsed);
		} catch (error) {
			if (controller.signal.aborted && !isExpanded) {
				return;
			}
			errorMessage = normalizeError(error);
		} finally {
			if (activeController === controller) {
				stopActiveRequest();
				isLoading = false;
			}
		}
	}

	async function retryPreview(): Promise<void> {
		if (isLoading) return;
		errorMessage = '';
		metadata = null;
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
	}
</script>

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
					<div class="zip-filter-row">
						<input
							class="zip-filter-input"
							type="search"
							bind:value={filterQuery}
							placeholder={$_('messages.zip_preview.filter_placeholder')}
							aria-label={$_('messages.zip_preview.filter_placeholder')}
						/>
					</div>
					{#if normalizedFilter.length > 0}
						<div class="zip-status">
							{$_('messages.zip_preview.filter_results', { values: { shown: filteredEntries.length, total: metadata.entries.length } })}
						</div>
					{/if}

					{#if filteredEntries.length === 0}
						<div class="zip-status">{$_('messages.zip_preview.no_matches')}</div>
					{:else}
						<ul class="zip-entry-list">
							{#each filteredEntries as entry}
								<li class="zip-entry">
									<div class="zip-entry-main" title={entry.path}>
										<span class="zip-entry-icon">{entry.isDirectory ? 'DIR' : 'FILE'}</span>
										<span class="zip-entry-path">{entry.path}</span>
									</div>
									<div class="zip-entry-meta">
										<span>{formatBytes(entry.uncompressedSize)}</span>
										<span>{describeCompression(entry.compressionMethod)}</span>
									</div>
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
		max-width: min(92vw, 540px);
	}

	.zip-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.65rem;
		font-size: 0.72rem;
		color: var(--text-secondary, #b8b8b8);
		margin-bottom: 0.45rem;
	}

	.zip-filter-row {
		margin-bottom: 0.4rem;
	}

	.zip-filter-input {
		width: 100%;
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
		gap: 0.3rem;
		max-height: 220px;
		overflow: auto;
	}

	.zip-entry {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.65rem;
		font-size: 0.78rem;
	}

	.zip-entry-main {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}

	.zip-entry-icon {
		min-width: 30px;
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		color: var(--text-secondary, #b8b8b8);
	}

	.zip-entry-path {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.zip-entry-meta {
		display: inline-flex;
		gap: 0.45rem;
		font-size: 0.7rem;
		color: var(--text-secondary, #b8b8b8);
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
		border: 1px solid var(--border, #3a3a3a);
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.06);
		color: var(--text-primary, #f5f5f5);
		font-size: 0.72rem;
		padding: 0.26rem 0.5rem;
		cursor: pointer;
	}

	.zip-retry-btn:hover {
		background: rgba(255, 255, 255, 0.12);
	}
</style>
