<script lang="ts">
	import { openLoreSurface } from '$lib/loreWorkspace';

	interface Props {
		path: string;
		startLine?: number;
		endLine?: number;
		channelId: string;
	}

	let { path, startLine, endLine, channelId }: Props = $props();
	let lineLabel = $derived(startLine ? (endLine && endLine !== startLine ? `:${startLine}-${endLine}` : `:${startLine}`) : '');

	function openCitation(): void {
		try {
			localStorage.setItem('wabi:lastLoreChannelId', channelId);
			localStorage.setItem('wabi:lore:pendingPath', path);
		} catch {
			// The Code surface remains useful when storage is unavailable.
		}
		openLoreSurface();
	}
</script>

<button type="button" class="chat-citation" title={`Open ${path}`} onclick={openCitation}>
	<span aria-hidden="true">⌘</span>
	<span class="path">{path}</span>
	{#if lineLabel}<span class="lines">{lineLabel}</span>{/if}
</button>

<style>
	.chat-citation { display: inline-flex; align-items: center; gap: var(--space-1); max-width: 100%; padding: 2px var(--space-2); border: 1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent); border-radius: var(--radius-sm); background: color-mix(in srgb, var(--accent-primary) 10%, var(--surface-raised)); color: var(--text-secondary); cursor: pointer; font: inherit; font-family: var(--font-mono); font-size: var(--font-size-xs); vertical-align: middle; }
	.chat-citation:hover { border-color: var(--accent-primary); color: var(--text-heading); }
	.path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lines { color: var(--text-muted); }
</style>
