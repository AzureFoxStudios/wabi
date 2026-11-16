<script lang="ts">
	import { _ } from '$lib/i18n';
	import { onMount, tick } from 'svelte';
	import { isDesktopTauri } from '$lib/tauri-platform';
	import { invoke } from '@tauri-apps/api/core';
	import type { Window as NativeWindow } from '@tauri-apps/api/window';
	import { savedServers, switchToSavedServer } from '$lib/savedServers';
	import { desktopServerRailPinned, recentSavedServers } from '$lib/serverNavigationPreference';
	import './DesktopTitlebar.css';

	let visible = $state(false);
	let maximized = $state(false);
	let focused = $state(true);
	let menuOpen = $state(false);
	let fullscreen = $state(false);
	let zoom = $state(1);
	let quitOnClose = $state(false);
	let devBuilds = $state(false);
	let updateBusy = $state(false);
	let updateStatus = $state('');
	let updateVersion = $state('');
	let version = $state('');
	let error = $state('');
	let menuButton = $state<HTMLButtonElement>();
	let menu = $state<HTMLDivElement>();
	let recentServers = $derived(recentSavedServers($savedServers));
	let native: NativeWindow | undefined;
	let controlBusy = false;
	const resizeDirections = ['North', 'NorthEast', 'East', 'SouthEast', 'South', 'SouthWest', 'West', 'NorthWest'] as const;
	function resize(event: PointerEvent, direction: typeof resizeDirections[number]) {
		if (event.button !== 0 || !native) return;
		event.preventDefault();
		void native.startResizeDragging(direction).catch(e => { error = String(e); });
	}

	async function windowAction(action: 'minimize' | 'maximize' | 'close') {
		if (!native || controlBusy) return;
		controlBusy = true;
		error = '';
		try {
			if (action === 'minimize') await native.minimize();
			else if (action === 'close') await native.close();
			else { await native.toggleMaximize(); maximized = await native.isMaximized(); }
		} catch (e) { error = String(e); }
		finally { controlBusy = false; }
	}
	async function action(name: string, keepOpen = false) {
		error = '';
		if (!keepOpen) closeMenu();
		try {
			zoom = await invoke<number>('desktop_action', { action: name });
			fullscreen = await native?.isFullscreen() ?? false;
		} catch (e) { error = String(e); }
	}
	async function toggleQuitOnClose() {
		error = '';
		try { quitOnClose = await invoke<boolean>('desktop_close_behavior', { quitOnClose: !quitOnClose }); }
		catch (e) { error = String(e); }
	}
	async function checkForUpdate() {
		if (updateBusy) return;
		updateBusy = true; updateStatus = $_('titlebar.checking'); updateVersion = '';
		try {
			const found = await invoke<{ version: string } | null>('desktop_update', { action: 'check' });
			updateVersion = found?.version ?? '';
			updateStatus = found ? $_('titlebar.version_available', { values: { version: found.version } }) : $_('titlebar.up_to_date');
		} catch (e) { updateStatus = String(e); }
		finally { updateBusy = false; }
	}
	async function installUpdate() {
		if (updateBusy) return;
		updateBusy = true; updateStatus = $_('titlebar.downloading', { values: { version: updateVersion } });
		// On success the app restarts and this never resolves.
		try { await invoke('desktop_update', { action: 'install' }); }
		catch (e) { updateStatus = String(e); updateBusy = false; }
	}
	async function toggleDevBuilds() {
		error = '';
		try {
			devBuilds = await invoke<boolean>('desktop_update', { action: devBuilds ? 'channel-stable' : 'channel-dev' });
			updateStatus = ''; updateVersion = '';
		} catch (e) { error = String(e); }
	}
	function closeMenu(restoreFocus = true) {
		menuOpen = false;
		if (restoreFocus) menuButton?.focus();
	}
	function openServerList() {
		closeMenu(false);
		window.dispatchEvent(new Event('wabi:open-server-switcher'));
	}
	function selectServer(url: string, active: boolean) {
		closeMenu(false);
		if (!active) switchToSavedServer(url);
	}
	async function toggleMenu() {
		if (menuOpen) { closeMenu(); return; }
		menuOpen = true;
		await tick();
		menu?.querySelector<HTMLButtonElement>('button')?.focus();
	}
	function menuKeys(event: KeyboardEvent) {
		if (!menu) return;
		const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		let next: number | undefined;
		if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
		if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
		if (event.key === 'Home') next = 0;
		if (event.key === 'End') next = buttons.length - 1;
		if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
		if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
	}
	onMount(() => {
		if (!isDesktopTauri()) return;
		let disposed = false;
		const cleanup: Array<() => void> = [];
		const register = async (promise: Promise<() => void>) => {
			const off = await promise;
			if (disposed) off(); else cleanup.push(off);
		};
		void (async () => {
			try {
				const { getCurrentWindow } = await import('@tauri-apps/api/window');
				native = getCurrentWindow();
				if (disposed || native.label !== 'main') return;
				const { getVersion } = await import('@tauri-apps/api/app');
				version = await getVersion();
				zoom = await invoke<number>('desktop_action', { action: 'zoom-level' });
				quitOnClose = await invoke<boolean>('desktop_close_behavior');
				devBuilds = await invoke<boolean>('desktop_update', { action: 'channel' }).catch(() => false);
				maximized = await native.isMaximized();
				focused = await native.isFocused();
				await register(native.onResized(async () => {
					maximized = await native!.isMaximized();
					fullscreen = await native!.isFullscreen();
				}));
				await register(native.onFocusChanged(({ payload }) => { focused = payload; if (!payload) closeMenu(false); }));
				if (disposed) return;
				visible = true;
				document.documentElement.dataset.desktopShell = 'true';
				await tick();
				// Leave native chrome in place if the custom surface cannot initialize.
				if (!disposed) await native.setDecorations(false);
			} catch (e) { error = String(e); console.warn('Custom titlebar could not initialize:', e); }
		})();
		const outside = (event: PointerEvent) => {
			if (menuOpen && !menu?.contains(event.target as Node) && !menuButton?.contains(event.target as Node)) closeMenu(false);
		};
		const shortcuts = (event: KeyboardEvent) => {
			if (!visible || event.defaultPrevented || event.altKey) return;
			const command = event.ctrlKey || event.metaKey;
			const key = event.key.toLowerCase();
			const name = event.key === 'F11' ? 'fullscreen' : !command ? null :
				key === ',' ? 'settings' : key === 'q' ? 'quit' : key === 'm' ? 'minimize' :
				key === '+' || key === '=' ? 'zoom-in' : key === '-' ? 'zoom-out' : key === '0' ? 'zoom-reset' : null;
			if (command && key === 'w') { event.preventDefault(); void windowAction('close'); }
			if (name) { event.preventDefault(); void action(name); }
			if (event.key === 'Escape' && menuOpen) closeMenu();
		};
		document.addEventListener('pointerdown', outside);
		window.addEventListener('keydown', shortcuts);
		return () => {
			disposed = true;
			cleanup.forEach(off => off());
			document.removeEventListener('pointerdown', outside);
			window.removeEventListener('keydown', shortcuts);
			delete document.documentElement.dataset.desktopShell;
			if (native?.label === 'main') void native.setDecorations(true).catch(() => {});
		};
	});
