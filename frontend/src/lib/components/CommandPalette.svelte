<script lang="ts">
	import { getMatchingCommands, type Command } from '$lib/commands';

	export let input: string = '';
	export let isVisible: boolean = false;
	export let selectedIndex: number = 0;
	export let onSelect: (command: Command) => void = () => {};

	$: matchingCommands = getMatchingCommands(input);
	$: if (matchingCommands.length > 0 && selectedIndex >= matchingCommands.length) {
		selectedIndex = 0;
	}

	function handleSelect(command: Command) {
		onSelect(command);
		isVisible = false;
		selectedIndex = 0;
	}

	function selectUp() {
		if (selectedIndex > 0) {
			selectedIndex--;
		} else {
			selectedIndex = Math.max(0, matchingCommands.length - 1);
		}
	}

	function selectDown() {
		if (selectedIndex < matchingCommands.length - 1) {
			selectedIndex++;
		} else {
			selectedIndex = 0;
		}
	}

	export function handleKeyDown(key: string) {
		if (!isVisible || matchingCommands.length === 0) return;

		switch (key) {
			case 'ArrowUp':
				selectUp();
				break;
			case 'ArrowDown':
				selectDown();
				break;
			case 'Enter':
				handleSelect(matchingCommands[selectedIndex]);
				return true;
			case 'Escape':
				isVisible = false;
				return true;
		}
		return false;
	}
</script>

{#if isVisible && matchingCommands.length > 0}
	<div class="command-palette">
		{#each matchingCommands as command, index}
			<button
				class="command-item"
				class:selected={index === selectedIndex}
				on:click={() => handleSelect(command)}
			>
				<div class="command-name">
					/{command.name}
					{#if command.aliases?.length}
						<span class="aliases">({command.aliases.join(', ')})</span>
					{/if}
				</div>
				<div class="command-desc">{command.description}</div>
				<div class="command-usage">{command.usage}</div>
			</button>
		{/each}
	</div>
{/if}

<style>
	.command-palette {
		position: absolute;
		bottom: 100%;
		left: 0;
		right: 0;
		background: var(--bg-secondary, #2a2a2e);
		border: 1px solid var(--border, #333);
		border-bottom: none;
		border-radius: 8px 8px 0 0;
		max-height: 300px;
		overflow-y: auto;
		z-index: 100;
		box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.25);
	}

	.command-item {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		padding: 12px 16px;
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--border, #333);
		color: var(--text-primary, #e0e0e0);
		text-align: left;
		cursor: pointer;
		transition: background 0.15s;
	}

	.command-item:last-child {
		border-bottom: none;
	}

	.command-item:hover,
	.command-item.selected {
		background: var(--bg-tertiary, #3a3a3e);
	}

	.command-name {
		font-weight: 600;
		font-size: 0.95rem;
		color: #6366f1;
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.aliases {
		font-weight: 400;
		font-size: 0.8rem;
		color: var(--text-secondary, #a0a0a0);
	}

	.command-desc {
		font-size: 0.85rem;
		color: var(--text-secondary, #a0a0a0);
	}

	.command-usage {
		font-size: 0.8rem;
		color: #808080;
		font-family: 'Monaco', 'Menlo', monospace;
	}
</style>
