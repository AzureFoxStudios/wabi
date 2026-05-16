<script lang="ts">
	import { channelMessages } from '$lib/socket';
	import { longpress } from '$lib/actions/longpress';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import DMMessageView from '../DMMessageView.svelte';
	import KeepNotesView from '../KeepNotesView.svelte';
	import GroupAvatar from '../GroupAvatar.svelte';
	import GroupSettingsPanel from '../GroupSettingsPanel.svelte';
	import CreateGroupModal from '../CreateGroupModal.svelte';
	import type { Channel, User } from '$lib/socket';
	import type { ContextMenuItem } from '$lib/context-menu/types';
	import type { DMPrivacyMode } from '$lib/dmPrivacyMode';

	type ConversationAction = {
		id: 'voice' | 'video' | 'remove';
		label: string;
		title: string;
		icon: string;
		danger?: boolean;
		showInline?: boolean;
		onSelect: () => void | Promise<void>;
	};

	export let showNewDM: boolean;
	export let showCreateGroup: boolean;
	export let showGroupSettings: boolean;
	export let showContextMenu: boolean;
	export let showHeaderActionMenu: boolean;
	export let searchQuery: string;
	export let activeHeaderElement: HTMLElement | null;
	export let selectedDmId: string | null;
	export let isKeepNotesSelected: boolean;
	export let dmOther: User | null;
	export let activeGroup: Channel | null;
	export let selectedDmPrivacyMode: DMPrivacyMode | null;
	export let selectedDmChannel: Channel | null;
	export let showCompactHeaderActions: boolean;
	export let hasHeaderActions: boolean;
	export let headerCallActions: ConversationAction[];
	export let headerRemoveAction: ConversationAction | undefined;
	export let activeHeaderTitle: string;
	export let filteredUsers: User[];
	export let dmChannels: Channel[];
	export let contextMenuChannel: Channel | null;
	export let contextMenuUser: User | null;
	export let contextMenuX: number;
	export let contextMenuY: number;
	export let contextMenuItems: ContextMenuItem[];
	export let headerActionMenuX: number;
	export let headerActionMenuY: number;
	export let headerActionMenuItems: ContextMenuItem[];
	export let getDmDirectoryKey: (user: User) => string;
	export let getOtherUser: (channel: Channel) => User | null;
	export let getInlineActions: (channel: Channel, other: User | null) => ConversationAction[];
	export let getConversationPrivacyMode: (channelId: string) => DMPrivacyMode;
	export let isConversationPinned: (channelId: string) => boolean;
	export let selectConversation: (channel: Channel) => void;
	export let handleConversationLongPress: (event: TouchEvent, channel: Channel, other?: User | null) => void;
	export let openContextMenu: (event: MouseEvent, channel: Channel, other?: User | null) => void;
	export let openHeaderActionMenu: (event: MouseEvent) => void;
	export let toggleGroupSettings: () => void;
	export let closeContextMenu: () => void;
	export let closeHeaderActionMenu: () => void;
	export let startDMWith: (user: User) => void;
	export let layoutStore: any;
	export let onOpenSettings: (detail: { paymentSurface: 'connections' }) => void;

	function getLastPreview(channelId: string): string {
		const msgs = $channelMessages[channelId] || [];
		if (msgs.length === 0) return 'No messages';
		const last = msgs[msgs.length - 1];
		if (last.type === 'text') return last.text.length > 35 ? last.text.slice(0, 35) + '...' : last.text;
		return `Sent a ${last.type}`;
	}

	function formatRelativeTime(channelId: string): string {
		const msgs = $channelMessages[channelId] || [];
		if (msgs.length === 0) return '';
		const diff = Date.now() - msgs[msgs.length - 1].timestamp;
		if (diff < 60000) return 'now';
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
		return `${Math.floor(diff / 86400000)}d`;
	}
</script>

