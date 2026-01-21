<script lang="ts">
	import type { Theme } from '$lib/theme/themes';

	export let theme: Theme;

	// Create inline styles for the preview
	let previewStyles = '';

	$: {
		const styles: string[] = [];

		// Apply colors
		Object.entries(theme.colors).forEach(([key, value]) => {
			const cssVarName = `--${key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
			styles.push(`${cssVarName}: ${value}`);
		});

		// Apply gradients
		Object.entries(theme.gradients).forEach(([key, value]) => {
			const cssVarName = `--gradient-${key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
			styles.push(`${cssVarName}: ${value}`);
		});

		previewStyles = styles.join('; ');
	}
</script>

<div class="preview-wrapper" style={previewStyles}>
	<div class="preview-container">
		<div class="preview-header">
			<h3>{theme.name}</h3>
			<p>{theme.description}</p>
		</div>

		<!-- Mock Chat Message -->
		<div class="preview-chat">
			<div class="chat-message">
				<div class="message-bubble">
					<span class="message-author">User</span>
					<p>This is how messages will look in this theme.</p>
				</div>
			</div>

			<div class="chat-message own">
				<div class="message-bubble">
					<span class="message-author">You</span>
					<p>Your messages appear on the right with the accent color.</p>
				</div>
			</div>
		</div>

		<!-- Color Swatches -->
		<div class="swatches">
			<div class="swatch">
				<div class="swatch-color" style="background-color: {theme.colors.bgPrimary}" />
				<span>Background</span>
			</div>
			<div class="swatch">
				<div class="swatch-color" style="background-color: {theme.colors.textPrimary}" />
				<span>Text</span>
			</div>
			<div class="swatch">
				<div class="swatch-color" style="background-color: {theme.colors.accentHex}" />
				<span>Accent</span>
			</div>
			<div class="swatch">
				<div class="swatch-color" style="background-color: {theme.colors.statusOnline}" />
				<span>Online</span>
			</div>
		</div>

		<!-- UI Elements -->
		<div class="ui-elements">
			<button class="preview-button">Button</button>
			<input type="text" class="preview-input" placeholder="Input field" />
			<div class="preview-badge success">✓ Success</div>
			<div class="preview-badge danger">✗ Danger</div>
		</div>
	</div>
</div>

<style>
	.preview-wrapper {
		padding: 1.5rem;
		background: var(--bg-secondary);
		border-radius: 8px;
		border: 1px solid rgba(var(--accent-rgb), 0.2);
		overflow: hidden;
	}

	.preview-container {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.preview-header {
		text-align: center;
		border-bottom: 1px solid rgba(var(--accent-rgb), 0.1);
		padding-bottom: 1rem;
	}

	.preview-header h3 {
		margin: 0 0 0.25rem 0;
		color: var(--text-primary);
		font-size: 1.1rem;
	}

	.preview-header p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.preview-chat {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 120px;
	}

	.chat-message {
		display: flex;
		justify-content: flex-start;
		margin-bottom: 0.5rem;
	}

	.chat-message.own {
		justify-content: flex-end;
	}

	.message-bubble {
		max-width: 70%;
		padding: 0.75rem 1rem;
		background: var(--ui-bg-lighter);
		border-radius: 8px;
		border: 1px solid rgba(var(--accent-rgb), 0.1);
	}

	.chat-message.own .message-bubble {
		background: var(--accent-hex);
		color: white;
		border-color: transparent;
	}

	.message-author {
		display: block;
		font-size: 0.75rem;
		font-weight: 600;
		margin-bottom: 0.25rem;
		opacity: 0.7;
	}

	.message-bubble p {
		margin: 0;
		font-size: 0.9rem;
		line-height: 1.4;
	}

	.swatches {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 1rem;
		padding: 1rem;
		background: rgba(var(--accent-rgb), 0.05);
		border-radius: 6px;
	}

	.swatch {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: center;
		text-align: center;
	}

	.swatch-color {
		width: 48px;
		height: 48px;
		border-radius: 4px;
		border: 1px solid rgba(var(--accent-rgb), 0.2);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	}

	.swatch span {
		font-size: 0.7rem;
		color: var(--text-secondary);
		font-weight: 500;
	}

	.ui-elements {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.75rem;
		padding: 1rem;
		background: rgba(var(--accent-rgb), 0.05);
		border-radius: 6px;
	}

	.preview-button {
		padding: 0.6rem 1rem;
		background: var(--accent-hex);
		color: white;
		border: none;
		border-radius: 4px;
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.2s;
	}

	.preview-button:hover {
		transform: translateY(-1px);
		box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
	}

	.preview-input {
		padding: 0.6rem 0.8rem;
		background: var(--ui-bg-lighter);
		color: var(--text-primary);
		border: 1px solid rgba(var(--accent-rgb), 0.2);
		border-radius: 4px;
		font-size: 0.8rem;
		transition: all 0.2s;
	}

	.preview-input:focus {
		outline: none;
		border-color: var(--accent-hex);
		box-shadow: 0 0 0 2px rgba(var(--accent-rgb), 0.1);
	}

	.preview-badge {
		padding: 0.4rem 0.8rem;
		border-radius: 4px;
		font-size: 0.75rem;
		font-weight: 600;
		text-align: center;
	}

	.preview-badge.success {
		background: rgba(16, 185, 129, 0.2);
		color: var(--color-success);
	}

	.preview-badge.danger {
		background: rgba(239, 68, 68, 0.2);
		color: var(--color-danger);
	}
</style>
