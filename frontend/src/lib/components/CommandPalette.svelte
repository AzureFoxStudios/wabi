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
		background: var(--surface-base, #1a1a2e);
		border: 1px solid var(--border-subtle, #24243e);
		border-bottom: none;
		border-radius: var(--radius-md, 8px) var(--radius-md, 8px) 0 0;
		max-height: var(--popover-max-height, 300px);
		overflow-y: auto;
		z-index: var(--z-popover, 500);
		box-shadow: var(--shadow-top, 0 -4px 12px rgba(0, 0, 0, 0.25));
	}

	.command-item {
		display: flex;
		flex-direction: column;
		gap: var(--space-1, 4px);
		width: 100%;
		padding: var(--space-3, 12px) var(--space-4, 16px);
		background: transparent;
		border: none;
		border-bottom: 1px solid var(--border-subtle, #24243e);
		color: var(--text-heading, #e0e0ff);
		text-align: left;
		cursor: pointer;
		transition: background var(--duration-fast, 150ms) ease;
	}

	.command-item:last-child {
		border-bottom: none;
	}

	.command-item:hover,
	.command-item.selected {
		background: var(--surface-raised, #24243e);
	}

	.command-item:active {
		background: var(--surface-active, #0f0c29);
	}

	.command-name {
		font-weight: var(--font-weight-semibold, 600);
		font-size: var(--text-base, 14px);
		color: var(--color-info, #3b82f6);
		display: flex;
		gap: var(--space-2, 8px);
		align-items: center;
	}

	.aliases {
		font-weight: var(--font-weight-regular, 400);
		font-size: var(--text-sm, 13px);
		color: var(--text-secondary, #b3b3ff);
	}

	.command-desc {
		font-size: var(--text-sm, 13px);
		color: var(--text-secondary, #b3b3ff);
	}

	.command-usage {
		font-size: var(--text-xs, 11px);
		color: var(--text-muted, #9999ff);
		font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', Consolas, Monaco, monospace);
	}

	@media (prefers-reduced-motion: reduce) {
		.command-item {
			transition: none;
		}
	}
</style>
