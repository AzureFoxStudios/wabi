<script lang="ts">
	// Dev-only specimen of the kit classes in styles/controls-kit.css, kit-overlays.css and
	// kit-prose.css (design contract §7, §8.7-§8.8). Every specimen is drawn from the active theme's
	// --w-* roles. `?theme=<id>` applies a theme on load so captures can switch after navigating.
	// The glyphs are a local copy of the reference set so this page does not depend on ui/Icon.
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { applyTheme } from '$lib/theme/themeManager';
	import { THEMES } from '$lib/theme/themes';
	import { initializeTheme } from '$lib/theme/initTheme';

	const ICONS: Record<string, string> = {
		search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
		plus: '<path d="M12 5v14M5 12h14"/>',
		x: '<path d="M18 6 6 18M6 6l12 12"/>',
		more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
		chevDown: '<path d="m6 9 6 6 6-6"/>',
		chevRight: '<path d="m9 6 6 6-6 6"/>',
		pin: '<path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
		lockOpen: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.75-1.4"/>',
		lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
		hourglass: '<path d="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 10 0V2M7 22v-4a5 5 0 0 1 10 0v4"/>',
		clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
		check: '<path d="M20 6 9 17l-5-5"/>',
		reply: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
		forward: '<path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
		smilePlus: '<path d="M22 11v1a10 10 0 1 1-9-10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6"/>',
		link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
		bold: '<path d="M6 12h9a4 4 0 0 1 0 8H6V4h8a4 4 0 0 1 0 8"/>',
		italic: '<path d="M19 4h-9M14 20H5M15 4 9 20"/>',
		strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16"/>',
		code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
		info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 16v-4M12 8h.01"/>',
		alert: '<circle cx="12" cy="12" r="9.5"/><path d="M12 8v4M12 16h.01"/>',
		refresh: '<path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M3 21v-5h5"/>',
		forum: '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2zM18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
		sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
		present: '<path d="M3 4h18M4 4v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V4M12 16v5M8 21h8"/>',
		map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
		image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
		bookOpen: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
		share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>',
		shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
		sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
		pages: '<path d="M8 3h9l4 4v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M16 3v5h5"/><path d="M6 7H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h9"/>',
		dm: '<path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.4-5.6A8.5 8.5 0 1 1 21 12z"/>',
		pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>'
	};

	const THEME_CHOICES: Array<[string, string]> = [
		['wabi-ink', 'Wabi Ink'],
		['light', 'Daylight'],
		['dark', 'Midnight Violet'],
		['high-contrast', 'High Contrast'],
		['joker', 'Joker']
	];

	let theme = $state('');
	let density = $state('cozy');
	let textSize = $state('100');
	let reduceMotion = $state(true);
	let encryptDms = $state(false);
	let mineReacted = $state(true);
	let troubleshootingOpen = $state(true);
	let advancedOpen = $state(false);
	let volume = $state(64);
	let someSelected = $state(true);
	let roomName = $state('Studio evening');
	let shareRoles = $state<Record<string, string>>({ theo: 'Editor', jun: 'Viewer' });

	function useTheme(id: string) {
		const next = THEMES[id];
		if (!next) return;
		theme = id;
		applyTheme(next);
	}

	function pickTheme(id: string) {
		useTheme(id);
		const url = new URL(location.href);
		url.searchParams.set('theme', id);
		replaceState(url, {});
	}

	onMount(() => {
		// The app shell locks the document to the viewport; this page is a long sheet.
		const root = document.documentElement;
		const body = document.body;
		const saved = { root: root.style.overflow, body: body.style.overflow, height: body.style.height };
		root.style.overflow = 'auto';
		body.style.overflow = 'visible';
		body.style.height = 'auto';
		const requested = new URL(location.href).searchParams.get('theme');
		if (requested && THEMES[requested]) useTheme(requested);
		else void initializeTheme();
		return () => {
			root.style.overflow = saved.root;
			body.style.overflow = saved.body;
			body.style.height = saved.height;
		};
	});
</script>

