<script lang="ts">
	import { onDestroy } from 'svelte';
	import { decryptAttachmentBlob } from '$lib/e2ee';
	import { _ } from '$lib/i18n';
	import type { AttachmentEncryptionMeta } from '../../../../../packages/wabi-protocol/src';

	/**
	 * Image from an E2EE room, decrypted in the browser for display: the
	 * server only ever holds ciphertext and the room key never leaves the
	 * client. Streams a loading state while the file downloads + decrypts,
	 * and falls back to an honest "can't decrypt" card when the key or the
	 * metadata is unavailable on this device.
	 */
	export let channelId: string;
	export let url: string;
	export let encryption: AttachmentEncryptionMeta;
	export let alt = '';
	export let label = '';
	export let imgClass = '';
	export let spoiled = false;
	export let title: string | undefined = undefined;
	export let onActivate: (objectUrl: string) => void = () => {};
	export let onContextMenu: ((event: MouseEvent) => void) | undefined = undefined;

	let objectUrl = '';
	let failed = false;
	let disposed = false;
	let generation = 0;
	let loadedKey = '';

	onDestroy(() => {
		disposed = true;
		generation += 1;
		if (objectUrl) URL.revokeObjectURL(objectUrl);
	});

	// Key on primitive fields only: message updates (edits, reactions) replace
	// the message object, and an object-identity dependency would re-decrypt
	// on every one of them.
	$: decKey =
		channelId && encryption
			? `${channelId}|${url}|${encryption.fileId || ''}|${encryption.iv}|${encryption.epoch ?? ''}`
			: '';
	$: if (decKey && decKey !== loadedKey) void load(decKey);

	async function load(key: string): Promise<void> {
		const myGeneration = ++generation;
		try {
			// Same access model as a plain <img> tag would get.
			const response = await fetch(url);
			if (!response.ok) throw new Error(`fetch failed with ${response.status}`);
			const plain = await decryptAttachmentBlob(channelId, await response.blob(), encryption);
			if (disposed || myGeneration !== generation) return;
			loadedKey = key;
			failed = false;
			objectUrl = URL.createObjectURL(plain);
		} catch (error) {
			if (disposed || myGeneration !== generation) return;
			loadedKey = key; // Cache the failure so we never spin on retries.
			failed = true;
			console.error('E2EE image decrypt failed:', error);
		}
	}

	function handleClick(event: MouseEvent) {
		if (event.button !== 0 || failed || !objectUrl) return;
		onActivate(objectUrl);
	}
</script>

{#if objectUrl}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
	<img
		src={objectUrl}
		alt={alt || label}
		class={imgClass}
		data-spoiler={spoiled ? 'true' : 'false'}
		{title}
		on:click={handleClick}
		on:contextmenu={onContextMenu}
	/>
{:else if failed}
	<div class="e2ee-fallback" role="status">
		<span aria-hidden="true">🔒</span>
		<span>{label || alt || $_('messages.encrypted')}</span>
		<small>{$_('messages.encrypted')} · {$_('messages.errors.decrypt_failed')}</small>
	</div>
{:else}
	<div class="e2ee-loading" aria-hidden="true"><span></span></div>
{/if}

<style>
	.e2ee-loading,
	.e2ee-fallback {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		width: 100%;
		min-height: 90px;
		border-radius: var(--radius-md, 8px);
		overflow: hidden;
		background: var(--surface-app, #0f0c29);
		border: 1px solid var(--border-subtle, transparent);
	}

	.e2ee-fallback {
		padding: 1rem;
		text-align: center;
		font-size: 0.85rem;
		color: var(--text-secondary, #b3b3ff);
		overflow-wrap: anywhere;
	}

	.e2ee-fallback small {
		font-size: 0.72rem;
		color: var(--text-muted, #9999ff);
		opacity: 0.8;
	}

	.e2ee-loading span {
		position: absolute;
		inset: 0;
		background: linear-gradient(90deg, transparent, rgba(123, 104, 238, 0.1), transparent);
		transform: translateX(-100%);
		animation: e2ee-shimmer 1.5s infinite;
	}

	@keyframes e2ee-shimmer {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(100%);
		}
	}
</style>
