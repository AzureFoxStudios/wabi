<script lang="ts">
	import { currentChannel, channels } from '$lib/socket';
	import { get } from 'svelte/store';
	import { getAuthToken } from '$lib/authSession';
	import {
		parseLoreChannelId,
		getLoreRepo,
		listLoreFiles,
		downloadLoreFile,
		uploadLoreFile,
		type LoreRepo,
		type LoreFileInfo
	} from '$lib/api/lore';
	import { showToast } from '$lib/toast';

	/** A connected space plus the channel it hangs off. */
	interface SpaceRepo extends LoreRepo {
		channelKey: string;
		channelName: string;
	}

	interface DirEntry {
		kind: 'folder' | 'file';
		name: string;
		path: string;
		size: number;
	}

	let activeChannelId = $derived(get(currentChannel));
	let allChannels = $derived(get(channels));
	let loreChannels = $derived(allChannels.filter((c) => c.type === 'lore'));

	let spaces = $state<Record<number, SpaceRepo>>({});
	let spacesLoaded = $state(false);

	let selectedChannelId = $state<number | null>(null);
	let currentPath = $state('');
	let files = $state<LoreFileInfo[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);

	let previewPath = $state<string | null>(null);
	let previewName = $state('');
	let previewKind = $state<'image' | 'text' | 'other'>('other');
	let previewUrl = $state<string | null>(null);
	let previewText = $state<string | null>(null);
	let previewLoading = $state(false);
	let fileSearch = $state('');
	let searchAllSpaces = $state(false);
	let globalSearchResults = $state<Array<{ channelId: number; channelName: string; path: string; size: number }>>([]);
	let globalSearchLoading = $state(false);

	let isDragging = $state(false);
	let uploading = $state(false);

	const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'];
	const TEXT_EXT = [
		'txt', 'md', 'markdown', 'json', 'ts', 'tsx', 'js', 'jsx', 'rs', 'toml',
		'css', 'scss', 'html', 'htm', 'xml', 'yaml', 'yml', 'py', 'sh', 'bash',
		'csv', 'log', 'sql', 'ini', 'conf', 'env', 'gitignore'
	];

	let selectedSpace = $derived(selectedChannelId !== null ? spaces[selectedChannelId ?? -1] ?? null : null);
	let mirror = $derived(mirrorInfo(selectedSpace?.class));
	let isMirror = $derived(mirror !== null);

	let spaceOptions = $derived(
		Object.values(spaces)
			.sort((a, b) => a.channelName.localeCompare(b.channelName))
			.map((s) => ({ id: s.channelId, name: s.channelName }))
	);

	let crumbs = $derived(currentPath ? currentPath.split('/') : []);
	let dirEntries = $derived(buildDir(files, currentPath));
	let visibleDirEntries = $derived(
		fileSearch.trim()
			? dirEntries.filter((entry) => entry.name.toLowerCase().includes(fileSearch.trim().toLowerCase()) || entry.path.toLowerCase().includes(fileSearch.trim().toLowerCase()))
			: dirEntries
	);

	/** Read the mirror payload off a space's class field (`class: { mirror: {...} }`). */
	function mirrorInfo(cls: LoreRepo['class'] | undefined | null): { host: string } | null {
		if (cls && typeof cls === 'object' && 'mirror' in cls) {
			const upstream = (cls as { mirror?: { upstream_url?: string } }).mirror?.upstream_url;
			if (upstream) {
				let host = upstream;
				try {
					host = new URL(upstream.includes('://') ? upstream : `https://${upstream}`).hostname;
				} catch {
					// Keep the raw URL when it doesn't parse.
				}
				return { host };
			}
			return { host: 'remote source' };
		}
		return null;
	}

	async function loadSpaces() {
		const token = getAuthToken();
		if (!token) return;
		spacesLoaded = false;
		const found: Record<number, SpaceRepo> = {};
		for (const ch of loreChannels) {
			const numeric = parseLoreChannelId(ch.id);
			if (numeric === null) continue;
			try {
				const info = await getLoreRepo(token, numeric);
				if (info) {
					found[numeric] = { ...info, channelKey: ch.id, channelName: ch.name };
				}
			} catch {
				// Channel has no space attached — skip.
			}
		}
		spaces = found;
		spacesLoaded = true;
		if (selectedChannelId === null) {
			const numeric = parseLoreChannelId(activeChannelId);
			if (numeric !== null && found[numeric]) {
				selectedChannelId = numeric;
			} else {
				const keys = Object.keys(found);
				selectedChannelId = keys.length ? Number(keys[0]) : null;
			}
		}
	}

	$effect(() => {
		loreChannels;
		void loadSpaces();
	});

	async function loadFiles(channelId: number, prefix: string) {
		const token = getAuthToken();
		if (!token) return;
		loading = true;
		loadError = null;
		try {
			files = await listLoreFiles(token, channelId, prefix);
		} catch (e) {
			loadError = e instanceof Error ? e.message : 'Failed to load files';
			files = [];
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		const id = selectedChannelId;
		const prefix = currentPath;
		if (id !== null) void loadFiles(id, prefix);
	});

	async function searchAcrossSpaces(): Promise<void> {
		const query = fileSearch.trim().toLowerCase();
		if (!searchAllSpaces || !query) { globalSearchResults = []; return; }
		const token = getAuthToken();
		if (!token) return;
		globalSearchLoading = true;
		try {
			const results: Array<{ channelId: number; channelName: string; path: string; size: number }> = [];
			for (const space of Object.values(spaces)) {
				const entries = await listLoreFiles(token, space.channelId);
				for (const file of entries) if (file.path.toLowerCase().includes(query)) results.push({ channelId: space.channelId, channelName: space.channelName, path: file.path, size: file.size });
			}
			globalSearchResults = results.slice(0, 100);
		} finally { globalSearchLoading = false; }
	}

	function buildDir(flat: LoreFileInfo[], path: string): DirEntry[] {
		const prefix = path ? `${path}/` : '';
		const folders = new Set<string>();
		const fileEntries: DirEntry[] = [];
		for (const f of flat) {
			if (!f.path.startsWith(prefix)) continue;
			const rest = f.path.slice(prefix.length);
			if (!rest) continue;
			const slash = rest.indexOf('/');
			if (slash === -1) {
				fileEntries.push({ kind: 'file', name: rest, path: f.path, size: f.size });
			} else {
				folders.add(rest.slice(0, slash));
			}
		}
		const folderEntries: DirEntry[] = [...folders].map((name) => ({
			kind: 'folder',
			name,
			path: path ? `${path}/${name}` : name,
			size: 0
		}));
		folderEntries.sort((a, b) => a.name.localeCompare(b.name));
		fileEntries.sort((a, b) => a.name.localeCompare(b.name));
		return [...folderEntries, ...fileEntries];
	}

	function goToBreadcrumb(index: number) {
		currentPath = index <= 0 ? '' : crumbs.slice(0, index + 1).join('/');
		clearPreview();
	}

	function openFolder(entry: DirEntry) {
		currentPath = entry.path;
		clearPreview();
	}

	function clearPreview() {
		previewPath = null;
		previewName = '';
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = null;
		previewText = null;
		previewKind = 'other';
	}

	function extOf(path: string): string {
		const idx = path.lastIndexOf('.');
		if (idx === -1) return '';
		return path.slice(idx + 1).toLowerCase();
	}

	async function openPreview(entry: DirEntry, channelId = selectedChannelId) {
		if (entry.kind !== 'file') return;
		const token = getAuthToken();
		if (!token || channelId === null) return;
		const isImage = IMAGE_EXT.includes(extOf(entry.path));
		const isText = TEXT_EXT.includes(extOf(entry.path));
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewPath = entry.path;
		previewName = entry.name;
		previewKind = isImage ? 'image' : isText ? 'text' : 'other';
		previewUrl = null;
		previewText = null;
		previewLoading = true;
		try {
			const blob = await downloadLoreFile(token, channelId, entry.path);
			if (previewKind === 'image') {
				previewUrl = URL.createObjectURL(blob);
			} else if (previewKind === 'text') {
				previewText = await blob.text();
			}
		} catch (e) {
			previewKind = 'other';
			showToast(e instanceof Error ? e.message : 'Could not preview file', 'error');
		} finally {
			previewLoading = false;
		}
	}

	async function downloadFile(path: string) {
		const token = getAuthToken();
		if (!token || selectedChannelId === null) return;
		try {
			const blob = await downloadLoreFile(token, selectedChannelId, path);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = path.split('/').pop() || 'download';
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1500);
		} catch (e) {
			showToast(e instanceof Error ? e.message : 'Download failed', 'error');
		}
	}

	function onPickChannel(e: Event) {
		const value = (e.target as HTMLSelectElement).value;
		if (!value) return;
		const id = Number(value);
		if (Number.isFinite(id) && id !== selectedChannelId) {
			selectedChannelId = id;
			currentPath = '';
			files = [];
			clearPreview();
		}
	}

	async function handleUploadFiles(fileList: File[]) {
		if (isMirror) return;
		const token = getAuthToken();
		if (!token || selectedChannelId === null) return;
		uploading = true;
		try {
			for (const file of fileList) {
				const dest = currentPath ? `${currentPath}/${file.name}` : file.name;
				const result = await uploadLoreFile(token, selectedChannelId, dest, file);
				if (result.pending_review) {
					showToast('Saved as a new version — waiting for team review', 'info');
				} else {
					showToast('Saved — new version recorded', 'info');
				}
			}
			await loadFiles(selectedChannelId, currentPath);
		} catch (e) {
			showToast(e instanceof Error ? e.message : 'Upload failed', 'error');
		} finally {
			uploading = false;
		}
	}

	function onFileInput(event: Event) {
		const input = event.target as HTMLInputElement;
		const list = input?.files ? Array.from(input.files) : [];
		input.value = '';
		if (list.length) void handleUploadFiles(list);
	}

	function onDragOver(e: DragEvent) {
		if (isMirror) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
		isDragging = true;
	}

	function onDragLeave(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
	}

	async function onDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		const list = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
		if (list.length) await handleUploadFiles(list);
	}

	function formatSize(bytes: number): string {
		if (!bytes || bytes <= 0) return '—';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<div class="files-workspace">
	<header class="files-header">
		<div class="files-heading">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="26" height="26">
				<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
			</svg>
			<div>
				<h2>Files</h2>
				<p>Browse and share files across this server's spaces</p>
			</div>
		</div>
		<div class="files-header-right">
			{#if isMirror && mirror}
				<span class="mirror-badge" title="Read-only view of an upstream source — no uploads">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
						<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
						<path d="M13.73 21a2 2 0 0 1-3.46 0"/>
					</svg>
					Mirror of {mirror.host}
				</span>
			{:else if selectedChannelId !== null}
				<label class="upload-btn" title="Upload files to this space">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
						<polyline points="17 8 12 3 7 8"/>
						<line x1="12" y1="3" x2="12" y2="15"/>
					</svg>
					{#if uploading}Uploading…{:else}Upload{/if}
					<input type="file" multiple style="display:none" onchange={onFileInput} />
				</label>
			{/if}
			<select class="channel-picker" value={selectedChannelId ?? ''} onchange={onPickChannel} aria-label="Choose a space">
				{#if selectedChannelId === null}
					<option value="" disabled>Choose a space</option>
				{/if}
				{#each spaceOptions as opt}
					<option value={String(opt.id)} selected={opt.id === selectedChannelId}>{opt.name}</option>
				{/each}
			</select>
		</div>
	</header>

	{#if !spacesLoaded}
		<div class="files-loading">
			<span class="spinner"></span>
			<span>Loading spaces…</span>
		</div>
	{:else if selectedChannelId === null}
		<div class="files-empty">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" width="64" height="64">
				<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
			</svg>
			<h3>No connected spaces yet</h3>
			<p>Open the Code view on a lore channel and connect a space — its files will show up here.</p>
		</div>
	{:else}
		<div class="files-body">
			<div
				class="files-pane"
				class:drop-target={!isMirror}
				ondragover={onDragOver}
				ondragleave={onDragLeave}
				ondrop={onDrop}
			>
				<div class="file-toolbar">
					<nav class="breadcrumbs" aria-label="File path">
						<button class="crumb" class:active={!currentPath} onclick={() => goToBreadcrumb(0)}>Space root</button>
					{#each crumbs as crumb, i}
						<span class="crumb-sep">/</span>
						<button class="crumb" class:active={i === crumbs.length - 1} onclick={() => goToBreadcrumb(i)}>{crumb}</button>
					{/each}
				</nav>
					<input class="file-search" type="search" bind:value={fileSearch} onkeydown={(event) => event.key === 'Enter' && void searchAcrossSpaces()} placeholder="Search files" aria-label="Search files" /><label class="all-spaces-toggle"><input type="checkbox" bind:checked={searchAllSpaces} /> All spaces</label>
				</div>

				<div class="file-list">
					{#if searchAllSpaces && fileSearch.trim()}
						{#if globalSearchLoading}<div class="files-inline-loading">Searching all spaces…</div>{:else if globalSearchResults.length === 0}<div class="files-empty-folder">Press Enter to search all spaces.</div>{:else}{#each globalSearchResults as result}<button type="button" class="global-result" onclick={() => { selectedChannelId = result.channelId; currentPath = ''; fileSearch = ''; searchAllSpaces = false; void openPreview({ kind: 'file', name: result.path.split('/').pop() ?? result.path, path: result.path, size: result.size }, result.channelId); }}><strong>{result.path}</strong><small>{result.channelName}</small></button>{/each}{/if}
					{:else if loading}
						<div class="files-inline-loading">
							<span class="spinner"></span>
							<span>Loading files…</span>
						</div>
					{:else if loadError}
						<div class="files-error">{loadError}</div>
					{:else if visibleDirEntries.length === 0}
						<div class="files-empty-folder">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" width="44" height="44">
								<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
							</svg>
							{#if isMirror}
								<p>This space is empty.</p>
							{:else}
								<p>Nothing here yet — drop files below to add them.</p>
							{/if}
						</div>
					{:else}
						{#each visibleDirEntries as entry}
							<div class="file-row" role="row">
								<button
									class="row-main"
									role="rowheader"
									onclick={() => entry.kind === 'folder' ? openFolder(entry) : openPreview(entry)}
									title={entry.kind === 'folder' ? `Open ${entry.name}` : `Preview ${entry.name}`}
								>
									<span class="row-icon">
										{#if entry.kind === 'folder'}
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
												<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
											</svg>
										{:else}
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
												<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
												<polyline points="14 2 14 8 20 8"/>
											</svg>
										{/if}
									</span>
									<span class="row-name">{entry.name}</span>
								</button>
								{#if entry.kind === 'file'}
									<span class="row-size">{formatSize(entry.size)}</span>
									<button
										class="row-download"
										onclick={() => void downloadFile(entry.path)}
										title="Download {entry.name}"
										aria-label="Download {entry.name}"
									>
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
											<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
											<polyline points="7 10 12 15 17 10"/>
											<line x1="12" y1="15" x2="12" y2="3"/>
										</svg>
									</button>
								{/if}
							</div>
						{/each}
					{/if}
				</div>

				{#if isDragging && !isMirror}
					<div class="drop-overlay">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="40" height="40">
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
							<polyline points="17 8 12 3 7 8"/>
							<line x1="12" y1="3" x2="12" y2="15"/>
						</svg>
						<span>Drop to upload</span>
					</div>
				{/if}
			</div>

			<aside class="preview-pane">
				{#if previewPath}
					<div class="preview-header">
						<span class="preview-name" title={previewPath}>{previewName}</span>
						<button class="preview-close" onclick={clearPreview} aria-label="Close preview">×</button>
					</div>
					<div class="preview-content">
						{#if previewLoading}
							<div class="preview-loading">
								<span class="spinner"></span>
								<span>Loading preview…</span>
							</div>
						{:else if previewKind === 'image' && previewUrl}
							<img class="preview-image" src={previewUrl} alt={previewName} />
						{:else if previewKind === 'text' && previewText !== null}
							<pre class="preview-text">{previewText}</pre>
						{:else}
							<div class="preview-other">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
									<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
									<polyline points="14 2 14 8 20 8"/>
								</svg>
								<span>No inline preview for this file.</span>
								<button class="preview-download" onclick={() => void downloadFile(previewPath!)}>Download</button>
							</div>
						{/if}
					</div>
				{:else}
					<div class="preview-placeholder">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
							<polyline points="14 2 14 8 20 8"/>
						</svg>
						<span>Select a file to preview</span>
					</div>
				{/if}
			</aside>
		</div>
	{/if}
</div>

<style>
	.files-workspace {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		gap: var(--space-2);
	}

	.files-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.files-heading {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	.files-heading svg {
		color: var(--accent-primary);
		flex-shrink: 0;
	}

	.files-heading h2 {
		margin: 0;
		font-size: var(--font-size-lg);
		color: var(--text-heading);
	}

	.files-heading p {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.files-header-right {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-shrink: 0;
	}

	.upload-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		background: var(--accent-primary);
		color: white;
		font-size: var(--font-size-sm);
		font-weight: 600;
		cursor: pointer;
		transition: background var(--duration-fast) var(--ease-out);
		white-space: nowrap;
	}

	.upload-btn:hover {
		background: var(--accent-secondary);
	}

	.mirror-badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--text-muted) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--text-muted) 25%, transparent);
		color: var(--text-secondary);
		font-size: var(--font-size-xs);
		white-space: nowrap;
	}

	.channel-picker {
		padding: var(--space-1) var(--space-2);
		background: var(--surface-sunken);
		border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent);
		border-radius: var(--radius-sm);
		color: var(--text-heading);
		font-size: var(--font-size-sm);
		cursor: pointer;
		transition: border-color var(--duration-fast) var(--ease-out);
	}

	.channel-picker:focus {
		outline: none;
		border-color: var(--accent-primary);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary) 25%, transparent);
	}

	.files-loading,
	.files-empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		color: var(--text-muted);
	}

	.files-empty svg {
		opacity: 0.4;
	}

	.files-empty h3 {
		margin: 0;
		font-size: var(--font-size-lg);
		color: var(--text-heading);
	}

	.files-empty p {
		margin: 0;
		max-width: 420px;
		font-size: var(--font-size-sm);
		text-align: center;
		line-height: 1.6;
	}

	.spinner {
		width: 22px;
		height: 22px;
		border: 2px solid var(--surface-raised);
		border-top-color: var(--accent-primary);
		border-radius: 50%;
		animation: files-spin 1s linear infinite;
	}

	@keyframes files-spin {
		to { transform: rotate(360deg); }
	}

	.files-body {
		flex: 1;
		display: flex;
		overflow: hidden;
		min-height: 0;
	}

	.files-pane {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		overflow: hidden;
		position: relative;
		border-right: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.files-pane.drop-target {
		background-image: linear-gradient(color-mix(in srgb, var(--accent-primary) 3%, transparent), color-mix(in srgb, var(--accent-primary) 3%, transparent));
	}

	.file-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
	.file-search { min-width: 160px; max-width: 280px; padding: var(--space-1) var(--space-2); border: 1px solid color-mix(in srgb, var(--text-muted) 20%, transparent); border-radius: var(--radius-md); background: var(--surface-sunken); color: var(--text-heading); }
	.all-spaces-toggle { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--text-muted); font-size: var(--font-size-xs); white-space: nowrap; }
	.global-result { display: flex; flex-direction: column; align-items: flex-start; width: 100%; gap: 2px; padding: var(--space-2); border: 0; border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 10%, transparent); background: transparent; color: var(--text-heading); cursor: pointer; text-align: left; }
	.global-result:hover { background: var(--surface-raised); }
	.global-result small { color: var(--text-muted); }
	.breadcrumbs {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 12%, transparent);
	}

	.crumb {
		padding: 2px var(--space-1);
		border: none;
		background: transparent;
		border-radius: var(--radius-sm);
		color: var(--text-muted);
		font-size: var(--font-size-xs);
		font-family: var(--font-mono);
		cursor: pointer;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.crumb:hover {
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	.crumb.active {
		color: var(--accent-primary);
		font-weight: 600;
	}

	.crumb-sep {
		color: var(--text-muted);
		opacity: 0.5;
		font-size: var(--font-size-xs);
	}

	.file-list {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-1);
	}

	.file-row {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0 var(--space-1);
		border-radius: var(--radius-sm);
		transition: background var(--duration-fast) var(--ease-out);
	}

	.file-row:hover {
		background: var(--surface-raised);
	}

	.row-main {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) 0;
		border: none;
		background: transparent;
		color: var(--text-heading);
		cursor: pointer;
		text-align: left;
	}

	.row-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--text-muted);
	}

	.file-row:hover .row-icon {
		color: var(--accent-primary);
	}

	.row-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--font-size-sm);
	}

	.row-size {
		flex-shrink: 0;
		font-size: var(--font-size-xs);
		color: var(--text-muted);
		font-family: var(--font-mono);
	}

	.row-download {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		opacity: 0;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.file-row:hover .row-download {
		opacity: 1;
	}

	.row-download:hover {
		background: var(--surface-sunken);
		color: var(--text-heading);
	}

	.files-inline-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		padding: var(--space-4);
		color: var(--text-muted);
		font-size: var(--font-size-sm);
	}

	.files-error {
		padding: var(--space-3);
		color: var(--color-danger, #ef4444);
		font-size: var(--font-size-sm);
		text-align: center;
	}

	.files-empty-folder {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		padding: var(--space-4);
		color: var(--text-muted);
		opacity: 0.7;
		height: 100%;
	}

	.files-empty-folder p {
		margin: 0;
		font-size: var(--font-size-sm);
	}

	.drop-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		background: color-mix(in srgb, var(--surface-app) 85%, transparent);
		backdrop-filter: blur(2px);
		color: var(--accent-primary);
		font-size: var(--font-size-base);
		font-weight: 600;
		pointer-events: none;
		z-index: 1;
	}

	.preview-pane {
		width: 320px;
		min-width: 260px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.preview-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-2);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 12%, transparent);
	}

	.preview-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--font-size-sm);
		color: var(--text-secondary);
		font-family: var(--font-mono);
	}

	.preview-close {
		width: 24px;
		height: 24px;
		border: none;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.preview-close:hover {
		background: var(--surface-raised);
		color: var(--text-heading);
	}

	.preview-content {
		flex: 1;
		overflow: auto;
		display: flex;
		flex-direction: column;
	}

	.preview-loading,
	.preview-placeholder,
	.preview-other {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		padding: var(--space-3);
		color: var(--text-muted);
		opacity: 0.7;
		text-align: center;
		font-size: var(--font-size-sm);
	}

	.preview-image {
		width: 100%;
		object-fit: contain;
		background: var(--surface-sunken);
	}

	.preview-text {
		flex: 1;
		margin: 0;
		padding: var(--space-2);
		overflow: auto;
		white-space: pre-wrap;
		word-break: break-word;
		font-family: var(--font-mono);
		font-size: var(--font-size-xs);
		color: var(--text-secondary);
		line-height: 1.6;
	}

	.preview-download {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-3);
		border: none;
		border-radius: var(--radius-sm);
		background: var(--accent-primary);
		color: white;
		font-size: var(--font-size-sm);
		font-weight: 600;
		cursor: pointer;
		transition: background var(--duration-fast) var(--ease-out);
	}

	.preview-download:hover {
		background: var(--accent-secondary);
	}

	@media (max-width: 768px) {
		.files-header {
			flex-wrap: wrap;
		}

		.preview-pane {
			width: 240px;
			min-width: 200px;
		}
	}
</style>
