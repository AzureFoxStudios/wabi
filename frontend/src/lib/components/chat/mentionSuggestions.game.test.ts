import { expect, test } from 'bun:test';
import { applyGameMention, suggestSharedGames } from './gameMentionSuggestions';
import type { GameSelection } from '$lib/games/model';

const shared: GameSelection = {
	key: 'steam:570', title: 'Dota 2', platform: 'PC', tags: [], note: '',
	rotation: false, favorite: false, invitations: true, visibility: 'server'
};

test('@game suggests only explicitly shared games and inserts a safe link', () => {
	const privateGame: GameSelection = { ...shared, key: 'steam:730', title: 'Private Game', visibility: 'private' };
	const suggestions = suggestSharedGames('', [privateGame, shared]);
	expect(suggestions.map((choice) => choice.label)).toEqual(['Dota 2']);
	const applied = applyGameMention('@game', [], suggestions[0], 0, 5);
	expect(applied.input).toContain('https://store.steampowered.com/app/570/');
	expect(applied.entities).toEqual([]);
});
