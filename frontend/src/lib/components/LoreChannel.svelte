<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { currentChannel, channels } from '$lib/socket';
	import {
		loreRepo,
		loreFiles,
		loreRevisions,
		loreBranches,
		loreFileHistory,
		loreFileDiff,
		loreLoading,
		loreError,
		loreHealth,
		loadLoreRepo,
		loadLoreHistory,
		loadLoreFileHistory,
		loadLoreFileDiff,
		loadLoreHealth,
		addLoreFile,
		removeLoreFile,
		clearLoreFileHistory,
		resetLoreStore,
	} from '$lib/loreStore';
	import {
		uploadLoreFile,
		downloadLoreFile,
		getSignedLoreUrl,
		deleteLoreFile,
		lockLoreFile,
		unlockLoreFile,
		createLoreSnapshot,
		createLoreBranch,
		mergeLoreBranch,
		parseLoreChannelId,
		type LoreFileInfo,
		type LoreRevision,
		type LoreBranch
	} from '$lib/api/lore';
	import { getAuthToken } from '$lib/authSession';
	import { layoutStore } from '$lib/layoutStore';
	import { currentUser } from '$lib/socket';

	/** L8: workspace-role gates — Owner/Admin/Developer edit; Artist asset-write; Viewer read-only. */
	$: loreRole = ($currentUser?.highestRole || '').toLowerCase();
	$: canEditLore = ['owner', 'admin', 'developer'].includes(loreRole);
	$: canAssetWriteLore = canEditLore || loreRole === 'artist';

	$: activeChannel = $channels.find((ch) => ch.id === $currentChannel) || null;
	$: repo = $loreRepo;
	$: files = $loreFiles;
	$: revisions = $loreRevisions;
	$: branches = $loreBranches;
	$: fileHistory = $loreFileHistory;
	$: fileDiff = $loreFileDiff;
	$: isLoading = $loreLoading;
	$: error = $loreError;
	$: health = $loreHealth;

	let dragOver = false;
	let uploadInput: HTMLInputElement;
	let uploadPath = '';
	let uploadMessage = 'Upload via API';
	let snapshotMessage = '';
	let selectedFile: LoreFileInfo | null = null;
	let showHistory = false;
	let showDiff = false;
	let diffFrom = '';
	let diffTo = '';
	let showBranchCreate = false;
	let newBranchName = '';
	let showSnapshot = false;
	let viewMode: 'list' | 'grid' = 'list';
	let currentFolder = '';
	let showPreview = false;
	let previewText = '';
	let previewTextLoading = false;
	/** L5: auth'd media — raw <img>/<video> cannot send Bearer; use blob object URLs. */
	let previewUrl = '';
	let previewUrlLoading = false;
	let previewBlobGen = 0;
	/** path -> object URL cache for grid thumbs (revoked on channel change / destroy). */
	let thumbUrlByPath: Record<string, string> = {};
	let thumbInflight = new Set<string>();

	// Lightbox state
	let lightboxImages: string[] = [];
	let lightboxIndex = 0;
	let lightboxVisible = false;
	let lightboxVideoUrl = '';

	// Derived: directories and files in the current folder
	$: dirsInFolder = [...new Set(
		files
			.filter((f) => {
				const rest = f.path.startsWith(currentFolder) ? f.path.slice(currentFolder.length) : f.path;
				return rest.includes('/') && !rest.startsWith('/');
			})
			.map((f) => {
				const rest = f.path.startsWith(currentFolder) ? f.path.slice(currentFolder.length) : f.path;
				return currentFolder + rest.split('/')[0] + '/';
			})
	)].sort();

	$: filesInFolder = files.filter((f) => {
		const rest = f.path.startsWith(currentFolder) ? f.path.slice(currentFolder.length) : f.path;
		return rest && !rest.includes('/');
	});

	$: breadcrumbs = currentFolder ? currentFolder.split('/').filter(Boolean) : [];

	onMount(() => {
		loadLoreRepo();
		loadLoreHistory();
		loadLoreHealth();
	});

	onDestroy(() => {
		revokePreviewUrl();
		revokeAllThumbs();
		resetLoreStore();
	});

	$: if ($currentChannel) {
		revokePreviewUrl();
		revokeAllThumbs();
		selectedFile = null;
		showPreview = false;
		loadLoreRepo();
		loadLoreHistory();
	}

	function revokePreviewUrl() {
		if (previewUrl && previewUrl.startsWith('blob:')) {
			try { URL.revokeObjectURL(previewUrl); } catch {}
		}
		previewUrl = '';
		previewUrlLoading = false;
	}

	function revokeAllThumbs() {
		for (const url of Object.values(thumbUrlByPath)) {
			if (url && url.startsWith('blob:')) {
				try { URL.revokeObjectURL(url); } catch {}
			}
		}
		thumbUrlByPath = {};
		thumbInflight = new Set();
	}

	function needsAuthMediaBlob(path: string): boolean {
		const t = getFileType(path);
		return t === 'image' || t === 'video' || t === 'audio' || t === 'pdf';
	}

	/** L5: download with bearer → object URL for <img>/<video>/<audio>/<iframe>. */
	async function loadPreviewBlob(file: LoreFileInfo) {
		const gen = ++previewBlobGen;
		revokePreviewUrl();
		if (!needsAuthMediaBlob(file.path)) return;
		const token = getAuthToken();
		const chId = parseLoreChannelId($currentChannel);
		if (!token || chId == null) return;
		previewUrlLoading = true;
		try {
			const blob = await downloadLoreFile(token, chId, file.path);
			if (gen !== previewBlobGen) return; // stale
			previewUrl = URL.createObjectURL(blob);
		} catch (err) {
			if (gen !== previewBlobGen) return;
			console.warn('[LoreChannel] preview blob failed', err);
			previewUrl = '';
		} finally {
			if (gen === previewBlobGen) previewUrlLoading = false;
		}
	}

	/** L5: lazy grid thumbs — only fetch when path not cached. */
	function ensureThumb(path: string): string {
		const cached = thumbUrlByPath[path];
		if (cached) return cached;
		if (thumbInflight.has(path)) return '';
		const token = getAuthToken();
		const chId = parseLoreChannelId($currentChannel);
		if (!token || chId == null) return '';
		thumbInflight.add(path);
		downloadLoreFile(token, chId, path)
			.then((blob) => {
				const url = URL.createObjectURL(blob);
				thumbUrlByPath = { ...thumbUrlByPath, [path]: url };
			})
			.catch((err) => {
				console.warn('[LoreChannel] thumb blob failed', path, err);
			})
			.finally(() => {
				thumbInflight.delete(path);
			});
		return '';
	}

	function formatSize(bytes: number): string {
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
	}

	function formatTime(ts: number): string {
		try {
			return new Intl.DateTimeFormat(undefined, {
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			}).format(new Date(ts));
		} catch {
			return String(ts);
		}
	}

	function getFileExtension(name: string): string {
		const i = name.lastIndexOf('.');
		return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
	}

	function getFileType(name: string): 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'archive' | 'model' | 'other' {
		const ext = getFileExtension(name);
		if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) return 'image';
		if (['mp4', 'webm', 'avi', 'mov', 'mkv'].includes(ext)) return 'video';
		if (['mp3', 'wav', 'ogg', 'flac', 'aac'].includes(ext)) return 'audio';
		if (['txt', 'md', 'json', 'xml', 'yaml', 'toml', 'js', 'ts', 'rs', 'py', 'go', 'java', 'c', 'cpp', 'h', 'css', 'html', 'sh', 'bash'].includes(ext)) return 'text';
		if (['pdf'].includes(ext)) return 'pdf';
		if (['zip', 'tar', 'gz', 'bz2', '7z', 'rar'].includes(ext)) return 'archive';
		if (['glb', 'gltf', 'obj', 'stl', 'fbx'].includes(ext)) return 'model';
		return 'other';
	}

	function getFileIcon(name: string): string {
		const type = getFileType(name);
		switch (type) {
			case 'image': return '🖼';
			case 'video': return '🎬';
			case 'audio': return '🎵';
			case 'text': return '📄';
			case 'pdf': return '📝';
			case 'archive': return '📦';
			case 'model': return '🧊';
			default: return '📁';
		}
	}

	function isImageType(name: string): boolean {
		return getFileType(name) === 'image';
	}

	function isVideoType(name: string): boolean {
		return getFileType(name) === 'video';
	}

	function isAudioType(name: string): boolean {
		return getFileType(name) === 'audio';
	}

	function isTextType(name: string): boolean {
		return getFileType(name) === 'text';
	}

	function isPreviewable(name: string): boolean {
		const type = getFileType(name);
		return type === 'image' || type === 'video' || type === 'audio' || type === 'text' || type === 'pdf';
	}

	/** L4: wire ids are ch_{hex}; use shared parser (never decimal). */
	function parseChannelId(chId: string | null | undefined): number | null {
		return parseLoreChannelId(chId);
	}

	function handleNavigateToFolder(dir: string) {
		currentFolder = dir;
		selectedFile = null;
		showPreview = false;
		showHistory = false;
		clearLoreFileHistory();
	}

	function handleBreadcrumbClick(idx: number) {
		currentFolder = breadcrumbs.slice(0, idx + 1).join('/') + '/';
		selectedFile = null;
		showPreview = false;
		showHistory = false;
		clearLoreFileHistory();
	}

	async function handlePreviewFile(file: LoreFileInfo) {
		selectedFile = file;
		showPreview = true;
		showHistory = false;
		showDiff = false;
		previewText = '';
		previewTextLoading = false;
		revokePreviewUrl();

		const token = getAuthToken();
		const chId = parseChannelId($currentChannel || '');
		if (token && chId) {
			await loadLoreFileHistory(file.path);
		}

		// L5: media/pdf via auth'd blob object URL
		if (needsAuthMediaBlob(file.path) && token && chId) {
			await loadPreviewBlob(file);
		}

		if (isTextType(file.path)) {
			previewTextLoading = true;
			try {
				if (!token || !chId) throw new Error('not authed');
				const blob = await downloadLoreFile(token, chId, file.path);
				previewText = await blob.text();
			} catch {
				previewText = 'Failed to load text preview.';
			}
			previewTextLoading = false;
		}
	}

	function openImageLightbox() {
		if (!selectedFile || !isImageType(selectedFile.path)) return;
		lightboxImages = [previewUrl];
		lightboxIndex = 0;
		lightboxVisible = true;
	}

	function openVideoLightbox() {
		if (!selectedFile || !isVideoType(selectedFile.path)) return;
		lightboxVideoUrl = previewUrl;
	}

	function closeLightbox() {
		lightboxVisible = false;
		lightboxVideoUrl = '';
	}

	async function handleUpload(file: File) {
		const token = getAuthToken();
		if (!token || !$currentChannel) return;

		const targetPath = uploadPath
			? uploadPath.endsWith('/') ? uploadPath + file.name : uploadPath + '/' + file.name
			: file.name;

		try {
			const result = await uploadLoreFile(token, parseChannelId($currentChannel)!, targetPath, file, uploadMessage);
			addLoreFile(result.file);
			await Promise.all([loadLoreRepo(), loadLoreHistory()]);
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Upload failed');
		}
	}

	function onDrop(e: DragEvent) {
		dragOver = false;
		if (!e.dataTransfer?.files.length) return;
		handleUpload(e.dataTransfer.files[0]);
	}

	function onFileSelected(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		if (!input.files?.length) return;
		handleUpload(input.files[0]);
		input.value = '';
	}

	async function handleDownload(file: LoreFileInfo) {
		const token = getAuthToken();
		const chId = $currentChannel ? parseChannelId($currentChannel) : null;
		if (!token || !chId) return;

		try {
			// L7: signed URL → direct web save (no Bearer header needed on the link)
			const signedUrl = await getSignedLoreUrl(token, chId, file.path);
			const a = document.createElement('a');
			a.href = signedUrl;
			a.download = file.path.split('/').pop() || file.path;
			a.target = '_blank';
			a.rel = 'noopener';
			a.click();
		} catch (err) {
			console.warn('[LoreChannel] signed URL failed, falling back to blob', err);
			try {
				const blob = await downloadLoreFile(token, chId, file.path);
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = file.path.split('/').pop() || file.path;
				a.click();
				URL.revokeObjectURL(url);
			} catch (err2) {
				alert(err2 instanceof Error ? err2.message : 'Download failed');
			}
		}
	}

	async function handleDelete(file: LoreFileInfo) {
		if (!confirm(`Delete "${file.path}"? This cannot be undone.`)) return;
		const token = getAuthToken();
		const chId = $currentChannel ? parseChannelId($currentChannel) : null;
		if (!token || !chId) return;

		try {
			await deleteLoreFile(token, chId, file.path);
			removeLoreFile(file.path);
			if (selectedFile?.path === file.path) {
				selectedFile = null;
				showPreview = false;
				revokePreviewUrl();
				clearLoreFileHistory();
			}
			await Promise.all([loadLoreRepo(), loadLoreHistory()]);
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Delete failed');
		}
	}

	async function handleLock(file: LoreFileInfo) {
		const token = getAuthToken();
		const chId = $currentChannel ? parseChannelId($currentChannel) : null;
		if (!token || !chId) return;

		try {
			if (file.lockedBy) {
				await unlockLoreFile(token, chId, file.path);
			} else {
				await lockLoreFile(token, chId, file.path);
			}
			addLoreFile({ ...file, lockedBy: file.lockedBy ? null : 0 });
			await loadLoreHistory();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Operation failed');
		}
	}

	function showFileDiff(rev: LoreRevision) {
		if (!selectedFile || !diffTo) return;
		showDiff = true;
		const from = rev.hash;
		const to = diffTo;
		const token = getAuthToken();
		const chId = $currentChannel ? parseChannelId($currentChannel) : null;
		if (token && chId && selectedFile) {
			loadLoreFileDiff(selectedFile.path, from, to);
		}
	}

	async function handleCreateSnapshot() {
		if (!snapshotMessage.trim()) return;
		const token = getAuthToken();
		const chId = $currentChannel ? parseChannelId($currentChannel) : null;
		if (!token || !chId) return;

		try {
			await createLoreSnapshot(token, chId, snapshotMessage);
			snapshotMessage = '';
			showSnapshot = false;
			await loadLoreHistory();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Snapshot failed');
		}
	}

	async function handleCreateBranch() {
		if (!newBranchName.trim()) return;
		const token = getAuthToken();
		const chId = $currentChannel ? parseChannelId($currentChannel) : null;
		if (!token || !chId) return;

		try {
			await createLoreBranch(token, chId, newBranchName);
			newBranchName = '';
			showBranchCreate = false;
			await loadLoreHistory();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Branch creation failed');
		}
	}

	async function handleMergeBranch(branch: LoreBranch) {
		if (!confirm(`Merge branch "${branch.name}"?`)) return;
		const token = getAuthToken();
		const chId = $currentChannel ? parseChannelId($currentChannel) : null;
		if (!token || !chId) return;

		try {
			await mergeLoreBranch(token, chId, branch.name);
			await loadLoreHistory();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Merge failed');
		}
	}
