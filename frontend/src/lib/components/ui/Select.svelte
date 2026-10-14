<!--
	Select (design contract §7.4): the kit `.w-select` trigger plus the one menu, replacing native
	<select> in chrome.

	- Trigger: 32px on --w-lift, an optional --w-mute label prefix ("Project"), the value in
	  --w-text and a 16px chevron. `applied` marks a filter that narrows what you see
	  (--w-accent-soft fill, 45% accent edge).
	- Menu: one menuitemradio per option with a --w-sig check on the chosen one, optional kicker
	  groups (`group`), icons, hints and maturity tags. It opens with focus on the chosen option;
	  ↑/↓ on the closed trigger open it too. On phones it opens as a bottom sheet.

	<Select label="Project" options={projects} bind:value={projectId} applied={projectId !== 'all'} />
	<Select ariaLabel="Language" options={languages} bind:value={locale} onchange={setLocale} />
-->
<script module lang="ts">
	import type { IconName } from './icons';

	export interface SelectOption {
		value: string;
		label: string;
		/** One word in the trailing slot; longer hints become a second line. */
		hint?: string;
		icon?: IconName;
		/** Kicker of the group this option belongs to; consecutive options share it. */
		group?: string;
		/** Maturity word ("PREVIEW"), with `tagTitle` as its explanation. */
		tag?: string;
		tagTitle?: string;
		disabled?: boolean;
	}

	let selectCounter = 0;
</script>

<script lang="ts">
	import type { MenuEntry } from '$lib/components/context-menu/ContextMenu.svelte';
	import ContextMenu from '$lib/components/context-menu/ContextMenu.svelte';
	import Icon from './Icon.svelte';

	interface Props {
		options: SelectOption[];
		value?: string;
		/** Visible prefix inside the trigger ("Project"); also names the control. */
		label?: string;
		/** Accessible name when there is no visible prefix ("Language"). */
		ariaLabel?: string;
		/** Shown when no option matches `value`. */
		placeholder?: string;
		/** The value narrows what is shown (an applied filter). */
		applied?: boolean;
		disabled?: boolean;
		align?: 'start' | 'end';
		/** Title of the phone sheet (defaults to the label). */
		heading?: string;
		id?: string;
		class?: string;
		onchange?: (value: string) => void;
	}

	let {
		options,
		value = $bindable(''),
		label,
		ariaLabel,
		placeholder = 'Choose…',
		applied = false,
		disabled = false,
		align = 'start',
		heading,
		id,
		class: className = '',
		onchange
	}: Props = $props();

	const menuId = `w-select-menu-${++selectCounter}`;
	let trigger = $state<HTMLButtonElement | null>(null);
	let open = $state(false);
	let rect = $state<{ left: number; top: number; right: number; bottom: number } | null>(null);

	const current = $derived(options.find((option) => option.value === value));
	const valueText = $derived(current?.label ?? placeholder);
	const accessibleName = $derived(label ? undefined : ariaLabel ? `${ariaLabel}: ${valueText}` : undefined);

	const items = $derived.by(() => {
		const entries: MenuEntry[] = [];
		let group: string | undefined;
		options.forEach((option, index) => {
			if (option.group && option.group !== group) entries.push({ id: `kicker-${index}`, type: 'kicker', label: option.group });
			group = option.group;
			entries.push({
				id: `option-${index}`,
				label: option.label,
				icon: option.icon,
				hint: option.hint,
				tag: option.tag,
				tagTitle: option.tagTitle,
				role: 'menuitemradio',
				checked: option.value === value,
				disabled: option.disabled,
				keepCase: true,
				onSelect: () => choose(option.value)
			});
		});
		return entries;
	});

	function choose(next: string) {
		if (next === value) return;
		value = next;
		onchange?.(next);
	}

	function openMenu() {
		if (disabled || open || !trigger) return;
		const box = trigger.getBoundingClientRect();
		rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
		open = true;
	}

	function closeMenu() {
		open = false;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			openMenu();
		}
	}
</script>

<button
	bind:this={trigger}
	{id}
	type="button"
	class="w-select {className}"
	class:w-select--applied={applied}
	aria-haspopup="menu"
	aria-expanded={open}
	aria-controls={open ? menuId : undefined}
	aria-label={accessibleName}
	{disabled}
	onclick={() => (open ? closeMenu() : openMenu())}
	onkeydown={handleKeydown}
>
	{#if label}<span class="w-select__label">{label}</span>{/if}
	<span class="w-select__value">{valueText}</span>
	<Icon name="chevDown" size={16} />
</button>

<ContextMenu
	open={open && !!rect}
	{items}
	anchor={rect}
	{align}
	{menuId}
	minWidth={160}
	ariaLabel={heading ?? label ?? ariaLabel ?? 'Options'}
	headerLabel={null}
	initialFocus="checked"
	returnFocus={trigger}
	onClose={closeMenu}
/>
