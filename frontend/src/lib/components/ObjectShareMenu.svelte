<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { ObjectRefRecord } from '$lib/objectRefRegistry';
	import { openShareModal } from '$lib/shareStore';
	import { buildShareLink, buildShareRefText, copyToClipboard } from '$lib/shareToChannel';

	export let record: ObjectRefRecord;

	let open = false;
	let menuEl: HTMLDivElement | undefined = undefined;
	let triggerEl: HTMLButtonElement | undefined = undefined;

	function handleWindowClick(e: MouseEvent) {
		const target = e.target as Node;
		if (
			open &&
			menuEl &&
			!menuEl.contains(target) &&
			triggerEl &&
			!triggerEl.contains(target)
		) {
			open = false;
		}
	}

	$: if (typeof window !== 'undefined') {
		if (open) {
			window.addEventListener('click', handleWindowClick);
		} else {
			window.removeEventListener('click', handleWindowClick);
		}
	}

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('click', handleWindowClick);
		}
	});

	function handleShareToChannel() {
		openShareModal(record);
		open = false;
	}

	async function handleCopyLink() {
		await copyToClipboard(buildShareLink(record));
		open = false;
	}

	async function handleCopyRef() {
		await copyToClipboard(buildShareRefText(record));
		open = false;
	}
</script>

<div class="share-menu-wrapper" style="position:relative;display:inline-flex">
	<button
		class="share-menu-trigger"
		on:click|stopPropagation={() => { open = !open; }}
		bind:this={triggerEl}
		aria-label="Share options"
		aria-haspopup="true"
		aria-expanded={open}
	>
		⋯
	</button>
	{#if open}
		<div class="share-menu" bind:this={menuEl} role="menu">
			<button class="share-menu-item" on:click={handleShareToChannel} role="menuitem">
				Share to channel&hellip;
			</button>
			<button class="share-menu-item" on:click={handleCopyLink} role="menuitem">
				Copy link
			</button>
			<button class="share-menu-item" on:click={handleCopyRef} role="menuitem">
				Copy ref
			</button>
		</div>
	{/if}
</div>
