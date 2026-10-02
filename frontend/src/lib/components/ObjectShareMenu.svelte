<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { portal } from '$lib/actions/portal';
	import type { ObjectRefRecord } from '$lib/objectRefRegistry';
	import { openShareModal } from '$lib/shareStore';
	import { buildShareLink, buildShareRefText, copyToClipboard } from '$lib/shareToChannel';

	export let record: ObjectRefRecord;
	export let menuLabel = 'Share options';
	export let extraActions: { label: string; run: () => void }[] = [];

	let open = false;
	let menuLeft = 0;
	let menuTop = 0;
	async function toggleMenu() {
		open = !open;
		if (!open) return;
		await tick();
		if (!menuEl || !triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		menuLeft = Math.max(8, Math.min(rect.right - menuEl.offsetWidth, window.innerWidth - menuEl.offsetWidth - 8));
		menuTop = rect.bottom + menuEl.offsetHeight + 8 > window.innerHeight
			? Math.max(8, rect.top - menuEl.offsetHeight - 4) : rect.bottom + 4;
		menuEl.querySelector<HTMLButtonElement>('button')?.focus();
	}
	function dismissMenu() { open = false; }
	function menuKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open = false; triggerEl?.focus(); }
		if (e.key === 'Tab') open = false;
	}
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
<svelte:window on:resize={dismissMenu} on:scroll|capture={dismissMenu} />

<div class="share-menu-wrapper" style="position:relative;display:inline-flex">
	<button
		class="share-menu-trigger"
		on:click|stopPropagation={toggleMenu}
		bind:this={triggerEl}
		aria-label={menuLabel}
		aria-haspopup="true"
		aria-expanded={open}
	>
		⋯
	</button>
	{#if open}
		<div class="share-menu" use:portal={(document.fullscreenElement as HTMLElement) || document.body} bind:this={menuEl} role="menu" tabindex="-1" on:keydown={menuKeydown} on:click|stopPropagation style="position:fixed;left:{menuLeft}px;top:{menuTop}px;right:auto;z-index:1600">
			{#each extraActions as action}
				<button class="share-menu-item" role="menuitem" on:click={() => { open = false; action.run(); }}>{action.label}</button>
			{/each}
			<button class="share-menu-item" on:click={handleShareToChannel} role="menuitem">
				Share to channel&hellip;
			</button>
			<button class="share-menu-item" on:click={handleCopyLink} role="menuitem">
				Copy link
			</button>
			<button class="share-menu-item" on:click={handleCopyRef} role="menuitem">
				Copy reference
			</button>
		</div>
	{/if}
</div>
