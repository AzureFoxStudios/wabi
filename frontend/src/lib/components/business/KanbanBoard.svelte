<script lang="ts">
	import KanbanBoardImpl from './KanbanBoardImpl.svelte';

	export let showTaskPanel = false;
	export let taskPanelWidth = 380;
	export let isReadOnly = false;
</script>

<KanbanBoardImpl {showTaskPanel} {taskPanelWidth} {isReadOnly} />
