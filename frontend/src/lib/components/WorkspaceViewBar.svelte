<!--
	The folio: workspace navigation in masthead row B (design contract §7.10, §8.2, §8.12).

	Desktop and tablet (`variant="folio"`):
	- Labelled words only, in groups divided by 16px hairlines: this channel (Chat, named by the
	  channel kind: Chat / Threads / Wiki / Gallery; Files; Whiteboard), community (Calls,
	  Activity with its ink "needs you" count, Project), yours (My Planner, Notes), office
	  (Documents, Sheets, Present, then one PREVIEW tag). Sheets and Present appear only when the
	  add-on is on for this device.
	- Active = --w-text + a 2px --w-sig underline on the masthead rule. Hover changes colour only:
	  tabs never grow, never scroll and never move; the row is the same in every workspace.
	- Tiers are container queries on the stage (stagebar.css, `@container stage`): ≥1000 all;
	  880–999 Whiteboard and Project go to More; 700–879 also Files, Sheets and Present;
	  <700 also Activity and Notes (and <560, a guard for tablets, the office group). More ▾ (right-aligned) lists exactly what the bar does not
	  show, with kicker groups, a --w-sig check on the current view, hints ("preview",
	  "off on this device") and a "Pin to bar" group. When the current view lives in More, More
	  carries the underline.
	- role=tablist with a roving tabindex: ←/→ move, Home/End jump, Enter/Space open. Each tab has a
	  tooltip with its detail line. Right-click (or the context-menu key): Open · Open beside
	  (views with a companion panel) · Remove from bar / Pin to bar. Bar choices are kept per
	  server in this browser.

	Phone shell, ≤768px (`variant="trigger"`): one "Chat ▾" button that opens the Workspaces
	sheet (kicker groups, one-line details, "off on this device"), never a scrolling strip.
-->
<script module lang="ts">
	import type { WorkspaceViewKey } from './chat/types';

	export type FolioGroupId = 'channel' | 'community' | 'yours' | 'office';
	/** 560 is a guard below the contract's tiers: a stage that narrow (a tablet before its sidebar
	 *  folds to the compact rail) moves the office group to More rather than clip the row. */
	export type FolioTier = 0 | 560 | 700 | 880 | 1000;

	export interface FolioView {
		id: WorkspaceViewKey;
		group: FolioGroupId;
		/** Stage width below which the view leaves the bar for More (0: never). */
		tier: FolioTier;
		/** On the bar unless the person removed it; the others live in More until pinned. */
		bar: boolean;
		preview?: boolean;
		addon?: 'sheets' | 'present';
	}

	/** Bar order is this order. A view pinned from More collapses first (tier 1000). */
	export const FOLIO_VIEWS: readonly FolioView[] = Object.freeze([
		{ id: 'messages', group: 'channel', tier: 0, bar: true },
		{ id: 'files', group: 'channel', tier: 880, bar: true },
		{ id: 'whiteboard', group: 'channel', tier: 1000, bar: true },
		{ id: 'media', group: 'channel', tier: 1000, bar: false },
		{ id: 'voice', group: 'community', tier: 0, bar: true },
		{ id: 'notifications', group: 'community', tier: 700, bar: true },
		{ id: 'lore', group: 'community', tier: 1000, bar: true },
		{ id: 'map', group: 'community', tier: 1000, bar: false },
		{ id: 'planner', group: 'yours', tier: 0, bar: true },
		{ id: 'notes', group: 'yours', tier: 700, bar: true },
		{ id: 'reader', group: 'yours', tier: 1000, bar: false },
		{ id: 'model', group: 'yours', tier: 1000, bar: false },
		{ id: 'documents', group: 'office', tier: 560, bar: true, preview: true },
		{ id: 'sheets', group: 'office', tier: 880, bar: true, preview: true, addon: 'sheets' },
		{ id: 'present', group: 'office', tier: 880, bar: true, preview: true, addon: 'present' }
	] satisfies FolioView[]);

	export const FOLIO_GROUPS: readonly FolioGroupId[] = Object.freeze(['channel', 'community', 'yours', 'office']);

	/** The person's bar choices: views pinned from More, default views removed from the bar. */
	export type FolioChoices = { pinned: WorkspaceViewKey[]; removed: WorkspaceViewKey[] };

	/** Views on the bar for these choices (Chat can never leave it). */
	export function folioBarIds(choices: FolioChoices, addons: { sheets: boolean; present: boolean }): WorkspaceViewKey[] {
		return FOLIO_VIEWS.filter((view) => {
			if (view.addon && !addons[view.addon]) return false;
			if (view.id === 'messages') return true;
			return view.bar ? !choices.removed.includes(view.id) : choices.pinned.includes(view.id);
		}).map((view) => view.id);
	}

	const STORAGE_PREFIX = 'wabi:folio-bar:v1:';
	const KNOWN = new Set<string>(FOLIO_VIEWS.map((view) => view.id));

	export function readFolioChoices(server: string): FolioChoices {
		try {
			const parsed = JSON.parse(localStorage.getItem(STORAGE_PREFIX + server) || 'null');
			const pick = (value: unknown) =>
				Array.isArray(value) ? (value.filter((id) => typeof id === 'string' && KNOWN.has(id)) as WorkspaceViewKey[]) : [];
			return { pinned: pick(parsed?.pinned), removed: pick(parsed?.removed) };
		} catch {
			return { pinned: [], removed: [] };
		}
	}

	function writeFolioChoices(server: string, choices: FolioChoices): void {
		try {
			localStorage.setItem(STORAGE_PREFIX + server, JSON.stringify(choices));
		} catch {
			// A preference that cannot be stored lasts for this session only.
		}
	}
