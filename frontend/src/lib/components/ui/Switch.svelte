<!--
	Switch (design contract §7.6): kit `.w-switch`, a button with role=switch and aria-checked.
	Always paired with a visible label in a settings row: point `labelledby` at that label's id,
	or wrap/associate it with <label for={id}> (clicking the label toggles the switch). `label`
	is the fallback accessible name when no visible label can be referenced. No ON/OFF text.

	<span id="motion-label">Reduce motion</span>
	<Switch labelledby="motion-label" bind:checked={reduceMotion} />
-->
<script lang="ts">
	interface Props {
		checked?: boolean;
		label?: string;
		labelledby?: string;
		describedby?: string;
		disabled?: boolean;
		id?: string;
		name?: string;
		class?: string;
		onchange?: (checked: boolean) => void;
	}

	let {
		checked = $bindable(false),
		label,
		labelledby,
		describedby,
		disabled = false,
		id,
		name,
		class: className = '',
		onchange
	}: Props = $props();

	function toggle() {
		if (disabled) return;
		checked = !checked;
		onchange?.(checked);
	}
</script>

<button
	{id}
	{name}
	type="button"
	role="switch"
	class={['w-switch', className]}
	aria-checked={checked}
	aria-label={labelledby ? undefined : label}
	aria-labelledby={labelledby}
	aria-describedby={describedby}
	{disabled}
	onclick={toggle}
></button>
