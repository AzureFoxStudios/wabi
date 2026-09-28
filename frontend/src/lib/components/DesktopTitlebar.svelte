<script lang="ts">
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
	<header class="desktop-titlebar" class:unfocused={!focused} aria-label="Wabi window">
		<button class="desktop-brand" bind:this={menuButton} aria-label="Wabi menu" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="desktop-app-menu" onclick={toggleMenu}>
			<svg class="desktop-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5 7 17l5-10 5 10 4-9.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
			<span class="desktop-wordmark">wabi</span>
			<svg class="desktop-chevron" class:open={menuOpen} viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
		</button>
		<div class="desktop-drag" data-tauri-drag-region aria-hidden="true"><span>YOUR SPACE</span><i></i></div>
		<div class="desktop-window-controls" aria-label="Window controls">
			<button aria-label="Minimize window" title="Minimize" onclick={() => windowAction('minimize')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 13h10"/></svg></button>
			<button aria-label={maximized ? 'Restore window' : 'Maximize window'} title={maximized ? 'Restore' : 'Maximize'} onclick={() => windowAction('maximize')}><svg viewBox="0 0 20 20" aria-hidden="true">{#if maximized}<path d="M7 6V4.5h8.5V13H14M4.5 7.5h8v8h-8z"/>{:else}<rect x="4.5" y="4.5" width="11" height="11" rx="2"/>{/if}</svg></button>
			<button class="desktop-close" aria-label="Close window to background" title="Close to background · Quit is in the Wabi menu" onclick={() => windowAction('close')}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8"/></svg></button>
		</div>
	</header>
	{#if menuOpen}
		<div id="desktop-app-menu" class="desktop-app-menu" role="dialog" aria-label="Wabi menu" tabindex="-1" bind:this={menu} onkeydown={menuKeys} onfocusout={() => { queueMicrotask(() => { if (menuOpen && !menu?.contains(document.activeElement) && document.activeElement !== menuButton) closeMenu(false); }); }}>
			<div class="desktop-menu-heading"><span>Make yourself at home.</span><span class="desktop-version">v{version}</span></div>
			<div class="desktop-menu-section-title">Servers</div>
			{#each recentServers as server (server.url)}
				<button class="desktop-menu-item desktop-menu-server" aria-current={server.isActive ? 'true' : undefined} title={server.effectiveName} onclick={() => selectServer(server.url, server.isActive)}>
					<span class="desktop-menu-server-name">{server.effectiveName}</span>
					{#if server.isActive}<span class="desktop-menu-current">Current</span>{/if}
				</button>
			{/each}
			<button class="desktop-menu-item" onclick={openServerList}><span>All servers · Join or create</span><span aria-hidden="true">↗</span></button>
			<button class="desktop-menu-item" aria-pressed={$desktopServerRailPinned} onclick={() => desktopServerRailPinned.update((pinned) => !pinned)}><span>Pin server rail</span><span aria-hidden="true">{$desktopServerRailPinned ? '✓' : ''}</span></button>
			<div class="desktop-menu-divider"></div>
			<button class="desktop-menu-item" onclick={() => action('settings')}><span>Settings</span><kbd>⌘ / Ctrl ,</kbd></button>
			<button class="desktop-menu-item" onclick={() => action('fullscreen')}><span>{fullscreen ? 'Leave fullscreen' : 'Fullscreen'}</span><kbd>F11</kbd></button>
			<div class="desktop-zoom-row"><span>Zoom</span><div><button aria-label="Zoom out" disabled={zoom <= 0.5} onclick={() => action('zoom-out', true)}>−</button><button class="desktop-zoom-value" aria-label="Reset zoom" title="Reset zoom" onclick={() => action('zoom-reset', true)}>{Math.round(zoom * 100)}%</button><button aria-label="Zoom in" disabled={zoom >= 3} onclick={() => action('zoom-in', true)}>+</button></div></div>
			<div class="desktop-menu-divider"></div>
			<button class="desktop-menu-item" onclick={() => action('logs')}><span>Open logs folder</span><span aria-hidden="true">↗</span></button>
			<button class="desktop-menu-item" onclick={() => action('about')}><span>About Wabi</span></button>
			<div class="desktop-menu-divider"></div>
			<button class="desktop-menu-item desktop-quit" onclick={() => action('quit')}><span>Quit Wabi</span><kbd>⌘ / Ctrl Q</kbd></button>
			<p class="desktop-menu-note">Closing the window keeps Wabi running.<br />Quitting stops your hosted community too.</p>
		</div>
	{/if}
	{#if error}<div class="desktop-shell-error" role="alert">{error}<button aria-label="Dismiss window error" onclick={() => error = ''}>×</button></div>{/if}
{/if}