</script>

<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { _ } from '$lib/i18n';
	import { activeServerUrl } from '$lib/serverUrl';
	import { hydrateWorkspaceAddons, workspaceAddonEnabled } from '$lib/workspaces/addonState';
	import { openRightPanel } from '$lib/layoutStoreRightPanel';
	import type { WorkspacePanelId } from '$lib/docking/layoutSchema';
	import ContextMenu, { type MenuAnchor, type MenuEntry } from './context-menu/ContextMenu.svelte';
	import Menu from './ui/Menu.svelte';
	import Icon from './ui/Icon.svelte';
	import Sheet from './ui/Sheet.svelte';
	import Tooltip from './ui/Tooltip.svelte';

	let {
		activeView,
		onSelectView,
		canOpenWhiteboard = true,
		activityBadge = '',
		channelKind = 'text',
		variant = 'folio'
	}: {
		activeView: WorkspaceViewKey;
		onSelectView: (view: WorkspaceViewKey) => void;
		canOpenWhiteboard?: boolean;
		activityBadge?: string;
		/** The current channel's kind names the Chat tab (Threads, Wiki, Gallery). */
		channelKind?: string | null;
		variant?: 'folio' | 'trigger';
	} = $props();

	// ---------------------------------------------------------------- words
	function labelOf(id: WorkspaceViewKey): string {
		switch (id) {
			case 'messages':
				return channelKind === 'forum'
					? $_('places.threads')
					: channelKind === 'wiki'
						? $_('places.wiki')
						: channelKind === 'gallery'
							? $_('places.gallery')
							: $_('places.chat');
			case 'files': return $_('places.files');
			case 'whiteboard': return $_('places.whiteboard');
			case 'voice': return $_('places.calls');
			case 'notifications': return $_('places.activity');
			case 'lore': return $_('places.project');
			case 'planner': return $_('places.my_planner');
			case 'notes': return $_('places.notes');
			case 'documents': return $_('places.documents');
			case 'sheets': return $_('places.sheets');
			case 'present': return $_('places.present');
			case 'media': return $_('places.media');
			case 'reader': return $_('places.reader');
			case 'model': return $_('places.model_viewer');
			case 'map': return $_('places.map');
		}
	}

	// Detail lines for tooltips, menus and the phone sheet (§7.10: "Documents · private until you share · preview").
	const DETAIL: Partial<Record<WorkspaceViewKey, string>> = {
		messages: 'the conversation in this channel',
		files: 'browse files & transfers',
		whiteboard: 'a canvas for this channel',
		voice: 'voice, video & sharing',
		notifications: 'alerts, follows & friends',
		lore: 'shared plan, wiki & optional files',
		planner: 'personal tasks, journal & calendar',
		notes: 'your personal notes',
		media: 'photos & albums',
		reader: 'documents & reading',
		model: 'explore 3D models',
		map: 'places & directions'
	};

	function detailOf(id: WorkspaceViewKey): string {
		return DETAIL[id] ?? '';
	}

	function tooltipOf(view: FolioView): string {
		if (view.id === 'documents') return $_('folio.detail.documents');
		if (view.id === 'sheets') return $_('folio.detail.sheets');
		if (view.id === 'present') return $_('folio.detail.present');
		return `${labelOf(view.id)} · ${detailOf(view.id)}`;
	}

	function groupLabel(group: FolioGroupId): string {
		switch (group) {
			case 'channel': return $_('folio.groups.this_channel');
			case 'community': return $_('folio.groups.community');
			case 'yours': return $_('folio.groups.yours');
			case 'office': return $_('folio.groups.office');
		}
	}

	const needsYou = $derived(
		activityBadge
			? activityBadge === '1'
				? $_('folio.needs_you_one', { values: { count: activityBadge } })
				: $_('folio.needs_you_many', { values: { count: activityBadge } })
			: ''
	);

	// ---------------------------------------------------------------- bar membership
	let server = $state('');
	let choices = $state<FolioChoices>({ pinned: [], removed: [] });
	$effect(() => {
		const next = $activeServerUrl || '';
		if (next === server) return;
		server = next;
		choices = readFolioChoices(next);
	});

	onMount(() => {
		// Sheets and Present join the bar only once the device's add-on state is known.
		void hydrateWorkspaceAddons().catch(() => {});
	});

	const addons = $derived($workspaceAddonEnabled);
	const barIds = $derived(folioBarIds(choices, addons));
	const barViews = $derived(FOLIO_VIEWS.filter((view) => barIds.includes(view.id)));
	const barGroups = $derived(
		FOLIO_GROUPS.map((group) => {
			const views = barViews.filter((view) => view.group === group);
			// A pinned view collapses first; the group stays while any of its tabs is shown.
			const tiers = views.map((view) => (view.bar ? view.tier : 1000));
			return { id: group, views, tier: tiers.length ? Math.min(...tiers) : 1000 };
		}).filter((group) => group.views.length > 0)
	);
	const tierOf = (view: FolioView): FolioTier => (view.bar ? view.tier : 1000);

	function saveChoices(next: FolioChoices): void {
		choices = next;
		writeFolioChoices(server, next);
	}

	function setOnBar(id: WorkspaceViewKey, onBar: boolean): void {
		const view = FOLIO_VIEWS.find((entry) => entry.id === id);
		if (!view || id === 'messages') return;
		const pinned = choices.pinned.filter((entry) => entry !== id);
		const removed = choices.removed.filter((entry) => entry !== id);
		if (view.bar && !onBar) removed.push(id);
		if (!view.bar && onBar) pinned.push(id);
		saveChoices({ pinned, removed });
	}

	// ---------------------------------------------------------------- what the bar hides at this width
	let root = $state<HTMLElement | null>(null);
	let hiddenByTier = $state<WorkspaceViewKey[]>([]);

	function measureHidden(): void {
		if (!root) return;
		const hidden: WorkspaceViewKey[] = [];
		for (const tab of root.querySelectorAll<HTMLElement>('[role="tab"][data-view]')) {
			if (!tab.getClientRects().length) hidden.push(tab.dataset.view as WorkspaceViewKey);
		}
		if (hidden.join() !== hiddenByTier.join()) hiddenByTier = hidden;
	}

	$effect(() => {
		const element = root;
		void barIds;
		if (!element) return;
		untrack(measureHidden);
		if (typeof ResizeObserver === 'undefined') return;
		// Runs after layout, so the container-query tiers have already applied.
		const observer = new ResizeObserver(() => measureHidden());
		observer.observe(element);
		return () => observer.disconnect();
	});

	const shownIds = $derived(barIds.filter((id) => !hiddenByTier.includes(id)));
	const inMore = $derived(FOLIO_VIEWS.filter((view) => !shownIds.includes(view.id)));
	const currentInMore = $derived(!shownIds.includes(activeView));
	// Activity's count stays in sight when a narrow stage moves Activity into More.
	const activityInMore = $derived(Boolean(activityBadge) && !shownIds.includes('notifications'));
	const moreLabel = $derived(
		[
			$_('folio.more'),
			currentInMore ? `${labelOf(activeView)} is open` : '',
			activityInMore ? `${$_('places.activity')} ${needsYou}` : ''
		].filter(Boolean).join(', ')
	);

	// ---------------------------------------------------------------- selection and keyboard
	function disabled(id: WorkspaceViewKey): boolean {
		return id === 'whiteboard' && !canOpenWhiteboard;
	}

	function select(id: WorkspaceViewKey): void {
		if (disabled(id)) return;
		onSelectView(id);
	}

	let focusId = $state<WorkspaceViewKey | null>(null);
	const rovingId = $derived(
		focusId && shownIds.includes(focusId) ? focusId : shownIds.includes(activeView) ? activeView : (shownIds[0] ?? 'messages')
	);

	function visibleTabs(): HTMLElement[] {
		return Array.from(root?.querySelectorAll<HTMLElement>('[role="tab"][data-view]') ?? []).filter((tab) => tab.getClientRects().length > 0);
	}

	function onTabKeydown(event: KeyboardEvent): void {
		const tabs = visibleTabs();
		const index = tabs.indexOf(event.target as HTMLElement);
		if (index < 0) return;
		let next = -1;
		if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
		else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = tabs.length - 1;
		if (next < 0) return;
		event.preventDefault();
		const target = tabs[next];
		focusId = (target.dataset.view as WorkspaceViewKey) ?? null;
		target.focus();
	}

	// ---------------------------------------------------------------- right-click menu
	const COMPANION: Partial<Record<WorkspaceViewKey, WorkspacePanelId>> = { notes: 'notes' };
	function companionOf(id: WorkspaceViewKey): WorkspacePanelId | null {
		if (id === 'messages' && (channelKind === 'wiki' || channelKind === 'forum')) return channelKind;
		return COMPANION[id] ?? null;
	}

	let tabMenu = $state<{ view: FolioView; x: number; y: number; anchor: MenuAnchor | null } | null>(null);

	function openTabMenu(event: MouseEvent, view: FolioView): void {
		event.preventDefault();
		const target = event.currentTarget as HTMLElement;
		// The context-menu key reports no pointer position: open under the tab instead.
		const fromKeyboard = event.button !== 2 && event.clientX === 0 && event.clientY === 0;
		const box = target.getBoundingClientRect();
		tabMenu = {
			view,
			x: event.clientX,
			y: event.clientY,
			anchor: fromKeyboard ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom } : null
		};
	}

	const tabMenuItems = $derived.by<MenuEntry[]>(() => {
		if (!tabMenu) return [];
		const { view } = tabMenu;
		const companion = companionOf(view.id);
		const items: MenuEntry[] = [
			{ id: 'open', label: $_('folio.open'), icon: 'arrowRight', disabled: disabled(view.id), onSelect: () => select(view.id) }
		];
		if (companion) items.push({ id: 'beside', label: $_('folio.open_beside'), icon: 'sidebarRight', onSelect: () => openRightPanel(companion) });
		if (view.id !== 'messages') {
			items.push({ id: 'sep', type: 'separator' });
			items.push({ id: 'remove', label: $_('folio.remove_from_bar'), icon: 'minus', onSelect: () => setOnBar(view.id, false) });
		}
		return items;
	});

	// ---------------------------------------------------------------- More ▾
	let moreOpen = $state(false);

	function hintOf(view: FolioView): string | undefined {
		if (view.id === 'notifications' && activityBadge) return needsYou;
		if (view.addon && !addons[view.addon]) return $_('maturity.off_on_device');
		if (view.preview) return $_('maturity.preview_hint');
		return undefined;
	}

	const moreItems = $derived.by<MenuEntry[]>(() => {
		const items: MenuEntry[] = [];
		for (const group of FOLIO_GROUPS) {
			const views = inMore.filter((view) => view.group === group);
			if (!views.length) continue;
			items.push({ id: `k-${group}`, type: 'kicker', label: groupLabel(group) });
			for (const view of views) {
				items.push({
					id: view.id,
					label: labelOf(view.id),
					keepCase: true,
					role: 'menuitemradio',
					checked: view.id === activeView,
					hint: hintOf(view),
					disabled: disabled(view.id),
					onSelect: () => select(view.id)
				});
			}
		}
		// Bar choices: the views the person can add to (or take off) the bar.
		const customizable = FOLIO_VIEWS.filter((view) => view.id !== 'messages' && !(view.addon && !addons[view.addon]) && (!view.bar || choices.removed.includes(view.id)));
		if (customizable.length) {
			items.push({ id: 'k-pin', type: 'kicker', label: $_('folio.pin_to_bar') });
			for (const view of customizable) {
				const onBar = barIds.includes(view.id);
				items.push({
					id: `pin-${view.id}`,
					label: labelOf(view.id),
					icon: 'pin',
					keepCase: true,
					role: 'menuitemcheckbox',
					checked: onBar,
					keepOpen: true,
					onSelect: () => setOnBar(view.id, !onBar)
				});
			}
		}
		return items;
	});

	// ---------------------------------------------------------------- phone: Workspaces sheet
	let sheetOpen = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	const SIDE_PANELS: { id: WorkspacePanelId; label: () => string; detail: string }[] = [
		{ id: 'users', label: () => $_('places.people'), detail: 'who is here, by place' },
		{ id: 'wiki', label: () => $_('places.wiki'), detail: 'read this community’s pages' },
		{ id: 'forum', label: () => $_('places.forum'), detail: 'longer conversations' }
	];

	function chooseFromSheet(id: WorkspaceViewKey): void {
		if (disabled(id)) return;
		sheetOpen = false;
		select(id);
	}

	async function openSidePanel(id: WorkspacePanelId): Promise<void> {
		sheetOpen = false;
		await tick();
		openRightPanel(id);
	}
