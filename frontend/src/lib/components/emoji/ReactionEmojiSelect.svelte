<script lang="ts">
	import { tick } from 'svelte';
	import { emojis } from '$lib/emoji-store';
	import { REACTION_EMOJI_PAGE_SIZE, filterReactionEmojis, getReactionEmojiLabel, type ReactionEmojiSource } from '$lib/reactionEmojiOptions';

	let { value, disabled = false, onchange }: {
		value: string;
		disabled?: boolean;
		onchange: (id: string) => void;
	} = $props();
	const id = $props.id();
	let open = $state(false);
	let query = $state('');
	let source = $state<ReactionEmojiSource>('all');
	let limit = $state(REACTION_EMOJI_PAGE_SIZE);
	let root = $state<HTMLDivElement>();
	let trigger = $state<HTMLButtonElement>();
	let search = $state<HTMLInputElement>();
	let results = $state<HTMLDivElement>();
	let selected = $derived($emojis.find((emoji) => emoji.id === value));
	let filtered = $derived(filterReactionEmojis($emojis, query, source));
	let visible = $derived(filtered.slice(0, limit));

	async function toggle() {
		if (disabled) return;
		open = !open;
		if (open) {
			limit = REACTION_EMOJI_PAGE_SIZE;
			await tick();
			if (open) search?.focus();
		}
	}

	function close(restoreFocus = false) {
		open = false;
		if (restoreFocus) trigger?.focus();
	}

	function select(id: string) {
		if (disabled) return;
		onchange(id);
		close(true);
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!open) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close(true);
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			if (event.target !== search && !results?.contains(event.target as Node)) return;
			const options = Array.from(results?.querySelectorAll<HTMLButtonElement>('[data-emoji-option]') || []);
			if (!options.length) return;
			event.preventDefault();
			const current = options.indexOf(event.target as HTMLButtonElement);
			const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
				: (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
			options[next].focus();
		}
	}
</script>

<svelte:window onpointerdown={(event) => {
	if (open && !root?.contains(event.target as Node)) close();
}} onblur={() => close()} />

<div class="reaction-emoji-select" bind:this={root} role="group" aria-label="Reaction emoji">
	<span id={`${id}-label`} class="reaction-emoji-label">Reaction emoji</span>
	<button bind:this={trigger} type="button" class="reaction-emoji-trigger" {disabled}
		aria-labelledby={`${id}-label ${id}-value`} aria-expanded={open} aria-controls={`${id}-options`}
		onclick={toggle} onkeydown={handleKeydown}>
		{#if selected}<img src={selected.url} alt="" width="24" height="24" />{/if}
		<span id={`${id}-value`}>{selected ? getReactionEmojiLabel(selected) : value ? 'Emoji unavailable — choose another' : 'Choose emoji'}</span>
		<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg>
	</button>
	{#if open}
		<div class="reaction-emoji-picker" id={`${id}-options`}>
			<label class="reaction-emoji-search">
				<span>Search emoji</span>
				<input bind:this={search} type="search" placeholder="Heart, happy, thumbs up…" bind:value={query}
					oninput={() => limit = REACTION_EMOJI_PAGE_SIZE} onkeydown={handleKeydown} />
			</label>
			<label class="reaction-emoji-source">
				<span>Emoji source</span>
				<select bind:value={source} onchange={() => limit = REACTION_EMOJI_PAGE_SIZE} onkeydown={handleKeydown}>
					<option value="all">All emoji</option><option value="bundled">Built-in</option><option value="custom">Custom</option>
				</select>
			</label>
			<p class="reaction-emoji-result-count" role="status">{filtered.length} {filtered.length === 1 ? 'match' : 'matches'}</p>
			<div class="reaction-emoji-results" bind:this={results} role="group" aria-label="Emoji matches">
				{#each visible as emoji (emoji.id)}
					<button type="button" data-emoji-option aria-pressed={value === emoji.id} onclick={() => select(emoji.id)} onkeydown={handleKeydown}>
						<img src={emoji.url} alt="" width="24" height="24" loading="lazy" decoding="async" />
						<span>{getReactionEmojiLabel(emoji)}</span>
					</button>
				{:else}
					<p class="reaction-emoji-empty">{$emojis.length ? 'No matching emoji. Try another name or source.' : 'No emoji loaded. Reconnect or reload Wabi and try again.'}</p>
				{/each}
				{#if limit < filtered.length}
					<button type="button" class="reaction-emoji-more" onclick={() => limit += REACTION_EMOJI_PAGE_SIZE} onkeydown={handleKeydown}>Show more emoji ({filtered.length - limit} remaining)</button>
				{/if}
			</div>
			<button type="button" class="reaction-emoji-close" onclick={() => close(true)} onkeydown={handleKeydown}>Done</button>
		</div>
	{/if}
</div>

<style>
	.reaction-emoji-select { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
	.reaction-emoji-label, label > span { font-size: 0.8rem; font-weight: 500; color: var(--text-secondary); }
	button, input, select { font: inherit; min-width: 0; max-width: 100%; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-app); color: var(--text-heading); }
	button, input, select { min-height: 44px; padding: 8px 10px; }
	button { cursor: pointer; text-align: start; transition: background-color 120ms ease-out, border-color 120ms ease-out; }
	button:hover:not(:disabled) { background: var(--surface-hover); border-color: var(--border-strong); }
	button:disabled { opacity: 0.6; cursor: not-allowed; }
	button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
	.reaction-emoji-trigger { display: flex; align-items: center; gap: 8px; width: 100%; }
	.reaction-emoji-trigger > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
	img, svg { flex: none; object-fit: contain; }
	.reaction-emoji-picker { display: flex; flex-direction: column; gap: 10px; padding: 12px; background: var(--surface-raised); border: 1px solid var(--border-subtle); border-radius: var(--radius-xl); }
	label { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
	.reaction-emoji-result-count { margin: 0; color: var(--text-muted); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
	.reaction-emoji-results { display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; overscroll-behavior: contain; padding: 3px; }
	.reaction-emoji-results > button { display: flex; align-items: center; gap: 10px; flex: none; }
	.reaction-emoji-results > button > span { overflow-wrap: anywhere; }
	.reaction-emoji-results > button[aria-pressed='true'] { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 12%, var(--surface-base)); }
	.reaction-emoji-more, .reaction-emoji-close { text-align: center; justify-content: center; }
	.reaction-emoji-empty { color: var(--text-secondary); font-size: 0.8rem; text-wrap: pretty; margin: 8px 0; }
	@media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
