<!-- Stands in for LinkPreview.svelte in render tests: marks where a server preview would mount. -->
<script>
	export let url = '';
</script>
<div data-link-preview={url}></div>
