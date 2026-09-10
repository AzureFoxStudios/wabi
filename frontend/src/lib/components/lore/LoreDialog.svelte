<script lang="ts">
	import { onMount, onDestroy, type Snippet } from 'svelte';
	let { title, onClose, busy = false, children }: { title: string; onClose: () => void; busy?: boolean; children: Snippet } = $props();
	let dialog: HTMLDialogElement;
	onMount(() => dialog.showModal());
	onDestroy(() => { if (dialog?.open) dialog.close(); });
</script>
<dialog bind:this={dialog} class="lw-dialog" aria-label={title} oncancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
	<header class="lw-dialog-head"><h2>{title}</h2><button class="lw-icon-button" disabled={busy} onclick={onClose} aria-label={`Close ${title}`}>×</button></header>
	{@render children()}
</dialog>
