<script lang="ts">
	import TodoListImpl from './TodoListImpl.svelte';

	export let isReadOnly = false;
</script>

<TodoListImpl {isReadOnly} />
