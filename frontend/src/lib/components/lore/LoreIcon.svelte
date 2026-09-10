<script lang="ts">
	let { name, size = 18 }: { name: string; size?: number } = $props();
	const paths: Record<string, string> = {
		file: 'M14 2H6a2 2 0 0 0-2 2v16h16V8z M14 2v6h6 M8 13h8 M8 17h6',
		folder: 'M3 7V5h6l2 2h10v13H3z',
		branch: 'M6 6v12 M18 6v4a4 4 0 0 1-4 4H6 M4 4h4v4H4z M16 4h4v4h-4z M4 16h4v4H4z',
		changes: 'M5 4v16 M2 7l3-3 3 3 M19 20V4 M16 17l3 3 3-3 M10 8h4 M10 16h4',
		history: 'M3 11a9 9 0 1 1 3 8 M3 4v7h7 M12 7v5l3 2',
		review: 'M5 3h14v18H5z M8 11l3 3 5-6',
		settings: 'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M5.6 18.4l2.1-2.1 M16.3 7.7l2.1-2.1 M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
		download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
		plus: 'M12 5v14 M5 12h14',
		close: 'M6 6l12 12 M18 6 6 18',
		tools: 'M5 4h14v16H5z M8 8l3 3-3 3 M13 15h3',
		refresh: 'M20 8a8 8 0 0 0-14-3L3 8 M3 3v5h5 M4 16a8 8 0 0 0 14 3l3-3 M16 16h5v5',
		shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z M8 12l3 3 5-6',
		chevron: 'M8 10l4 4 4-4',
		menu: 'M4 6h16 M4 12h16 M4 18h16'
	};
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.file} /></svg>
