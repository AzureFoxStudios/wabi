import { get } from 'svelte/store';
import { currentUser } from '$lib/socket';
import { authSessionGeneration, getAuthToken } from '$lib/authSession';
import { getServerUrl } from '$lib/serverUrl';
import { createGameClient } from './client';
import { board, type GameSelection } from './model';

/** Chat suggests only games the sender explicitly shared with this Authority. */
export async function loadSharedGamesForMentions(): Promise<GameSelection[]> {
	const client = createGameClient(() => {
		const server = getServerUrl();
		return { server, userId: String(get(currentUser)?.dbUserId || ''), generation: authSessionGeneration(server), token: getAuthToken(server) };
	});
	try {
		const result = board(await client.request('/games/me'));
		return result.entries.filter((game) => game.visibility === 'server');
	} catch {
		return [];
	} finally {
		client.dispose();
	}
}
