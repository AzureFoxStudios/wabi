<!--
	JumpPalette (design contract §7.24, D12, D13): Ctrl K, one keyboard path to any channel,
	person, workspace or action, with the truth labels of §9 carried into the rows.

	Mounted once by routes/+layout.svelte (lazily, on first use) and driven by `lib/jumpPalette.ts`:
	anything opens it with `openPalette()`, the layout's Ctrl K listener toggles it. Ranking, groups,
	match ranges and truth labels come from `lib/jumpIndex.ts`; this component only maps the live
	stores onto that index, renders it and performs the jump.

	- Portaled dialog over a sibling `.w-scrim`: 640 wide at 12vh on desktop, full screen on phones.
	- Input row 56 (`role=combobox`, `aria-activedescendant`), scope row 40 (Everything, # Channels,
	  @ People, / Workspaces, > Actions; typing a prefix switches scope, Tab / Shift Tab walk them,
	  Backspace on an empty query returns to Everything), 44px option rows grouped under kickers,
	  footer hints with keycaps (keycaps live only in the palette, never as persistent legends).
	- Opening a result closes without restoring focus (the destination takes it); Esc, the scrim and
	  Ctrl K return focus to where the palette was opened from.
	- Loading shows skeleton rows where recent documents will land; an empty result names the scope.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { get } from 'svelte/store';
	import { MediaQuery } from 'svelte/reactivity';
	import { portal } from '$lib/actions/portal';
	import Icon from '$lib/components/ui/Icon.svelte';
	import PrivacyBadge from '$lib/components/PrivacyBadge.svelte';
	import { _ } from '$lib/i18n';
	import {
		PALETTE_SCOPES,
		PALETTE_SCOPE_LABEL,
		PALETTE_SCOPE_PREFIX,
		closePalette,
		nextPaletteScope,
		palette,
		parsePaletteInput,
		setPaletteScope,
		type PaletteScope
	} from '$lib/jumpPalette';
	import {
		JUMP_GROUP_KEY,
		JUMP_GROUP_LABEL,
		SCOPE_GROUPS,
		buildJumpIndex,
		flattenSections,
		highlightParts,
		presenceOf,
		searchJump,
		type JumpActionId,
		type JumpChannelInput,
		type JumpDocumentInput,
		type JumpPersonInput,
		type JumpResult,
		type OfficeAddonState
	} from '$lib/jumpIndex';
	import { channels, currentChannel, switchChannel } from '$lib/channelStore';
	import { channelUnreadCounts, markChannelAsRead, markMessagesAsRead } from '$lib/messageStore';
	import { currentUser, serverMembers, users, voiceChannelMembers } from '$lib/presenceStore';
	import type { Channel, User } from '$lib/socket-types';
	import { activeWorkspaceView, selectWorkspaceView } from '$lib/workspaceNavigationState';
	import { workspaceViewSelect } from '$lib/workspaceViewBridge';
	import type { WorkspaceViewKey } from '$lib/components/chat/types';
	import { layoutStore } from '$lib/layoutStore';
	import { openProfilePanel } from '$lib/profilePanelNavigation';
	import { captureScope, openWorkspace, type ArtifactKind } from '$lib/workspaces/bridge';
	import { hydrateWorkspaceAddons, workspaceAddonEnabled } from '$lib/workspaces/addonState';
	import { cachedE2eeStatus } from '$lib/dm/dmE2eeState';
	import { privacyStateFor } from '$lib/privacy/privacyState';
	import { resolveDmOtherUser } from '$lib/dmConversations';
	import { groupRecipientSummary } from '$lib/dmPresentation';
	import { inkFor } from '$lib/theme/identity';
	import { mediaUrl } from '$lib/mediaUrl';

	const uid = $props.id();
	const listId = `jump-${uid}-list`;
	const helpId = `jump-${uid}-help`;
	const optionId = (index: number) => `jump-${uid}-opt-${index}`;
	const kickerId = (group: string) => `jump-${uid}-group-${group}`;

	/** Phones: full screen, no keyboard hints (§8.12). */
	const phone = new MediaQuery('max-width: 599px', false);

	let input = $state<HTMLInputElement | null>(null);
	let query = $state('');
	let active = $state(0);
	let session = -1;

	// Recent office documents are read from this device's workspace store on every opening.
	let documents = $state<JumpDocumentInput[]>([]);
	let documentsState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let slowDocuments = $state(false);
	// Sheets/Present: known after their setting is read; absent from some builds.
	let officeKnown = $state(false);
	let officeIncluded = $state<{ sheets: boolean; present: boolean } | null>(null);
	let failedPictures = $state<Record<string, true>>({});
	let announcement = $state('');

	const open = $derived($palette.open);
	const scope = $derived<PaletteScope>($palette.scope);

	/** A locale string, or the English words when the key does not resolve. */
	function tr(key: string, fallback: string, values?: Record<string, string | number>): string {
		const text = $_(key, values ? { values } : undefined);
		return typeof text === 'string' && text !== key ? text : fallback;
	}

	const scopeLabel = (value: PaletteScope) =>
		tr(`jump.scopes.${value === 'all' ? 'everything' : value}`, PALETTE_SCOPE_LABEL[value]);

	const PLACEHOLDER: Record<PaletteScope, string> = {
		all: 'Search or jump to',
		channels: 'Search channels',
		people: 'Search people',
		workspaces: 'Search workspaces and documents',
		actions: 'Search actions'
	};
	const placeholder = $derived(scope === 'all' ? tr('jump.placeholder', PLACEHOLDER.all) : PLACEHOLDER[scope]);

	// ---------------------------------------------------------------- live stores → index inputs

	function identity(user: User): string {
		return String(user.dbUserId ?? user.id);
	}

	const order = (channel: Channel) => channel.position ?? channel.sortOrder ?? Number.MAX_SAFE_INTEGER;

	const channelInputs = $derived.by((): JumpChannelInput[] => {
		const me = $currentUser;
		const live = $users;
		const members = $serverMembers;
		const unread = $channelUnreadCounts;
		const rooms = $voiceChannelMembers;
		const here = $currentChannel;
		const view = $activeWorkspaceView;
		void open; // re-read the privacy cache on every opening
		const anchoredToChannel = view === 'messages' || view === 'whiteboard';
		const conversation = (channel: Channel) => channel.type === 'dm' || channel.type === 'group';
		return [...$channels]
			.filter((channel) => channel?.id && channel.type !== 'category')
			.sort((a, b) => Number(conversation(a)) - Number(conversation(b)) || order(a) - order(b))
			.map((channel): JumpChannelInput => {
				const type = channel.type || 'text';
				const other = type === 'dm' ? resolveDmOtherUser(channel, me, live, members) : null;
				const policy = conversation(channel) ? cachedE2eeStatus(channel.id) : null;
				return {
					id: channel.id,
					name: channel.name,
					type,
					unread: unread[channel.id] ?? 0,
					current: anchoredToChannel && channel.id === here,
					parentId: channel.parentChannelId ?? null,
					occupancy: rooms[channel.id]?.length ?? 0,
					person: other
						? {
								name: other.username,
								color: other.color ?? null,
								picture: other.profilePicture ?? null,
								// Presence comes from the live list only; a directory entry is not "here now".
								presence: presenceOf(live.find((user) => identity(user) === identity(other))?.status ?? 'offline')
							}
						: null,
					members: type === 'group' ? groupRecipientSummary(channel, me, [...members, ...live]) || null : null,
					// Only a known room status becomes a label; unknown is left unsaid (§9.2).
					privacy: policy ? privacyStateFor({ channelType: type, policy }) : null
				};
			});
	});

	/** People by account: the live list first (it carries presence), then the member directory. */
	const directory = $derived.by((): Map<string, User> => {
		const people = new Map<string, User>();
		for (const user of [...$users, ...$serverMembers]) {
			if (user && !people.has(identity(user))) people.set(identity(user), user);
		}
		return people;
	});

	const peopleInputs = $derived.by((): JumpPersonInput[] => {
		const me = $currentUser;
		const mine = me ? identity(me) : null;
		const live = new Set($users.map(identity));
		const roomOf = new Map<string, string>();
		const names = new Map($channels.map((channel) => [channel.id, channel.name]));
		for (const [roomId, participants] of Object.entries($voiceChannelMembers)) {
			for (const participant of participants ?? []) roomOf.set(String(participant.userId), names.get(roomId) ?? roomId);
		}
		const people: JumpPersonInput[] = [];
		for (const [key, user] of directory) {
			if (key === mine || !user.username) continue;
			people.push({
				id: key,
				name: user.username,
				handle: user.handle ?? null,
				status: live.has(key) ? user.status : 'offline',
				color: user.color ?? null,
				picture: user.profilePicture ?? null,
				room: roomOf.get(String(user.id)) ?? roomOf.get(key) ?? null
			});
		}
		return people;
	});

	function addonState(tool: 'sheets' | 'present'): OfficeAddonState {
		if (officeIncluded && !officeIncluded[tool]) return 'unavailable';
		if (!officeKnown) return 'unknown';
		return $workspaceAddonEnabled[tool] ? 'on' : 'off';
	}

	const items = $derived(
		buildJumpIndex({
			channels: channelInputs,
			people: peopleInputs,
			documents,
			office: { sheets: addonState('sheets'), present: addonState('present') },
			activeView: $activeWorkspaceView,
			currentChannelName: $channels.find((channel) => channel.id === $currentChannel)?.name ?? null,
			canOpenWhiteboard: Boolean($currentChannel),
			unreadChannels: Object.values($channelUnreadCounts).filter((count) => count > 0).length
		})
	);

	const sections = $derived(searchJump(items, query, scope));
	const flat = $derived(flattenSections(sections));
	const activeIndex = $derived(flat.length ? Math.min(Math.max(0, active), flat.length - 1) : -1);
	const typed = $derived(query.trim() !== '');

	const documentsInScope = $derived(SCOPE_GROUPS[scope].includes('documents'));
	/** Skeleton rows while recent documents are still on their way (after a short delay). */
	const showSkeleton = $derived(documentsInScope && documentsState === 'loading' && slowDocuments && (!typed || flat.length === 0));
	const documentsFailed = $derived(documentsInScope && documentsState === 'error' && !typed);

	const countText = $derived(
		flat.length === 1 ? tr('jump.count_one', '1 result', { count: 1 }) : tr('jump.count_many', `${flat.length} results`, { count: flat.length })
	);
	const emptyText = $derived(
		scope === 'all'
			? tr('jump.empty', `Nothing matches “${query.trim()}”.`, { query: query.trim() })
			: tr('jump.empty_scope', `Nothing matches “${query.trim()}” in ${scopeLabel(scope)}. Try Everything.`, {
					query: query.trim(),
					scope: scopeLabel(scope)
				})
	);

	// ---------------------------------------------------------------- opening a session

	async function loadDocuments(own: number): Promise<void> {
		documentsState = 'loading';
		slowDocuments = false;
		const slow = setTimeout(() => {
			if (own === session) slowDocuments = true;
		}, 150);
		try {
			const [{ listLocal, readLocal }, owner] = await Promise.all([import('$lib/workspaces/session'), captureScope()]);
			const kinds: ArtifactKind[] = ['document', 'sheets', 'present'];
			const rows = (await Promise.all(kinds.map(async (kind) => (await listLocal(owner, kind)).map((row) => ({ ...row, kind })))))
				.flat()
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, 6);
			const found = await Promise.all(
				rows.map(async (row): Promise<JumpDocumentInput | null> => {
					// The record's server metadata is what makes a draft shared (and Server-readable).
					const record = await readLocal(owner, row.id).catch(() => null);
					if (!record) return null;
					return { id: row.id, kind: row.kind, title: row.title, updatedAt: row.updatedAt, shared: Boolean(record.meta), role: record.meta?.role ?? null };
				})
			);
			if (own !== session || !owner.isCurrent()) return;
			documents = found.filter((row): row is JumpDocumentInput => row !== null);
			documentsState = 'ready';
		} catch (error) {
			if (own !== session) return;
			console.warn('[JumpPalette] recent documents unavailable', error);
			documents = [];
			documentsState = 'error';
		} finally {
			clearTimeout(slow);
		}
	}

	async function loadOffice(): Promise<void> {
		try {
			const [sheets, present] = await Promise.all([import('@wabi/workspace-sheets'), import('@wabi/workspace-present')]);
			officeIncluded = { sheets: sheets.available, present: present.available };
		} catch {
			officeIncluded = null;
		}
		try {
			await hydrateWorkspaceAddons();
			officeKnown = true;
		} catch (error) {
			console.warn('[JumpPalette] office add-on setting unavailable', error);
		}
	}

	$effect(() => {
		const state = $palette;
		if (!state.open || state.session === session) return;
		session = state.session;
		untrack(() => {
			query = state.query;
			active = 0;
			failedPictures = {};
			void loadDocuments(state.session);
			void loadOffice();
		});
		void tick().then(() => {
			if (!input) return;
			input.value = state.query;
			input.focus({ preventScroll: true });
			input.select();
		});
	});

	// Keep the highlighted row in view as the arrows move it.
	$effect(() => {
		if (!open || activeIndex < 0) return;
		const id = optionId(activeIndex);
		void tick().then(() => document.getElementById(id)?.scrollIntoView({ block: 'nearest' }));
	});

	// One polite announcement after typing settles: count and scope.
	$effect(() => {
		if (!open) return;
		const text = `${countText}, ${scopeLabel(scope)}`;
		const timer = setTimeout(() => (announcement = text), 400);
		return () => clearTimeout(timer);
	});

	// ---------------------------------------------------------------- input

	function setQuery(value: string): void {
		query = value;
		active = 0;
		if (input && input.value !== value) input.value = value;
	}

	function onInput(event: Event & { currentTarget: HTMLInputElement }): void {
		const value = event.currentTarget.value;
		const parsed = parsePaletteInput(value, scope);
		if (parsed.query !== value || parsed.scope !== scope) {
			setPaletteScope(parsed.scope);
			setQuery(parsed.query);
			return;
		}
		setQuery(value);
	}

	function chooseScope(next: PaletteScope): void {
		setPaletteScope(next);
		active = 0;
		input?.focus({ preventScroll: true });
	}

	function move(step: number): void {
		if (!flat.length) return;
		active = (activeIndex + step + flat.length) % flat.length;
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				move(1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				move(-1);
				break;
			case 'PageDown':
				event.preventDefault();
				if (flat.length) active = Math.min(flat.length - 1, activeIndex + 5);
				break;
			case 'PageUp':
				event.preventDefault();
				if (flat.length) active = Math.max(0, activeIndex - 5);
				break;
			case 'Enter': {
				event.preventDefault();
				const result = flat[activeIndex];
				if (result) openResult(result);
				break;
			}
			case 'Tab':
				event.preventDefault();
				chooseScope(nextPaletteScope(scope, event.shiftKey ? -1 : 1));
				break;
			case 'Escape':
				event.preventDefault();
				event.stopPropagation();
				closePalette();
				break;
			case 'Backspace':
				if (!query && scope !== 'all' && input?.selectionStart === 0 && input.selectionEnd === 0) {
					event.preventDefault();
					chooseScope('all');
				}
				break;
		}
	}

	/** Keep focus in the input while pointing at chips and rows. */
	function keepFocus(event: MouseEvent): void {
		event.preventDefault();
	}

	// ---------------------------------------------------------------- jumping

	function selectView(view: WorkspaceViewKey): void {
		// MainLayout's handler also moves the shell back to the channel workspace and closes a center DM.
		const select = get(workspaceViewSelect);
		if (select) select(view);
		else selectWorkspaceView(view);
	}

	function navigate(detail: Record<string, unknown>): void {
		window.dispatchEvent(new CustomEvent('wabi:navigate', { detail }));
	}

	/** After a jump into a conversation the composer takes focus (not on phones: no surprise keyboard). */
	function focusComposerSoon(): void {
		if (phone.current) return;
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const field = document.querySelector<HTMLElement>('.input-container textarea, textarea[aria-label^="Message "]');
				if (field && field.getClientRects().length) field.focus({ preventScroll: true });
			})
		);
	}

	function runAction(action: JumpActionId): void {
		switch (action) {
			case 'new-document':
				// A blank private draft in Documents; the unique source key makes it a new one each time.
				openWorkspace('documents', {
					source: { title: 'Untitled document', content: '', format: 'markdown', sourceKey: `palette:new:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}` }
				});
				break;
			case 'new-task':
				selectView('planner');
				break;
			case 'mark-all-read':
				for (const [id, count] of Object.entries(get(channelUnreadCounts))) if (count > 0) markChannelAsRead(id);
				markMessagesAsRead();
				break;
			case 'open-settings':
				window.dispatchEvent(new CustomEvent('wabi:open-settings'));
				break;
		}
	}

	function openResult(result: JumpResult): void {
		const target = result.item.target;
		closePalette({ restoreFocus: false });
		switch (target.type) {
			case 'view':
				selectView(target.view);
				break;
			case 'dms':
				navigate({ view: 'dm' });
				break;
			case 'channel':
				switchChannel(target.channelId);
				selectView('messages');
				layoutStore.showMobileChannels.set(false);
				focusComposerSoon();
				break;
			case 'voice':
				selectView('voice');
				break;
			case 'conversation':
				navigate({ view: 'dm', channelId: target.channelId });
				focusComposerSoon();
				break;
			case 'person': {
				const user = directory.get(target.personId);
				if (user) openProfilePanel(user);
				break;
			}
			case 'document':
				openWorkspace(target.tool, { id: target.documentId });
				break;
			case 'action':
				runAction(target.action);
				break;
		}
	}

	function groupLabel(group: keyof typeof JUMP_GROUP_KEY): string {
		return tr(JUMP_GROUP_KEY[group], JUMP_GROUP_LABEL[group]);
	}

	/** Index of a row in the flat order the arrows walk. */
	function indexOf(result: JumpResult): number {
		return flat.indexOf(result);
	}
