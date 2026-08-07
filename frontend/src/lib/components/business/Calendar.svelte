<script lang="ts">
	import CalendarImpl from './CalendarImpl.svelte';

	export let isReadOnly = false;
	export let embedded = false;
	export let addSignal = 0;
</script>

<CalendarImpl {isReadOnly} {embedded} {addSignal} />