</script>

{#if visible}
	{#if !maximized && !fullscreen}
		{#each resizeDirections as direction}
			<div class="desktop-resize-edge" data-direction={direction} aria-hidden="true" onpointerdown={(event) => resize(event, direction)}></div>
		{/each}
	{/if}
	<header class="desktop-titlebar" class:unfocused={!focused} aria-label={$_('titlebar.window_label')}>
		<button class="desktop-brand" bind:this={menuButton} aria-label={$_('titlebar.menu_label')} aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="desktop-app-menu" onclick={toggleMenu}>
			<svg class="desktop-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5 7 17l5-10 5 10 4-9.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
			<span class="desktop-wordmark">wabi</span>
			<svg class="desktop-chevron" class:open={menuOpen} viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
		</button>
		<div class="desktop-drag" data-tauri-drag-region aria-hidden="true"><span>{$_('titlebar.your_space')}</span><i></i></div>
		<div class="desktop-window-controls" aria-label={$_('titlebar.window_controls')}>
			<button aria-label={$_('titlebar.minimize')} title={$_('titlebar.minimize_short')} onclick={() => windowAction('minimize')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 13h10"/></svg></button>
			<button aria-label={maximized ? $_('titlebar.restore_window') : $_('titlebar.maximize_window')} title={maximized ? $_('titlebar.restore') : $_('titlebar.maximize')} onclick={() => windowAction('maximize')}><svg viewBox="0 0 20 20" aria-hidden="true">{#if maximized}<path d="M7 6V4.5h8.5V13H14M4.5 7.5h8v8h-8z"/>{:else}<rect x="4.5" y="4.5" width="11" height="11" rx="2"/>{/if}</svg></button>
			<button class="desktop-close" aria-label={quitOnClose ? $_('titlebar.close_quit_label') : $_('titlebar.close_background_label')} title={quitOnClose ? $_('titlebar.close_quit_title') : $_('titlebar.close_background_title')} onclick={() => windowAction('close')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg></button>
		</div>
	</header>
	{#if menuOpen}
		<div id="desktop-app-menu" class="desktop-app-menu" role="dialog" aria-label={$_('titlebar.menu_label')} tabindex="-1" bind:this={menu} onkeydown={menuKeys} onfocusout={() => { queueMicrotask(() => { if (menuOpen && !menu?.contains(document.activeElement) && document.activeElement !== menuButton) closeMenu(false); }); }}>
			<div class="desktop-menu-heading"><span>{$_('titlebar.menu_tagline')}</span><span class="desktop-version">v{version}</span></div>
			<div class="desktop-menu-section-title">{$_('shell.you.servers')}</div>
			{#each recentServers as server (server.url)}
				<button class="desktop-menu-item desktop-menu-server" aria-current={server.isActive ? 'true' : undefined} title={server.effectiveName} onclick={() => selectServer(server.url, server.isActive)}>
					<span class="desktop-menu-server-name">{server.effectiveName}</span>
					{#if server.isActive}<span class="desktop-menu-current">{$_('titlebar.current')}</span>{/if}
				</button>
			{/each}
			<button class="desktop-menu-item" onclick={openServerList}><span>{$_('titlebar.all_servers')}</span><span aria-hidden="true">↗</span></button>
			<button class="desktop-menu-item" aria-pressed={$desktopServerRailPinned} onclick={() => desktopServerRailPinned.update((pinned) => !pinned)}><span>{$_('titlebar.pin_rail')}</span><span aria-hidden="true">{$desktopServerRailPinned ? '✓' : ''}</span></button>
			<div class="desktop-menu-divider"></div>
			<button class="desktop-menu-item" onclick={() => action('settings')}><span>{$_('settings.title')}</span><kbd>⌘ / Ctrl ,</kbd></button>
			<button class="desktop-menu-item" aria-pressed={quitOnClose} onclick={toggleQuitOnClose}><span>{$_('titlebar.quit_when_closed')}</span><span aria-hidden="true">{quitOnClose ? '✓' : ''}</span></button>
			<button class="desktop-menu-item" onclick={() => action('fullscreen')}><span>{fullscreen ? $_('titlebar.leave_fullscreen') : $_('lore_viewer.fullscreen')}</span><kbd>F11</kbd></button>
			<div class="desktop-zoom-row"><span>{$_('titlebar.zoom')}</span><div><button aria-label={$_('messages.viewer.zoom_out')} disabled={zoom <= 0.5} onclick={() => action('zoom-out', true)}>−</button><button class="desktop-zoom-value" aria-label={$_('messages.viewer.reset_zoom')} title={$_('messages.viewer.reset_zoom')} onclick={() => action('zoom-reset', true)}>{Math.round(zoom * 100)}%</button><button aria-label={$_('messages.viewer.zoom_in')} disabled={zoom >= 3} onclick={() => action('zoom-in', true)}>+</button></div></div>
			<div class="desktop-menu-divider"></div>
			<button class="desktop-menu-item" onclick={() => action('logs')}><span>{$_('titlebar.open_logs')}</span><span aria-hidden="true">↗</span></button>
			<button class="desktop-menu-item" onclick={() => action('about')}><span>{$_('titlebar.about')}</span></button>
			<div class="desktop-menu-divider"></div>
			{#if updateVersion}
				<button class="desktop-menu-item" disabled={updateBusy} onclick={installUpdate}><span>{$_('titlebar.install_version', { values: { version: updateVersion } })}</span><span aria-hidden="true">↓</span></button>
			{:else}
				<button class="desktop-menu-item" disabled={updateBusy} onclick={checkForUpdate}><span>{$_('titlebar.check_updates')}</span></button>
			{/if}
			<button class="desktop-menu-item" aria-pressed={devBuilds} onclick={toggleDevBuilds}><span>{$_('titlebar.dev_builds')}</span><span aria-hidden="true">{devBuilds ? '✓' : ''}</span></button>
			{#if updateStatus}<p class="desktop-menu-note" role="status">{updateStatus}</p>{/if}
			<div class="desktop-menu-divider"></div>
			<button class="desktop-menu-item desktop-quit" onclick={() => action('quit')}><span>{$_('host_page.quit_app')}</span><kbd>⌘ / Ctrl Q</kbd></button>
			<p class="desktop-menu-note">{quitOnClose ? $_('titlebar.note_quit') : $_('titlebar.note_keep')}<br />{$_('titlebar.note_hosted')}</p>
		</div>
	{/if}
	{#if error}<div class="desktop-shell-error" role="alert">{error}<button aria-label={$_('titlebar.dismiss_error')} onclick={() => error = ''}>×</button></div>{/if}
{/if}