</script>

{#if variant === 'trigger'}
	<button
		bind:this={trigger}
		type="button"
		class="w-folio-trigger"
		aria-haspopup="dialog"
		aria-expanded={sheetOpen}
		aria-label={`${labelOf(activeView)}: ${$_('folio.label')}`}
		onclick={() => (sheetOpen = true)}
	>
		<!-- No count here: next to "Chat" it would read as unread chat; the bottom nav and the sheet carry Activity's. -->
		<span class="w-folio-trigger__label">{labelOf(activeView)}</span>
		<Icon name="chevDown" size={14} />
	</button>
	<Sheet bind:open={sheetOpen} title={$_('folio.label')} zIndex="calc(var(--z-toast, 2000) + 1)" onclose={() => trigger?.focus({ preventScroll: true })}>
		{#each FOLIO_GROUPS as group (group)}
			<p class="w-kicker w-folio-sheet__kicker">{group === 'office' ? `${groupLabel(group)} · ${$_('maturity.preview')}` : groupLabel(group)}</p>
			{#each FOLIO_VIEWS.filter((view) => view.group === group) as view (view.id)}
				<button
					type="button"
					class="w-sheet__row w-folio-sheet__row"
					aria-current={activeView === view.id ? 'page' : undefined}
					aria-disabled={disabled(view.id) || undefined}
					onclick={() => chooseFromSheet(view.id)}
				>
					<span class="w-folio-sheet__words">
						<span class="w-folio-sheet__label">{labelOf(view.id)}{#if view.id === 'notifications' && activityBadge}<span class="w-badge w-badge--sm" aria-hidden="true">{activityBadge}</span><span class="sr-only">, {needsYou}</span>{/if}</span>
						<span class="w-folio-sheet__detail">{view.addon && !addons[view.addon] ? $_('maturity.off_on_device') : view.preview ? $_('folio.detail.' + view.id) : detailOf(view.id)}</span>
					</span>
					{#if activeView === view.id}<Icon name="check" size={16} class="w-folio-sheet__check" />{/if}
				</button>
			{/each}
		{/each}
		<p class="w-kicker w-folio-sheet__kicker">{$_('folio.groups.side_panels')}</p>
		{#each SIDE_PANELS as panel (panel.id)}
			<button type="button" class="w-sheet__row w-folio-sheet__row" onclick={() => void openSidePanel(panel.id)}>
				<span class="w-folio-sheet__words">
					<span class="w-folio-sheet__label">{panel.label()}</span>
					<span class="w-folio-sheet__detail">{panel.detail}</span>
				</span>
			</button>
		{/each}
	</Sheet>
{:else}
	<nav class="w-folio" aria-label={$_('folio.label')} bind:this={root}>
		<div class="w-folio__tabs" role="tablist" aria-label={$_('folio.label')} aria-orientation="horizontal" tabindex="-1" onkeydown={onTabKeydown}>
			{#each barGroups as group (group.id)}
				<div class="w-folio__group" role="none" data-group={group.id} data-tier={group.tier}>
					{#each group.views as view (view.id)}
						<Tooltip text={tooltipOf(view)} placement="bottom">
							<button
								type="button"
								role="tab"
								class="w-folio__tab"
								data-view={view.id}
								data-tier={tierOf(view)}
								aria-selected={activeView === view.id}
								aria-current={activeView === view.id ? 'page' : undefined}
								aria-disabled={disabled(view.id) || undefined}
								tabindex={rovingId === view.id ? 0 : -1}
								onfocus={() => (focusId = view.id)}
								onclick={() => select(view.id)}
								oncontextmenu={(event) => openTabMenu(event, view)}
							>
								<span class="w-folio__label">{labelOf(view.id)}</span>
								{#if view.id === 'notifications' && activityBadge}
									<span class="w-badge w-badge--sm" aria-hidden="true">{activityBadge}</span>
									<span class="sr-only">, {needsYou}</span>
								{/if}
							</button>
						</Tooltip>
					{/each}
					{#if group.id === 'office'}
						<!-- The office tabs' descriptions say "preview" to assistive tech; the tag is the visible word. -->
						<span class="w-tag w-tag--mat w-folio__mat" aria-hidden="true" title={$_('maturity.preview_title')}>{$_('maturity.preview')}</span>
					{/if}
				</div>
			{/each}
		</div>
		<span class="w-folio__more-wrap">
			<Menu
				label={$_('folio.more')}
				class="w-folio__more"
				align="end"
				items={moreItems}
				bind:open={moreOpen}
				data-current={currentInMore ? 'true' : undefined}
				triggerLabel={currentInMore || activityInMore ? moreLabel : undefined}
			>
				<span class="w-folio__label">{$_('folio.more')}</span>
				{#if activityInMore}<span class="w-badge w-badge--sm" aria-hidden="true">{activityBadge}</span>{/if}
				<Icon name="chevDown" size={14} />
			</Menu>
		</span>
		{#if tabMenu}
			<ContextMenu
				open
				x={tabMenu.x}
				y={tabMenu.y}
				anchor={tabMenu.anchor}
				items={tabMenuItems}
				ariaLabel={labelOf(tabMenu.view.id)}
				headerLabel={labelOf(tabMenu.view.id)}
				onClose={() => (tabMenu = null)}
			/>
		{/if}
	</nav>
{/if}
