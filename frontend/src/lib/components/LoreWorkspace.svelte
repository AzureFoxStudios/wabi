<script lang="ts">
	/** Lore workspace surface — a pill-accessible "Code" hub.
	 *
	 * Works from ANY channel. Shows the server's lore channels with repo status,
	 * a "New Code Channel" button, and lets you jump into a code channel.
	 * If the current channel is a lore channel, embeds the full LoreChannelShell.
	 */
	import { currentChannel, channels } from '$lib/socket';
	import { switchChannel } from '$lib/channelStore';
	import { get } from 'svelte/store';
	import { layoutStore } from '$lib/layoutStore';
	import LoreChannelShell from './lore/LoreChannelShell.svelte';
	import { onMount } from 'svelte';

	let activeChannelId = $derived(get(currentChannel));
	let allChannels = $derived(get(channels));

	let loreChannels = $derived(
		allChannels.filter((c) => c.type === 'lore')
	);

	let isCurrentLore = $derived(
		loreChannels.some((c) => c.id === activeChannelId)
	);

	let showCreateForm = $state(false);

	function channelType(ch: any): string {
		return (ch as any).type || (ch as any).channelType || '';
	}

	// If current channel is lore, render the shell directly
	if (isCurrentLore) {
		// handled in markup below
	}

	function jumpToChannel(id: string) {
		switchChannel(id);
		layoutStore.rightPanelView.set('none');
	}

	function openCreateForm() {
		showCreateForm = true;
		// Use the global create-channel affordance via event if available
		const el = document.querySelector('[data-create-channel]') as HTMLElement | null;
		el?.click();
		setTimeout(() => (showCreateForm = false), 1500);
	}

	onMount(() => {
		// Keep it simple — no fetch needed, channels store is live
	});
</script>

{#if isCurrentLore}
	<LoreChannelShell />
{:else}
	<div class="lore-workspace">
		<header class="lore-workspace-header">
			<div class="lore-workspace-title">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" width="28" height="28">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
					<polyline points="14 2 14 8 20 8"/>
					<line x1="16" y1="13" x2="8" y2="13"/>
					<line x1="16" y1="17" x2="8" y2="17"/>
					<path d="M10 9H8"/>
				</svg>
				<div>
					<h2>Code</h2>
					<p>Versioned repositories — browse files, history, diffs, and scripts</p>
				</div>
			</div>
			<button class="new-code-btn" onclick={openCreateForm} title="Create a code channel">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
					<line x1="12" y1="5" x2="12" y2="19"/>
					<line x1="5" y1="12" x2="19" y2="12"/>
				</svg>
				New Code Channel
			</button>
		</header>

		{#if loreChannels.length === 0}
			<div class="lore-empty">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" width="64" height="64">
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
					<polyline points="14 2 14 8 20 8"/>
					<line x1="16" y1="13" x2="8" y2="13"/>
					<line x1="16" y1="17" x2="8" y2="17"/>
				</svg>
				<h3>No code channels yet</h3>
				<p>Create a Code channel to start a versioned repository — browse files, commit history, diffs, branches, and run scripts right inside Wabi.</p>
				<button class="new-code-btn" onclick={openCreateForm}>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
						<line x1="12" y1="5" x2="12" y2="19"/>
						<line x1="5" y1="12" x2="19" y2="12"/>
					</svg>
					Create your first Code channel
				</button>
				<p class="lore-empty-hint">Uses Epic Games Lore — a fully open-source version control system. No cloud, no third party.</p>
			</div>
		{:else}
			<div class="lore-channel-grid">
				{#each loreChannels as ch}
					<button class="lore-channel-card" onclick={() => jumpToChannel(ch.id)}>
						<span class="lore-card-icon">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
								<path d="M21 8V21H3V8"/>
								<rect x="1" y="3" width="22" height="5"/>
								<line x1="10" y1="12" x2="14" y2="12"/>
							</svg>
						</span>
						<span class="lore-card-name">{ch.name}</span>
						<span class="lore-card-meta">Code channel</span>
						<span class="lore-card-open">Open →
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
								<path d="M5 12h14"/>
								<path d="M12 5l7 7-7 7"/>
							</svg>
						</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.lore-workspace {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		padding: var(--space-3);
		gap: var(--space-3);
	}

	.lore-workspace-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding-bottom: var(--space-2);
		border-bottom: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
	}

	.lore-workspace-title {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.lore-workspace-title svg {
		color: var(--accent-primary);
	}

	.lore-workspace-title h2 {
		margin: 0;
		font-size: var(--font-size-lg);
		color: var(--text-heading);
	}

	.lore-workspace-title p {
		margin: 0;
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.new-code-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-sm);
		background: var(--accent-primary);
		color: white;
		border: none;
		cursor: pointer;
		font-size: var(--font-size-sm);
		font-weight: 600;
		transition: background var(--duration-fast) var(--ease-out);
		white-space: nowrap;
	}

	.new-code-btn:hover {
		background: var(--accent-secondary);
	}

	.lore-empty {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		text-align: center;
		color: var(--text-muted);
	}

	.lore-empty svg {
		opacity: 0.4;
	}

	.lore-empty h3 {
		margin: 0;
		font-size: var(--font-size-lg);
		color: var(--text-heading);
	}

	.lore-empty p {
		margin: 0;
		max-width: 420px;
		font-size: var(--font-size-sm);
		line-height: 1.6;
	}

	.lore-empty-hint {
		font-size: var(--font-size-xs) !important;
		opacity: 0.8;
	}

	.lore-channel-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: var(--space-2);
		overflow-y: auto;
		padding-bottom: var(--space-3);
	}

	.lore-channel-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--space-1);
		padding: var(--space-3);
		background: var(--surface-raised);
		border: 1px solid color-mix(in srgb, var(--text-muted) 15%, transparent);
		border-radius: var(--radius-md);
		cursor: pointer;
		text-align: left;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.lore-channel-card:hover {
		border-color: color-mix(in srgb, var(--accent-primary) 40%, transparent);
		transform: translateY(-1px);
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
	}

	.lore-card-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
		color: var(--accent-primary);
	}

	.lore-card-name {
		font-weight: 600;
		color: var(--text-heading);
		font-size: var(--font-size-sm);
		margin-top: var(--space-1);
	}

	.lore-card-meta {
		font-size: var(--font-size-xs);
		color: var(--text-muted);
	}

	.lore-card-open {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-top: var(--space-1);
		font-size: var(--font-size-xs);
		color: var(--accent-primary);
		opacity: 0;
		transition: opacity var(--duration-fast) var(--ease-out);
	}

	.lore-channel-card:hover .lore-card-open {
		opacity: 1;
	}
</style>