{#snippet icon(name: string, cls = '')}
	<svg class={cls} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{@html ICONS[name] ?? ''}</svg>
{/snippet}

<svelte:head><title>Kit review · Wabi</title></svelte:head>

<main class="kit">
	<header class="kit-head">
		<div class="kit-head-text">
			<h1 class="kit-title">Wabi kit</h1>
			<p class="kit-sub">Every specimen is drawn only from the active theme's <span class="w-mono">--w-*</span> roles.</p>
		</div>
		<div class="w-seg" role="radiogroup" aria-label="Theme">
			{#each THEME_CHOICES as [id, label] (id)}
				<button type="button" role="radio" aria-checked={theme === id} onclick={() => pickTheme(id)}>{label}</button>
			{/each}
		</div>
	</header>

	<div class="kit-grid">
		<!-- ====== column 1: controls ====== -->
		<div class="kit-col">
			<section aria-labelledby="k-buttons">
				<h2 class="w-kicker" id="k-buttons">Buttons</h2>
				<div class="kit-row">
					<button type="button" class="w-btn w-btn--primary">Post reply</button>
					<button type="button" class="w-btn">{@render icon('share')}Share…</button>
					<button type="button" class="w-btn w-btn--quiet">Cancel</button>
					<button type="button" class="w-btn w-btn--danger">Delete channel…</button>
				</div>
				<div class="kit-row">
					<button type="button" class="w-btn w-btn--sm">{@render icon('refresh')}Retry</button>
					<button type="button" class="w-btn w-btn--primary w-btn--lg">Turn on Sheets</button>
					<span class="w-split">
						<button type="button" class="w-btn w-btn--primary">{@render icon('plus')}New task</button>
						<button type="button" class="w-btn w-btn--primary w-split__menu" aria-label="More ways to add a task" aria-haspopup="menu">{@render icon('chevDown')}</button>
					</span>
				</div>
				<div class="kit-row">
					<button type="button" class="w-btn" aria-busy="true"><span class="w-btn__swap"><span>Join</span><span>Joining…</span></span></button>
					<button type="button" class="w-btn" aria-busy="false"><span class="w-btn__swap"><span>Join</span><span>Joining…</span></span></button>
					<button type="button" class="w-btn" disabled>Archive</button>
					<button type="button" class="w-btn w-btn--quiet w-btn--sm">Show more</button>
				</div>
				<div class="kit-row kit-row--tight">
					<button type="button" class="w-ibtn" aria-label="Search this channel">{@render icon('search')}</button>
					<button type="button" class="w-ibtn" aria-label="Pinned messages" aria-pressed="true">{@render icon('pin')}</button>
					<button type="button" class="w-ibtn" aria-label="More">{@render icon('more')}</button>
					<button type="button" class="w-ibtn w-ibtn--edge w-ibtn--dot" aria-label="Filter people, filter applied">{@render icon('sliders')}</button>
					<button type="button" class="w-ibtn w-ibtn--sm" aria-label="Close">{@render icon('x')}</button>
					<span class="kit-note">idle · pressed · more · edge + applied · small</span>
				</div>
			</section>

			<section aria-labelledby="k-fields">
				<h2 class="w-kicker" id="k-fields">Fields &amp; choices</h2>
				<label class="w-field w-field--chrome">
					{@render icon('search')}
					<input type="search" placeholder="Search people" aria-label="Search people" />
					<kbd class="w-kbd">Ctrl K</kbd>
				</label>
				<div class="kit-stack">
					<label class="w-label" for="kit-room">Room name</label>
					<input id="kit-room" class="w-field" bind:value={roomName} maxlength="32" aria-describedby="kit-room-count" />
					<div class="w-field-foot"><span class="w-field-count" id="kit-room-count">{roomName.length} / 32</span></div>
				</div>
				<div class="kit-stack">
					<label class="w-label" for="kit-handle">Handle</label>
					<input id="kit-handle" class="w-field" value="mira!" aria-invalid="true" aria-describedby="kit-handle-error" />
					<div class="w-field-foot">
						<span class="w-field-error" id="kit-handle-error">{@render icon('alert')}Use letters, numbers and dashes.</span>
						<span class="w-field-count">5 / 24</span>
					</div>
				</div>
				<div class="kit-row">
					<button type="button" class="w-select" aria-haspopup="listbox" aria-expanded="false"><span class="w-select__label">Project</span><span class="w-select__value">All</span>{@render icon('chevDown')}</button>
					<button type="button" class="w-select" aria-haspopup="listbox" aria-expanded="false"><span class="w-select__value">English</span>{@render icon('chevDown')}</button>
					<button type="button" class="w-select w-select--applied" aria-haspopup="listbox" aria-expanded="false"><span class="w-select__label">Priority</span><span class="w-select__value">High</span>{@render icon('chevDown')}</button>
				</div>
				<div class="kit-row">
					<div class="w-seg" role="radiogroup" aria-label="Message density">
						<button type="button" role="radio" aria-checked={density === 'cozy'} onclick={() => (density = 'cozy')}>Cozy</button>
						<button type="button" role="radio" aria-checked={density === 'compact'} onclick={() => (density = 'compact')}>Compact</button>
					</div>
					<button type="button" class="w-switch" role="switch" aria-checked={reduceMotion} aria-label="Reduce motion" onclick={() => (reduceMotion = !reduceMotion)}></button>
					<button type="button" class="w-switch" role="switch" aria-checked={encryptDms} aria-label="Encrypt new DMs" onclick={() => (encryptDms = !encryptDms)}></button>
					<input type="checkbox" class="w-check" checked aria-label="Checked" />
					<input type="checkbox" class="w-check" aria-label="Unchecked" />
					<input type="checkbox" class="w-check" aria-label="Some selected" bind:indeterminate={someSelected} />
					<input type="radio" class="w-radio" name="kit-radio" checked aria-label="Radio on" />
					<input type="radio" class="w-radio" name="kit-radio" aria-label="Radio off" />
				</div>
				<div class="kit-row">
					<label class="w-choice"><input type="checkbox" class="w-check" checked />Show join and leave notices</label>
					<label class="w-choice"><input type="radio" class="w-radio" name="kit-radio-2" checked />Everyone</label>
				</div>
				<div class="kit-range">
					<label class="kit-range-label" for="kit-volume">Volume for Studio lounge</label>
					<input id="kit-volume" type="range" class="w-range" min="0" max="100" bind:value={volume} style:--w-range-fill="{volume}%" aria-valuetext="{volume}%" />
					<span class="w-count">{volume}%</span>
				</div>
			</section>

			<section aria-labelledby="k-marks">
				<h2 class="w-kicker" id="k-marks">Chips, tags &amp; counts</h2>
				<div class="kit-row">
					<span class="w-tag"><span class="w-dot"></span>Private · this device</span>
					<span class="w-tag"><span class="w-dot w-dot--online"></span>Synced to server</span>
					<span class="w-tag"><span class="w-dot w-dot--warn"></span>Away</span>
					<span class="w-tag">{@render icon('clock')}Kept 24 hours</span>
				</div>
				<div class="kit-row">
					<span class="w-tag w-tag--mat" title="Office tools are an integration candidate, not a deployed feature">Preview</span>
					<span class="w-tag w-tag--mat" title="Works, but may change">Experimental</span>
					<span class="w-tag w-tag--mat" title="Turned on per device">Optional add-on</span>
					<span class="kit-name">Amara Okafor <span class="w-role" title="Community admin">Admin</span></span>
				</div>
				<div class="kit-row">
					<span class="w-seal">{@render icon('lockOpen')}Server-readable</span>
					<span class="w-seal">{@render icon('hourglass')}Encryption pending</span>
					<span class="w-seal">{@render icon('lock')}Experimental encryption</span>
				</div>
				<div class="kit-row">
					<span class="w-badge" aria-label="3 unread">3</span>
					<span class="w-badge" aria-label="More than 99 unread">99+</span>
					<span class="w-badge w-badge--sm" aria-label="2 unread">2</span>
					<span class="kit-badged">{@render icon('dm')}<span class="w-badge w-badge--sm w-badge--ring" aria-label="2 unread">2</span></span>
					<span class="w-count">12</span>
					<button type="button" class="w-react" aria-pressed="false" aria-label="Herb, 3 reactions"><span class="w-react__emoji">🌿</span>3</button>
					<button type="button" class="w-react" aria-pressed={mineReacted} aria-label="Coffee, 2 reactions, including yours" onclick={() => (mineReacted = !mineReacted)}><span class="w-react__emoji">☕</span>{mineReacted ? 2 : 1}</button>
					<button type="button" class="w-react" aria-pressed="false" aria-label="partyparrot, 1 reaction"><span class="w-react__code">:partyparrot:</span>1</button>
				</div>
			</section>

			<section aria-labelledby="k-srows">
				<h2 class="w-kicker" id="k-srows">Settings rows &amp; disclosure</h2>
				<div class="w-srows">
					<div class="w-srow">
						<div class="w-srow__text"><p class="w-srow__label">Text size</p><p class="w-srow__hint">Scales every word in Wabi, chat included.</p></div>
						<div class="w-seg" role="radiogroup" aria-label="Text size">
							{#each ['90', '100', '112', '125'] as size (size)}
								<button type="button" role="radio" aria-checked={textSize === size} onclick={() => (textSize = size)}>{size}%</button>
							{/each}
						</div>
					</div>
					<div class="w-srow">
						<div class="w-srow__text"><p class="w-srow__label">Reduce motion</p><p class="w-srow__hint">Panels and menus appear without sliding.</p></div>
						<button type="button" class="w-switch" role="switch" aria-checked={reduceMotion} aria-label="Reduce motion" onclick={() => (reduceMotion = !reduceMotion)}></button>
					</div>
					<div class="w-srow w-srow--seal">
						<div class="w-srow__text"><p class="w-srow__label">{@render icon('lock')}Encrypt new DMs</p><p class="w-srow__hint">Experimental encryption. Not independently verified.</p></div>
						<button type="button" class="w-switch" role="switch" aria-checked={encryptDms} aria-label="Encrypt new DMs" onclick={() => (encryptDms = !encryptDms)}></button>
					</div>
				</div>
				<button type="button" class="w-disclosure" aria-expanded={advancedOpen} aria-controls="kit-adv" onclick={() => (advancedOpen = !advancedOpen)}>{@render icon('chevRight')}Advanced</button>
				<div class="w-disclosure__body" id="kit-adv" hidden={!advancedOpen}><p class="kit-note">Nothing here yet.</p></div>
				<button type="button" class="w-disclosure" aria-expanded={troubleshootingOpen} aria-controls="kit-trouble" onclick={() => (troubleshootingOpen = !troubleshootingOpen)}>{@render icon('chevRight')}Troubleshooting</button>
				<div class="w-disclosure__body" id="kit-trouble" hidden={!troubleshootingOpen}>
					<div class="w-srow">
						<div class="w-srow__text"><p class="w-srow__label">Show connection details during calls</p><p class="w-srow__hint">Adds the network readout to the call dock.</p></div>
						<button type="button" class="w-switch" role="switch" aria-checked="false" aria-label="Show connection details during calls"></button>
					</div>
				</div>
			</section>
		</div>

		<!-- ====== column 2: menus, popovers, floating tools, separators ====== -->
		<div class="kit-col">
			<section aria-labelledby="k-menu">
				<h2 class="w-kicker" id="k-menu">Menu · more workspaces</h2>
				<div class="w-menu" role="menu" aria-label="More workspaces">
					<span class="w-menu__kicker" role="presentation">This channel</span>
					<button type="button" class="w-menu__item" role="menuitem">{@render icon('image')}<span class="w-menu__label">Media</span></button>
					<button type="button" class="w-menu__item" role="menuitem">{@render icon('bookOpen')}<span class="w-menu__label">Reader</span></button>
					<button type="button" class="w-menu__item" role="menuitem">{@render icon('map')}<span class="w-menu__label">Map</span><span class="w-menu__hint">off on this device</span></button>
					<hr />
					<span class="w-menu__kicker" role="presentation">Office</span>
					<button type="button" class="w-menu__item" role="menuitemradio" aria-checked="true">{@render icon('sheet')}<span class="w-menu__label">Sheets</span>{@render icon('check', 'w-menu__check')}</button>
					<button type="button" class="w-menu__item" role="menuitemradio" aria-checked="false" data-highlighted>{@render icon('present')}<span class="w-menu__label">Present</span><span class="w-tag w-tag--mat">Preview</span></button>
					<hr />
					<button type="button" class="w-menu__item" role="menuitem">{@render icon('pin')}<span class="w-menu__label">Pin Present to the bar</span></button>
				</div>
			</section>

			<section aria-labelledby="k-ctx">
				<h2 class="w-kicker" id="k-ctx">Menu · message actions</h2>
				<div class="w-menu" role="menu" aria-label="Message actions">
					<button type="button" class="w-menu__item" role="menuitem">{@render icon('reply')}<span class="w-menu__label">Reply</span></button>
					<button type="button" class="w-menu__item" role="menuitem">{@render icon('link')}<span class="w-menu__label">Copy link</span><span class="w-menu__key">Ctrl Shift C</span></button>
					<button type="button" class="w-menu__item" role="menuitem">{@render icon('pencil')}<span class="w-menu__label">Edit message</span></button>
					<hr />
					<span class="w-menu__kicker" role="presentation">Moderate</span>
					<button type="button" class="w-menu__item w-menu__item--seal" role="menuitem">{@render icon('shield')}<span class="w-menu__label">Hide for everyone</span></button>
					<button type="button" class="w-menu__item" role="menuitem" aria-disabled="true">{@render icon('pin')}<span class="w-menu__label">Pin to channel</span></button>
					<hr />
					<button type="button" class="w-menu__item w-menu__item--danger" role="menuitem">{@render icon('x')}<span class="w-menu__label">Delete message</span></button>
				</div>
			</section>

			<section aria-labelledby="k-pop">
				<h2 class="w-kicker" id="k-pop">Popover · privacy</h2>
				<div class="w-pop" role="dialog" aria-labelledby="kit-pop-title">
					<h3 class="w-pop__title" id="kit-pop-title"><span class="kit-seal-glyph">{@render icon('lockOpen')}</span>Server-readable</h3>
					<p class="w-pop__body">Messages in #general are stored on this server. The people who run it can read them.</p>
					<dl class="w-pop__facts">
						<dt>Room</dt><dd>#general · Common Ground</dd>
						<dt>Kept</dt><dd>Until someone deletes them</dd>
						<dt>Encryption</dt><dd>Experimental, DMs and groups only</dd>
					</dl>
					<p class="w-pop__foot"><a href="/privacy">How privacy works in Wabi</a></p>
				</div>
			</section>

			<section aria-labelledby="k-tools">
				<h2 class="w-kicker" id="k-tools">Tooltip · floating tools</h2>
				<div class="kit-tipdemo">
					<button type="button" class="w-ibtn" aria-label="Search this channel" aria-describedby="kit-tip">{@render icon('search')}</button>
					<span class="w-tip" role="tooltip" id="kit-tip">Search this channel <span class="w-tip__key">Ctrl F</span></span>
				</div>
				<div class="kit-row">
					<div class="w-tool" role="toolbar" aria-label="Message actions">
						<button type="button" class="w-tool__quick" aria-label="React with thumbs up">👍</button>
						<button type="button" class="w-tool__quick" aria-label="React with heart">❤️</button>
						<button type="button" class="w-tool__quick" aria-label="React with herb">🌿</button>
						<span class="w-tool__sep" aria-hidden="true"></span>
						<button type="button" class="w-ibtn" aria-label="Add reaction">{@render icon('smilePlus')}</button>
						<button type="button" class="w-ibtn" aria-label="Reply">{@render icon('reply')}</button>
						<button type="button" class="w-ibtn" aria-label="Forward">{@render icon('forward')}</button>
						<span class="w-tool__sep" aria-hidden="true"></span>
						<button type="button" class="w-ibtn" aria-label="More actions">{@render icon('more')}</button>
					</div>
				</div>
				<div class="kit-row">
					<div class="w-tool w-tool--bubble" role="toolbar" aria-label="Format selection">
						<button type="button" class="w-ibtn" aria-label="Bold" aria-pressed="true">{@render icon('bold')}</button>
						<button type="button" class="w-ibtn" aria-label="Italic" aria-pressed="false">{@render icon('italic')}</button>
						<button type="button" class="w-ibtn" aria-label="Strikethrough" aria-pressed="false">{@render icon('strike')}</button>
						<span class="w-tool__sep" aria-hidden="true"></span>
						<button type="button" class="w-ibtn" aria-label="Link">{@render icon('link')}</button>
						<button type="button" class="w-ibtn" aria-label="Inline code">{@render icon('code')}</button>
					</div>
				</div>
			</section>

			<section aria-labelledby="k-stream">
				<h2 class="w-kicker" id="k-stream">Stream separators</h2>
				<div class="w-dayrule" role="separator" aria-label="Today, Monday 21 September"><span><b>Today</b> · Monday 21 September</span></div>
				<div class="w-dayrule" role="separator" aria-label="Saturday 19 September"><span>Saturday 19 September</span></div>
				<div class="w-newrule" role="separator" aria-label="New messages since you last read"><span>New</span></div>
				<div class="w-typing" aria-live="polite">
					<span class="kit-av" aria-hidden="true">I</span>
					<span><b>Iris</b> is writing</span>
					<span class="w-typing__dots" aria-hidden="true"><i></i><i></i><i></i></span>
				</div>
			</section>
		</div>

		<!-- ====== column 3: states and dialogs ====== -->
		<div class="kit-col">
			<section aria-labelledby="k-toast">
				<h2 class="w-kicker" id="k-toast">Toast</h2>
				<div class="w-toast" role="status">
					{@render icon('link')}
					<span class="w-toast__msg">Link to message copied</span>
					<button type="button" class="w-toast__action">Undo</button>
				</div>
			</section>

			<section aria-labelledby="k-notice">
				<h2 class="w-kicker" id="k-notice">Notices, in place</h2>
				<div class="w-notice" role="alert">
					{@render icon('alert')}
					<p class="w-notice__title">Couldn’t join Studio lounge</p>
					<p class="w-notice__text">Not connected to the server. Your draft and settings are unchanged.</p>
					<button type="button" class="w-btn w-btn--sm">Retry</button>
				</div>
				<div class="w-notice w-notice--info" role="status">
					{@render icon('info')}
					<p class="w-notice__title">Sheets is a preview</p>
					<p class="w-notice__text">It stays on this device until you share a spreadsheet.</p>
				</div>
				<div class="w-notice w-notice--warn" role="status">
					{@render icon('alert')}
					<p class="w-notice__title">Unsaved changes</p>
					<p class="w-notice__text">Save before you leave this page.</p>
					<div class="w-notice__actions"><button type="button" class="w-btn w-btn--sm w-btn--quiet">Discard</button><button type="button" class="w-btn w-btn--sm w-btn--primary">Save</button></div>
				</div>
			</section>

			<section aria-labelledby="k-loading">
				<h2 class="w-kicker" id="k-loading">Loading</h2>
				<div class="kit-mast"><span class="w-loadline" role="progressbar" aria-label="Opening Documents…"></span></div>
				<div class="w-skel-row" aria-hidden="true">
					<span class="w-skel w-skel--disc"></span>
					<span class="w-skel-stack"><span class="w-skel" style="width: 28%"></span><span class="w-skel" style="width: 82%"></span></span>
				</div>
				<div class="w-skel-row" aria-hidden="true">
					<span class="w-skel w-skel--disc"></span>
					<span class="w-skel-stack"><span class="w-skel" style="width: 22%"></span><span class="w-skel" style="width: 64%"></span></span>
				</div>
			</section>

			<section aria-labelledby="k-empty">
				<h2 class="w-kicker" id="k-empty">Empty</h2>
				<div class="w-empty">
					{@render icon('forum')}
					<h3 class="w-empty__title">No threads in conversations yet</h3>
					<p class="w-empty__text">Longer conversations live here, so they don’t scroll away.</p>
					<div class="w-empty__actions"><button type="button" class="w-btn w-btn--primary">New thread</button></div>
				</div>
				<div class="w-empty w-empty--enso kit-empty-enso">
					<span class="w-empty__enso" aria-hidden="true"></span>
					<h3 class="w-empty__title">Nothing on this device yet</h3>
					<p class="w-empty__text">Start a document. It stays on this device until you share it.</p>
					<div class="w-empty__actions"><button type="button" class="w-btn w-btn--primary">New document</button><button type="button" class="w-btn">Open file…</button></div>
				</div>
			</section>

			<section aria-labelledby="k-dialog">
				<h2 class="w-kicker" id="k-dialog">Confirm dialog</h2>
				<div class="kit-frame">
					<div class="w-dialog w-dialog--sm" role="group" aria-labelledby="kit-dialog-title">
						<header class="w-dialog__head">
							<h3 class="w-dialog__title" id="kit-dialog-title">Delete this message?</h3>
							<button type="button" class="w-ibtn w-dialog__close" aria-label="Close">{@render icon('x')}</button>
						</header>
						<div class="w-dialog__body"><p>It will be removed for everyone in #general. Its 2 attached files are deleted too.</p></div>
						<footer class="w-dialog__foot">
							<button type="button" class="w-btn w-btn--quiet">Cancel</button>
							<button type="button" class="w-btn w-btn--danger">Delete message</button>
						</footer>
					</div>
				</div>
			</section>
		</div>
	</div>

	<!-- ====== reading row: outline + facts, prose, a phone sheet ====== -->
	<div class="kit-reading">
		<aside class="kit-aside" aria-label="Document outline">
			<nav class="w-outline" aria-label="Contents">
				<p class="w-outline__title">Contents</p>
				<ol>
					<li>
						<a href="#kit-prose">A field guide to belonging</a>
						<ol>
							<li><a href="#kit-prose" aria-current="location">The places</a></li>
							<li><a href="#kit-prose">What each page holds</a></li>
							<li><a href="#kit-prose">Before Monday</a></li>
						</ol>
					</li>
				</ol>
			</nav>
			<div class="kit-facts">
				<p class="w-outline__title">Facts</p>
				<dl class="w-facts">
					<dt>Words</dt><dd>412</dd>
					<dt>Reading</dt><dd>2 min</dd>
					<dt>Edited</dt><dd>09:41</dd>
					<dt>Format</dt><dd>Markdown</dd>
				</dl>
			</div>
		</aside>

		<article class="w-prose" id="kit-prose" aria-label="Prose specimen">
			<h2>The places</h2>
			<p>Eight stories, a fold-out map, and one page left blank on purpose. We are keeping it small enough to finish together, and honest enough to feel like ours. <a href="#kit-prose">Read the brief</a>.</p>
			<p>Each page is one place and the person who loves it. Keep it to a few hundred words; the map ties the pages together.</p>
			<p></p>
			<ol>
				<li><strong>The bench with the afternoon sun</strong> — Amara</li>
				<li><strong>The bakery that remembers your order</strong> — Leo</li>
			</ol>
			<blockquote><p>Not the best places. Our places.</p></blockquote>
			<table>
				<thead><tr><th scope="col">Page</th><th scope="col">Writer</th><th scope="col">Words</th></tr></thead>
				<tbody>
					<tr><td>The bench</td><td>Amara</td><td>380</td></tr>
					<tr><td>The bakery</td><td>Leo</td><td>412</td></tr>
				</tbody>
			</table>
			<h3>Before Monday</h3>
			<p>Two things to bring to the call:</p>
			<ul>
				<li>Draft one page each in <code>field-guide.md</code></li>
				<li>Bring one photo of the place</li>
			</ul>
			<ul>
				<li><input type="checkbox" checked disabled aria-label="Done" />Find a name for the field guide</li>
				<li><input type="checkbox" disabled aria-label="Not done" />Draft one page each</li>
			</ul>
		</article>

		<div class="kit-phone" aria-label="Bottom sheet specimen" role="group">
			<div class="kit-phone-page" aria-hidden="true">
				<div class="w-skel-row"><span class="w-skel w-skel--disc"></span><span class="w-skel-stack"><span class="w-skel" style="width: 30%"></span><span class="w-skel" style="width: 76%"></span></span></div>
				<div class="w-skel-row"><span class="w-skel w-skel--disc"></span><span class="w-skel-stack"><span class="w-skel" style="width: 24%"></span><span class="w-skel" style="width: 58%"></span></span></div>
			</div>
			<div class="w-scrim"></div>
			<div class="w-sheet" role="dialog" aria-labelledby="kit-sheet-title">
				<span class="w-sheet__grabber" aria-hidden="true"></span>
				<h3 class="w-sheet__title" id="kit-sheet-title">Workspaces</h3>
				<div class="w-sheet__body">
					<div class="w-menu" role="menu" aria-label="Workspaces">
						<span class="w-menu__kicker" role="presentation">In this channel</span>
						<button type="button" class="w-menu__item" role="menuitemradio" aria-checked="true">{@render icon('forum')}<span class="w-menu__label">Chat</span>{@render icon('check', 'w-menu__check')}</button>
						<button type="button" class="w-menu__item" role="menuitemradio" aria-checked="false">{@render icon('pages')}<span class="w-menu__label">Documents</span><span class="w-tag w-tag--mat">Preview</span></button>
						<button type="button" class="w-menu__item" role="menuitemradio" aria-checked="false">{@render icon('sheet')}<span class="w-menu__label">Sheets</span><span class="w-menu__hint">off on this device</span></button>
					</div>
				</div>
			</div>
		</div>
	</div>

	<!-- ====== dialog row: a md dialog with a ruled header, and the size scale ====== -->
	<div class="kit-dialogs">
		<section aria-labelledby="k-dialog-md">
			<h2 class="w-kicker" id="k-dialog-md">Dialog · md, ruled header</h2>
			<div class="kit-frame">
				<div class="w-dialog w-dialog--md" role="group" aria-labelledby="kit-share-title">
					<header class="w-dialog__head w-dialog__head--rule">
						<h3 class="w-dialog__title" id="kit-share-title">Share field guide</h3>
						<p class="w-dialog__note">Private on this device until you share</p>
						<button type="button" class="w-ibtn w-dialog__close" aria-label="Close">{@render icon('x')}</button>
					</header>
					<div class="w-dialog__body">
						<label class="w-field">
							{@render icon('search')}
							<input type="text" placeholder="Add people by name" aria-label="Add people by name" />
						</label>
						<ul class="kit-people" aria-label="People with access">
							{#each [['theo', 'T', 'Theo Park', '@theo'], ['jun', 'J', 'Jun Sato', '@jun']] as [id, initial, name, handle] (id)}
								<li>
									<span class="kit-av kit-av--28" aria-hidden="true">{initial}</span>
									<span class="kit-person"><span class="kit-person-name">{name}</span><span class="kit-handle">{handle}</span></span>
									<button type="button" class="w-select" aria-haspopup="menu" aria-expanded="false" aria-label="Role for {name}: {shareRoles[id]}" onclick={() => (shareRoles[id] = shareRoles[id] === 'Editor' ? 'Viewer' : 'Editor')}><span class="w-select__value">{shareRoles[id]}</span>{@render icon('chevDown')}</button>
								</li>
							{/each}
						</ul>
						<p class="kit-truth"><span class="kit-seal-glyph">{@render icon('lockOpen')}</span><span>Publishes to commonground.example. The server operator can read this document. No public link is created.</span></p>
					</div>
					<footer class="w-dialog__foot w-dialog__foot--rule">
						<span class="w-dialog__foot-start w-tag w-tag--mat" title="Office tools are an integration candidate, not a deployed feature">Preview</span>
						<button type="button" class="w-btn w-btn--quiet">Cancel</button>
						<button type="button" class="w-btn w-btn--primary">Share</button>
					</footer>
				</div>
			</div>
		</section>

		<section aria-labelledby="k-dialog-sizes">
			<h2 class="w-kicker" id="k-dialog-sizes">Dialog sizes</h2>
			<dl class="w-facts kit-sizes">
				<dt>w-dialog--sm</dt><dd>440 · confirm, create channel</dd>
				<dt>w-dialog--md</dt><dd>560 · share, new message</dd>
				<dt>w-dialog--lg</dt><dd>760 · channel settings</dd>
				<dt>w-dialog--settings</dt><dd>1040 × min(808, 100dvh − 64)</dd>
			</dl>
			<p class="kit-note">Every dialog: --w-bg, --w-line-strong, --radius-xl, --w-shadow, over a sibling .w-scrim.</p>
		</section>
	</div>
</main>

<style>
	/* Page layout only; every specimen is a kit class. */
	.kit {
		box-sizing: border-box;
		max-width: 1536px;
		margin: 0 auto;
		padding: 48px 56px 72px;
		background: var(--w-bg);
		color: var(--w-text);
		font: var(--w-t-ui);
	}
	.kit-head {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 24px;
		flex-wrap: wrap;
		padding-bottom: 20px;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.kit-head-text {
		display: flex;
		align-items: baseline;
		gap: 18px;
		flex-wrap: wrap;
		min-width: 0;
	}
	.kit-title {
		margin: 0;
		font: var(--w-t-display);
		letter-spacing: 0.005em;
	}
	.kit-sub {
		margin: 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.kit-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		column-gap: 56px;
	}
	.kit-col {
		min-width: 0;
	}
	.kit-col > section {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
		padding: 28px 0;
		border-bottom: var(--w-bw) solid var(--w-line);
	}
	.kit-col > section > .w-kicker {
		margin: 0 0 6px;
	}
	.kit-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.kit-row--tight {
		gap: 4px;
	}
	.kit-stack {
		align-self: stretch;
	}
	.kit-col > section > .w-field,
	.kit-col > section > .w-srows,
	.kit-col > section > .w-disclosure,
	.kit-col > section > .w-disclosure__body,
	.kit-col > section > .w-notice,
	.kit-col > section > .w-dayrule,
	.kit-col > section > .w-newrule,
	.kit-col > section > .w-skel-row,
	.kit-col > section > .kit-mast,
	.kit-col > section > .kit-frame,
	.kit-col > section > .kit-range {
		align-self: stretch;
	}
	.kit-col > section > .w-disclosure + .w-disclosure__body {
		margin-top: -12px;
	}
	.kit-col > section > .w-disclosure__body + .w-disclosure,
	.kit-col > section > .w-srows + .w-disclosure {
		margin-top: -4px;
	}
	.kit-col > section > .w-dayrule,
	.kit-col > section > .w-newrule,
	.kit-col > section > .w-typing {
		margin-top: 0;
	}
	.kit-note {
		margin: 0;
		color: var(--w-faint);
		font: var(--w-t-micro);
	}
	.kit-name {
		display: inline-flex;
		align-items: baseline;
		gap: 8px;
		margin-left: 8px;
		font: var(--w-t-label);
	}
	.kit-badged {
		position: relative;
		display: inline-grid;
		place-items: center;
		width: 32px;
		height: 32px;
		color: var(--w-mute);
	}
	.kit-badged :global(svg) {
		width: 18px;
		height: 18px;
	}
	.kit-badged .w-badge {
		position: absolute;
		top: 2px;
		right: 0;
	}
	.kit-range {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
	}
	.kit-range-label {
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.kit-seal-glyph {
		display: inline-flex;
		color: var(--w-seal);
	}
	.kit-tipdemo {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
	}
	.kit-av {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: 20px;
		height: 20px;
		border-radius: var(--w-avr);
		background: var(--w-raise);
		color: var(--w-text);
		font: 500 calc(10px * var(--w-fs)) / 1 var(--w-sans);
	}
	.kit-mast {
		position: relative;
		height: 2px;
		margin: 4px 0 6px;
		box-shadow: inset 0 calc(-1 * var(--w-bw)) 0 var(--w-line);
	}
	.kit-empty-enso {
		padding-top: 24px;
		padding-bottom: 8px;
	}
	.kit-col > section > .w-empty {
		padding-top: 4px;
		padding-bottom: 12px;
	}
	.kit-frame {
		padding: 4px 0;
	}
	/* Specimens of fixed overlays are laid out in flow. */
	.kit-frame .w-dialog {
		position: relative;
		inset: auto;
		z-index: auto;
		width: min(var(--w-dialog-w), 100%);
		margin: 0;
	}
	.kit-reading {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr) 360px;
		column-gap: 56px;
		align-items: start;
		padding-top: 40px;
	}
	.kit-aside {
		display: flex;
		flex-direction: column;
		gap: 36px;
		padding-top: 6px;
	}
	.kit-facts .w-outline__title {
		margin-bottom: 10px;
	}
	.kit-phone {
		position: relative;
		height: 420px;
		overflow: hidden;
		border: var(--w-bw) solid var(--w-line);
		border-radius: var(--radius-xl);
		background: var(--w-bg);
	}
	.kit-phone-page {
		padding: 20px 16px;
	}
	.kit-phone .w-scrim,
	.kit-phone .w-sheet {
		position: absolute;
		z-index: auto;
	}
	.kit-dialogs {
		display: grid;
		grid-template-columns: 560px minmax(0, 1fr);
		column-gap: 56px;
		align-items: start;
		margin-top: 48px;
		border-top: var(--w-bw) solid var(--w-line);
	}
	.kit-dialogs > section {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 12px;
		min-width: 0;
		padding: 28px 0;
	}
	.kit-dialogs .kit-frame {
		align-self: stretch;
	}
	.kit-dialogs .w-dialog__body {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding-bottom: 20px;
	}
	.kit-people {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.kit-people > li {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 12px;
		min-height: 46px;
	}
	.kit-person {
		display: flex;
		align-items: baseline;
		gap: 8px;
		min-width: 0;
	}
	.kit-person-name {
		color: var(--w-text);
		font: var(--w-t-label);
	}
	.kit-handle {
		color: var(--w-faint);
		font: var(--w-t-mono);
	}
	.kit-av--28 {
		width: 28px;
		height: 28px;
		font: 600 calc(12px * var(--w-fs)) / 1 var(--w-serif);
	}
	.kit-truth {
		display: grid;
		grid-template-columns: 14px minmax(0, 1fr);
		column-gap: 10px;
		margin: 0;
		color: var(--w-mute);
		font: var(--w-t-small);
	}
	.kit-truth .kit-seal-glyph {
		padding-top: 2px;
	}
	.kit-truth :global(svg) {
		width: 14px;
		height: 14px;
	}
	.kit-sizes {
		align-self: stretch;
		max-width: 480px;
	}
	.kit-sizes dt {
		font: var(--w-t-mono);
	}
	.kit-sizes dd {
		text-align: start;
	}
	@media (max-width: 1100px) {
		.kit-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.kit-reading,
		.kit-dialogs {
			grid-template-columns: minmax(0, 1fr);
			row-gap: 32px;
		}
	}
	@media (max-width: 700px) {
		.kit {
			padding: 24px 16px 48px;
		}
		/* Five theme keys are wider than a phone: the strip scrolls instead of the page. */
		.kit-head > .w-seg {
			max-width: 100%;
			overflow-x: auto;
			scrollbar-width: none;
		}
		.kit-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
