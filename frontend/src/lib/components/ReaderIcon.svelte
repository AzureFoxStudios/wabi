<script lang="ts">
	let { name, size = 18 }: { name: string; size?: number } = $props();
	const paths: Record<string, string[]> = {
		book: ['M4 3h12a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V3Z', 'M4 17h14M8 7h6M8 10h6'],
		file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z', 'M14 2v6h6M8 13h8M8 17h6'],
		search: ['M21 21l-5-5', 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z'],
		bookmark: ['M6 3h12v18l-6-4-6 4V3Z'],
		notes: ['M12 20H4V4h12v4M10 16l2-5 6-6 3 3-6 6-5 2Z'],
		contents: ['M8 6h12M8 12h12M8 18h12M3 6h1M3 12h1M3 18h1'],
		image: ['M3 3h18v18H3V3Z', 'm3 17 5-5 4 4 4-6 5 7M8 7h.01'],
		paste: ['M9 4H5v17h14V4h-4M9 2h6v5H9V2Z'],
		theme: ['M12 3a9 9 0 1 0 9 9A7 7 0 0 1 12 3Z'],
		focus: ['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'],
		close: ['m6 6 12 12M6 18 18 6'],
		left: ['m15 5-7 7 7 7'],
		right: ['m9 5 7 7-7 7'],
		plus: ['M12 5v14M5 12h14'],
		trash: ['M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7'],
		clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 7v5l3 2'],
		pages: ['M3 4h8v16H3V4ZM13 4h8v16h-8V4Z'],
		scroll: ['M5 3h14v18H5V3ZM8 7h8M8 11h8M8 15h6']
	};
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
	{#each paths[name] || paths.book as d}<path {d}></path>{/each}
</svg>
