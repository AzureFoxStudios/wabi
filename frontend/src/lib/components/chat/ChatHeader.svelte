<script lang="ts">
	import { _ } from '$lib/i18n';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { activeServerSpoilAll, activeServerUnspoilAll } from '$lib/serverSettings';
	import { layoutStore } from '$lib/layoutStore';
	import { openFullMapTab } from '$lib/mapWorkspace';
	import { openModelViewportSurface } from '$lib/modelViewportTab';
	import { openReaderSurface } from '$lib/readerWorkspace';
	import { openMediaAlbumsSurface } from '$lib/mediaAlbumsWorkspace';
	import { openPlannerSurface } from '$lib/plannerWorkspace';
	import { getTauriPlatform, isTauriRuntime } from '$lib/tauri-platform';
	import { setWhiteboardSurface } from '$lib/whiteboard/whiteboardSurface';
	import type { User } from '$lib/socket';
	import type { WorkspaceViewKey } from './types';

	export let isDMChannel = false;
	export let workspaceSurfaceLabel: string | null = null;
	export let workspaceHeaderTitle = '';
	export let workspaceHeaderSubtitle = '';
	export let selectedWorkspaceView: WorkspaceViewKey = 'messages';
	export let currentChannel = '';
	export let forceSpoiler = false;
	export let dmCallTargetUser: User | null = null;
	export let dmDirectCallActive = false;
	export let dmDirectCallPending = false;
	export let experimentalScopeVisible = false;
	export let experimentalWabidbCallsEnabled = false;
	export let currentChannelPersistMessages = false;
	export let searchExpanded = false;
	export let searchInput = '';
	export let searchContainerElement: HTMLElement | null = null;
	export let searchInputElement: HTMLInputElement | null = null;
	export let filteredMessageCount = 0;
	export let searchBackfillBusy = false;
	export let isFullHistorySearchRunning = false;
	export let fullHistorySearchPagesLoaded = 0;
	export let fullHistorySearchStatus = '';
	export let onReturnToMessages: () => void;
	export let onStartDMVoiceCall: () => void | Promise<void>;
	export let onStartDMVideoCall: () => void | Promise<void>;
	export let onToggleExperimentalWabidbCall: () => void | Promise<void>;
	export let onOpenSearch: () => void | Promise<void>;
	export let onSearchInputKeydown: (event: KeyboardEvent) => void;
	export let onSearchCurrentQueryInBrowser: () => void;
	export let onToggleFullHistorySearchBackfill: () => void;
</script>

