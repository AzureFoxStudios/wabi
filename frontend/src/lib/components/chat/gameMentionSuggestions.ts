import type { MessageEntity } from '$lib/socket-types';
import { steamStoreUrl, type GameSelection } from '$lib/games/model';
import type { MentionSuggestion } from './types';

export function suggestSharedGames(query: string, games: GameSelection[]): MentionSuggestion[] {
	return games.filter((game) => game.visibility === 'server' && game.title.toLowerCase().includes(query.toLowerCase()))
		.slice(0, 8)
		.map((game) => ({ key: `game-${game.key}`, label: game.title, value: game.title,
			kind: 'game', gameKey: game.key, detail: game.platform || 'Shared game' }));
}

export function applyGameMention(
	input: string, entities: MessageEntity[], suggestion: MentionSuggestion, tokenStart: number, caret: number
): { input: string; entities: MessageEntity[]; cursor: number } {
	const before = input.slice(0, tokenStart);
	const after = input.slice(caret);
	const safeTitle = suggestion.label.replace(/[\r\n\[\]()<>*_`~\\]/g, ' ').trim();
	const storeUrl = suggestion.gameKey ? steamStoreUrl(suggestion.gameKey) : null;
	const gameText = storeUrl ? `🎮 [${safeTitle}](${storeUrl}) ` : `🎮 ${safeTitle} `;
	const delta = gameText.length - (caret - tokenStart);
	return { input: before + gameText + after,
		entities: entities.filter((entity) => entity.end <= tokenStart || entity.start >= caret)
			.map((entity) => entity.start >= caret ? { ...entity, start: entity.start + delta, end: entity.end + delta } : entity),
		cursor: before.length + gameText.length };
}
