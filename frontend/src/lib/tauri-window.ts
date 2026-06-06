import { browser } from '$app/environment';
import { isDesktopTauri } from '$lib/tauri-platform';

export interface WindowBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ScreenBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export type SnapPosition = 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'maximize' | 'center';

async function getTauriWindow() {
	const { getCurrentWindow } = await import('@tauri-apps/api/window');
	return getCurrentWindow();
}

async function makePhysicalPosition(x: number, y: number) {
	const { PhysicalPosition } = await import('@tauri-apps/api/dpi');
	return new PhysicalPosition(x, y);
}

async function makePhysicalSize(width: number, height: number) {
	const { PhysicalSize } = await import('@tauri-apps/api/dpi');
	return new PhysicalSize(width, height);
}

export async function getCurrentWindowBounds(): Promise<WindowBounds | null> {
	if (!browser || !isDesktopTauri()) return null;
	try {
		const window = await getTauriWindow();
		const position = await window.outerPosition();
		const size = await window.outerSize();
		return {
			x: position.x,
			y: position.y,
			width: size.width,
			height: size.height
		};
	} catch (err) {
		console.warn('[TauriWindow] Failed to get window bounds:', err);
		return null;
	}
}

export async function getCurrentScreenBounds(): Promise<ScreenBounds | null> {
	if (!browser || !isDesktopTauri()) return null;
	try {
		const { currentMonitor } = await import('@tauri-apps/api/window');
		const monitor = await currentMonitor();
		if (!monitor) return null;
		const workArea = monitor.workArea;
		return {
			x: workArea.position.x,
			y: workArea.position.y,
			width: workArea.size.width,
			height: workArea.size.height
		};
	} catch (err) {
		console.warn('[TauriWindow] Failed to get screen bounds:', err);
		return null;
	}
}

export async function snapWindow(position: SnapPosition): Promise<boolean> {
	if (!browser || !isDesktopTauri()) return false;
	try {
		const window = await getTauriWindow();
		const screenBounds = await getCurrentScreenBounds();
		if (!screenBounds) return false;

		const { x: screenX, y: screenY, width: screenW, height: screenH } = screenBounds;
		let newBounds: WindowBounds;

		switch (position) {
			case 'left':
				newBounds = { x: screenX, y: screenY, width: Math.floor(screenW / 2), height: screenH };
				break;
			case 'right':
				newBounds = { x: screenX + Math.floor(screenW / 2), y: screenY, width: Math.floor(screenW / 2), height: screenH };
				break;
			case 'top':
				newBounds = { x: screenX, y: screenY, width: screenW, height: Math.floor(screenH / 2) };
				break;
			case 'bottom':
				newBounds = { x: screenX, y: screenY + Math.floor(screenH / 2), width: screenW, height: Math.floor(screenH / 2) };
				break;
			case 'top-left':
				newBounds = { x: screenX, y: screenY, width: Math.floor(screenW / 2), height: Math.floor(screenH / 2) };
				break;
			case 'top-right':
				newBounds = { x: screenX + Math.floor(screenW / 2), y: screenY, width: Math.floor(screenW / 2), height: Math.floor(screenH / 2) };
				break;
			case 'bottom-left':
				newBounds = { x: screenX, y: screenY + Math.floor(screenH / 2), width: Math.floor(screenW / 2), height: Math.floor(screenH / 2) };
				break;
			case 'bottom-right':
				newBounds = { x: screenX + Math.floor(screenW / 2), y: screenY + Math.floor(screenH / 2), width: Math.floor(screenW / 2), height: Math.floor(screenH / 2) };
				break;
			case 'maximize':
				await window.maximize();
				return true;
			case 'center':
				const currentBounds = await getCurrentWindowBounds();
				if (!currentBounds) return false;
				newBounds = {
					x: screenX + Math.floor((screenW - currentBounds.width) / 2),
					y: screenY + Math.floor((screenH - currentBounds.height) / 2),
					width: currentBounds.width,
					height: currentBounds.height
				};
				break;
			default:
				return false;
		}

		await window.setPosition(await makePhysicalPosition(newBounds.x, newBounds.y));
		await window.setSize(await makePhysicalSize(newBounds.width, newBounds.height));
		return true;
	} catch (err) {
		console.warn('[TauriWindow] Failed to snap window:', err);
		return false;
	}
}

export async function setWindowBounds(bounds: WindowBounds): Promise<boolean> {
	if (!browser || !isDesktopTauri()) return false;
	try {
		const window = await getTauriWindow();
		await window.setPosition(await makePhysicalPosition(bounds.x, bounds.y));
		await window.setSize(await makePhysicalSize(bounds.width, bounds.height));
		return true;
	} catch (err) {
		console.warn('[TauriWindow] Failed to set window bounds:', err);
		return false;
	}
}

export async function maximizeWindow(): Promise<boolean> {
	if (!browser || !isDesktopTauri()) return false;
	try {
		const window = await getTauriWindow();
		await window.maximize();
		return true;
	} catch (err) {
		console.warn('[TauriWindow] Failed to maximize window:', err);
		return false;
	}
}

export async function unmaximizeWindow(): Promise<boolean> {
	if (!browser || !isDesktopTauri()) return false;
	try {
		const window = await getTauriWindow();
		await window.unmaximize();
		return true;
	} catch (err) {
		console.warn('[TauriWindow] Failed to unmaximize window:', err);
		return false;
	}
}

export async function minimizeWindow(): Promise<boolean> {
	if (!browser || !isDesktopTauri()) return false;
	try {
		const window = await getTauriWindow();
		await window.minimize();
		return true;
	} catch (err) {
		console.warn('[TauriWindow] Failed to minimize window:', err);
		return false;
	}
}

export async function closeWindow(): Promise<boolean> {
	if (!browser || !isDesktopTauri()) return false;
	try {
		const window = await getTauriWindow();
		await window.close();
		return true;
	} catch (err) {
		console.warn('[TauriWindow] Failed to close window:', err);
		return false;
	}
}

export async function setWindowTitle(title: string): Promise<boolean> {
	if (!browser || !isDesktopTauri()) return false;
	try {
		const window = await getTauriWindow();
		await window.setTitle(title);
		return true;
	} catch (err) {
		console.warn('[TauriWindow] Failed to set window title:', err);
		return false;
	}
}

export async function listenForWindowStateChanges(callback: (state: 'maximized' | 'minimized' | 'normal') => void): Promise<() => void> {
	if (!browser || !isDesktopTauri()) return () => {};
	try {
		const window = await getTauriWindow();
		const { listen } = await import('@tauri-apps/api/event');
		const unlistenMaximized = await listen('tauri://window-state-changed', (event) => {
			const payload = event.payload as { state?: string };
			if (payload?.state === 'maximized') callback('maximized');
			else if (payload?.state === 'minimized') callback('minimized');
			else if (payload?.state === 'normal') callback('normal');
		});
		return unlistenMaximized;
	} catch (err) {
		console.warn('[TauriWindow] Failed to listen for window state changes:', err);
		return () => {};
	}
}