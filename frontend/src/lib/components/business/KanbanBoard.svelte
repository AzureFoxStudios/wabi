<script lang="ts">
	import KanbanBoardImpl from './KanbanBoardImpl.svelte';

	export let showTaskPanel = false;
	export let taskPanelWidth = 380;
	export let isReadOnly = false;
	export let embedded = false;
	export let addSignal = 0;
</script>

<KanbanBoardImpl {showTaskPanel} {taskPanelWidth} {isReadOnly} {embedded} {addSignal} />
