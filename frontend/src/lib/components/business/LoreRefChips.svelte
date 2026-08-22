<script lang="ts">
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import { parseLoreChannelId, getSignedLoreUrl } from '$lib/api/lore';
	import type { LoreCitationRef } from '$lib/business/types';

	/**
	 * Compact lore file-reference chips for planner items (tasks).
	 * Renders nothing when there are no refs. Clicking a chip opens the file
	 * at its line range in a new tab via a signed lore URL. Inert-safe: if
	 * the addon is missing the fetch fails and we fall back to no-op.
	 */
	export let refs: LoreCitationRef[] = [];
	export let size: 'xs' | 'sm' = 'xs';

	let busy = false;

	function chipLabel(ref: LoreCitationRef): string {
		const file = ref.path.split('/').pop() || ref.path;
		if (ref.startLine && ref.endLine && ref.endLine !== ref.startLine) return `${file}:${ref.startLine}-${ref.endLine}`;
		if (ref.startLine) return `${file}:${ref.startLine}`;
		return file;
	}

	async function open(ref: LoreCitationRef): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const token = getAuthToken();
			const numericId = parseLoreChannelId(ref.channelId);
			if (!token || !numericId) return;
			const url = await getSignedLoreUrl(token, numericId, ref.path);
			window.open(url, '_blank', 'noopener');
		} catch {
			// Addon absent or unreachable — chips are additive, stay silent.
		} finally {
			busy = false;
		}
	}
</script>

{#if refs.length > 0}
	<span class="lore-ref-chips" class:size-sm={size === 'sm'}>
		{#each refs as ref, i (ref.channelId + ':' + ref.path + ':' + (ref.startLine ?? 0) + ':' + i)}
			<button
				type="button"
				class="lore-ref-chip"
				disabled={busy}
				title={`Open ${ref.path}${ref.startLine ? `:${ref.startLine}` : ''} in Project files`}
				on:click={() => open(ref)}
			>
				<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<polyline points="16 18 22 12 16 6" />
					<polyline points="8 6 2 12 8 18" />
				</svg>
				{chipLabel(ref)}
			</button>
		{/each}
	</span>
{/if}

<style>
	.lore-ref-chips {
		display: inline-flex;
		flex-wrap: wrap;
		gap: 4px;
		align-items: center;
	}
	.lore-ref-chip {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: 0.65rem;
		font-family: var(--font-mono, monospace);
		padding: 1px 6px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--biz-accent, #6366f1) 30%, transparent);
		background: color-mix(in srgb, var(--biz-accent, #6366f1) 10%, transparent);
		color: var(--biz-text-secondary, #b3b3ff);
		cursor: pointer;
		max-width: 140px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		transition: background 120ms ease, color 120ms ease;
	}
	.lore-ref-chip:hover:not(:disabled) {
		background: color-mix(in srgb, var(--biz-accent, #6366f1) 22%, transparent);
		color: var(--biz-text-primary, #e0e0ff);
	}
	.lore-ref-chip:disabled {
		opacity: 0.55;
		cursor: wait;
	}
	.size-sm .lore-ref-chip {
		font-size: 0.72rem;
		padding: 2px 8px;
	}
</style>
