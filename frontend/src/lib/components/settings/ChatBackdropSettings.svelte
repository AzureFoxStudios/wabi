<script lang="ts">
	import ChatBackdrop from '../chat/ChatBackdrop.svelte';
	import {
		defaultChatBackdropSettings,
		loadChatBackdropSettings,
		saveChatBackdropSettings,
		type ChatBackdropSettings as BackdropSettings
	} from '$lib/theme/chatBackdrop';

	let settings: BackdropSettings = { ...defaultChatBackdropSettings };

	if (typeof window !== 'undefined') settings = loadChatBackdropSettings();

	function persist() {
		settings = { ...settings };
		saveChatBackdropSettings(settings);
	}
</script>

<section class="backdrop-settings" aria-labelledby="chat-backdrop-heading">
	<div class="section-copy">
		<h3 id="chat-backdrop-heading">Chat backdrop</h3>
		<p>Give the conversation surface its own living background. Readability controls stay local to your client.</p>
	</div>

	<div class="preview-shell">
		<ChatBackdrop scene={settings.scene} motion={settings.motion} dim={settings.dim} frost={settings.frost} />
		<div class="preview-copy">
			<div class="preview-message"><strong>Wabi</strong><span>The background moves. The conversation stays readable.</span></div>
			<div class="preview-message"><strong>You</strong><span>Koi behind frosted glass is exactly the point.</span></div>
		</div>
	</div>

	<label>
		<span>Scene</span>
		<select bind:value={settings.scene} on:change={persist}>
			<option value="none">None</option>
			<option value="koi">Koi pond</option>
		</select>
	</label>

	<label>
		<span>Motion <output>{Math.round(settings.motion * 100)}%</output></span>
		<input type="range" min="0" max="1" step="0.05" bind:value={settings.motion} on:input={persist} disabled={settings.scene === 'none'} />
	</label>

	<label>
		<span>Darken <output>{Math.round(settings.dim * 100)}%</output></span>
		<input type="range" min="0" max="0.7" step="0.02" bind:value={settings.dim} on:input={persist} disabled={settings.scene === 'none'} />
	</label>

	<label>
		<span>Frost <output>{Math.round(settings.frost * 100)}%</output></span>
		<input type="range" min="0" max="0.9" step="0.02" bind:value={settings.frost} on:input={persist} disabled={settings.scene === 'none'} />
	</label>

	<p class="motion-note">Reduced-motion preferences automatically freeze animated scenes instead of removing the backdrop.</p>
</section>

<style>
	.backdrop-settings { display: grid; gap: 1rem; }
	.section-copy h3 { margin: 0; }
	.section-copy p, .motion-note { margin: .35rem 0 0; color: var(--text-muted); }
	.preview-shell { position: relative; min-height: 180px; overflow: hidden; border-radius: var(--radius-xl, 18px); border: 1px solid var(--border-subtle); background: var(--surface-sunken); }
	.preview-copy { position: relative; z-index: 1; display: grid; gap: .65rem; padding: 1.25rem; }
	.preview-message { width: min(80%, 28rem); display: grid; gap: .2rem; padding: .75rem .9rem; border-radius: 14px; background: color-mix(in srgb, var(--surface-raised) 72%, transparent); backdrop-filter: blur(8px); }
	.preview-message:nth-child(2) { justify-self: end; }
	label { display: grid; gap: .45rem; }
	label > span { display: flex; justify-content: space-between; gap: 1rem; font-weight: 600; }
	select, input[type='range'] { width: 100%; }
	select { padding: .7rem .8rem; border-radius: var(--radius-md, 10px); border: 1px solid var(--border-subtle); background: var(--surface-raised); color: var(--text-primary); }
	output { color: var(--text-muted); font-weight: 500; }
</style>
