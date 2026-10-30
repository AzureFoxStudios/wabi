<!--
	Row A of the stage masthead for a channel, DM or group (design contract §7.23, §8.2, §8.10).
	StageBar.svelte renders it for the channel views (Chat / Threads / Wiki / Gallery, Whiteboard)
	when no workspace has described row A through `stageHeader`.

	- Channel: `#` (or the kind glyph) in --w-sig + the name in --w-t-title; the topic as one line
	  that opens "About this channel"; display chips as words. Actions: search, pinned, More.
	- DM / group: avatar 28 + name + the seal chip (PrivacyBadge, which owns every privacy word)
	  with the retention chip; actions: search, call, video, More.
	- One fixed 56px row: nothing wraps; the topic and chips give way first.
	- Search is a quiet icon that expands into a 280px kit field. The query lives in `chatSearch`
	  so the stream (Chat.svelte) filters by it; Chat.svelte publishes the result facts through
	  `chatStageInfo`. Operator syntax help sits in the results dropdown, not in the placeholder.
	- Channel privacy is the colophon's job (§8.10): the channel row carries no privacy chip.
	  The member privacy summary is still fetched here and published as `stagePrivacySummary`
	  for surfaces that word retention; it fails closed (null) and never invents a policy.
-->
<script module lang="ts">
	import { writable, type Readable } from 'svelte/store';

	/** The masthead search; Chat.svelte filters the stream by `query`. */
	export type ChatSearchState = { query: string; expanded: boolean };
	export const chatSearch = writable<ChatSearchState>({ query: '', expanded: false });

	/** Set the query from anywhere (slash commands); a non-empty query opens the field. */
	export function setChatSearchQuery(query: string): void {
		chatSearch.update((state) => ({ query, expanded: state.expanded || query.trim() !== '' }));
	}

	export function resetChatSearch(): void {
		chatSearch.set({ query: '', expanded: false });
	}

	/** What the mounted chat stream tells the masthead; null while no stream is mounted. */
	export interface ChatStageInfo {
		channelId: string;
		/** The stream filters by the query (text-like channels showing messages). */
		searchable: boolean;
		resultCount: number;
		backfillBusy: boolean;
		persistMessages: boolean;
		fullHistoryRunning: boolean;
		fullHistoryPages: number;
		fullHistoryStatus: string;
		onSearchWeb: () => void;
		onToggleFullHistory: () => void;
	}
	export const chatStageInfo = writable<ChatStageInfo | null>(null);

	export type ChannelPrivacySummary = {
		channelId: string;
		retention: string;
		confidentiality: 'server_readable' | 'experimental_e2ee';
		e2ee: boolean;
		privateConversation: boolean;
		automatedContentRules: boolean;
		reportsPreserveEvidence: boolean;
	};
	const privacySummaryStore = writable<ChannelPrivacySummary | null>(null);
	/** `/api/privacy/channels/:id` for the room in the masthead (null while loading or on failure). */
	export const stagePrivacySummary: Readable<ChannelPrivacySummary | null> = { subscribe: privacySummaryStore.subscribe };

	const KIND_WORDS: Record<string, string> = {
		text: 'Text channel',
		public: 'Text channel',
		forum: 'Forum',
		wiki: 'Wiki',
		gallery: 'Gallery',
		lore: 'Project channel',
		planning: 'Project channel',
		announcement: 'Announcements',
		reception: 'Reception'
	};
</script>

