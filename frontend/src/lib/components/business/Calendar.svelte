<script lang="ts">
	import CalendarImpl from './CalendarImpl.svelte';

	export let isReadOnly = false;
</script>

<CalendarImpl {isReadOnly} />
