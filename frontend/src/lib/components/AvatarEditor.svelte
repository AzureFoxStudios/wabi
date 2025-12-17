<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let isOpen = false;

	const dispatch = createEventDispatcher();

	let imageFile: File | null = null;
	let previewUrl: string | null = null;
	let error = '';
	let fileInput: HTMLInputElement;

	// Reset state when modal opens/closes
	$: if (isOpen) {
		imageFile = null;
		previewUrl = null;
		error = '';
		if (fileInput) fileInput.value = ''; // Clear file input on modal open
	}

	function closeModal() {
		isOpen = false;
		imageFile = null;
		previewUrl = null;
		error = '';
		if (fileInput) fileInput.value = '';
	}

	function handleFileInput(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];

		if (file) {
			if (!['image/jpeg', 'image/gif', 'image/png'].includes(file.type)) {
				error = 'Please select a JPG, GIF, or PNG file.';
				imageFile = null;
				previewUrl = null;
				return;
			}
			if (file.size > 5 * 1024 * 1024) {
				error = 'File is too large. Please select an image under 5MB.';
				imageFile = null;
				previewUrl = null;
				return;
			}

			error = '';
			imageFile = file;
			const reader = new FileReader();
			reader.onload = (e) => {
				previewUrl = e.target?.result as string;
			};
			reader.readAsDataURL(file);
		} else {
			imageFile = null;
			previewUrl = null;
		}
	}

	function confirmSelection() {
		if (!imageFile || !previewUrl) {
			error = 'Please select an image first.';
			return;
		}

		// Dispatch the selected file and its data URL
		dispatch('change', { file: imageFile, dataUrl: previewUrl });
		closeModal();
	}
</script>

{#if isOpen}
	<!-- svelte-ignore a11y-click-events-have-key-events -->
	<!-- svelte-ignore a11y-no-static-element-interactions -->
	<div class="modal-overlay" on:click={closeModal}>
		<div class="modal-content" on:click|stopPropagation>
			<div class="modal-header">
				<h2>Choose Profile Picture</h2>
				<button class="close-btn" on:click={closeModal}>&times;</button>
			</div>
			<div class="modal-body">
				<p class="instructions">Select a JPG, GIF, or PNG image (max 5MB)</p>
				<button class="choose-file-btn" on:click={() => fileInput?.click()}>
					{imageFile ? 'Change Image' : 'Choose Image'}
				</button>
				<input
					bind:this={fileInput}
					type="file"
					accept="image/jpeg,image/gif,image/png"
					on:change={handleFileInput}
					style="display: none;"
				/>

				{#if previewUrl}
					<div class="preview-container">
						<img src={previewUrl} alt="Profile picture preview" class="avatar-preview" />
					</div>
				{/if}
				{#if error}
					<p class="error">{error}</p>
				{/if}
			</div>
			<div class="modal-footer">
				<button class="cancel-btn" on:click={closeModal}>Cancel</button>
				<button class="confirm-btn" on:click={confirmSelection} disabled={!imageFile}>Use This Image</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.modal-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: var(--modal-overlay);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1001;
		backdrop-filter: blur(4px);
	}

	.modal-content {
		background: var(--modal-bg);
		border-radius: 12px;
		width: 90%;
		max-width: 400px;
		box-shadow: 0 8px 32px 0 var(--shadow-lg);
		overflow: hidden;
		border: var(--modal-border);
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1.25rem 1.5rem;
		background-color: var(--modal-header-bg);
		border-bottom: var(--modal-border);
	}

	.modal-header h2 {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--modal-text);
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 1.75rem;
		color: var(--modal-text-secondary);
		cursor: pointer;
		line-height: 1;
		padding: 0;
	}

	.close-btn:hover {
		color: var(--modal-text);
	}

	.modal-body {
		padding: 2rem 1.5rem;
		color: var(--modal-text);
		text-align: center;
	}

	.instructions {
		margin: 0 0 1.5rem 0;
		color: var(--text-secondary);
	}

	.choose-file-btn {
		padding: 1rem 2rem;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.2s;
		margin-bottom: 1.5rem;
	}

	.choose-file-btn:hover {
		background: var(--accent-hover);
	}

	.preview-container {
		display: flex;
		justify-content: center;
		margin-bottom: 1rem;
	}

	.avatar-preview {
		width: 150px;
		height: 150px;
		border-radius: 50%;
		object-fit: cover;
		border: 3px solid var(--accent);
	}

	.error {
		color: var(--color-danger);
		margin-top: 1rem;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		padding: 1.25rem 1.5rem;
		border-top: var(--modal-border);
		background-color: var(--modal-header-bg);
	}

	.cancel-btn, .confirm-btn {
		padding: 0.625rem 1.25rem;
		border-radius: 8px;
		font-weight: 500;
		font-size: 0.875rem;
		cursor: pointer;
		transition: all 0.2s;
		border: none;
	}

	.cancel-btn {
		background: var(--ui-bg-light);
		color: var(--text-primary);
	}

	.cancel-btn:hover {
		background-color: var(--bg-hover);
	}

	.confirm-btn {
		background: var(--accent);
		color: white;
	}

	.confirm-btn:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.confirm-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