<script lang="ts">
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import { get } from 'svelte/store';
	import { _ } from '$lib/i18n';
	import { displayEnhancementSettingsStore } from '$lib/displayEnhancements';
	import { activeServerSpoilAll, activeServerUnspoilAll, isServerChannelMuted, toggleServerMutedChannelId } from '$lib/serverSettings';
	import { getLoreBinding, parseLoreChannelId, type LoreChannelBinding } from '$lib/api/lore';
	import { getAuthToken } from '$lib/authSession';
	import { activeServerUrl } from '$lib/serverUrl';
	import { hasAddonCapability } from '$lib/addonInventory';
	import {
		channelMessagesStore,
		channels,
		currentUser,
		getDMOtherUser,
		getSocket,
		pinChannel,
		socket,
		togglePinMessage,
		unpinChannel,
		userLookup,
		type Message
	} from '$lib/socket';
	import { showToast } from '$lib/toast';
	import { communityRulesAvailable, communityRulesOpen } from '$lib/communityRulesUi';
	import { callMode, isInCall, outgoingCall } from '$lib/callingStateStores';
	import { startCall } from '$lib/calling';
	import { getUserIdentityKey } from '$lib/localNicknames';
	import { cachedE2eeStatus, refreshE2eeStatus } from '$lib/dm/dmE2eeState';
	import type { E2eeRoomStatus } from '$lib/e2ee';
	import { mediaUrl } from '$lib/mediaUrl';
	import { inkFor } from '$lib/theme/identity';
	import { portal } from '$lib/actions/portal';
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import PrivacyBadge from '$lib/components/PrivacyBadge.svelte';
	import GroupAvatar from '$lib/components/GroupAvatar.svelte';
	import type { WorkspaceViewKey } from './types';

	let {
		channelId = '',
		view = 'messages',
		trail
	}: {
		channelId?: string;
		view?: WorkspaceViewKey;
		/** Rendered right after the name (the phone's "Chat ▾" workspace button). */
		trail?: Snippet;
	} = $props();

	const uid = $props.id();
	const channel = $derived($channels.find((entry) => entry.id === channelId));
	const kind = $derived(channel?.type || 'text');
	const isDM = $derived(kind === 'dm');
	const isGroup = $derived(kind === 'group');
	const conversation = $derived(isDM || isGroup);
	const peer = $derived(isDM ? getDMOtherUser(channel, $currentUser, $userLookup) : null);
	// Prefer the live peer identity for DMs: the stored channel name can be stale or blank.
	const name = $derived(isDM && peer?.username ? peer.username : channel?.name || channelId);
	const topic = $derived(conversation ? '' : channel?.description?.trim() || '');
	const glyph = $derived(kind === 'wiki' ? 'book' : kind === 'forum' ? 'forum' : kind === 'gallery' ? 'image' : null);

	// ---------------------------------------------------------------- privacy summary (fail closed)
	let privacySummary = $state<ChannelPrivacySummary | null>(null);
	let privacyRequestKey = '';
	$effect(() => privacySummaryStore.set(privacySummary));

	async function refreshPrivacySummary(id: string, requestKey: string): Promise<void> {
		privacySummary = null;
		const server = get(activeServerUrl);
		const token = getAuthToken(server);
		if (!token) return;
		try {
			const response = await fetch(`${server}/api/privacy/channels/${encodeURIComponent(id)}`, {
				headers: { Authorization: `Bearer ${token}` },
				credentials: 'include'
			});
			if (!response.ok) return;
			const value = await response.json();
			if (`${get(activeServerUrl)}|${channelId}` === requestKey) privacySummary = value;
		} catch {
			// Privacy labels fail closed by disappearing; never invent a policy.
		}
	}

	function requestPrivacySummary(force = false): void {
		if (!channelId) {
			privacyRequestKey = '';
			privacySummary = null;
			return;
		}
		const key = `${$activeServerUrl}|${channelId}`;
		if (!force && key === privacyRequestKey) return;
		privacyRequestKey = key;
		void refreshPrivacySummary(channelId, key);
	}

	$effect(() => {
		void channelId;
		void $activeServerUrl;
		requestPrivacySummary();
	});

	// ---------------------------------------------------------------- DM / group encryption status
	let e2eeStatus = $state<E2eeRoomStatus | null>(null);
	let e2eeRefresh = $state(0);
	$effect(() => {
		const id = channelId;
		void e2eeRefresh;
		if (!conversation || !id) {
			e2eeStatus = null;
			return;
		}
		e2eeStatus = cachedE2eeStatus(id);
		let live = true;
		// Display only: a failed request leaves the chip on "Checking privacy…", never a claim.
		refreshE2eeStatus(id)
			.then((status) => {
				if (live) e2eeStatus = status;
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	});

	onMount(() => {
		const live = getSocket();
		const onChannelUpdated = (payload: { channelId?: string; autoDeleteAfter?: unknown }) => {
			if (payload?.channelId !== channelId || !('autoDeleteAfter' in payload)) return;
			requestPrivacySummary(true);
		};
		const onPolicyUpdated = () => {
			// Policy changes are not silent: refresh the visible contract now and say so.
			requestPrivacySummary(true);
			e2eeRefresh += 1;
			showToast('Server privacy policy changed. The room privacy labels have been refreshed.', 'info');
		};
		const onFocus = () => {
			if (conversation) e2eeRefresh += 1;
		};
		live?.on('channel-updated', onChannelUpdated);
		live?.on('privacy-policy-updated', onPolicyUpdated);
		window.addEventListener('focus', onFocus);
		return () => {
			live?.off('channel-updated', onChannelUpdated);
			live?.off('privacy-policy-updated', onPolicyUpdated);
			window.removeEventListener('focus', onFocus);
		};
	});

	// ---------------------------------------------------------------- display chips (words, no emoji)
	let loreBinding = $state<LoreChannelBinding | null>(null);
	$effect(() => {
		const id = channelId;
		loreBinding = null;
		let live = true;
		void (async () => {
			const numeric = parseLoreChannelId(id);
			const token = getAuthToken();
			if (!numeric || !token) return;
			if (!(await hasAddonCapability('lore'))) return;
			try {
				const binding = await getLoreBinding(token, numeric);
				if (live) loreBinding = binding;
			} catch {
				if (live) loreBinding = null;
			}
		})();
		return () => {
			live = false;
		};
	});

	type Chip = { id: string; label: string; title: string };
	const chips = $derived.by<Chip[]>(() => {
		const list: Chip[] = [];
		if (channel?.forceSpoiler) list.push({ id: 'spoilers', label: 'Spoilers', title: 'Every message in this channel is hidden until clicked.' });
		if (loreBinding) list.push({ id: 'lore', label: `Lore · ${loreBinding.path}`, title: `Lore binding: uploads promote to ${loreBinding.path} on branch ${loreBinding.branch} (mode: ${loreBinding.mode})` });
		if ($displayEnhancementSettingsStore.spoilerAllMessagesEnabled) list.push({ id: 'spoil-all', label: 'Spoiler all · your view', title: 'You have Spoiler All Messages enabled: every message is hidden until clicked (your view only).' });
		if ($activeServerSpoilAll) list.push({ id: 'server-spoiled', label: 'Spoiled on this server · your view', title: 'You have Spoiler All enabled for this server: every message here is hidden until clicked (your view only).' });
		if ($activeServerUnspoilAll) list.push({ id: 'server-unspoiled', label: 'Unspoiled on this server · your view', title: 'You have Unspoil All enabled for this server: every message here is revealed, even spoilers (your view only).' });
		return list;
	});
	// At most two chips in the row; the rest are named in one "+N" tag so the row never wraps.
	const shownChips = $derived(chips.slice(0, 2));
	const extraChips = $derived(chips.slice(2));
	const rulesTag = $derived(
		conversation && privacySummary?.privateConversation
			? privacySummary.automatedContentRules
				? { label: 'Local rules on', title: 'This server has explicitly opted private conversations into local automated content rules.' }
				: { label: 'Reports only', title: 'Automated content rules do not inspect this private conversation. Participants can explicitly report messages to server staff.' }
			: null
	);

	// ---------------------------------------------------------------- DM calls
	const callActive = $derived(($isInCall && $callMode === 'direct') || Boolean($outgoingCall));
	const callPending = $derived(Boolean($outgoingCall) && !$isInCall && $callMode === 'direct');

	async function startDmCall(video: boolean): Promise<void> {
		const live = get(socket);
		if (!live || !peer || callActive) return;
		try {
			await startCall(live, getUserIdentityKey(peer), video, { scope: 'dm', displayName: peer.username });
		} catch (error) {
			console.warn(`[Call] DM ${video ? 'video' : 'voice'} call failed to start:`, error);
		}
	}

	// ---------------------------------------------------------------- search
	const info = $derived($chatStageInfo && $chatStageInfo.channelId === channelId ? $chatStageInfo : null);
	const searchable = $derived(Boolean(info?.searchable) && view === 'messages');
	const searchLabel = $derived(
		conversation
			? $_('stage.search_conversation', { values: { name } })
			: $_('stage.search_channel', { values: { channel: name } })
	);
	const query = $derived($chatSearch.query);
	const expanded = $derived(searchable && $chatSearch.expanded);
	const betterSearch = $derived(Boolean($displayEnhancementSettingsStore.betterSearchPageEnabled));
	const dropId = `stage-search-drop-${uid}`;
	let searchBox = $state<HTMLElement | null>(null);
	let searchField = $state<HTMLInputElement | null>(null);
	let searchButton = $state<HTMLButtonElement | null>(null);
	let searchFocused = $state(false);
	const dropVisible = $derived(expanded && (searchFocused || query.trim() !== ''));

	async function openSearch(): Promise<void> {
		chatSearch.update((state) => ({ ...state, expanded: true }));
		await tick();
		searchField?.focus();
	}

	async function closeSearch(restoreFocus: boolean): Promise<void> {
		chatSearch.set({ query: '', expanded: false });
		if (!restoreFocus) return;
		await tick();
		searchButton?.focus();
	}

	function onSearchKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		if (query.trim()) setChatSearchQuery('');
		else void closeSearch(true);
	}

	$effect(() => {
		if (!expanded) return;
		// A press outside an idle field folds it back into its icon.
		const onPress = (event: PointerEvent) => {
			if (searchBox?.contains(event.target as Node)) return;
			if (!get(chatSearch).query.trim()) chatSearch.update((state) => ({ ...state, expanded: false }));
		};
		document.addEventListener('pointerdown', onPress);
		return () => document.removeEventListener('pointerdown', onPress);
	});

	// ---------------------------------------------------------------- pinned messages
	let channelMessages = $state<Message[]>([]);
	$effect(() => {
		const id = channelId;
		if (!id) {
			channelMessages = [];
			return;
		}
		return channelMessagesStore(id).subscribe((list) => {
			channelMessages = list || [];
		});
	});
	const pinned = $derived(channelMessages.filter((message) => message.isPinned));
	const pinnedLabel = $derived($_('stage.pinned'));

	function excerpt(text: string | undefined): string {
		const flat = (text || '').replace(/\s+/g, ' ').trim();
		return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
	}

	function timeOf(timestamp: number | undefined): string {
		if (!timestamp) return '';
		return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
	}

	function jumpTo(messageId: string): void {
		const target = document.getElementById(`message-${messageId}`);
		closePop(false);
		const still = document.documentElement.dataset.motion === 'reduce' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		target?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
	}

	// ---------------------------------------------------------------- popovers (About, Pinned)
	type PopKind = 'about' | 'pinned';
	let pop = $state<PopKind | null>(null);
	let popAnchor = $state<HTMLElement | null>(null);
	let popElement = $state<HTMLDivElement | null>(null);
	let popPosition = $state({ left: 0, top: 0 });
	let topicButton = $state<HTMLButtonElement | null>(null);
	let pinnedButton = $state<HTMLButtonElement | null>(null);
	let moreButton = $state<HTMLElement | null>(null);
	const popId = `stage-pop-${uid}`;

	async function openPop(kind: PopKind, anchor: HTMLElement | null): Promise<void> {
		if (pop === kind) {
			closePop(true);
			return;
		}
		pop = kind;
		popAnchor = anchor;
		await tick();
		place();
		popElement?.focus({ preventScroll: true });
	}

	function closePop(restoreFocus: boolean): void {
		if (!pop) return;
		const anchor = popAnchor;
		pop = null;
		popAnchor = null;
		if (restoreFocus) anchor?.focus({ preventScroll: true });
	}

	function place(): void {
		if (!popElement || !popAnchor) return;
		const box = popAnchor.getBoundingClientRect();
		const width = popElement.offsetWidth;
		const alignEnd = pop === 'pinned';
		const left = alignEnd ? box.right - width : box.left;
		popPosition = {
			left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
			top: box.bottom + 6
		};
	}

	$effect(() => {
		if (!pop) return;
		const onPress = (event: PointerEvent) => {
			const target = event.target as Node;
			if (popElement?.contains(target) || popAnchor?.contains(target)) return;
			closePop(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			closePop(true);
		};
		const onResize = () => place();
		document.addEventListener('pointerdown', onPress, true);
		document.addEventListener('keydown', onKey, true);
		window.addEventListener('resize', onResize);
		return () => {
			document.removeEventListener('pointerdown', onPress, true);
			document.removeEventListener('keydown', onKey, true);
			window.removeEventListener('resize', onResize);
		};
	});

	// A channel switch closes what was open about the previous one.
	$effect(() => {
		void channelId;
		untrack(() => closePop(false));
	});

	function onPopFocusOut(event: FocusEvent): void {
		const next = event.relatedTarget as Node | null;
		if (!next || popElement?.contains(next) || popAnchor?.contains(next)) return;
		closePop(false);
	}

	// ---------------------------------------------------------------- More menu
	let menuSeed = $state(0);
	/** A popover opened from More anchors to its own control when that is on screen (a narrow
	 *  stage hides the topic; the phone bar hides Pinned), else to the More button. */
	function shown(element: HTMLElement | null): HTMLElement | null {
		return element && element.getClientRects().length > 0 ? element : null;
	}
	function moreTrigger(): HTMLElement | null {
		return moreButton?.querySelector<HTMLElement>('button') ?? null;
	}
	const isBookmarked = $derived(Boolean($currentUser?.id && channel?.pinnedBy?.includes($currentUser.id)));
	const moreItems = $derived.by<MenuEntry[]>(() => {
		void menuSeed;
		if (!channelId) return [];
		const muted = isServerChannelMuted(channelId);
		const items: MenuEntry[] = [];
		if (!conversation) {
			items.push({ id: 'about', label: $_('stage.about_channel'), icon: 'info', onSelect: () => void tick().then(() => openPop('about', shown(topicButton) ?? moreTrigger())) });
			if (searchable) items.push({ id: 'pinned', label: pinnedLabel, icon: 'pin', hint: pinned.length ? String(pinned.length) : undefined, onSelect: () => void tick().then(() => openPop('pinned', shown(pinnedButton) ?? moreTrigger())) });
			items.push({ id: 'bookmark', label: isBookmarked ? 'Remove bookmark' : 'Bookmark channel', icon: 'star', onSelect: () => void (isBookmarked ? unpinChannel(channelId) : pinChannel(channelId)) });
		}
		items.push({
			id: 'mute',
			label: muted ? (conversation ? 'Unmute conversation' : 'Unmute channel') : conversation ? 'Mute conversation' : 'Mute channel',
			icon: 'bell',
			hint: 'this device',
			onSelect: () => toggleServerMutedChannelId(channelId)
		});
		if ($communityRulesAvailable) {
			items.push({ id: 'rules-sep', type: 'separator' });
			items.push({ id: 'rules', label: 'Community rules', icon: 'book', onSelect: () => communityRulesOpen.set(true) });
		}
		return items;
	});
	const kindWord = $derived(KIND_WORDS[kind] ?? 'Channel');
</script>

{#snippet searchControl()}
	{#if searchable}
		<div class="stage-search" class:open={expanded} bind:this={searchBox} role="search" aria-label={searchLabel}>
			{#if expanded}
				<label class="w-field w-field--chrome stage-search__field">
					<Icon name="search" size={16} />
					<input
						bind:this={searchField}
						type="text"
						enterkeyhint="search"
						autocomplete="off"
						spellcheck="false"
						value={query}
						placeholder={searchLabel}
						aria-label={searchLabel}
						aria-describedby={dropVisible ? dropId : undefined}
						oninput={(event) => setChatSearchQuery(event.currentTarget.value)}
						onkeydown={onSearchKeydown}
						onfocus={() => (searchFocused = true)}
						onblur={() => (searchFocused = false)}
					/>
				</label>
				{#if dropVisible}
					<div class="stage-search__drop" id={dropId}>
						{#if query.trim() && info && !betterSearch}
							<p class="stage-search__count" role="status" aria-live="polite">
								{info.resultCount === 1
									? $_('chat.search.results_one', { values: { count: info.resultCount } })
									: $_('chat.search.results_many', { values: { count: info.resultCount } })}
								{#if info.backfillBusy}<span class="stage-search__busy"> · {$_('chat.search.loading_older')}</span>{/if}
							</p>
							{#if info.persistMessages || $displayEnhancementSettingsStore.googleSearchReplaceEnabled}
								<div class="stage-search__actions">
									{#if info.persistMessages}
										<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={info.onToggleFullHistory}>
											{info.fullHistoryRunning
												? $_('chat.search.stop', { values: { count: info.fullHistoryPages } })
												: $_('chat.search.full_history')}
										</button>
									{/if}
									{#if $displayEnhancementSettingsStore.googleSearchReplaceEnabled}
										<button type="button" class="w-btn w-btn--sm w-btn--quiet" onclick={info.onSearchWeb}>Search on the web</button>
									{/if}
								</div>
							{/if}
							{#if info.fullHistoryStatus}<p class="stage-search__status">{info.fullHistoryStatus}</p>{/if}
						{/if}
						<p class="stage-search__help">{$_('stage.search_help')}</p>
					</div>
				{/if}
			{:else}
				<Tooltip text={searchLabel} placement="bottom">
					<button bind:this={searchButton} type="button" class="w-ibtn" aria-label={searchLabel} aria-expanded="false" onclick={openSearch}>
						<Icon name="search" />
					</button>
				</Tooltip>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet moreMenu()}
	{#if moreItems.length}
		<span class="stage-a__menu" bind:this={moreButton}>
			<Menu
				label={$_('stage.more_actions')}
				triggerLabel={$_('stage.more_actions')}
				class="w-ibtn"
				align="end"
				heading={conversation ? name : `#${name}`}
				items={moreItems}
				onopenchange={(next) => {
					if (next) menuSeed += 1;
				}}
			>
				<Icon name="more" />
			</Menu>
		</span>
	{/if}
{/snippet}

{#if conversation}
	<div class="stage-a__lead stage-a__lead--dm">
		{#if isGroup && channel}
			<span class="stage-a__avatar stage-a__avatar--group" aria-hidden="true"><GroupAvatar {channel} size={28} /></span>
		{:else if peer?.profilePicture}
			<img class="stage-a__avatar" src={mediaUrl(peer.profilePicture)} alt="" />
		{:else}
			<span class="stage-a__avatar stage-a__avatar--stamp" style={$inkFor(peer?.roleColor || peer?.color)} aria-hidden="true">{(name || '?').charAt(0).toUpperCase()}</span>
		{/if}
		<h2 class="stage-a__title"><span class="stage-a__name">{name}</span></h2>
		{@render trail?.()}
		<PrivacyBadge
			variant="popover-trigger"
			input={{ channelType: isGroup ? 'group' : 'dm', policy: e2eeStatus }}
			retention={privacySummary}
			showRetention
			room={name}
			placement="bottom"
		/>
		{#if rulesTag}<span class="w-tag stage-a__chip" title={rulesTag.title}>{rulesTag.label}</span>{/if}
	</div>
	<div class="stage-a__actions">
		{#if isDM && peer && callActive}
			<span class="w-tag stage-a__call" role="status" aria-live="polite"><span class="w-dot w-dot--online"></span>{callPending ? 'Calling…' : 'Call active'}</span>
		{/if}
		{@render searchControl()}
		{#if isDM && peer}
			<Tooltip text={$_('chat.dm.voice_call_title', { values: { user: peer.username } })} placement="bottom">
				<button type="button" class="w-ibtn" aria-label={$_('chat.dm.voice_call_title', { values: { user: peer.username } })} disabled={callActive} onclick={() => void startDmCall(false)}>
					<Icon name="phone" />
				</button>
			</Tooltip>
			<Tooltip text={$_('chat.dm.video_call_title', { values: { user: peer.username } })} placement="bottom">
				<button type="button" class="w-ibtn" aria-label={$_('chat.dm.video_call_title', { values: { user: peer.username } })} disabled={callActive} onclick={() => void startDmCall(true)}>
					<Icon name="video" />
				</button>
			</Tooltip>
		{/if}
		{@render moreMenu()}
	</div>
{:else}
	<div class="stage-a__lead">
		<h2 class="stage-a__title">
			{#if glyph}<Icon name={glyph} size={18} class="stage-a__glyph-icon" />{:else}<span class="stage-a__glyph" aria-hidden="true">#</span>{/if}<span class="stage-a__name">{name}</span>
		</h2>
		{@render trail?.()}
		{#if topic}
			<button
				bind:this={topicButton}
				type="button"
				class="stage-a__topic"
				aria-haspopup="dialog"
				aria-expanded={pop === 'about'}
				aria-controls={pop === 'about' ? popId : undefined}
				title={topic}
				onclick={() => void openPop('about', topicButton)}
			>{topic}</button>
		{/if}
		{#if shownChips.length}
			<span class="stage-a__chips">
				{#each shownChips as chip (chip.id)}<span class="w-tag stage-a__chip" title={chip.title}>{chip.label}</span>{/each}
				{#if extraChips.length}<span class="w-tag stage-a__chip" title={extraChips.map((chip) => chip.label).join(' · ')}>+{extraChips.length}</span>{/if}
			</span>
		{/if}
	</div>
	<div class="stage-a__actions">
		{@render searchControl()}
		{#if searchable}
			<Tooltip text={pinned.length ? `${pinnedLabel} · ${pinned.length}` : pinnedLabel} placement="bottom">
				<button
					bind:this={pinnedButton}
					type="button"
					class="w-ibtn stage-a__pinned"
					aria-label={pinned.length ? `${pinnedLabel}, ${pinned.length}` : pinnedLabel}
					aria-haspopup="dialog"
					aria-expanded={pop === 'pinned'}
					aria-controls={pop === 'pinned' ? popId : undefined}
					onclick={() => void openPop('pinned', pinnedButton)}
				>
					<Icon name="pin" />
				</button>
			</Tooltip>
		{/if}
		{@render moreMenu()}
	</div>
{/if}

{#if pop}
	<div
		use:portal
		bind:this={popElement}
		id={popId}
		class="w-pop stage-pop"
		class:stage-pop--list={pop === 'pinned'}
		role="dialog"
		aria-labelledby={`${popId}-title`}
		tabindex="-1"
		style:left={`${popPosition.left}px`}
		style:top={`${popPosition.top}px`}
		onfocusout={onPopFocusOut}
	>
		{#if pop === 'about'}
			<p class="w-pop__title" id={`${popId}-title`}>
				{#if glyph}<Icon name={glyph} size={16} />{:else}<span class="stage-pop__hash" aria-hidden="true">#</span>{/if}{name}
			</p>
			<p class="w-pop__body stage-pop__topic">{topic || 'No topic yet.'}</p>
			<dl class="w-pop__facts">
				<dt>Kind</dt>
				<dd>{kindWord}</dd>
			</dl>
		{:else}
			<p class="w-pop__title" id={`${popId}-title`}><Icon name="pin" size={16} />{pinnedLabel}{#if pinned.length}<span class="w-count">{pinned.length}</span>{/if}</p>
			{#if pinned.length}
				<ul class="stage-pop__pins">
					{#each pinned as message (message.id)}
						<li class="stage-pop__pin">
							<button type="button" class="stage-pop__jump" onclick={() => jumpTo(message.id)}>
								<span class="stage-pop__meta"><span class="stage-pop__who">{message.user}</span><span class="w-count">{timeOf(message.timestamp)}</span></span>
								<span class="stage-pop__text">{excerpt(message.text)}</span>
							</button>
							<button type="button" class="w-ibtn w-ibtn--sm" aria-label={`Unpin message from ${message.user}`} onclick={() => void togglePinMessage(channelId, message.id)}>
								<Icon name="x" />
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="w-pop__body">Nothing is pinned in #{name} yet. Pin a message from its actions to keep it here.</p>
			{/if}
		{/if}
	</div>
{/if}
