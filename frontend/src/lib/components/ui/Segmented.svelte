<!--
	Segmented control (design contract §7.5): kit `.w-seg`, the selected key is paper, never an
	accent fill. 2–5 options; more belong in a select.

	mode="radio" (default): one value out of a set. role=radiogroup with role=radio keys and a
	roving tabindex: Tab enters on the checked key; ←/→ (↑/↓) and Home/End move and select,
	skipping disabled keys.
	mode="pressed": a view switch. A role=group of toggle buttons with aria-pressed; each key is
	its own tab stop and Space/Enter selects it.

	<Segmented label="Theme mode" options={[{ value: 'dark', label: 'Dark' }, …]} bind:value />
-->
<script module lang="ts">
	import type { IconName } from './icons';

	export interface SegmentedOption<V> {
		value: V;
		label: string;
		icon?: IconName;
		/** Hide the visible label (the label still names the key for assistive tech). */
		iconOnly?: boolean;
		disabled?: boolean;
		/** Native tooltip text; prefer the Tooltip primitive for anything longer than a word. */
		title?: string;
	}
</script>

<script lang="ts" generics="T extends string | number">
	import Icon from './Icon.svelte';

	interface Props {
		options: SegmentedOption<T>[];
		value?: T;
		/** Accessible name of the group (use labelledby when a visible label exists). */
		label?: string;
		labelledby?: string;
		mode?: 'radio' | 'pressed';
		vertical?: boolean;
		disabled?: boolean;
		class?: string;
		id?: string;
		onchange?: (value: T) => void;
	}

	let {
		options,
		value = $bindable(),
		label,
		labelledby,
		mode = 'radio',
		vertical = false,
		disabled = false,
		class: className = '',
		id,
		onchange
	}: Props = $props();

	let keys: HTMLButtonElement[] = $state([]);

	const enabled = (option: SegmentedOption<T>) => !disabled && !option.disabled;
	const selectedIndex = $derived(options.findIndex((option) => option.value === value));
	// The one key Tab lands on: the checked key when it can take focus, else the first enabled key.
	const tabIndex = $derived(
		selectedIndex >= 0 && enabled(options[selectedIndex]) ? selectedIndex : options.findIndex(enabled)
	);

	function choose(option: SegmentedOption<T>) {
		if (!enabled(option) || option.value === value) return;
		value = option.value;
		onchange?.(option.value);
	}

	function onKeydown(event: KeyboardEvent, index: number) {
		if (mode !== 'radio') return;
		const forward = ['ArrowRight', 'ArrowDown'].includes(event.key);
		const backward = ['ArrowLeft', 'ArrowUp'].includes(event.key);
		let target = -1;
		if (event.key === 'Home') target = options.findIndex(enabled);
		else if (event.key === 'End') target = options.findLastIndex(enabled);
		else if (forward || backward) {
			const step = forward ? 1 : -1;
			for (let i = 1; i <= options.length; i++) {
				const candidate = (index + step * i + options.length) % options.length;
				if (enabled(options[candidate])) {
					target = candidate;
					break;
				}
			}
		} else return;
		event.preventDefault();
		if (target < 0) return;
		choose(options[target]);
		keys[target]?.focus();
	}
</script>

<div
	{id}
	class={['w-seg', vertical && 'w-seg--vertical', className]}
	role={mode === 'radio' ? 'radiogroup' : 'group'}
	aria-label={labelledby ? undefined : label}
	aria-labelledby={labelledby}
	aria-orientation={mode === 'radio' ? (vertical ? 'vertical' : 'horizontal') : undefined}
	aria-disabled={disabled || undefined}
>
	{#each options as option, index (option.value)}
		{@const selected = option.value === value}
		<button
			bind:this={keys[index]}
			type="button"
			role={mode === 'radio' ? 'radio' : undefined}
			aria-checked={mode === 'radio' ? selected : undefined}
			aria-pressed={mode === 'pressed' ? selected : undefined}
			aria-label={option.iconOnly ? option.label : undefined}
			tabindex={mode === 'radio' ? (index === tabIndex ? 0 : -1) : undefined}
			disabled={!enabled(option)}
			title={option.title}
			onclick={() => choose(option)}
			onkeydown={(event) => onKeydown(event, index)}
		>
			{#if option.icon}<Icon name={option.icon} size={14} />{/if}
			{#if !option.iconOnly}<span>{option.label}</span>{/if}
		</button>
	{/each}
</div>
