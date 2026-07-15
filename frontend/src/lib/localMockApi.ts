import { browser } from '$app/environment';
import { isLocalMockMode } from './localMockSocket';

export interface LocalMockRegisteredUser {
	user_id: number;
	username: string;
	profile_picture?: string;
	color: string;
}

export function isLocalMockApiMode(): boolean {
	return browser && isLocalMockMode();
}

export function getLocalMockUsers(): LocalMockRegisteredUser[] {
	return [
		{ user_id: 1, username: 'Hermes', color: '#98D8C8' },
		{ user_id: 2, username: 'Mira', color: '#F6A6FF' },
		{ user_id: 3, username: 'Taro', color: '#FFD166' }
	];
}

export function getLocalMockPlaces(): [] {
	return [];
}

export function acceptLocalMockGuestCode(code: string): boolean {
	const trimmed = code.trim();
	return trimmed.length > 0;
}

export function grantLocalMockGuestAccess(code = 'local-dev'): void {
	if (!browser) return;
	sessionStorage.setItem('guestAccessCode', code);
}
