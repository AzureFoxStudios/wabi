<script lang="ts">
	import '../app.css';
	import '$lib/prism-theme.css';
	import type { PageData } from './$types';

	// Accept data prop to suppress warning (we don't use it in root layout)
	export let data: PageData;
</script>

<slot />
