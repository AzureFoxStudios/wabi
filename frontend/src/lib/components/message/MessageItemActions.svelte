<script module lang="ts">
	/** A box in viewport pixels (a DOMRect is one). */
	export type ToolRect = { left: number; top: number; right: number; bottom: number };
	/**
	 * `edge` is the toolbar's home (styles/components/ml-actions.css); the others are placed from
	 * `x`/`y`, relative to the row's top-left. `compact` keeps only the More key.
	 */
	export type HoverToolPlace = { place: 'edge' | 'margin' | 'above' | 'gutter'; compact: boolean; x: number; y: number };

	/** Air between the page edge (or the text column) and a tool set beside it. */
	const SIDE_GAP = 12;
	/** A row's first line; a tool beside the row is centred on it. */
	const FIRST_LINE = 24;

	function box(left: number, top: number, width: number, height: number): ToolRect {
		return { left, top, right: left + width, bottom: top + height };
	}

	function overlaps(a: ToolRect, b: ToolRect): boolean {
		return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
	}

	function within(a: ToolRect, bounds: ToolRect): boolean {
		return a.left >= bounds.left && a.right <= bounds.right && a.top >= bounds.top && a.bottom <= bounds.bottom;
	}

	/**
	 * Where the hover toolbar goes so that it never covers message text (§7.15). The first spot
	 * that stays inside the scroller and clear of every obstacle (text, pictures and avatars of
	 * this row and its neighbours) wins:
	 *   1. home, on the page edge straddling the row's top (a group start's name line is free);
	 *   2. beside the page, in the right margin that §8.3 keeps for it;
	 *   3. just above the row;
	 *   then reduced to its More key, whose menu holds every action:
	 *   4. home, 5. in the margin, 6. in the row's empty avatar column (`textStart` is the text
	 *      column's left edge).
	 * Nothing clear: home, as before. A keyboard user inside the toolbar keeps every key, so
	 * `allowCompact` is false then.
	 */
	export function chooseHoverToolPlace(input: {
		row: ToolRect;
		edge: ToolRect;
		compactWidth: number;
		textStart: number | null;
		bounds: ToolRect;
		obstacles: ToolRect[];
		allowCompact: boolean;
	}): HoverToolPlace {
		const { row, edge, compactWidth, textStart, bounds, obstacles, allowCompact } = input;
		const width = edge.right - edge.left;
		const height = edge.bottom - edge.top;
		// Own messages on the right put the home at the text column's start instead of the page edge.
		const mirrored = edge.right < row.right - 1;
		const besideTop = row.top + Math.round((FIRST_LINE - height) / 2);
		const candidates: Array<[HoverToolPlace['place'], boolean, ToolRect]> = [
			['edge', false, edge],
			['margin', false, box(row.right + SIDE_GAP, besideTop, width, height)],
			['above', false, box(edge.left, row.top - 4 - height, width, height)]
		];
		if (allowCompact) {
			candidates.push(
				['edge', true, box(mirrored ? edge.left : edge.right - compactWidth, edge.top, compactWidth, height)],
				['margin', true, box(row.right + SIDE_GAP, besideTop, compactWidth, height)]
			);
			if (textStart !== null) {
				candidates.push(['gutter', true, box(textStart - 6 - compactWidth, besideTop, compactWidth, height)]);
			}
		}
		for (const [place, compact, rect] of candidates) {
			if (within(rect, bounds) && !obstacles.some((obstacle) => overlaps(rect, obstacle))) {
				return { place, compact, x: rect.left - row.left, y: rect.top - row.top };
			}
		}
		return { place: 'edge', compact: false, x: edge.left - row.left, y: edge.top - row.top };
	}
</script>

