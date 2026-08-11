<script lang="ts">
	import { openLoreSurface } from '$lib/loreWorkspace';

	interface Props {
		channelId: string;
		channelName: string;
		isMirror?: boolean;
	}

	let { channelId, channelName, isMirror = false }: Props = $props();

	function openCode(): void {
		try {
			localStorage.setItem('wabi:lastLoreChannelId', channelId);
		} catch {
			// Private browsing/storage-disabled mode: the workspace still opens.
		}
		openLoreSurface();
	}
</script>

<section class="lore-channel-card" aria-label="Code repository">
	<div class="card-copy">
		<div class="card-kicker">
			<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8">
				<path d="M8 3 3 8l5 5M16 3l5 5-5 5M14 2l-4 20" />
			</svg>
			<span>{isMirror ? 'Read-only mirror' : 'Code repository'}</span>
		</div>
		<strong>{channelName}</strong>
		<span class="card-hint">Browse files, history, and review in Code</span>
	</div>
	<button type="button" class="open-code" onclick={openCode}>Open in Code</button>
</section>

<style>
	.lore-channel-card {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		min-height: 88px;
		margin: var(--space-3) var(--space-4) var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: color-mix(in srgb, var(--surface-raised) 72%, transparent);
		border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent);
		border-radius: var(--radius-lg);
	}
	.card-copy { min-width: 0; display: grid; gap: 2px; }
	.card-kicker { display: flex; align-items: center; gap: var(--space-1); color: var(--text-muted); font-size: var(--font-size-xs); }
	.card-kicker svg { width: 14px; height: 14px; flex: 0 0 auto; }
	.card-copy strong { color: var(--text-heading); font-size: var(--font-size-base); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.card-hint { color: var(--text-muted); font-size: var(--font-size-xs); }
	.open-code { flex: 0 0 auto; padding: var(--space-2) var(--space-3); border: 1px solid color-mix(in srgb, var(--accent-primary) 45%, transparent); border-radius: var(--radius-md); background: var(--accent-primary); color: var(--text-inverse, white); cursor: pointer; font-weight: 600; }
	.open-code:hover { background: var(--accent-secondary); }
	@media (max-width: 600px) { .lore-channel-card { margin-inline: var(--space-2); } .card-hint { display: none; } }
</style>
