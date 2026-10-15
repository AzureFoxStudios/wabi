<!--
	The one menu (design contract §7.4, §8.9): right-click menus and button menus (ui/Menu.svelte,
	ui/Select.svelte) all render through this component, on the kit `.w-menu`.

	- Portaled to <body> (or the fullscreen element) and placed with `position: fixed`, so no
	  scroller or transformed dock can clip it. At a point (right-click) it opens down-right and
	  flips left/up at the viewport edge; at an `anchor` rect (a trigger button) it opens below and
	  flips above when there is more room there. It never leaves an 8px viewport margin.
	- Under (max-width: 768px) it opens as a bottom sheet (`.w-scrim` + `.w-sheet`) with 52px rows.
	- role=menu with role=menuitem / menuitemradio / menuitemcheckbox rows, a roving tabindex,
	  ↑/↓, Home/End, typeahead, Esc (focus returns to the opener) and Tab (closes). Disabled rows
	  stay focusable (aria-disabled) so their hint can be read, but cannot be activated.
	- Grammar: a reserved 16px icon slot, sentence-case labels, kicker groups, hairline separators,
	  danger rows always last, a seal glyph for moderation rows, a trailing check / shortcut /
	  maturity tag / hint word. A hint longer than a word drops to a second line instead of
	  widening the menu.

	Items are `ContextMenuItem`s ($lib/context-menu/types) or the richer `MenuEntry` below.
	Legacy text glyphs in `leading` (★ ! ≈ ▸ ● ◦ …) are mapped to registry icons, radio rows or
	kickers here; new callers pass `icon` (any registry name) and the structured fields instead.