<script lang="ts">
	import type { Message, Emoji } from '$lib/socket';
	import { _ } from '$lib/i18n';
	import Icon from '$lib/components/ui/Icon.svelte';

	export let message: Message;
	export let ownMessage: boolean;
	export let quickReactionEmojis: Emoji[];
	export let mobileActionsMessageId: string | null;
	export let displayEnhancementSettingsStore: any;
	export let onReply: (message: Message) => void;
	export let onQuickMention: (message: Message) => void;
	export let onForward: (message: Message) => void = () => {};
	export let onContextMenu: (event: MouseEvent, message: Message) => void;
	export let onOpenReactionPicker: (event: MouseEvent, messageId: string) => void;
	export let onQuickReact: (messageId: string, emojiId: string) => void;
	export let onHandleUtilityPinToggle: (message: Message) => void;
	export let onHandleUtilityEdit: (message: Message) => void;

	/** Hover toolbar order (§7.15): 3 quick reactions | Add reaction, Reply, Forward | More. */
	const QUICK_LIMIT = 3;
	$: quick = quickReactionEmojis.slice(0, QUICK_LIMIT);

	// An emoji whose image cannot load (no bundled art, a deleted server emoji, a CDN hiccup)
	// shows the character it stands for, or its :shortcode:, so the key keeps working.
	let broken: Record<string, true> = {};
	function emojiText(emoji: Emoji): string {
		const sequence = /^[0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*$/i.test(emoji.id)
			? emoji.id
			: (emoji.url.match(/\/([0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*)\.(?:png|svg|webp|gif)(?:[?#].*)?$/i)?.[1] ?? '');
		if (sequence && !emoji.isCustom) {
			try {
				return String.fromCodePoint(...sequence.split('-').map((part) => Number.parseInt(part, 16)));
			} catch {
				// fall through to the shortcode
			}
		}
		if (/\p{Extended_Pictographic}/u.test(emoji.id)) return emoji.id;
		return `:${emoji.displayName || emoji.name}:`;
	}
	function quickLabel(emoji: Emoji): string {
		return `Quick react: ${emoji.displayName || emoji.name}`;
	}

	// ---- placement: measured when the pointer or focus enters the row --------------------------
	const STREAM_SCROLLERS = '.messages, .dm-messages, .dm-conversation-messages, .glance-page';
	const OBSTACLE_BOXES = 'img, video, canvas, iframe, .message-avatar:not(.message-avatar-spacer)';

	function isToolPart(node: Node): boolean {
		const element = node instanceof Element ? node : node.parentElement;
		return Boolean(element?.closest('.message-actions'));
	}

	/** Text line boxes and pictures inside `root`, leaving out every row's (hidden) toolbar. */
	function collectObstacles(root: Element | null, out: ToolRect[]): void {
		if (!root) return;
		const range = document.createRange();
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (!node.nodeValue?.trim() || isToolPart(node)) continue;
			range.selectNodeContents(node);
			for (const rect of range.getClientRects()) if (rect.width > 0 && rect.height > 0) out.push(rect);
		}
		for (const element of root.querySelectorAll(OBSTACLE_BOXES)) {
			if (isToolPart(element)) continue;
			const rect = element.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) out.push(rect);
		}
	}

	function scrollerBounds(row: Element): ToolRect {
		const scroller = row.closest<HTMLElement>(STREAM_SCROLLERS);
		if (!scroller) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
		const rect = scroller.getBoundingClientRect();
		const left = rect.left + scroller.clientLeft;
		const top = rect.top + scroller.clientTop;
		return { left, top, right: left + scroller.clientWidth, bottom: top + scroller.clientHeight };
	}

	function textColumnStart(row: Element): number | null {
		const body = row.querySelector(':scope > .message-body');
		if (!body) return null;
		const own = body.getBoundingClientRect();
		if (own.width > 0) return own.left;
		// compact density lays the body out with display: contents
		for (const child of body.children) {
			const rect = child.getBoundingClientRect();
			if (rect.width > 0) return rect.left;
		}
		return null;
	}

	function placeTool(tool: HTMLElement, allowCompact: boolean): void {
		const row = tool.parentElement;
		if (!row || tool.classList.contains('mobile-visible')) return;
		// Measure from home: clear any earlier placement first (no paint happens in between).
		delete tool.dataset.place;
		delete tool.dataset.compact;
		const edge = tool.getBoundingClientRect();
		const style = getComputedStyle(tool);
		const chrome =
			Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight) +
			Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
		const more = tool.querySelector<HTMLElement>('.message-actions__more');
		const obstacles: ToolRect[] = [];
		collectObstacles(row, obstacles);
		collectObstacles(row.previousElementSibling, obstacles);
		collectObstacles(row.nextElementSibling, obstacles);
		// the floating day rule is an opaque band at the top of the stream
		const floating = row.parentElement?.querySelector(':scope > .stream-float .stream-day--float');
		if (floating) obstacles.push(floating.getBoundingClientRect());
		const result = chooseHoverToolPlace({
			row: row.getBoundingClientRect(),
			edge,
			compactWidth: (more?.offsetWidth ?? 28) + (Number.isFinite(chrome) ? chrome : 6),
			textStart: textColumnStart(row),
			bounds: scrollerBounds(row),
			obstacles,
			allowCompact: allowCompact && !tool.contains(document.activeElement)
		});
		if (result.place !== 'edge') tool.dataset.place = result.place;
		if (result.compact) tool.dataset.compact = '';
		tool.style.setProperty('--tool-x', `${Math.round(result.x)}px`);
		tool.style.setProperty('--tool-y', `${Math.round(result.y)}px`);
	}

	function hoverToolPlacement(tool: HTMLElement) {
		const row = tool.parentElement;
		if (!row) return {};
		const onPointerEnter = (event: PointerEvent) => {
			// touch opens the toolbar by long-press (.mobile-visible), placed by ml-mobile.css
			if (event.pointerType === 'touch') return;
			placeTool(tool, true);
		};
		// Focus arriving on one of the toolbar's own keys must keep that key on screen.
		const onFocusIn = (event: FocusEvent) => placeTool(tool, !tool.contains(event.target as Node | null));
		row.addEventListener('pointerenter', onPointerEnter);
		row.addEventListener('focusin', onFocusIn);
		return {
			destroy() {
				row.removeEventListener('pointerenter', onPointerEnter);
				row.removeEventListener('focusin', onFocusIn);
			}
		};
	}
	$: mobileVisible = mobileActionsMessageId === message.id;
</script>

<div class="message-actions w-tool" class:mobile-visible={mobileVisible} use:hoverToolPlacement>
	{#if quick.length > 0}
		<div class="quick-reactions-strip">
			{#each quick as quickEmoji (quickEmoji.id)}
				<button
					type="button"
					class="quick-reaction-btn w-tool__quick"
					title={quickLabel(quickEmoji)}
					aria-label={quickLabel(quickEmoji)}
					on:click|stopPropagation={() => onQuickReact(message.id, quickEmoji.id)}
				>
					{#if broken[quickEmoji.id]}
						<span class="quick-reaction-fallback" aria-hidden="true">{emojiText(quickEmoji)}</span>
					{:else}
						<img
							src={quickEmoji.url}
							alt=""
							class="quick-reaction-emoji"
							loading="lazy"
							decoding="async"
							on:error={() => (broken = { ...broken, [quickEmoji.id]: true })}
						/>
					{/if}
				</button>
			{/each}
		</div>
		<span class="w-tool__sep" aria-hidden="true"></span>
	{/if}

	<button type="button" class="action-btn w-ibtn" title={$_('messages.add_reaction')} aria-label={$_('messages.add_reaction')} on:click={(event) => onOpenReactionPicker(event, message.id)}>
		<Icon name="smilePlus" size={16} />
	</button>

	<button type="button" class="action-btn w-ibtn" title={$_('messages.actions.reply')} aria-label={$_('messages.actions.reply')} on:click={() => onReply(message)}>
		<Icon name="reply" size={16} />
	</button>

	<button type="button" class="action-btn w-ibtn" title={$_('context_menu.forward')} aria-label={$_('context_menu.forward')} on:click={() => onForward(message)}>
		<Icon name="forward" size={16} />
	</button>

	<!-- Settings › Chat › MessageUtilities adds its own group; every one of these is also in More. -->
	{#if displayEnhancementSettingsStore.messageUtilitiesEnabled}
		<span class="w-tool__sep" aria-hidden="true"></span>
		{#if displayEnhancementSettingsStore.quickMentionEnabled && !ownMessage}
			<button type="button" class="action-btn utility-btn w-ibtn" title={$_('context_menu.quick_mention')} aria-label={$_('context_menu.quick_mention')} on:click={() => onQuickMention(message)}>
				<Icon name="at" size={16} />
			</button>
		{/if}
		<button
			type="button"
			class="action-btn utility-btn w-ibtn"
			title={message.isPinned ? $_('context_menu.unpin_message') : $_('context_menu.pin_message')}
			aria-label={message.isPinned ? $_('context_menu.unpin_message') : $_('context_menu.pin_message')}
			on:click={() => onHandleUtilityPinToggle(message)}
		>
			<Icon name="pin" size={16} />
		</button>
		{#if ownMessage}
			<button type="button" class="action-btn utility-btn w-ibtn" title={$_('context_menu.edit_message')} aria-label={$_('context_menu.edit_message')} on:click={() => onHandleUtilityEdit(message)}>
				<Icon name="pencil" size={16} />
			</button>
		{/if}
	{/if}

	<span class="w-tool__sep" aria-hidden="true"></span>
	<button type="button" class="action-btn message-actions__more w-ibtn" title={$_('messages.actions.more')} aria-label={$_('messages.actions.more')} aria-haspopup="menu" on:click={(event) => onContextMenu(event, message)}>
		<Icon name="more" size={16} />
	</button>
</div>
