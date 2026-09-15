<script lang="ts">
	import { mapTokens } from './tokenStore';

	export let placeId: string | null = null;
	export let layerId: string | null = null;
	export let compact = false;

	let label = '';
	let glyph = '●';
	let color = '#ff9f43';

	$: visibleTokens = $mapTokens.filter((token) =>
		placeId && token.placeId === placeId && (!layerId || !token.layerId || token.layerId === layerId)
	);

	function addToken() {
		if (!placeId) return;
		const clean = label.trim() || `Token ${visibleTokens.length + 1}`;
		mapTokens.add({
			placeId,
			layerId,
			x: 0.5,
			y: 0.5,
			label: clean,
			glyph: glyph.trim() || '●',
			color,
			ownerId: null,
			visibility: 'everyone'
		});
		label = '';
	}
</script>

<section class:compact class="token-board" aria-label="Map board tokens">
	<header>
		<div>
			<strong>Board tokens</strong>
			<small>Movable shared-object groundwork for STDB/WabiDB sync.</small>
		</div>
		<span class="count">{visibleTokens.length}</span>
	</header>

	{#if placeId}
		<div class="new-token-row">
			<input bind:value={glyph} maxlength="3" aria-label="Token glyph" class="glyph-input" />
			<input bind:value={label} placeholder="Team A, Booth 12, William…" aria-label="Token label" />
			<input bind:value={color} type="color" aria-label="Token color" class="color-input" />
			<button type="button" on:click={addToken}>Add</button>
		</div>

		{#if visibleTokens.length}
			<div class="token-list">
				{#each visibleTokens as token (token.id)}
					<div class="token-row">
						<span class="chip" style={`--token-color:${token.color}`}>{token.glyph}</span>
						<div class="token-copy">
							<strong>{token.label}</strong>
							<small>{Math.round(token.x * 100)}%, {Math.round(token.y * 100)}%</small>
						</div>
						<div class="nudge" aria-label={`Move ${token.label}`}>
							<button title="Left" on:click={() => mapTokens.move(token.id, token.x - 0.05, token.y)}>←</button>
							<button title="Up" on:click={() => mapTokens.move(token.id, token.x, token.y - 0.05)}>↑</button>
							<button title="Down" on:click={() => mapTokens.move(token.id, token.x, token.y + 0.05)}>↓</button>
							<button title="Right" on:click={() => mapTokens.move(token.id, token.x + 0.05, token.y)}>→</button>
						</div>
						<button class="remove" title="Remove token" on:click={() => mapTokens.remove(token.id)}>×</button>
					</div>
				{/each}
			</div>
		{:else}
			<p class="empty">No board tokens on this map yet.</p>
		{/if}
	{:else}
		<p class="empty">Choose a place to use the shared board.</p>
	{/if}
</section>

<style>
	.token-board { border:1px solid var(--border-subtle); border-radius:var(--radius-lg); background:color-mix(in srgb,var(--surface-raised) 82%,transparent); padding:.75rem; display:flex; flex-direction:column; gap:.65rem; }
	header { display:flex; justify-content:space-between; gap:.75rem; align-items:flex-start; }
	header strong, .token-copy strong { color:var(--text-heading); }
	header small, .token-copy small, .empty { color:var(--text-muted); font-size:var(--font-size-xs); }
	header div, .token-copy { display:flex; flex-direction:column; gap:.1rem; min-width:0; }
	.count { background:var(--surface-hover); border-radius:999px; padding:.15rem .45rem; color:var(--text-secondary); font-size:var(--font-size-xs); }
	.new-token-row { display:grid; grid-template-columns:2.75rem 1fr 2.75rem auto; gap:.35rem; }
	input, button { border:1px solid var(--border-subtle); border-radius:var(--radius-md); background:var(--surface-base); color:var(--text-primary); padding:.45rem .55rem; }
	button { cursor:pointer; }
	button:hover { border-color:var(--accent-primary-color); background:var(--surface-hover); }
	.glyph-input { text-align:center; }
	.color-input { padding:.2rem; min-width:0; width:100%; }
	.token-list { display:flex; flex-direction:column; gap:.35rem; }
	.token-row { display:grid; grid-template-columns:auto 1fr auto auto; gap:.5rem; align-items:center; padding:.4rem; border-radius:var(--radius-md); background:color-mix(in srgb,var(--surface-base) 78%,transparent); }
	.chip { width:2rem; height:2rem; border-radius:50%; display:grid; place-items:center; background:var(--token-color); color:#111; box-shadow:0 2px 10px rgba(0,0,0,.25); font-weight:800; }
	.nudge { display:grid; grid-template-columns:repeat(2,1.75rem); gap:.15rem; }
	.nudge button, .remove { padding:.15rem; width:1.75rem; height:1.75rem; }
	.remove { color:var(--text-danger,#ff6b6b); }
	.compact .new-token-row { grid-template-columns:2.4rem 1fr auto; }
	.compact .color-input { display:none; }
	.compact .token-row { grid-template-columns:auto 1fr auto; }
	.compact .nudge { display:none; }
</style>