<div class="dm-tab">
	{#if selectedDmId && (isKeepNotesSelected || dmOther || activeGroup)}
		<!-- Active conversation -->
		<div class="dm-tab-active">
			<div class="dm-active-header" bind:this={activeHeaderElement}>
				<div class="dm-header-primary">
					<button class="dm-back-btn" on:click={() => { showGroupSettings = false; layoutStore.closeDM(); }} title="Back to all DMs" aria-label="Back to all DMs">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
					</button>
					<div class="dm-header-title-wrap">
						<span class="dm-header-title">{activeHeaderTitle}</span>
						{#if isKeepNotesSelected}
							<span class="dm-header-pill">Private</span>
						{:else if selectedDmPrivacyMode === 'open'}
							<span class="dm-header-pill dm-header-pill-open">
								<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
									<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3l-8.47-14.14a2 2 0 0 0-3.42 0z"></path>
									<line x1="12" y1="9" x2="12" y2="13"></line>
									<circle cx="12" cy="17" r="1"></circle>
								</svg>
								Open
							</span>
						{/if}
					</div>
				</div>
				{#if hasHeaderActions}
					{#if showCompactHeaderActions}
						<button class="dm-header-menu-btn" on:click={openHeaderActionMenu} title="Conversation actions" aria-label="Conversation actions">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
								<circle cx="12" cy="5" r="2"></circle>
								<circle cx="12" cy="12" r="2"></circle>
								<circle cx="12" cy="19" r="2"></circle>
							</svg>
						</button>
					{:else}
						<div class="dm-header-actions-inline">
							{#if headerCallActions.length > 0}
								<div class="dm-call-actions">
									{#each headerCallActions as action (action.id)}
										<button class="dm-call-btn" on:click={action.onSelect} title={action.title}>
											{#if action.id === 'voice'}
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
											{:else}
												<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
											{/if}
											{action.id === 'voice' ? 'Call' : 'Video'}
										</button>
									{/each}
								</div>
							{/if}
							{#if activeGroup}
								<button class="dm-settings-btn" on:click={toggleGroupSettings} title="Group settings">
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
								</button>
							{:else if headerRemoveAction}
								<button class="dm-delete-btn" on:click={headerRemoveAction.onSelect} title={headerRemoveAction.title}>
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
								</button>
							{/if}
						</div>
					{/if}
				{/if}
			</div>
			{#if showGroupSettings && activeGroup}
				<div class="dm-tab-messages">
					<GroupSettingsPanel channel={activeGroup} />
				</div>
			{:else}
				<div class="dm-tab-messages">
					{#if isKeepNotesSelected}
						<KeepNotesView />
					{:else if activeGroup}
						<DMMessageView
							channelId={selectedDmId}
							otherUser={activeGroup.memberUsers?.[0] || { id: '', username: activeGroup.name, color: '#888', status: 'offline' }}
							channel={activeGroup}
								on:openSettings={(event) => onOpenSettings(event.detail)}
						/>
					{:else if dmOther}
						<DMMessageView
							channelId={selectedDmId}
							otherUser={dmOther}
							channel={selectedDmChannel || undefined}
								on:openSettings={(event) => onOpenSettings(event.detail)}
						/>
					{/if}
				</div>
			{/if}
		</div>
	{:else}
		<!-- DM list view -->
		<div class="dm-tab-list">
			<div class="dm-tab-header">
				<span class="dm-tab-title">Messages</span>
				<div class="dm-header-actions">
					<button class="dm-new-btn dm-new-group-btn" on:click={() => { showCreateGroup = true; }} title="Create group">
						<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.98 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" fill="currentColor"/></svg>
					</button>
					<button class="dm-new-btn dm-new-dm-btn" on:click={() => { showNewDM = !showNewDM; }} title="Create DM">
						<span class="plus-glyph" aria-hidden="true">+</span>
					</button>
				</div>
			</div>

			{#if showNewDM}
				<div class="dm-new-panel">
					<input
						type="text"
						class="dm-search"
						placeholder="Search users..."
						bind:value={searchQuery}
					/>
					<div class="dm-new-list">
						{#each filteredUsers as user (getDmDirectoryKey(user))}
							<button class="dm-new-user" on:click={() => startDMWith(user)}>
								{#if user.profilePicture}
									<img src={user.profilePicture} alt={user.username} class="dm-new-avatar" />
								{:else}
									<div class="dm-new-avatar-ph" style="--avatar-color: {user.roleColor || user.color}">
										{user.username.charAt(0).toUpperCase()}
									</div>
								{/if}
								<div class="dm-new-info">
									<span class="dm-new-name">{user.username}</span>
									{#if user.handle}<span class="dm-new-handle">@{user.handle}</span>{/if}
								</div>
							</button>
						{:else}
							<div class="dm-empty-search">No users found</div>
						{/each}
					</div>
				</div>
			{/if}

			<div class="dm-conversations">
				{#each dmChannels as channel (channel.id)}
					{#if channel.type === 'group'}
						<div
							class="dm-conv-item"
							class:selected={selectedDmId === channel.id}
							class:dm-conv-item-pinned={isConversationPinned(channel.id)}
							role="button"
							tabindex="0"
							on:click={() => selectConversation(channel)}
							on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectConversation(channel); } }}
							on:contextmenu={(e) => openContextMenu(e, channel)}
							use:longpress={{ onLongPress: (e) => handleConversationLongPress(e, channel) }}
						>
							<div class="dm-conv-avatar-wrap">
								<GroupAvatar {channel} size={36} />
							</div>
								<div class="dm-conv-info">
									<div class="dm-conv-top">
										<span class="dm-conv-name">{channel.name}</span>
									{#if isConversationPinned(channel.id)}
										<span class="dm-conv-pin" title="Pinned conversation">Pinned</span>
									{/if}
										<span class="dm-conv-time">{formatRelativeTime(channel.id)}</span>
									</div>
									<span class="dm-conv-preview dm-group-conv-preview">
										<svg class="dm-group-row-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
										{channel.members?.length || 0} members - {getLastPreview(channel.id)}
									</span>
								</div>
							<div class="dm-conv-actions">
								{#each getInlineActions(channel, null) as action (action.id)}
									<button
										class:dm-conv-action-btn={action.id !== 'remove'}
										class:dm-conv-close-btn={action.id === 'remove'}
										on:click|stopPropagation={action.onSelect}
										title={action.title}
									>
										<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
											{#if action.id === 'voice'}
												<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
											{:else if action.id === 'video'}
												<path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
											{:else}
												<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
											{/if}
										</svg>
									</button>
								{/each}
							</div>
						</div>
					{:else}
						{@const other = getOtherUser(channel)}
						{#if other}
							<div
								class="dm-conv-item"
								class:selected={selectedDmId === channel.id}
								class:dm-conv-item-pinned={isConversationPinned(channel.id)}
								role="button"
								tabindex="0"
								on:click={() => selectConversation(channel)}
								on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectConversation(channel); } }}
								on:contextmenu={(e) => openContextMenu(e, channel, other)}
								use:longpress={{ onLongPress: (e) => handleConversationLongPress(e, channel, other) }}
							>
								<div class="dm-conv-avatar-wrap">
									{#if other.profilePicture}
										<img src={other.profilePicture} alt={other.username} class="dm-conv-avatar" />
									{:else}
										<div class="dm-conv-avatar-ph" style="--avatar-color: {other.roleColor || other.color}">
											{other.username.charAt(0).toUpperCase()}
										</div>
									{/if}
									{#if getConversationPrivacyMode(channel.id) === 'open'}
										<span class="dm-open-mode-badge" title="Open mode: plaintext DM">
											<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
												<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3l-8.47-14.14a2 2 0 0 0-3.42 0z"></path>
												<line x1="12" y1="9" x2="12" y2="13"></line>
												<circle cx="12" cy="17" r="1"></circle>
											</svg>
										</span>
									{:else if other.status && other.status !== 'offline'}
										<span class="dm-conv-status-dot" class:active={other.status === 'active'} class:away={other.status === 'away'} class:busy={other.status === 'busy'} title={other.status}></span>
									{/if}
								</div>
								<div class="dm-conv-info">
									<div class="dm-conv-top">
										<span class="dm-conv-name">{other.username}</span>
										{#if isConversationPinned(channel.id)}
											<span class="dm-conv-pin" title="Pinned conversation">Pinned</span>
										{/if}
										<span class="dm-conv-time">{formatRelativeTime(channel.id)}</span>
									</div>
									<span class="dm-conv-preview">{getLastPreview(channel.id)}</span>
								</div>
								<div class="dm-conv-actions">
									{#each getInlineActions(channel, other) as action (action.id)}
										<button
											class:dm-conv-action-btn={action.id !== 'remove'}
											class:dm-conv-close-btn={action.id === 'remove'}
											on:click|stopPropagation={action.onSelect}
											title={action.title}
										>
											<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
												{#if action.id === 'voice'}
													<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
												{:else if action.id === 'video'}
													<path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
												{:else}
													<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>
												{/if}
											</svg>
										</button>
									{/each}
								</div>
							</div>
						{/if}
					{/if}
				{:else}
					<div class="dm-empty-state">
						<p>No conversations yet</p>
						<button class="dm-start-btn" on:click={() => { showNewDM = true; }}>
							Start a conversation
						</button>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<ContextMenu
		open={showContextMenu && !!contextMenuChannel}
		x={contextMenuX}
		y={contextMenuY}
		items={contextMenuItems}
		ariaLabel="DM conversation actions"
		headerLabel={contextMenuChannel?.type === 'group' ? contextMenuChannel?.name || null : contextMenuUser?.username || null}
		on:close={closeContextMenu}
	/>

	<ContextMenu
		open={showHeaderActionMenu && !!selectedDmId && hasHeaderActions}
		x={headerActionMenuX}
		y={headerActionMenuY}
		items={headerActionMenuItems}
		ariaLabel="DM header actions"
		headerLabel={activeHeaderTitle}
		on:close={closeHeaderActionMenu}
	/>
</div>

<CreateGroupModal bind:isOpen={showCreateGroup} />