-->
<script module lang="ts">
	import type { ContextMenuIcon, ContextMenuItem } from '$lib/context-menu/types';
	import { isIconName, type IconName } from '$lib/components/ui/icons';

	export type MenuEntry = Omit<ContextMenuItem, 'type' | 'icon'> & {
		/** 'kicker' starts a labelled group (rendered as the uppercase mono group label). */
		type?: 'action' | 'separator' | 'kicker';
		/** A registry icon name, or one of the legacy ContextMenuIcon names. */
		icon?: ContextMenuIcon | IconName;
		role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
		/** Checked state for menuitemradio / menuitemcheckbox rows (draws the --w-sig check). */
		checked?: boolean;
		/** Moderation rows (kick, ban, permissions): the glyph is drawn in --w-seal. */
		seal?: boolean;
		/** Keyboard shortcut shown in micro type at the end of the row ("Ctrl K"). */
		shortcut?: string;
		/** Maturity word shown as a `.w-tag--mat` ("PREVIEW"); `tagTitle` explains it. */
		tag?: string;
		tagTitle?: string;
		/** The label is user data (a name, a folder): never sentence-case it. */
		keepCase?: boolean;
	};

	export type MenuAnchor = { left: number; top: number; right: number; bottom: number };

	type Row = {
		key: string;
		source: MenuEntry;
		label: string;
		icon: IconName | null;
		role: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
		checked: boolean | undefined;
		hint: string | null;
		hintBelow: boolean;
		shortcut: string | null;
		tag: string | null;
		tagTitle: string | null;
		danger: boolean;
		seal: boolean;
		disabled: boolean;
		nav: number;
	};

	type Group = { key: string; kicker: string | null; rule: boolean; rows: Row[] };

	const LEGACY_ICONS: Record<ContextMenuIcon, IconName | null> = {
		'message-circle': 'chat',
		phone: 'phone',
		video: 'video',
		monitor: 'screen',
		user: 'user',
		pin: 'pin',
		settings: 'gear',
		'trash-2': 'trash',
		smile: 'smilePlus',
		download: 'download',
		forward: 'forward',
		edit: 'pencil',
		copy: 'copy',
		'credit-card': null,
		archive: 'box',
		'archive-restore': 'undo',
		banknote: null,
		'log-out': 'logout',
		languages: 'globe',
		'external-window': 'externalLink'
	};

	/** Legacy text glyphs callers put in `leading`; chrome never shows the glyph itself (§2.6). */
	const LEADING_ICONS: Record<string, IconName> = {
		'★': 'star',
		'☆': 'star',
		'!': 'bell',
		'≈': 'list',
		'▣': 'expand',
		'▥': 'sidebarRight',
		'⧉': 'externalLink',
		'✎': 'pencil',
		'✕': 'x',
		'×': 'x'
	};
	const RADIO_ON = new Set(['●', '◉', '✓', '✔']);
	const RADIO_OFF = new Set(['◦', '○', '◯']);
	const KICKER_GLYPHS = new Set(['▸', '▾', '›', '»']);

	/**
	 * UI words that legacy Title Case / ALL CAPS labels use ("Follow Channel With Alerts",
	 * "DELETE MESSAGE + UPLOADS"). Only these are re-cased, so names, acronyms (DM, OS) and place
	 * names that keep their capital (Documents, Notes, Calls, People, Lore…) are never touched.
	 */
	const UI_WORDS = new Set(
		(
			'a add alert alerts album all an and as at audio back block bookmark bookmarks breakout by call ' +
			'camera categories category change channel channels clear close code conversation conversations ' +
			'copy create cycle delete details direct download duplicate edit emoji end event export feed file ' +
			'files floating folder follow for forward from group groups hide history image import in info ' +
			'invite join kick leave level link local locally main mark member members mention message ' +
			'messages microphone move mute name new note of off on open or panel password payment ' +
			'permissions pin pinned profile quick quote reaction reactions read remove rename reply report ' +
			'request ringing role roles room rooms screen send server settings share show side silent start ' +
			'status stop text the thread threads to top translate unblock unfollow unmute unpin unread ' +
			'upload uploads user video view voice window with'
		).split(' ')
	);

	/** Sentence case for chrome labels (§9.6), touching only known UI words. */
	export function sentenceCaseLabel(label: string): string {
		let index = 0;
		return label.replace(/[A-Za-z]+/g, (word) => {
			const first = index === 0;
			index += 1;
			const lower = word.toLowerCase();
			if (!UI_WORDS.has(lower)) return word;
			const titled = word[0] === word[0].toUpperCase() && word.slice(1) === word.slice(1).toLowerCase();
			const shouted = word.length > 1 && word === word.toUpperCase();
			if (!titled && !shouted) return word;
			return first ? lower[0].toUpperCase() + lower.slice(1) : lower;
		});
	}

	function iconFor(entry: MenuEntry): IconName | null {
		if (entry.icon) {
			if (isIconName(entry.icon)) return entry.icon;
			return LEGACY_ICONS[entry.icon as ContextMenuIcon] ?? null;
		}
		const glyph = entry.leading?.trim();
		return glyph ? LEADING_ICONS[glyph] ?? null : null;
	}

	/**
	 * Turns caller items into labelled groups: hidden rows dropped, legacy glyphs mapped, kickers
	 * recognised, danger rows moved into a last group of their own, empty groups and stray
	 * separators removed. `nav` is each row's position in arrow-key order.
	 */
	export function arrangeMenu(items: MenuEntry[]): Group[] {
		const groups: Group[] = [];
		const danger: Row[] = [];
		let current: Group = { key: 'g0', kicker: null, rule: false, rows: [] };
		let pendingRule = false;
		const flush = () => {
			if (current.rows.length) groups.push(current);
		};
		for (const entry of items) {
			if (!entry || entry.hidden) continue;
			const glyph = entry.leading?.trim() ?? '';
			if (entry.type === 'separator') {
				flush();
				pendingRule = true;
				current = { key: `g-${entry.id}`, kicker: null, rule: true, rows: [] };
				continue;
			}
			const legacyKicker = KICKER_GLYPHS.has(glyph) && !entry.onSelect;
			if (entry.type === 'kicker' || legacyKicker) {
				flush();
				current = { key: `g-${entry.id}`, kicker: entry.label ?? '', rule: pendingRule, rows: [] };
				pendingRule = false;
				continue;
			}
			pendingRule = false;
			const radioOn = RADIO_ON.has(glyph);
			const radioOff = RADIO_OFF.has(glyph);
			const role = entry.role ?? (radioOn || radioOff ? 'menuitemradio' : 'menuitem');
			const checked = role === 'menuitem' ? undefined : entry.checked ?? radioOn;
			const userData = entry.keepCase || role === 'menuitemradio' || /^[#@]/.test(entry.label ?? '');
			const label = entry.label ?? '';
			const hint = entry.hint?.trim() || null;
			const row: Row = {
				key: entry.id,
				source: entry,
				label: userData ? label : sentenceCaseLabel(label),
				icon: iconFor(entry),
				role,
				checked,
				hint,
				hintBelow: !!hint && hint.length > 16,
				shortcut: entry.shortcut ?? null,
				tag: entry.tag ?? null,
				tagTitle: entry.tagTitle ?? null,
				danger: !!entry.danger,
				seal: !!entry.seal,
				disabled: !!entry.disabled,
				nav: -1
			};
			if (row.danger) danger.push(row);
			else current.rows.push(row);
		}
		flush();
		if (danger.length) groups.push({ key: 'g-danger', kicker: null, rule: true, rows: danger });
		let nav = 0;
		groups.forEach((group, index) => {
			group.key = `g${index}`;
			if (index === 0) group.rule = false;
			else if (!group.kicker) group.rule = true;
			for (const row of group.rows) row.nav = nav++;
		});
		return groups;
	}

	/** Which input opened the menu decides whether the first row is highlighted at once. */
	let lastInput: 'pointer' | 'keyboard' = 'pointer';
	if (typeof window !== 'undefined') {
		window.addEventListener('pointerdown', () => (lastInput = 'pointer'), { capture: true, passive: true });
		window.addEventListener('keydown', () => (lastInput = 'keyboard'), { capture: true, passive: true });
	}

	let menuCounter = 0;
	const SHEET_QUERY = '(max-width: 768px)';
	const MARGIN = 8;
	const GAP = 4;
</script>

<script lang="ts">
	import { createEventDispatcher, onDestroy, tick } from 'svelte';
	import { portal } from '$lib/actions/portal';
	import Icon from '$lib/components/ui/Icon.svelte';

	export let open = false;
	export let x = 0;
	export let y = 0;
	export let items: MenuEntry[] = [];
	export let minWidth = 220;
	export let ariaLabel = 'Context menu';
	export let headerLabel: string | null = null;
	export let headerSubLabel: string | null = null;
	/** Trigger rect for button menus; when set, x/y are ignored. */
	export let anchor: MenuAnchor | null = null;
	export let align: 'start' | 'end' = 'start';
	/** 'auto': the first row when opened from the keyboard, nothing when opened by a pointer. */
	export let initialFocus: 'auto' | 'first' | 'last' | 'checked' = 'auto';
	/** Element that gets focus back on Esc / Tab (defaults to whatever had focus at open). */
	export let returnFocus: HTMLElement | null = null;
	export let menuId: string | null = null;
	/** Callback forms of the `close` / `select` events, for runes callers. */
	export let onClose: (() => void) | null = null;
	export let onSelectItem: ((id: string) => void) | null = null;

	const dispatch = createEventDispatcher<{
		close: void;
		select: { id: string };
	}>();

	const autoId = `w-menu-${++menuCounter}`;
	let menuElement: HTMLDivElement | null = null;
	let focusedIndex = -1;
	let placed = false;
	let position = { left: 0, top: 0, maxHeight: 0 };
	let sheetMode = false;
	let opener: HTMLElement | null = null;
	let typeahead = '';
	let typeaheadTimer: ReturnType<typeof setTimeout> | null = null;
	let wasOpen = false;
	let mediaQuery: MediaQueryList | null = null;

	$: id = menuId ?? autoId;
	$: groups = arrangeMenu(items);
	$: rows = groups.flatMap((group) => group.rows);
	$: sheetTitle = headerLabel ?? (ariaLabel && ariaLabel !== 'Context menu' ? ariaLabel : null);
	$: portalTarget =
		typeof document !== 'undefined'
			? ((document.fullscreenElement as HTMLElement | null) ?? document.body)
			: undefined;

	$: handleOpenChange(open);
	$: if (open && !sheetMode) {
		void x;
		void y;
		void anchor;
		void rows;
		void schedulePlace();
	}

	function handleOpenChange(isOpen: boolean) {
		if (isOpen === wasOpen) return;
		wasOpen = isOpen;
		if (typeof window === 'undefined') return;
		if (isOpen) {
			opener = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
			mediaQuery = window.matchMedia(SHEET_QUERY);
			sheetMode = mediaQuery.matches;
			mediaQuery.addEventListener('change', handleMediaChange);
			window.addEventListener('resize', handleResize);
			placed = false;
			focusedIndex = -1;
			void focusInitial();
		} else {
			teardown();
		}
	}

	function teardown() {
		mediaQuery?.removeEventListener('change', handleMediaChange);
		mediaQuery = null;
		if (typeof window !== 'undefined') window.removeEventListener('resize', handleResize);
		if (typeaheadTimer) clearTimeout(typeaheadTimer);
		typeahead = '';
	}

	onDestroy(teardown);

	function handleMediaChange(event: MediaQueryListEvent) {
		sheetMode = event.matches;
		placed = false;
	}

	function handleResize() {
		void schedulePlace();
	}

	async function schedulePlace() {
		await tick();
		place();
	}

	function place() {
		if (!open || sheetMode || !menuElement) return;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const room = Math.max(0, vh - MARGIN * 2);
		const width = menuElement.offsetWidth;
		const natural = Math.min(menuElement.scrollHeight + 2, room);
		let left: number;
		let top: number;
		let maxHeight = room;
		if (anchor) {
			left = align === 'end' ? anchor.right - width : anchor.left;
			const below = vh - MARGIN - (anchor.bottom + GAP);
			const above = anchor.top - GAP - MARGIN;
			if (natural <= below || below >= above) {
				top = anchor.bottom + GAP;
				maxHeight = Math.max(below, 120);
			} else {
				maxHeight = above;
				top = anchor.top - GAP - Math.min(natural, above);
			}
		} else {
			left = x + width > vw - MARGIN ? x - width : x;
			top = y + natural > vh - MARGIN ? y - natural : y;
		}
		left = Math.max(MARGIN, Math.min(left, vw - MARGIN - width));
		top = Math.max(MARGIN, Math.min(top, vh - MARGIN - Math.min(natural, maxHeight)));
		position = { left: Math.round(left), top: Math.round(top), maxHeight: Math.floor(maxHeight) };
		placed = true;
	}

	function rowElements(): HTMLElement[] {
		if (!menuElement) return [];
		return Array.from(menuElement.querySelectorAll<HTMLElement>('[data-menu-row]'));
	}

	function focusRow(index: number) {
		const elements = rowElements();
		if (index < 0 || index >= elements.length) return;
		focusedIndex = index;
		elements[index]?.focus({ preventScroll: false });
	}

	async function focusInitial() {
		await tick();
		if (!sheetMode) place();
		await tick();
		const checkedIndex = rows.findIndex((row) => row.checked);
		let target = -1;
		if (initialFocus === 'checked') target = checkedIndex >= 0 ? checkedIndex : 0;
		else if (initialFocus === 'first') target = 0;
		else if (initialFocus === 'last') target = rows.length - 1;
		else if (lastInput === 'keyboard') target = 0;
		if (target >= 0 && rows.length) focusRow(target);
		else {
			focusedIndex = -1;
			menuElement?.focus({ preventScroll: true });
		}
	}

	function closeMenu(restore = false) {
		const back = opener;
		dispatch('close');
		onClose?.();
		if (restore && back?.isConnected) queueMicrotask(() => back.focus({ preventScroll: true }));
	}

	function selectRow(row: Row) {
		if (row.disabled) return;
		const item = row.source;
		// The caller's handler starts while its menu state is still intact; the menu closes at once
		// (a handler that awaits a confirm must not leave the menu on screen behind it).
		let result: void | Promise<void> | undefined;
		try {
			result = item.onSelect?.();
		} catch (error) {
			console.error('[ContextMenu] item action failed', error);
		}
		dispatch('select', { id: item.id });
		onSelectItem?.(item.id);
		if (!item.keepOpen) {
			const back = opener;
			closeMenu(false);
			// Selecting a row removes the focused element; give focus back unless the action moved it.
			queueMicrotask(() => {
				const active = document.activeElement;
				if ((!active || active === document.body) && back?.isConnected) back.focus({ preventScroll: true });
			});
		}
		if (result && typeof (result as Promise<void>).catch === 'function') {
			(result as Promise<void>).catch((error) => console.error('[ContextMenu] item action failed', error));
		}
	}

	function move(key: string) {
		const count = rows.length;
		if (!count) return;
		let next = focusedIndex;
		if (key === 'Home') next = 0;
		else if (key === 'End') next = count - 1;
		else if (key === 'ArrowDown') next = focusedIndex < 0 ? 0 : (focusedIndex + 1) % count;
		else if (key === 'ArrowUp') next = focusedIndex < 0 ? count - 1 : (focusedIndex - 1 + count) % count;
		focusRow(next);
	}

	function runTypeahead(char: string) {
		if (typeaheadTimer) clearTimeout(typeaheadTimer);
		typeahead += char.toLowerCase();
		typeaheadTimer = setTimeout(() => (typeahead = ''), 600);
		const count = rows.length;
		const start = typeahead.length === 1 ? focusedIndex + 1 : Math.max(focusedIndex, 0);
		for (let step = 0; step < count; step += 1) {
			const index = (start + step) % count;
			if (rows[index].label.toLowerCase().startsWith(typeahead)) {
				focusRow(index);
				return;
			}
		}
	}

	function handleMenuKeydown(event: KeyboardEvent) {
		if (!open) return;
		const active = document.activeElement;
		const inside = !!menuElement && (menuElement.contains(active) || active === document.body || !active);
		if (!inside) return;
		switch (event.key) {
			case 'ArrowDown':
			case 'ArrowUp':
			case 'Home':
			case 'End':
				event.preventDefault();
				event.stopPropagation();
				move(event.key);
				break;
			case 'Escape':
				event.preventDefault();
				event.stopImmediatePropagation();
				closeMenu(true);
				break;
			case 'Tab':
				event.preventDefault();
				closeMenu(true);
				break;
			default:
				if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
					event.preventDefault();
					runTypeahead(event.key);
				}
		}
	}

	function handleWindowContextMenu(event: MouseEvent) {
		if (!open || !menuElement) return;
		// If another handler already claimed this event (e.g. opening a new menu), don't interfere.
		if (event.defaultPrevented) return;
		if (event.target instanceof Node && menuElement.contains(event.target)) {
			event.preventDefault();
			return;
		}
		event.preventDefault();
		closeMenu(false);
	}

	function handleCatcherPointerDown(event: PointerEvent) {
		if (event.button === 0 && event.target === event.currentTarget) closeMenu(false);
	}
