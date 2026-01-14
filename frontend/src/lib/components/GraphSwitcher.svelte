<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let currentGraph: 'workspace' | 'personal' = 'workspace';

	const dispatch = createEventDispatcher();

	function switchGraph(type: 'workspace' | 'personal') {
		currentGraph = type;
		dispatch('graph-change', { type });
	}
</script>

<div class="graph-switcher">
	<button
			class="switch-btn {currentGraph === 'workspace' ? 'active' : ''}"
			onclick={() => switchGraph('workspace')}>
		🏢 Workspace Graph
	</button>
	<button
			class="switch-btn {currentGraph === 'personal' ? 'active' : ''}"
			onclick={() => switchGraph('personal')}>
		👤 Personal Graph
	</button>
</div>

<style>
	.graph-switcher {
		display: flex;
		gap: 8px;
		margin-bottom: 16px;
	}

	.switch-btn {
		padding: 8px 16px;
		background: transparent;
		border: 1px solid #444;
		border-radius: 4px;
		color: #fff;
		cursor: pointer;
		transition: all 0.2s;
		font-size: 14px;
	}

	.switch-btn:hover {
		background: #3a3a3e;
		border-color: #6366f1;
	}

	.switch-btn.active {
		background: #6366f1;
		border-color: #6366f1;
		font-weight: bold;
	}
</style>
