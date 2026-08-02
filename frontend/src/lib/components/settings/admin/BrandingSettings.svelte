<script lang="ts">
	import { getAuthToken } from '$lib/authSession';
	import { getServerUrl } from '$lib/serverUrl';
	import { brandConfig, applyBranding } from '$lib/branding';
	import { updateProfile } from '$lib/socket';

	export let canManageBranding = false;

	let name = brandConfig.name;
	let tagline = brandConfig.tagline;
	let headline = brandConfig.headline;
	let subheadline = brandConfig.subheadline;
	let footerText = brandConfig.footerText;
	let customCss = brandConfig.customCss;
	let paletteAccent = brandConfig.palette.accent;
	let paletteMuted = brandConfig.palette.muted;
	let paletteSurface = brandConfig.palette.surface;
	let saving = false;
	let status = '';

	let logoInput: HTMLInputElement | null = null;
	let bannerInput: HTMLInputElement | null = null;
	let faviconInput: HTMLInputElement | null = null;

	const BRAND_STORE_KEY = 'wabi:brand:config';

	function loadSaved() {
		try {
			const raw = localStorage.getItem(BRAND_STORE_KEY);
			if (!raw) return;
			const saved = JSON.parse(raw);
			if (saved.name) name = saved.name;
			if (saved.tagline) tagline = saved.tagline;
			if (saved.headline) headline = saved.headline;
			if (saved.subheadline) subheadline = saved.subheadline;
			if (saved.footerText) footerText = saved.footerText;
			if (saved.customCss) customCss = saved.customCss;
			if (saved.palette) {
				paletteAccent = saved.palette.accent || paletteAccent;
				paletteMuted = saved.palette.muted || paletteMuted;
				paletteSurface = saved.palette.surface || paletteSurface;
			}
		} catch { /* ignore */ }
	}

	$: if (canManageBranding) {
		void loadSaved();
	}

	async function uploadAsset(file: File, _field: string): Promise<string> {
		const fd = new FormData();
		fd.append('file', file, file.name);
		const res = await fetch(`${getServerUrl()}/api/upload`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${getAuthToken()}` },
			body: fd
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `Upload failed (${res.status})`);
		const url = typeof payload?.file_url === 'string' ? payload.file_url : '';
		if (!url) throw new Error('No URL returned');
		return url;
	}

	async function saveBranding() {
		if (!canManageBranding) return;
		saving = true;
		status = '';
		try {
			let logoUrl = brandConfig.logoUrl;
			let bannerUrl = brandConfig.logoUrl;
			let faviconUrl = brandConfig.faviconUrl;

			const logoFile = logoInput?.files?.[0];
			const bannerFile = bannerInput?.files?.[0];
			const faviconFile = faviconInput?.files?.[0];

			if (logoFile) logoUrl = await uploadAsset(logoFile, 'logoUrl');
			if (bannerFile) bannerUrl = await uploadAsset(bannerFile, 'bannerUrl');
			if (faviconFile) faviconUrl = await uploadAsset(faviconFile, 'faviconUrl');

			const next = {
				name,
				tagline,
				headline,
				subheadline,
				footerText,
				customCss,
				palette: { accent: paletteAccent, muted: paletteMuted, surface: paletteSurface },
				logoUrl,
				bannerUrl,
				faviconUrl
			};
			localStorage.setItem(BRAND_STORE_KEY, JSON.stringify(next));
			applyBranding();
			status = 'Branding saved locally. Server persistence requires backend patch.';
			if (logoInput) logoInput.value = '';
			if (bannerInput) bannerInput.value = '';
			if (faviconInput) faviconInput.value = '';
		} catch (e) {
			status = e instanceof Error ? e.message : 'Save failed.';
		} finally {
			saving = false;
		}
	}

	$: if (typeof document !== 'undefined') {
		let styleEl = document.getElementById('wabi-brand-custom-css');
		if (!styleEl) {
			styleEl = document.createElement('style');
			styleEl.id = 'wabi-brand-custom-css';
			document.head.appendChild(styleEl);
		}
		styleEl.textContent = customCss;
	}
</script>

{#if canManageBranding}
	<div class="settings-section">
		<h3>Brand Identity</h3>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Brand Name</span>
				<span class="setting-description">Shown in titles, sidebar, boot.</span>
			</div>
			<input type="text" class="emoji-name-input" bind:value={name} maxlength="32" />
		</div>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Tagline</span>
			</div>
			<input type="text" class="emoji-name-input" bind:value={tagline} maxlength="64" />
		</div>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Headline</span>
				<span class="setting-description">Login/landing headline.</span>
			</div>
			<input type="text" class="emoji-name-input" bind:value={headline} maxlength="120" />
		</div>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Subheadline</span>
			</div>
			<input type="text" class="emoji-name-input" bind:value={subheadline} maxlength="200" />
		</div>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Footer Text</span>
			</div>
			<input type="text" class="emoji-name-input" bind:value={footerText} maxlength="200" />
		</div>
	</div>

	<div class="settings-section">
		<h3>Brand Assets</h3>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Logo</span>
			</div>
			<input type="file" accept="image/*" bind:this={logoInput} />
		</div>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Favicon</span>
			</div>
			<input type="file" accept="image/*" bind:this={faviconInput} />
		</div>
	</div>

	<div class="settings-section">
		<h3>Palette</h3>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Accent</span>
			</div>
			<input type="color" bind:value={paletteAccent} />
		</div>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Muted</span>
			</div>
			<input type="color" bind:value={paletteMuted} />
		</div>
		<div class="setting-item-full">
			<div class="setting-info">
				<span class="setting-label">Surface</span>
			</div>
			<input type="color" bind:value={paletteSurface} />
		</div>
	</div>

	<div class="settings-section">
		<h3>Custom CSS</h3>
		<div class="setting-item-full">
			<textarea class="emoji-name-input" rows="6" bind:value={customCss} placeholder="/* Custom CSS */"></textarea>
		</div>
	</div>

	<div class="settings-section">
		<button class="pfp-upload-btn" on:click={saveBranding} disabled={saving}>
			{saving ? 'Saving...' : 'Save Branding'}
		</button>
		{#if status}<div class="runtime-note">{status}</div>{/if}
	</div>
{/if}