</script>

<svelte:document on:keydown|capture={handleMenuKeydown} />
<svelte:window on:contextmenu={handleWindowContextMenu} />

{#if open}
	<div class="menu-layer" class:menu-layer--sheet={sheetMode} use:portal={portalTarget}>
		{#if sheetMode}
			<!-- svelte-ignore a11y-click-events-have-key-events -->
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<div class="w-scrim menu-scrim" on:click={() => closeMenu(false)}></div>
			<div class="w-sheet menu-sheet">
				<div class="w-sheet__grabber" aria-hidden="true"></div>
				{#if sheetTitle}
					<p class="w-sheet__title menu-sheet__title" id="{id}-title">{sheetTitle}</p>
					{#if headerSubLabel}<p class="menu-sheet__sub">{headerSubLabel}</p>{/if}
				{/if}
				<div class="w-sheet__body">
					<div
						bind:this={menuElement}
						{id}
						class="w-menu context-menu-surface menu-surface--sheet"
						role="menu"
						aria-orientation="vertical"
						aria-label={sheetTitle ? undefined : ariaLabel}
						aria-labelledby={sheetTitle ? `${id}-title` : undefined}
						tabindex="-1"
					>
						{#each groups as group}
							{#if group.rule}<div class="w-menu__sep" role="separator"></div>{/if}
							<div role="group" aria-labelledby={group.kicker ? `${id}-${group.key}` : undefined}>
								{#if group.kicker}<div class="w-menu__kicker" id="{id}-{group.key}">{group.kicker}</div>{/if}
								{#each group.rows as row}
									{@const highlighted = focusedIndex === row.nav}
									<button
										type="button"
										class="w-menu__item menu-item"
										class:w-menu__item--danger={row.danger}
										class:w-menu__item--seal={row.seal}
										class:danger={row.danger}
										class:menu-item--two-line={row.hintBelow}
										data-menu-row
										data-highlighted={highlighted ? '' : undefined}
										role={row.role}
										aria-checked={row.checked === undefined ? undefined : row.checked}
										aria-disabled={row.disabled ? 'true' : undefined}
										tabindex={highlighted ? 0 : -1}
										on:focus={() => (focusedIndex = row.nav)}
										on:click={() => selectRow(row)}
									>
										{#if row.icon}<Icon name={row.icon} size={18} />{/if}
										{#if row.hintBelow}
											<span class="menu-text">
												<span class="w-menu__label menu-label">{row.label}</span>
												<span class="menu-sub menu-hint">{row.hint}</span>
											</span>
										{:else}
											<span class="w-menu__label menu-label">{row.label}</span>
										{/if}
										{#if row.tag}<span class="w-tag w-tag--mat" title={row.tagTitle ?? undefined}>{row.tag}</span>{/if}
										{#if row.shortcut}<span class="w-menu__key">{row.shortcut}</span>{/if}
										{#if row.hint && !row.hintBelow}<span class="w-menu__hint menu-hint">{row.hint}</span>{/if}
										{#if row.checked !== undefined}<Icon name="check" size={16} class="w-menu__check" />{/if}
									</button>
								{/each}
							</div>
						{/each}
					</div>
				</div>
			</div>
		{:else}
			<!-- svelte-ignore a11y-no-static-element-interactions -->
			<div class="menu-catcher" on:pointerdown={handleCatcherPointerDown}></div>
			<div
				bind:this={menuElement}
				{id}
				class="w-menu context-menu-surface"
				class:menu-surface--placed={placed}
				style:left="{position.left}px"
				style:top="{position.top}px"
				style:min-width="{Math.max(minWidth, anchor ? Math.round(anchor.right - anchor.left) : 0)}px"
				style:max-height={position.maxHeight ? `${position.maxHeight}px` : undefined}
				role="menu"
				aria-orientation="vertical"
				aria-label={headerLabel ? `${ariaLabel}: ${headerLabel}` : ariaLabel}
				tabindex="-1"
				on:mousedown|stopPropagation
			>
				{#if headerLabel}
					<div class="menu-head" aria-hidden="true">
						<p class="menu-head__label">{headerLabel}</p>
						{#if headerSubLabel}<p class="menu-head__sub">{headerSubLabel}</p>{/if}
					</div>
					<div class="w-menu__sep" role="separator"></div>
				{/if}
				{#each groups as group}
					{#if group.rule}<div class="w-menu__sep" role="separator"></div>{/if}
					<div role="group" aria-labelledby={group.kicker ? `${id}-${group.key}` : undefined}>
						{#if group.kicker}<div class="w-menu__kicker" id="{id}-{group.key}">{group.kicker}</div>{/if}
						{#each group.rows as row}
							{@const highlighted = focusedIndex === row.nav}
							<button
								type="button"
								class="w-menu__item menu-item"
								class:w-menu__item--danger={row.danger}
								class:w-menu__item--seal={row.seal}
								class:danger={row.danger}
								class:menu-item--two-line={row.hintBelow}
								data-menu-row
								data-highlighted={highlighted ? '' : undefined}
								role={row.role}
								aria-checked={row.checked === undefined ? undefined : row.checked}
								aria-disabled={row.disabled ? 'true' : undefined}
								tabindex={highlighted ? 0 : -1}
								on:focus={() => (focusedIndex = row.nav)}
								on:pointerenter={(event) => {
									if (event.pointerType !== 'touch') focusRow(row.nav);
								}}
								on:click={() => selectRow(row)}
							>
								{#if row.icon}<Icon name={row.icon} size={16} />{/if}
								{#if row.hintBelow}
									<span class="menu-text">
										<span class="w-menu__label menu-label">{row.label}</span>
										<span class="menu-sub menu-hint">{row.hint}</span>
									</span>
								{:else}
									<span class="w-menu__label menu-label">{row.label}</span>
								{/if}
								{#if row.tag}<span class="w-tag w-tag--mat" title={row.tagTitle ?? undefined}>{row.tag}</span>{/if}
								{#if row.shortcut}<span class="w-menu__key">{row.shortcut}</span>{/if}
								{#if row.hint && !row.hintBelow}<span class="w-menu__hint menu-hint">{row.hint}</span>{/if}
								{#if row.checked !== undefined}<Icon name="check" size={16} class="w-menu__check" />{/if}
							</button>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	/* The layer only groups the catcher (or scrim) and the surface; it draws nothing itself. */
	.menu-layer {
		display: contents;
	}

	.menu-catcher {
		position: fixed;
		inset: 0;
		z-index: var(--z-floating-ui, 2250);
	}

	.context-menu-surface:not(.menu-surface--sheet) {
		position: fixed;
		z-index: calc(var(--z-floating-ui, 2250) + 1);
		overflow-y: auto;
		overscroll-behavior: contain;
		outline: none;
		visibility: hidden;
	}
	.context-menu-surface.menu-surface--placed {
		visibility: visible;
	}

	/* The object the menu acts on, named once above the rows: serif, like every place name. */
	.menu-head {
		padding: 6px 10px 4px;
	}
	.menu-head__label {
		margin: 0;
		overflow: hidden;
		color: var(--w-text);
		font: var(--w-t-subhead);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.menu-head__sub {
		margin: 2px 0 0;
		color: var(--w-faint);
		font: var(--w-t-small);
	}

	/* A hint longer than a word becomes the row's second line instead of widening the menu. */
	.menu-item--two-line {
		align-items: flex-start;
		padding-top: 7px;
		padding-bottom: 7px;
	}
	.menu-item--two-line > :global(svg:first-child) {
		margin-top: 2px;
	}
	.menu-text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.menu-sub {
		color: var(--w-faint);
		font: var(--w-t-small);
		white-space: normal;
		text-wrap: pretty;
	}
	.w-menu__item--danger .menu-sub {
		color: color-mix(in srgb, var(--w-danger) 70%, var(--w-faint));
	}

	/* Sheet: z-order above app chrome, the title and its one-line context. */
	.menu-layer--sheet :global(.menu-scrim) {
		z-index: var(--z-floating-ui, 2250);
	}
	.menu-sheet {
		z-index: calc(var(--z-floating-ui, 2250) + 1);
	}
	.menu-sheet__title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.menu-sheet__sub {
		margin: -6px 0 0;
		padding: 0 20px 10px;
		color: var(--w-faint);
		font: var(--w-t-small);
	}
	.menu-surface--sheet {
		outline: none;
	}
	.menu-surface--sheet .menu-item {
		gap: 14px;
		padding-inline: 12px;
	}
	/* Rows keep the reserved icon slot at the sheet's larger glyph size. */
	.menu-surface--sheet .menu-item:not(:has(> :global(svg:first-child))) {
		padding-left: 44px;
	}
	.menu-surface--sheet :global(.menu-item > svg:first-child) {
		width: 18px;
		height: 18px;
	}
	.menu-surface--sheet .w-menu__label,
	.menu-surface--sheet .menu-label {
		font: var(--w-t-chat);
	}
</style>