<div class="chat-header" class:dm-channel={isDMChannel}>
	<div class="chat-heading">
		{#if workspaceSurfaceLabel}
			<span class="channel-surface-label">{workspaceSurfaceLabel}</span>
		{/if}
		<h2>
			<span class="channel-title" class:channel-title-hash={!isDMChannel && selectedWorkspaceView === 'messages'}>{workspaceHeaderTitle}</span>
			{#if isDMChannel && selectedWorkspaceView === 'messages'}
				<span class="dm-badge">{$_('chat.dm.badge')}</span>
			{/if}
		</h2>
		{#if !isDMChannel && workspaceHeaderSubtitle}
			<p class="channel-description">{workspaceHeaderSubtitle}</p>
		{/if}
		{#if forceSpoiler}
			<span class="spoiler-channel-badge" title="Every message in this channel is hidden until clicked.">🔒 Spoilers</span>
		{/if}
		{#if $displayEnhancementSettingsStore.spoilerAllMessagesEnabled}
			<span class="spoiler-channel-badge" title="You have Spoiler All Messages enabled — every message is hidden until clicked (your view only).">🔒 Spoiler All</span>
		{/if}
		{#if $activeServerSpoilAll}
			<span class="spoiler-channel-badge" title="You have Spoiler All enabled for this server — every message here is hidden until clicked (your view only).">🔒 Server Spoiled</span>
		{/if}
		{#if $activeServerUnspoilAll}
			<span class="spoiler-channel-badge spoiler-channel-badge-revealed" title="You have Unspoil All enabled for this server — every message here is force-revealed, even spoilers (your view only).">👁 Server Unspoiled</span>
		{/if}
	</div>
	<div class="header-actions">
		<div class="header-action-group">
			{#if selectedWorkspaceView !== 'messages'}
				<button
					class="surface-return-btn btn-secondary"
					type="button"
					on:click={onReturnToMessages}
					title="Return to messages"
					aria-label="Return to messages"
				>
					Messages
				</button>
			{/if}
			<div
				class="workspace-view-actions"
				class:compactable={!$layoutStore.isMobile}
				role="tablist"
				aria-label="Channel views"
			>
			<button
				class="view-open-btn"
				class:active={selectedWorkspaceView === 'messages'}
				type="button"
				on:click={() => setWhiteboardSurface(currentChannel, 'messages')}
				title="Show messages"
				aria-label="Show messages"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
				</svg>
			</button>
			<button
				class="view-open-btn"
				class:active={selectedWorkspaceView === 'whiteboard'}
				type="button"
				on:click={() => setWhiteboardSurface(currentChannel, 'whiteboard')}
				title="Show whiteboard"
				aria-label="Show whiteboard"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="3" y="4" width="18" height="14" rx="2"></rect>
					<path d="M7 8h10"></path>
					<path d="M7 12h6"></path>
					<path d="M8 20h8"></path>
				</svg>
			</button>
			<button
				class="view-open-btn"
				class:active={selectedWorkspaceView === 'planner'}
				type="button"
				on:click={() => openPlannerSurface()}
				title="Open Planner"
				aria-label="Open Planner"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="3" y="3" width="18" height="18" rx="2"></rect>
					<path d="M3 9h18"></path>
					<path d="M9 21V9"></path>
				</svg>
			</button>
			<button
				class="view-open-btn"
				type="button"
				on:click={openMediaAlbumsSurface}
				class:active={selectedWorkspaceView === 'media'}
				title="Open media albums view"
				aria-label="Open media albums view"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<rect x="3" y="3" width="18" height="18" rx="2"></rect>
					<circle cx="8.5" cy="8.5" r="1.5"></circle>
					<polyline points="21 15 16 10 5 21"></polyline>
				</svg>
			</button>
			<button
				class="view-open-btn"
				type="button"
				on:click={openReaderSurface}
				class:active={selectedWorkspaceView === 'reader'}
				title="Open reader view"
				aria-label="Open reader view"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
					<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
				</svg>
			</button>
			<button
				class="view-open-btn"
				type="button"
				on:click={openModelViewportSurface}
				class:active={selectedWorkspaceView === 'model'}
				title="Open 3D view"
				aria-label="Open 3D view"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
					<path d="M3.27 6.96 12 12.01l8.73-5.05"></path>
					<path d="M12 22.08V12"></path>
				</svg>
			</button>
			<button
				class="view-open-btn"
				type="button"
				on:click={() => void openFullMapTab()}
				class:active={selectedWorkspaceView === 'map'}
				title="Open map view"
				aria-label="Open map view"
			>
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"></path>
					<path d="M9 4v14"></path>
					<path d="M15 6v14"></path>
				</svg>
			</button>
		</div>
		</div>
		<div class="header-action-group">
			{#if isDMChannel && dmCallTargetUser}
				<div class="dm-call-actions">
				{#if dmDirectCallActive}
					<span class="dm-call-live" role="status" aria-live="polite">{dmDirectCallPending ? 'Calling…' : 'Call active'}</span>
				{/if}
				<button
					class="dm-call-btn btn-secondary"
					class:active={dmDirectCallActive}
					on:click={onStartDMVoiceCall}
					disabled={dmDirectCallActive}
					title={$_('chat.dm.voice_call_title', { values: { user: dmCallTargetUser.username } })}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
					<span>{$_('chat.dm.call')}</span>
				</button>
				<button
					class="dm-call-btn btn-secondary"
					class:active={dmDirectCallActive}
					on:click={onStartDMVideoCall}
					disabled={dmDirectCallActive}
					title={$_('chat.dm.video_call_title', { values: { user: dmCallTargetUser.username } })}
				>
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
					<span>{$_('chat.dm.video')}</span>
				</button>
			</div>
		{/if}
		</div>
		<div class="header-action-group">
			{#if experimentalScopeVisible}
				<button
					type="button"
					class="experimental-wabidb-toggle btn-secondary"
					class:active={experimentalWabidbCallsEnabled}
					on:click={onToggleExperimentalWabidbCall}
					disabled={!isTauriRuntime() || getTauriPlatform() !== 'desktop'}
					title="Experimental wabiDB routing for DM/group calls only"
				>
					wabiDB EXP {experimentalWabidbCallsEnabled ? 'ON' : 'OFF'}
				</button>
			{/if}
			<div class="search-container" class:expanded={searchExpanded} bind:this={searchContainerElement} role="search">
			<span class="search-icon" aria-hidden="true">
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="11" cy="11" r="7"></circle>
					<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
				</svg>
			</span>
			<input
				type="text"
				bind:this={searchInputElement}
				bind:value={searchInput}
				placeholder={$_('chat.search.placeholder')}
				class="search-input input"
				on:focus={onOpenSearch}
				on:keydown={onSearchInputKeydown}
			/>
			{#if searchExpanded && searchInput && !$displayEnhancementSettingsStore.betterSearchPageEnabled}
				<span class="search-results">
					{filteredMessageCount === 1
						? $_('chat.search.results_one', { values: { count: filteredMessageCount } })
						: $_('chat.search.results_many', { values: { count: filteredMessageCount } })}
				</span>
			{/if}
			{#if searchExpanded && searchBackfillBusy && !$displayEnhancementSettingsStore.betterSearchPageEnabled}
				<span class="search-results">{$_('chat.search.loading_older')}</span>
			{/if}
			{#if searchExpanded && searchInput && $displayEnhancementSettingsStore.googleSearchReplaceEnabled && !$displayEnhancementSettingsStore.betterSearchPageEnabled}
				<button type="button" class="search-history-btn btn-ghost btn-sm" on:click={onSearchCurrentQueryInBrowser}>
					Search on Web
				</button>
			{/if}
			{#if searchExpanded && searchInput && currentChannelPersistMessages && !$displayEnhancementSettingsStore.betterSearchPageEnabled}
				<button
					type="button"
					class="search-history-btn btn-ghost btn-sm"
					on:click={onToggleFullHistorySearchBackfill}
				>
					{isFullHistorySearchRunning
						? $_('chat.search.stop', { values: { count: fullHistorySearchPagesLoaded } })
						: $_('chat.search.full_history')}
				</button>
				{#if fullHistorySearchStatus}
					<span class="search-results">{fullHistorySearchStatus}</span>
				{/if}
			{/if}
				</div>
		</div>
	</div>
</div>