</script>

{#if open}
	<div class="jump-layer" use:portal data-jump-palette>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="w-scrim jump-scrim" aria-hidden="true" onclick={() => closePalette()}></div>
		<div class="jump" role="dialog" aria-modal="true" aria-label={tr('jump.label', 'Jump to')}>
			<div class="jump__head">
				<Icon name="search" size={20} class="jump__search" />
				<input
					bind:this={input}
					class="jump__input"
					type="text"
					role="combobox"
					aria-label={tr('jump.label', 'Jump to')}
					aria-expanded="true"
					aria-haspopup="listbox"
					aria-controls={listId}
					aria-autocomplete="list"
					aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
					aria-describedby={helpId}
					{placeholder}
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					enterkeyhint="go"
					oninput={onInput}
					onkeydown={onKeydown}
				/>
				<kbd class="w-kbd jump__esc" aria-hidden="true">Esc</kbd>
				<button type="button" class="w-ibtn jump__close" aria-label="Close" onclick={() => closePalette()}>
					<Icon name="x" size={20} />
				</button>
			</div>

			<div class="jump__scopes" role="group" aria-label="Search in">
				{#each PALETTE_SCOPES as option (option)}
					<button
						type="button"
						class="jump__scope"
						tabindex="-1"
						aria-pressed={scope === option}
						onmousedown={keepFocus}
						onclick={() => chooseScope(option)}
					>
						{#if option !== 'all'}<kbd class="w-kbd jump__prefix" aria-hidden="true">{PALETTE_SCOPE_PREFIX[option]}</kbd>{/if}
						{scopeLabel(option)}
					</button>
				{/each}
			</div>

			<div class="jump__body">
				<div id={listId} role="listbox" aria-label={scopeLabel(scope)} class="jump__list">
					{#each sections as section (section.group)}
						<div role="group" aria-labelledby={kickerId(section.group)} class="jump__group">
							<div role="presentation" id={kickerId(section.group)} class="w-kicker jump__kicker">{groupLabel(section.group)}</div>
							{#each section.results as result (result.item.id)}
								{@const index = indexOf(result)}
								{@const item = result.item}
								<!-- The combobox input owns the keyboard (arrows, Enter); rows answer the pointer. -->
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<div
									role="option"
									id={optionId(index)}
									class="jump__row"
									class:is-current={item.current}
									aria-selected={index === activeIndex}
									tabindex="-1"
									onmousedown={keepFocus}
									onpointermove={() => {
										if (active !== index) active = index;
									}}
									onclick={() => openResult(result)}
								>
									{#if item.person}
										<span class="jump__av" style={$inkFor(item.person.color)} aria-hidden="true">
											{#if item.person.picture && !failedPictures[item.id]}
												<img src={mediaUrl(item.person.picture)} alt="" loading="lazy" onerror={() => (failedPictures = { ...failedPictures, [item.id]: true })} />
											{:else}
												{item.person.initial}
											{/if}
											<span class="jump__presence" data-presence={item.person.presence}></span>
										</span>
									{:else}
										<span class="jump__tile" aria-hidden="true">
											{#if item.glyph}<span class="jump__glyph">{item.glyph}</span>{:else}<Icon name={item.icon} size={16} />{/if}
										</span>
									{/if}
									<span class="jump__text">
										<span class="jump__title"
											>{#each highlightParts(item.title, result.ranges) as part, partIndex (partIndex)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{#if item.current}<span class="jump__sr">, you are here</span>{/if}</span
										>
										{#if item.subtitle}<span class="jump__sub">{item.subtitle}</span>{/if}
									</span>
									{#if item.unread || item.truths.length}
										<span class="jump__truths">
											{#each item.truths as truth, truthIndex (truthIndex)}
												{#if truth.kind === 'maturity'}
													<span class="w-tag w-tag--mat" title={truth.title}>{truth.label}</span>
												{:else if truth.kind === 'hint'}
													<span class="jump__hint">{truth.label}</span>
												{:else if truth.kind === 'locality'}
													<span class="w-tag jump__tag" title={truth.title}>{truth.label}</span>
												{:else if truth.kind === 'seal'}
													<span class="w-seal" title={truth.title}><Icon name="lockOpen" size={13} />{truth.label}</span>
												{:else if truth.kind === 'privacy'}
													<PrivacyBadge variant="chip" state={truth.state} conversation />
												{/if}
											{/each}
											{#if item.unread}
												<span class="w-badge w-badge--sm" aria-label="{item.unread} unread">{item.unread > 99 ? '99+' : item.unread}</span>
											{/if}
										</span>
									{/if}
								</div>
							{/each}
						</div>
					{/each}
				</div>

				{#if showSkeleton}
					<div class="jump__group" aria-hidden="true">
						<div class="w-kicker jump__kicker">{groupLabel('documents')}</div>
						{#each [0, 1] as row (row)}
							<div class="jump__row jump__row--skel">
								<span class="w-skel jump__skel-tile"></span>
								<span class="w-skel-stack jump__skel-text">
									<span class="w-skel jump__skel-title"></span>
									<span class="w-skel jump__skel-sub"></span>
								</span>
							</div>
						{/each}
					</div>
					<span class="jump__sr" role="status">Loading recent documents</span>
				{:else if documentsFailed}
					<p class="jump__note" role="status">Recent documents could not be read on this device.</p>
				{/if}

				{#if flat.length === 0 && !showSkeleton && typed}
					<p class="jump__empty" role="status">{emptyText}</p>
				{/if}
			</div>

			<div class="jump__foot">
				<span class="jump__hints" aria-hidden="true">
					<span class="jump__hint-pair"><kbd class="w-kbd">↑</kbd><kbd class="w-kbd">↓</kbd> {tr('jump.hint_move', 'move')}</span>
					<span class="jump__hint-pair"><kbd class="w-kbd">Enter</kbd> {tr('jump.hint_open', 'open')}</span>
					<span class="jump__hint-pair"><kbd class="w-kbd">Tab</kbd> {tr('jump.hint_next_scope', 'next scope')}</span>
				</span>
				<span class="jump__count">{countText}</span>
			</div>
			<span id={helpId} class="jump__sr">Arrow keys move through results, Enter opens one, Tab switches scope, Escape closes.</span>
			<span class="jump__sr" aria-live="polite">{announcement}</span>
		</div>
	</div>
{/if}

<style>
	/* One stacking context above the shell chrome (docked call bar included). */
	.jump-layer {
		position: fixed;
		inset: 0;
		z-index: var(--z-floating-ui, 2250);
	}
	.jump-scrim {
		z-index: 0;
	}

	/* ---- frame: 640 at 12vh, an overlay (§4.5 plane 2) */
	.jump {
		position: absolute;
		top: 12vh;
		left: 0;
		right: 0;
		z-index: 1;
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		width: min(640px, calc(100vw - 32px));
		max-height: calc(100dvh - 12vh - 24px);
		margin: 0 auto;
		overflow: hidden;
		border: var(--w-bw) solid var(--w-line-strong);
		border-radius: var(--radius-lg);
		background: var(--w-bg2);
		box-shadow: var(--w-shadow);
		color: var(--w-text);
		animation: w-enter var(--w-dur-2) var(--w-ease);
	}
	:global(:root[data-mode='light']) .jump {
		background: var(--w-lift);
	}

	/* ---- input row 56 */
	.jump__head {
		display: flex;
		flex: none;
		align-items: center;
		gap: 12px;
		height: 56px;
		padding: 0 16px;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.jump__head :global(.jump__search) {
		flex: none;
		color: var(--w-faint);
	}
	.jump__input {
		flex: 1;
		min-width: 0;
		height: 100%;
		padding: 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--w-text);
		font: 400 calc(17px * var(--w-fs)) / calc(24px * var(--w-fs)) var(--w-sans);
		caret-color: var(--w-accent);
	}
	.jump__input::placeholder {
		color: var(--w-faint);
		opacity: 1;
	}
	/* The dialog itself shows where focus is: the caret in an always-focused field. */
	.jump__input:focus-visible {
		outline: 0;
	}
	.jump__close {
		display: none;
	}

	/* ---- scope row 40 */
	.jump__scopes {
		display: flex;
		flex: none;
		align-items: center;
		gap: 4px;
		height: 40px;
		padding: 0 12px;
		border-bottom: var(--w-bw) solid var(--w-line);
		overflow-x: auto;
		scrollbar-width: none;
	}
	.jump__scopes::-webkit-scrollbar {
		display: none;
	}
	.jump__scope {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 6px;
		height: 28px;
		padding: 0 10px;
		border: 0;
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--w-mute);
		font: var(--w-t-label-sm);
		white-space: nowrap;
		cursor: pointer;
		transition:
			background-color var(--w-dur-1) var(--w-ease),
			color var(--w-dur-1) var(--w-ease);
	}
	.jump__scope:hover {
		background: color-mix(in srgb, var(--w-raise) 70%, transparent);
		color: var(--w-text);
	}
	/* Selected scope is a paper key (§5.2), never an accent fill. */
	.jump__scope[aria-pressed='true'] {
		background: var(--w-bg);
		color: var(--w-text);
		box-shadow:
			0 0 0 var(--w-bw) var(--w-line-strong),
			var(--w-shadow-1);
	}
	:global(:root[data-mode='light']) .jump__scope[aria-pressed='true'] {
		background: var(--w-lift);
	}
	.jump__prefix {
		min-width: 18px;
		justify-content: center;
		padding: 0 4px;
	}
	:global(:root[data-char='contrast']) .jump__scope:hover {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}

	/* ---- results */
	.jump__body {
		flex: 1 1 auto;
		min-height: 0;
		max-height: min(452px, calc(100dvh - 12vh - 24px - 56px - 40px - 36px));
		padding: 4px 8px 8px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.jump__group + .jump__group,
	.jump__list:not(:empty) + .jump__group {
		margin-top: 4px;
	}
	.jump__kicker {
		display: block;
		padding: 12px 10px 4px;
	}
	.jump__row {
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 12px;
		box-sizing: border-box;
		min-height: 44px;
		padding: 4px 10px;
		border-radius: var(--radius-inner);
		cursor: pointer;
		transition: background-color var(--w-dur-1) var(--w-ease);
	}
	.jump__row[aria-selected='true'] {
		background: var(--w-raise);
	}
	:global(:root[data-char='contrast']) .jump__row[aria-selected='true'] {
		box-shadow: inset 0 0 0 1px var(--w-line-strong);
	}

	.jump__tile {
		display: inline-grid;
		place-items: center;
		box-sizing: border-box;
		width: 28px;
		height: 28px;
		border: var(--w-bw) solid var(--w-line);
		border-radius: var(--radius-inner);
		color: var(--w-mute);
	}
	.jump__glyph {
		font: 500 calc(16px * var(--w-fs)) / 1 var(--w-sans);
	}
	.jump__row[aria-selected='true'] .jump__tile {
		border-color: var(--w-line-strong);
		color: var(--w-text);
	}
	/* Where you are: the glyph in --w-sig (§5.1). */
	.jump__row.is-current .jump__tile {
		color: var(--w-sig);
	}

	/* Avatar stamp (§7.12): serif initial at 28px on the person's disc. */
	.jump__av {
		position: relative;
		display: inline-grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: var(--w-avr);
		background: var(--disc, var(--w-raise));
		color: var(--on, var(--w-mute));
		font: 600 calc(12px * var(--w-fs)) / 1 var(--w-serif);
	}
	.jump__av img {
		width: 100%;
		height: 100%;
		border-radius: inherit;
		object-fit: cover;
	}
	.jump__presence {
		position: absolute;
		right: -2px;
		bottom: -2px;
		box-sizing: border-box;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--w-online);
		box-shadow: 0 0 0 2px var(--w-bg2);
	}
	:global(:root[data-mode='light']) .jump__presence {
		box-shadow: 0 0 0 2px var(--w-lift);
	}
	.jump__row[aria-selected='true'] .jump__presence {
		box-shadow: 0 0 0 2px var(--w-raise);
	}
	.jump__presence[data-presence='away'] {
		background: var(--w-warn);
	}
	.jump__presence[data-presence='busy'] {
		background: var(--w-danger);
	}
	.jump__presence[data-presence='offline'] {
		border: 1.5px solid var(--w-faint);
		background: var(--w-bg2);
	}
	:global(:root[data-mode='light']) .jump__presence[data-presence='offline'] {
		background: var(--w-lift);
	}

	.jump__text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.jump__title,
	.jump__sub {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.jump__title {
		color: var(--w-text);
		font: var(--w-t-label);
	}
	/* Matched characters: 700 with a 1.5px accent underline (§7.24). */
	.jump__title mark {
		background: none;
		color: inherit;
		font-weight: 700;
		text-decoration: underline;
		text-decoration-color: var(--w-accent);
		text-decoration-thickness: 1.5px;
		text-underline-offset: 3px;
		text-decoration-skip-ink: none;
	}
	.jump__sub {
		color: var(--w-faint);
		font: var(--w-t-mono);
	}

	.jump__truths {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		min-width: 0;
	}
	.jump__hint {
		color: var(--w-faint);
		font: var(--w-t-micro);
		white-space: nowrap;
	}

	/* ---- states */
	.jump__row--skel {
		cursor: default;
	}
	.jump__skel-tile {
		width: 28px;
		height: 28px;
		border-radius: var(--radius-inner);
	}
	.jump__skel-text {
		gap: 6px;
	}
	.jump__skel-title {
		width: 46%;
	}
	.jump__skel-sub {
		width: 28%;
		height: 8px;
	}
	.jump__empty,
	.jump__note {
		margin: 0;
		padding: 20px 10px 16px;
		color: var(--w-mute);
		font: var(--w-t-ui);
	}
	.jump__note {
		padding: 8px 10px;
		color: var(--w-faint);
		font: var(--w-t-small);
	}

	/* ---- footer 36 */
	.jump__foot {
		display: flex;
		flex: none;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		height: 36px;
		padding: 0 16px;
		border-top: var(--w-bw) solid var(--w-line);
		background: var(--w-bg2);
		color: var(--w-faint);
		font: var(--w-t-micro);
	}
	.jump__hints {
		display: inline-flex;
		align-items: center;
		gap: 14px;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
	}
	.jump__hint-pair {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.jump__count {
		flex: none;
		white-space: nowrap;
	}

	.jump__sr {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
		border: 0;
		white-space: nowrap;
	}

	/* ---- phones: the whole screen, 44px targets, no keyboard legends (§8.12) */
	@media (max-width: 599px) {
		.jump {
			top: 0;
			width: 100%;
			height: 100dvh;
			max-height: none;
			border: 0;
			border-radius: 0;
			box-shadow: none;
			padding-top: env(safe-area-inset-top, 0px);
			animation-name: w-enter-up;
		}
		.jump__head {
			gap: 8px;
			padding: 0 4px 0 16px;
		}
		.jump__esc {
			display: none;
		}
		.jump__close {
			display: inline-grid;
			flex: none;
			width: 44px;
			height: 44px;
		}
		.jump__scopes {
			height: 48px;
			padding: 0 12px;
			mask-image: linear-gradient(to right, var(--w-text) calc(100% - 24px), transparent);
		}
		.jump__scopes::after {
			content: '';
			flex: none;
			width: 12px;
		}
		.jump__scope {
			height: 36px;
		}
		.jump__body {
			max-height: none;
			padding: 4px 8px 12px;
		}
		.jump__row {
			min-height: 52px;
		}
		.jump__hints {
			display: none;
		}
		.jump__foot {
			justify-content: flex-end;
			height: calc(36px + env(safe-area-inset-bottom, 0px));
			padding-bottom: env(safe-area-inset-bottom, 0px);
		}
	}
	@media (pointer: coarse) {
		.jump__esc {
			display: none;
		}
		.jump__close {
			display: inline-grid;
			flex: none;
			width: 44px;
			height: 44px;
		}
	}

	@media (forced-colors: active) {
		.jump__row[aria-selected='true'] {
			outline: 2px solid Highlight;
			outline-offset: -2px;
		}
		.jump__title mark {
			text-decoration-color: Highlight;
		}
	}
</style>
