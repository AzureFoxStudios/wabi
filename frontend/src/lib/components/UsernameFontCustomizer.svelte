<script lang="ts">
	import { currentUser, getSocket, connected } from '../socket';
	import { getWabiDB } from '$lib/wabidb';
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';

	const fontFamilies = ['Arial', 'Georgia', 'Times New Roman', 'Comic Sans MS', 'Courier New', 'Trebuchet MS', 'Verdana', 'Impact', 'Palatino', 'Helvetica'];
	const fontSizes = ['Small', 'Medium', 'Large', 'XL'];
	const fontWeights = ['Normal', 'Medium', 'Semi-Bold', 'Bold'];
	const fontStyles = ['Normal', 'Italic'];

	const sizeMap = { Small: '0.9em', Medium: '1em', Large: '1.2em', XL: '1.4em' };
	const weightMap = { Normal: '400', Medium: '500', 'Semi-Bold': '600', Bold: '700' };
	const styleMap = { Normal: 'normal', Italic: 'italic' };

	let selectedFamily = $currentUser?.usernameFont?.family || 'inherit';
	let selectedSize = Object.keys(sizeMap).find(key => sizeMap[key as keyof typeof sizeMap] === ($currentUser?.usernameFont?.size || 'inherit')) || 'Medium';
	let selectedWeight = Object.keys(weightMap).find(key => weightMap[key as keyof typeof weightMap] === ($currentUser?.usernameFont?.weight || '600')) || 'Semi-Bold';
	let selectedStyle = Object.keys(styleMap).find(key => styleMap[key as keyof typeof styleMap] === ($currentUser?.usernameFont?.style || 'normal')) || 'Normal';

	let isSaving = false;
	let saveError: string | null = null;
	let saveOk = false;
	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	function onProfileUpdated() {
		isSaving = false;
		saveError = null;
		saveOk = true;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => (saveOk = false), 2200);
	}

	function onProfileFailed(error: { reason?: string; message?: string } | string) {
		isSaving = false;
		const msg = typeof error === 'string' ? error : error?.reason || error?.message || 'Update failed';
		saveError = msg;
	}

	onMount(() => {
		const socket = getSocket();
		if (!socket) return;
		socket.on('profile-updated', onProfileUpdated);
		socket.on('profile-update-failed', onProfileFailed);
		return () => {
			socket.off('profile-updated', onProfileUpdated);
			socket.off('profile-update-failed', onProfileFailed);
			if (saveTimer) clearTimeout(saveTimer);
		};
	});

	$: previewStyle = `
		font-family: ${selectedFamily !== 'inherit' ? selectedFamily : 'inherit'};
		font-size: ${sizeMap[selectedSize as keyof typeof sizeMap]};
		font-weight: ${weightMap[selectedWeight as keyof typeof weightMap]};
		font-style: ${styleMap[selectedStyle as keyof typeof styleMap]};
		color: ${$currentUser?.color || '#ffffff'};
	`;

	async function handleSave() {
		const sock = getSocket();
		if (!$currentUser || !sock) {
			saveError = 'Not connected — cannot save.';
			return;
		}

		const usernameFont = {
			family: selectedFamily,
			size: sizeMap[selectedSize as keyof typeof sizeMap],
			weight: weightMap[selectedWeight as keyof typeof weightMap],
			style: styleMap[selectedStyle as keyof typeof styleMap]
		};

		isSaving = true;
		saveError = null;
		saveOk = false;

		// Optimistic local apply so chat usernames update immediately.
		currentUser.update((u) => (u ? { ...u, usernameFont } : u));

		const db = getWabiDB();
		const online = get(connected);
		if (db && !online) {
			await db.enqueue({ scopeId: 'corechat', type: 'update-profile', payload: { usernameFont } });
			isSaving = false;
			saveOk = true;
			return;
		}

		sock.emit('update-profile', { usernameFont });

		// Safety: clear spinner if server never answers.
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			if (isSaving) {
				isSaving = false;
				saveOk = true;
			}
		}, 4000);
	}

	function handleReset() {
		selectedFamily = 'inherit';
		selectedSize = 'Medium';
		selectedWeight = 'Semi-Bold';
		selectedStyle = 'Normal';
		handleSave();
	}
</script>

<div class="font-customizer">
	<h3>Username Font</h3>
	<p class="hint">Shown on your name in chat. Others see it after save.</p>

	<div class="preview" style={previewStyle}>{$currentUser?.username || 'username'}</div>

	<label>
		Family
		<select bind:value={selectedFamily}>
			<option value="inherit">Default</option>
			{#each fontFamilies as f}<option value={f}>{f}</option>{/each}
		</select>
	</label>
	<label>
		Size
		<select bind:value={selectedSize}>
			{#each fontSizes as s}<option value={s}>{s}</option>{/each}
		</select>
	</label>
	<label>
		Weight
		<select bind:value={selectedWeight}>
			{#each fontWeights as w}<option value={w}>{w}</option>{/each}
		</select>
	</label>
	<label>
		Style
		<select bind:value={selectedStyle}>
			{#each fontStyles as s}<option value={s}>{s}</option>{/each}
		</select>
	</label>

	<div class="actions">
		<button type="button" class="primary" disabled={isSaving} on:click={handleSave}>{isSaving ? 'Saving…' : 'Save font'}</button>
		<button type="button" class="ghost" disabled={isSaving} on:click={handleReset}>Reset</button>
	</div>
	{#if saveOk}<p class="ok">Saved.</p>{/if}
	{#if saveError}<p class="err">{saveError}</p>{/if}
</div>

<style>
	.font-customizer { display: flex; flex-direction: column; gap: 0.65rem; }
	.hint { margin: 0; color: var(--text-secondary); font-size: 0.82rem; }
	.preview {
		padding: 0.75rem 1rem;
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: var(--surface-raised);
	}
	label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; font-weight: 650; color: var(--text-secondary); }
	select {
		padding: 0.45rem 0.55rem;
		border-radius: 8px;
		border: 1px solid var(--border-subtle);
		background: var(--surface-base);
		color: var(--text-heading);
	}
	.actions { display: flex; gap: 0.5rem; }
	.primary, .ghost {
		border-radius: 8px;
		padding: 0.45rem 0.85rem;
		font-weight: 650;
		cursor: pointer;
	}
	.primary {
		border: 1px solid rgba(var(--accent-rgb), 0.45);
		background: rgba(var(--accent-rgb), 0.18);
		color: var(--text-heading);
	}
	.ghost {
		border: 1px solid var(--border-subtle);
		background: transparent;
		color: var(--text-secondary);
	}
	.ok { color: #4ade80; margin: 0; font-size: 0.82rem; }
	.err { color: #f87171; margin: 0; font-size: 0.82rem; }
</style>