</script>

<div class="lore-channel">
	<header class="lore-header">
		<div class="lore-header-left">
			<span class="lore-hash">#</span>
			<span class="lore-title">{activeChannel?.name || 'lore'}</span>
			<span class="lore-badge">Asset Storage</span>
			{#if health === 'ok'}
				<span class="lore-health lore-health-ok">Connected</span>
			{:else if health === 'error'}
				<span class="lore-health lore-health-err">Disconnected</span>
			{/if}
		</div>
		<div class="lore-header-actions">
			{#if branches.length > 0}
				<span class="lore-branch-label">Branch:</span>
				<select class="lore-branch-select" on:change={() => loadLoreHistory()}>
					{#each branches as branch}
						<option value={branch.name}>{branch.name}</option>
					{/each}
				</select>
			{/if}
			<button
				class="lore-view-toggle"
				title={viewMode === 'grid' ? 'List view' : 'Grid view'}
				on:click={() => viewMode = viewMode === 'grid' ? 'list' : 'grid'}
			>
				{#if viewMode === 'grid'}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
						<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
						<line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>
						<line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
					</svg>
				{:else}
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
						<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
						<rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
					</svg>
				{/if}
			</button>
			<button
				class="lore-btn lore-btn-sm"
				type="button"
				title="Open notes"
				aria-label="Open notes"
				on:click={() => layoutStore.openNotes()}
			>
				Notes
			</button>
			{#if canEditLore}
			<button class="lore-btn lore-btn-sm" on:click={() => showSnapshot = !showSnapshot}>
				Snapshot
			</button>
			{/if}
			{#if canEditLore}
			<button class="lore-btn lore-btn-sm" on:click={() => showBranchCreate = !showBranchCreate}>
				New Branch
			</button>
			{/if}
		</div>
	</header>

	{#if canEditLore && showSnapshot}
		<div class="lore-panel">
			<h4>Create Snapshot</h4>
			<div class="lore-panel-row">
				<input
					type="text"
					class="lore-input"
					placeholder="Commit message..."
					bind:value={snapshotMessage}
					on:keydown={(e) => e.key === 'Enter' && handleCreateSnapshot()}
				/>
				<button class="lore-btn" on:click={handleCreateSnapshot} disabled={!snapshotMessage.trim()}>
					Commit
				</button>
			</div>
		</div>
	{/if}

	{#if canEditLore && showBranchCreate}
		<div class="lore-panel">
			<h4>Create Branch</h4>
			<div class="lore-panel-row">
				<input
					type="text"
					class="lore-input"
					placeholder="Branch name..."
					bind:value={newBranchName}
					on:keydown={(e) => e.key === 'Enter' && handleCreateBranch()}
				/>
				<button class="lore-btn" on:click={handleCreateBranch} disabled={!newBranchName.trim()}>
					Create
				</button>
			</div>
		</div>
	{/if}

	<div class="lore-body">
		<div class="lore-main">
			{#if canAssetWriteLore}
			<div
				class="lore-upload-zone"
				class:lore-drag-over={dragOver}
				on:dragover|preventDefault={() => dragOver = true}
				on:dragleave={() => dragOver = false}
				on:drop|preventDefault={onDrop}
				on:click={() => uploadInput?.click()}
				on:keydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						uploadInput?.click();
					}
				}}
				role="button"
				tabindex="0"
				aria-label="Upload files to lore"
			>
				<div class="lore-upload-icon">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
						<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
						<polyline points="17 8 12 3 7 8"/>
						<line x1="12" y1="3" x2="12" y2="15"/>
					</svg>
				</div>
				<p>Drop files here or click to upload</p>
				<div class="lore-upload-options">
					<input
						type="text"
						class="lore-input lore-upload-path"
						placeholder="Path (optional, e.g. assets/images/)"
						bind:value={uploadPath}
						on:click|stopPropagation
					/>
					<input
						type="text"
						class="lore-input lore-upload-msg"
						placeholder="Commit message"
						bind:value={uploadMessage}
						on:click|stopPropagation
					/>
				</div>
				<input
					type="file"
					bind:this={uploadInput}
					on:change={onFileSelected}
					style="display: none"
				/>
			</div>
			{/if}

			<div class="lore-content">
				{#if currentFolder}
					<div class="lore-breadcrumbs">
						<button class="lore-breadcrumb" on:click={() => handleNavigateToFolder('')}>/</button>
						{#each breadcrumbs as crumb, idx}
							<span class="lore-breadcrumb-sep">/</span>
							<button class="lore-breadcrumb" on:click={() => handleBreadcrumbClick(idx)}>
								{crumb}
							</button>
						{/each}
					</div>
				{/if}

				{#if isLoading}
					<div class="lore-loading">
						<div class="loading-spinner"></div>
						<span>Loading...</span>
					</div>
				{:else if error}
					<div class="lore-empty">
						<h3>No Lore repository</h3>
						<p>{error}</p>
					</div>
				{:else if files.length === 0}
					<div class="lore-empty">
						<div class="lore-empty-icon">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
								<polyline points="14 2 14 8 20 8"/>
								<line x1="12" y1="18" x2="12" y2="12"/>
								<line x1="9" y1="15" x2="15" y2="15"/>
							</svg>
						</div>
						<h3>No files yet</h3>
						<p>Upload files to start building your asset library.</p>
					</div>
				{:else if viewMode === 'grid'}
					<div class="lore-grid-view">
						{#each dirsInFolder as dir}
							<button class="lore-grid-item lore-grid-dir" on:click={() => handleNavigateToFolder(dir)}>
								<div class="lore-grid-icon">📁</div>
								<span class="lore-grid-name">{dir.replace(currentFolder, '').replace('/', '')}</span>
							</button>
						{/each}
						{#each filesInFolder as file}
							<button
								class="lore-grid-item"
								class:lore-grid-selected={selectedFile?.path === file.path}
								on:click={() => handlePreviewFile(file)}
							>
								{#if isImageType(file.path)}
									<img
										class="lore-grid-thumb"
										src={thumbUrlByPath[file.path] || ensureThumb(file.path)}
										alt={file.path}
										loading="lazy"
									/>
								{:else if isVideoType(file.path)}
									<video class="lore-grid-thumb" preload="metadata" muted>
										<source src={thumbUrlByPath[file.path] || ensureThumb(file.path)} />
									</video>
								{:else}
									<div class="lore-grid-icon">{getFileIcon(file.path)}</div>
								{/if}
								<div class="lore-grid-overlay">
									<span class="lore-grid-name">{file.path.split('/').pop() || file.path}</span>
									<span class="lore-grid-size">{formatSize(file.size)}</span>
								</div>
								{#if file.lockedBy}
									<span class="lore-grid-lock">🔒</span>
								{/if}
							</button>
						{/each}
					</div>
				{:else}
					<div class="lore-file-list">
						<div class="lore-file-list-header">
							<span class="lore-col-name">Name</span>
							<span class="lore-col-size">Size</span>
							<span class="lore-col-modified">Modified</span>
							<span class="lore-col-lock">Lock</span>
							<span class="lore-col-actions">Actions</span>
						</div>
						{#each dirsInFolder as dir}
							<div
								class="lore-file-row"
								role="button"
								tabindex="0"
								aria-label="Open folder {dir.replace(currentFolder, '').replace('/', '')}"
								on:click={() => handleNavigateToFolder(dir)}
								on:keydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										handleNavigateToFolder(dir);
									}
								}}
							>
								<span class="lore-col-name">
									<span class="lore-file-icon">📁</span>
									<span class="lore-file-name">{dir.replace(currentFolder, '').replace('/', '')}</span>
								</span>
								<span class="lore-col-size">—</span>
								<span class="lore-col-modified">—</span>
								<span class="lore-col-lock">—</span>
								<span class="lore-col-actions"></span>
							</div>
						{/each}
						{#each filesInFolder as file (file.path)}
							<div
								class="lore-file-row"
								class:lore-file-selected={selectedFile?.path === file.path}
								role="button"
								tabindex="0"
								aria-label="Preview {file.path.split('/').pop() || file.path}"
								on:click={() => handlePreviewFile(file)}
								on:keydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										handlePreviewFile(file);
									}
								}}
							>
								<span class="lore-col-name">
									<span class="lore-file-icon">{getFileIcon(file.path)}</span>
									<span class="lore-file-name">{file.path.split('/').pop() || file.path}</span>
								</span>
								<span class="lore-col-size">{formatSize(file.size)}</span>
								<span class="lore-col-modified">{formatTime(file.modifiedAt)}</span>
								<span class="lore-col-lock">
									{#if file.lockedBy}
										<span class="lore-lock-badge">Locked</span>
									{:else}
										<span class="lore-unlock-badge">-</span>
									{/if}
								</span>
								<span class="lore-col-actions">
									<button
										class="lore-action-btn"
										title="Download"
										on:click|stopPropagation={() => handleDownload(file)}
									>
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
											<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
											<polyline points="7 10 12 15 17 10"/>
											<line x1="12" y1="15" x2="12" y2="3"/>
										</svg>
									</button>
									{#if canAssetWriteLore}
									<button
										class="lore-action-btn"
										title={file.lockedBy ? 'Unlock' : 'Lock'}
										on:click|stopPropagation={() => handleLock(file)}
									>
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
											{#if file.lockedBy}
											<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
											<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
											{:else}
												<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
												<path d="M7 11V7a5 5 0 0 1 10 0v4"/>
												<line x1="12" y1="16" x2="12" y2="16.01"/>
											{/if}
										</svg>
									</button>
									{/if}
									{#if canAssetWriteLore}
									<button
										class="lore-action-btn lore-action-danger"
										title="Delete"
										on:click|stopPropagation={() => handleDelete(file)}
									>
										<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
											<polyline points="3 6 5 6 21 6"/>
											<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
										</svg>
									</button>
									{/if}
								</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		{#if showPreview && selectedFile}
			<aside class="lore-sidebar">
				<div class="lore-sidebar-header">
					<h4 title={selectedFile.path}>{selectedFile.path.split('/').pop() || selectedFile.path}</h4>
					<button class="lore-action-btn" aria-label="Close preview" on:click={() => { showPreview = false; selectedFile = null; clearLoreFileHistory(); }}>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
							<line x1="18" y1="6" x2="6" y2="18"/>
							<line x1="6" y1="6" x2="18" y2="18"/>
						</svg>
					</button>
				</div>
				<div class="lore-sidebar-content">
					<!-- Preview area -->
					{#if isImageType(selectedFile.path)}
						{#if previewUrlLoading || !previewUrl}
							<div class="lore-loading"><div class="loading-spinner"></div><span>Loading preview...</span></div>
						{:else}
							<div
								class="lore-preview-image-container"
								role="button"
								tabindex="0"
								aria-label="Enlarge image preview"
								on:click={openImageLightbox}
								on:keydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										openImageLightbox();
									}
								}}
							>
								<img class="lore-preview-image" src={previewUrl} alt={selectedFile.path} />
								<div class="lore-preview-enlarge">Click to enlarge</div>
							</div>
						{/if}
					{:else if isVideoType(selectedFile.path)}
						{#if previewUrlLoading || !previewUrl}
							<div class="lore-loading"><div class="loading-spinner"></div><span>Loading preview...</span></div>
						{:else}
							<div class="lore-preview-video-container">
								<video class="lore-preview-video" controls preload="auto" src={previewUrl}>
									<track kind="captions" />
								</video>
								<button class="lore-btn lore-btn-sm" on:click={openVideoLightbox}>Full screen</button>
							</div>
						{/if}
					{:else if isAudioType(selectedFile.path)}
						{#if previewUrlLoading || !previewUrl}
							<div class="lore-loading"><div class="loading-spinner"></div><span>Loading preview...</span></div>
						{:else}
							<div class="lore-preview-audio">
								<div class="lore-preview-audio-icon">🎵</div>
								<audio controls src={previewUrl} style="width: 100%">
									<track kind="captions" />
								</audio>
							</div>
						{/if}
					{:else if isTextType(selectedFile.path)}
						<div class="lore-preview-text">
							{#if previewTextLoading}
								<div class="lore-loading"><div class="loading-spinner"></div><span>Loading text...</span></div>
							{:else}
								<pre class="lore-preview-text-content">{previewText}</pre>
							{/if}
						</div>
					{:else if getFileType(selectedFile.path) === 'pdf'}
						{#if previewUrlLoading || !previewUrl}
							<div class="lore-loading"><div class="loading-spinner"></div><span>Loading preview...</span></div>
						{:else}
							<div class="lore-preview-pdf">
								<iframe class="lore-preview-pdf-frame" src={previewUrl} title="PDF preview"></iframe>
							</div>
						{/if}
					{:else}
						<div class="lore-preview-metadata">
							<div class="lore-preview-metadata-icon">{getFileIcon(selectedFile.path)}</div>
							<div class="lore-preview-metadata-fields">
								<div class="lore-meta-row"><span class="lore-meta-label">Name</span><span class="lore-meta-value">{selectedFile.path.split('/').pop()}</span></div>
								<div class="lore-meta-row"><span class="lore-meta-label">Path</span><span class="lore-meta-value">{selectedFile.path}</span></div>
								<div class="lore-meta-row"><span class="lore-meta-label">Size</span><span class="lore-meta-value">{formatSize(selectedFile.size)}</span></div>
								<div class="lore-meta-row"><span class="lore-meta-label">Modified</span><span class="lore-meta-value">{formatTime(selectedFile.modifiedAt)}</span></div>
								<div class="lore-meta-row"><span class="lore-meta-label">Locked</span><span class="lore-meta-value">{selectedFile.lockedBy ? 'Yes' : 'No'}</span></div>
							</div>
						</div>
					{/if}

					<!-- Actions -->
					<div class="lore-preview-actions">
						<button class="lore-btn lore-btn-sm" on:click={() => handleDownload(selectedFile!)}>Download</button>
						{#if canAssetWriteLore}
						<button class="lore-btn lore-btn-sm" on:click={() => handleLock(selectedFile!)}>
							{selectedFile.lockedBy ? 'Unlock' : 'Lock'}
						</button>
						{/if}
						{#if canAssetWriteLore}
						<button class="lore-btn lore-btn-sm lore-btn-danger" on:click={() => handleDelete(selectedFile!)}>Delete</button>
						{/if}
					</div>

					<!-- Revision history -->
					<div class="lore-preview-section">
						<h5>Revision History</h5>
						{#if fileHistory.length === 0}
							<p class="lore-sidebar-empty">No revision history.</p>
						{:else}
							<div class="lore-history-list">
								{#each fileHistory as rev, idx (rev.hash)}
									<div class="lore-history-item">
										<div class="lore-history-dot"></div>
										<div class="lore-history-info">
											<span class="lore-history-hash" title={rev.hash}>{rev.hash.slice(0, 8)}</span>
											<span class="lore-history-msg">{rev.message}</span>
											<span class="lore-history-time">{formatTime(rev.timestamp)}</span>
											{#if fileHistory.length >= 2}
												<div class="lore-history-actions">
													<button class="lore-btn lore-btn-xs" on:click|stopPropagation={() => showFileDiff(rev)}>Diff {idx + 1}</button>
												</div>
											{/if}
										</div>
									</div>
								{/each}
							</div>

							{#if fileHistory.length >= 2 && !showDiff}
								<div class="lore-diff-form">
									<h5>Compare Revisions</h5>
									<select class="lore-input" bind:value={diffTo}>
										<option value="">Select revision...</option>
										{#each fileHistory as rev}
											<option value={rev.hash}>{rev.hash.slice(0, 8)}</option>
										{/each}
									</select>
								</div>
							{/if}

							{#if showDiff && fileDiff}
								<div class="lore-diff-panel">
									<h5>Diff</h5>
									<pre class="lore-diff-content">{fileDiff}</pre>
								</div>
							{/if}
						{/if}
					</div>
				</div>
			</aside>
		{/if}
	</div>

	<footer class="lore-footer">
		<div class="lore-footer-left">
			<span class="lore-footer-stat">{files.length} file{files.length !== 1 ? 's' : ''}</span>
			{#if revisions.length > 0}
				<span class="lore-footer-stat">{revisions.length} revision{revisions.length !== 1 ? 's' : ''}</span>
			{/if}
			{#if branches.length > 0}
				<span class="lore-footer-stat">{branches.length} branch{branches.length !== 1 ? 'es' : ''}</span>
			{/if}
		</div>
		<div class="lore-footer-right">
			{#each branches as branch}
				<button class="lore-btn lore-btn-xs" on:click={() => handleMergeBranch(branch)}>Merge {branch.name}</button>
			{/each}
		</div>
	</footer>
</div>

<!-- Lightbox overlays -->
{#if lightboxVisible && lightboxImages.length > 0}
	<div class="lore-lightbox-backdrop" on:click={closeLightbox} role="button" tabindex="0" aria-label="Close image lightbox" on:keydown={(e) => (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') && closeLightbox()}>
		<button class="lore-lightbox-close" aria-label="Close" on:click={closeLightbox}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24">
				<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
			</svg>
		</button>
		<img class="lore-lightbox-image" src={lightboxImages[lightboxIndex]} alt="" />
	</div>
{/if}

{#if lightboxVideoUrl}
	<div class="lore-lightbox-backdrop" on:click={closeLightbox} role="button" tabindex="0" aria-label="Close video lightbox" on:keydown={(e) => (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') && closeLightbox()}>
		<button class="lore-lightbox-close" aria-label="Close" on:click={closeLightbox}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24">
				<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
			</svg>
		</button>
		<video class="lore-lightbox-video" controls autoplay src={lightboxVideoUrl}>
			<track kind="captions" />
		</video>
	</div>
{/if}

<style>
	.lore-channel {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		background: var(--background-primary-color, #1a1a2e);
	}

	.lore-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		border-bottom: 1px solid var(--border-color, #2a2a3e);
		flex-shrink: 0;
	}

	.lore-header-left {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.lore-hash {
		font-size: 20px;
		font-weight: 600;
		color: var(--text-muted-color, #888);
	}

	.lore-title {
		font-size: 16px;
		font-weight: 600;
	}

	.lore-badge {
		font-size: 11px;
		padding: 2px 6px;
		border-radius: 4px;
		background: var(--accent-primary-color);
		color: var(--text-on-danger);
	}

	.lore-health {
		font-size: 11px;
		padding: 2px 6px;
		border-radius: 4px;
	}

	.lore-health-ok {
		background: var(--color-success);
		color: var(--text-on-danger);
	}

	.lore-health-err {
		background: var(--color-danger);
		color: var(--text-on-danger);
	}

	.lore-header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.lore-branch-label {
		font-size: 12px;
		color: var(--text-muted-color, #888);
	}

	.lore-branch-select {
		font-size: 12px;
		padding: 2px 6px;
		border-radius: 4px;
		border: 1px solid var(--border-color, #2a2a3e);
		background: var(--background-secondary-color, #16162a);
		color: var(--text-primary-color, #eee);
	}

	.lore-view-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted-color, #888);
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.lore-view-toggle:hover {
		background: color-mix(in srgb, var(--text-heading) 6%, transparent);
		color: var(--text-primary-color, #eee);
	}

	.lore-panel {
		padding: 12px 16px;
		border-bottom: 1px solid var(--border-color, #2a2a3e);
		flex-shrink: 0;
	}

	.lore-panel h4 {
		margin: 0 0 8px 0;
		font-size: 14px;
	}

	.lore-panel-row {
		display: flex;
		gap: 8px;
	}

	.lore-body {
		display: flex;
		flex: 1;
		overflow: hidden;
	}

	.lore-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.lore-upload-zone {
		margin: 16px 16px 0;
		padding: 20px;
		border: 2px dashed var(--border-color, #2a2a3e);
		border-radius: 8px;
		text-align: center;
		cursor: pointer;
		transition: border-color 0.2s, background 0.2s;
		flex-shrink: 0;
	}

	.lore-upload-zone:hover,
	.lore-drag-over {
		border-color: var(--accent-primary-color, var(--accent-primary));
		background: color-mix(in srgb, var(--accent-primary-color, var(--accent-primary)) 8%, transparent);
	}

	.lore-upload-icon {
		margin-bottom: 6px;
		color: var(--text-muted-color, #888);
	}

	.lore-upload-zone p {
		margin: 0 0 10px 0;
		font-size: 14px;
		color: var(--text-muted-color, #888);
	}

	.lore-upload-options {
		display: flex;
		gap: 8px;
		justify-content: center;
	}

	.lore-input {
		padding: 6px 10px;
		border-radius: 4px;
		border: 1px solid var(--border-color, #2a2a3e);
		background: var(--background-secondary-color, #16162a);
		color: var(--text-primary-color, #eee);
		font-size: 13px;
		outline: none;
	}

	.lore-input:focus {
		border-color: var(--accent-primary-color);
	}

	.lore-upload-path {
		width: 200px;
	}

	.lore-upload-msg {
		width: 240px;
	}

	.lore-breadcrumbs {
		display: flex;
		align-items: center;
		padding: 8px 16px;
		gap: 2px;
		border-bottom: 1px solid var(--border-color, #2a2a3e);
		flex-shrink: 0;
		font-size: 13px;
	}

	.lore-breadcrumb {
		background: none;
		border: none;
		color: var(--text-muted-color, #888);
		cursor: pointer;
		padding: 2px 4px;
		border-radius: 3px;
		font-size: 13px;
		transition: color 0.15s, background 0.15s;
	}

	.lore-breadcrumb:hover {
		color: var(--accent-primary-color);
		background: color-mix(in srgb, var(--accent-primary-color) 8%, transparent);
	}

	.lore-breadcrumb-sep {
		color: var(--text-muted-color, #555);
		font-size: 12px;
	}

	.lore-content {
		flex: 1;
		overflow-y: auto;
	}

	.lore-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 200px;
		gap: 12px;
		color: var(--text-muted-color, #888);
	}

	.loading-spinner {
		width: 32px;
		height: 32px;
		border: 3px solid var(--border-color, #2a2a3e);
		border-top-color: var(--accent-primary-color);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.lore-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 200px;
		gap: 8px;
		color: var(--text-muted-color, #888);
	}

	.lore-empty h3 {
		margin: 0;
		font-size: 16px;
	}

	.lore-empty p {
		margin: 0;
		font-size: 13px;
	}

	.lore-empty-icon {
		color: var(--text-muted-color, #888);
		opacity: 0.5;
	}

	/* -- Grid view -- */

	.lore-grid-view {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
		gap: 12px;
		padding: 16px;
	}

	.lore-grid-item {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		aspect-ratio: 1;
		border-radius: 8px;
		border: 1px solid var(--border-color, #2a2a3e);
		background: var(--background-secondary-color, #16162a);
		cursor: pointer;
		overflow: hidden;
		transition: border-color 0.15s, transform 0.15s;
		padding: 0;
		color: inherit;
		font: inherit;
	}

	.lore-grid-item:hover {
		border-color: var(--accent-primary-color);
		transform: translateY(-2px);
	}

	.lore-grid-selected {
		border-color: var(--accent-primary-color);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-primary-color) 30%, transparent);
	}

	.lore-grid-dir {
		background: color-mix(in srgb, var(--text-heading) 2%, transparent);
	}

	.lore-grid-thumb {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.lore-grid-icon {
		font-size: 36px;
		line-height: 1;
		opacity: 0.7;
	}

	.lore-grid-overlay {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		padding: 6px 8px;
		background: linear-gradient(transparent, color-mix(in srgb, #000 70%, transparent));
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.lore-grid-name {
		font-size: 11px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.lore-grid-size {
		font-size: 10px;
		color: var(--text-muted-color, #aaa);
	}

	.lore-grid-lock {
		position: absolute;
		top: 6px;
		right: 6px;
		font-size: 14px;
	}

	/* -- List view -- */

	.lore-file-list {
		display: flex;
		flex-direction: column;
	}

	.lore-file-list-header {
		display: flex;
		padding: 8px 16px;
		font-size: 12px;
		font-weight: 600;
		color: var(--text-muted-color, #888);
		border-bottom: 1px solid var(--border-color, #2a2a3e);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.lore-file-row {
		display: flex;
		align-items: center;
		padding: 8px 16px;
		border-bottom: 1px solid var(--border-color, #2a2a3e);
		cursor: pointer;
		transition: background 0.15s;
		font-size: 13px;
	}

	.lore-file-row:hover {
		background: color-mix(in srgb, var(--text-heading) 3%, transparent);
	}

	.lore-file-selected {
		background: color-mix(in srgb, var(--accent-primary-color) 10%, transparent);
	}

	.lore-col-name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.lore-col-size {
		width: 80px;
		flex-shrink: 0;
		text-align: right;
	}

	.lore-col-modified {
		width: 140px;
		flex-shrink: 0;
	}

	.lore-col-lock {
		width: 60px;
		flex-shrink: 0;
		text-align: center;
	}

	.lore-col-actions {
		width: 100px;
		flex-shrink: 0;
		display: flex;
		gap: 4px;
		justify-content: flex-end;
	}

	.lore-file-icon {
		font-size: 16px;
	}

	.lore-file-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.lore-lock-badge {
		font-size: 11px;
		padding: 1px 4px;
		border-radius: 3px;
		background: var(--color-warning);
		color: var(--text-on-danger);
	}

	.lore-unlock-badge {
		font-size: 11px;
		color: var(--text-muted-color, #666);
	}

	.lore-action-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted-color, #888);
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
	}

	.lore-action-btn:hover {
		background: color-mix(in srgb, var(--text-heading) 6%, transparent);
		color: var(--text-primary-color, #eee);
	}

	.lore-action-danger:hover {
		background: var(--color-danger-bg);
		color: var(--text-danger);
	}

	.lore-btn {
		padding: 6px 12px;
		border: none;
		border-radius: 4px;
		background: var(--accent-primary-color);
		color: var(--text-on-danger);
		font-size: 13px;
		cursor: pointer;
		transition: opacity 0.15s;
	}

	.lore-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.lore-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	.lore-btn-sm {
		font-size: 12px;
		padding: 4px 8px;
	}

	.lore-btn-xs {
		font-size: 11px;
		padding: 2px 6px;
	}

	.lore-btn-danger {
		background: var(--color-danger);
	}

	.lore-btn-danger:hover:not(:disabled) {
		background: var(--color-danger);
	}

	/* -- Sidebar / Preview -- */

	.lore-sidebar {
		width: 360px;
		border-left: 1px solid var(--border-color, #2a2a3e);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
	}

	.lore-sidebar-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--border-color, #2a2a3e);
	}

	.lore-sidebar-header h4 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.lore-sidebar-content {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px;
	}

	.lore-sidebar-empty {
		font-size: 13px;
		color: var(--text-muted-color, #888);
	}

	/* Preview: image */

	.lore-preview-image-container {
		position: relative;
		border-radius: 6px;
		overflow: hidden;
		cursor: zoom-in;
		margin-bottom: 12px;
	}

	.lore-preview-image {
		width: 100%;
		max-height: 250px;
		object-fit: contain;
		background: var(--background-secondary-color, #16162a);
		border-radius: 6px;
	}

	.lore-preview-enlarge {
		position: absolute;
		bottom: 8px;
		right: 8px;
		font-size: 11px;
		padding: 3px 8px;
		border-radius: 4px;
		background: var(--surface-overlay);
		color: var(--text-on-danger);
		opacity: 0;
		transition: opacity 0.15s;
	}

	.lore-preview-image-container:hover .lore-preview-enlarge {
		opacity: 1;
	}

	/* Preview: video */

	.lore-preview-video-container {
		margin-bottom: 12px;
	}

	.lore-preview-video {
		width: 100%;
		max-height: 250px;
		border-radius: 6px;
		background: var(--surface-sunken);
	}

	/* Preview: audio */

	.lore-preview-audio {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 20px 0;
		margin-bottom: 12px;
	}

	.lore-preview-audio-icon {
		font-size: 40px;
	}

	/* Preview: text */

	.lore-preview-text {
		margin-bottom: 12px;
	}

	.lore-preview-text-content {
		font-size: 11px;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-all;
		max-height: 300px;
		overflow-y: auto;
		padding: 8px;
		border-radius: 6px;
		background: var(--background-secondary-color, #16162a);
		font-family: monospace;
	}

	/* Preview: PDF */

	.lore-preview-pdf {
		margin-bottom: 12px;
		height: 300px;
	}

	.lore-preview-pdf-frame {
		width: 100%;
		height: 100%;
		border: none;
		border-radius: 6px;
	}

	/* Preview: metadata (other files) */

	.lore-preview-metadata {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 20px 0;
		margin-bottom: 12px;
	}

	.lore-preview-metadata-icon {
		font-size: 48px;
		opacity: 0.7;
	}

	.lore-preview-metadata-fields {
		width: 100%;
	}

	.lore-meta-row {
		display: flex;
		justify-content: space-between;
		padding: 4px 0;
		font-size: 13px;
		border-bottom: 1px solid var(--border-color, #2a2a3e);
	}

	.lore-meta-label {
		color: var(--text-muted-color, #888);
	}

	.lore-meta-value {
		color: var(--text-primary-color, #eee);
		text-align: right;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 200px;
	}

	/* Preview actions */

	.lore-preview-actions {
		display: flex;
		gap: 6px;
		margin-bottom: 16px;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--border-color, #2a2a3e);
	}

	.lore-preview-section h5 {
		margin: 0 0 8px 0;
		font-size: 13px;
		color: var(--text-muted-color, #aaa);
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	/* History */

	.lore-history-list {
		position: relative;
		padding-left: 16px;
	}

	.lore-history-list::before {
		content: '';
		position: absolute;
		left: 4px;
		top: 8px;
		bottom: 8px;
		width: 2px;
		background: var(--border-color, #2a2a3e);
	}

	.lore-history-item {
		position: relative;
		padding-bottom: 12px;
	}

	.lore-history-dot {
		position: absolute;
		left: -14px;
		top: 4px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent-primary-color);
	}

	.lore-history-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.lore-history-hash {
		font-family: monospace;
		font-size: 11px;
		color: var(--accent-primary-color);
	}

	.lore-history-msg {
		font-size: 13px;
	}

	.lore-history-time {
		font-size: 11px;
		color: var(--text-muted-color, #888);
	}

	.lore-history-actions {
		margin-top: 4px;
	}

	.lore-diff-panel {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--border-color, #2a2a3e);
	}

	.lore-diff-panel h5 {
		margin: 0 0 6px 0;
		font-size: 13px;
	}

	.lore-diff-content {
		font-size: 11px;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-all;
		max-height: 200px;
		overflow-y: auto;
		padding: 8px;
		border-radius: 4px;
		background: var(--background-secondary-color, #16162a);
	}

	.lore-diff-form {
		margin-top: 12px;
	}

	.lore-diff-form h5 {
		margin: 0 0 6px 0;
		font-size: 13px;
	}

	/* Footer */

	.lore-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 16px;
		border-top: 1px solid var(--border-color, #2a2a3e);
		flex-shrink: 0;
		font-size: 12px;
	}

	.lore-footer-left, .lore-footer-right {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.lore-footer-stat {
		color: var(--text-muted-color, #888);
	}

	/* Lightbox */

	.lore-lightbox-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-lightbox);
		background: color-mix(in srgb, #000 90%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 40px;
	}

	.lore-lightbox-close {
		position: absolute;
		top: 16px;
		right: 16px;
		background: color-mix(in srgb, #000 50%, transparent);
		border: none;
		border-radius: 50%;
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-on-danger);
		cursor: pointer;
		z-index: calc(var(--z-lightbox) + 1);
	}

	.lore-lightbox-close:hover {
		background: color-mix(in srgb, var(--text-heading) 20%, transparent);
	}

	.lore-lightbox-image {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		border-radius: 4px;
	}

	.lore-lightbox-video {
		max-width: 100%;
		max-height: 100%;
		border-radius: 4px;
	}
</style>
