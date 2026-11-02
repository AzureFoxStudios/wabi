import { describe, expect, test } from 'bun:test';
import type { Channel } from '$lib/socket-types';
import {
  JOIN_TIMEOUT_MS,
  boardMetaWords,
  channelOptions,
  errorWords,
  resultWords,
  scoreWords,
  turnWords
} from './present';

describe('turnWords', () => {
  test('names the seat that moves next', () => {
    expect(turnWords(0)).toBe('Black to play');
    expect(turnWords(1)).toBe('White to play');
  });

  test('never turns an unknown seat into a colour claim', () => {
    expect(turnWords(-1)).toBe('To play');
    expect(turnWords(7)).toBe('To play');
  });
});

describe('resultWords', () => {
  test('resignation, area score and komi each get their own sentence', () => {
    expect(resultWords({ winner: 1, reason: 'resign' })).toBe('White wins by resignation.');
    expect(resultWords({ winner: 0, reason: 'area' })).toBe('Black wins on points (komi 6.5).');
    expect(resultWords({ winner: 1, reason: 'tie-komi' })).toBe('White wins on komi (6.5).');
  });

  test('an unfinished result makes no winner claim', () => {
    expect(resultWords({ winner: null, reason: '' })).toBe('The game ended.');
    expect(resultWords({ winner: 0, reason: '' })).toBe('Black wins.');
  });
});

describe('scoreWords', () => {
  test('prints whole and half points without trailing zeros', () => {
    expect(scoreWords({ black: 34, white: 29.5 })).toBe('Black 34 · White 29.5');
    expect(scoreWords({ black: 0, white: 6.5 })).toBe('Black 0 · White 6.5');
  });

  test('no score means no score line', () => {
    expect(scoreWords(null)).toBeNull();
    expect(scoreWords(undefined)).toBeNull();
  });
});

describe('boardMetaWords', () => {
  test('counts moves in mono, singular and plural', () => {
    expect(boardMetaWords(19, 0)).toBe('19×19 · 0 moves · komi 6.5');
    expect(boardMetaWords(9, 1)).toBe('9×9 · 1 move · komi 6.5');
    expect(boardMetaWords(13, 42)).toBe('13×13 · 42 moves · komi 6.5');
  });
});

describe('channelOptions', () => {
  const channel = (id: string, name: string, type: Channel['type']): Channel =>
    ({ id, name, type }) as Channel;

  test('marks places with # and leaves people and groups plain', () => {
    expect(
      channelOptions([
        channel('a', 'general', 'text'),
        channel('b', 'Ada', 'dm'),
        channel('c', 'Board night', 'group'),
        channel('d', 'Patch notes', 'thread_public')
      ])
    ).toEqual([
      { value: 'a', label: '#general' },
      { value: 'b', label: 'Ada' },
      { value: 'c', label: 'Board night' },
      { value: 'd', label: '#Patch notes' }
    ]);
  });

  test('an empty list stays empty', () => {
    expect(channelOptions([])).toEqual([]);
  });
});

describe('errorWords', () => {
  const SERVER_ERRORS = [
    'Game Sync is disabled on this server',
    'Channel access denied',
    'A game is already in progress in this channel',
    'game already started',
    'already seated',
    'no open seat',
    'no game',
    'game not active',
    'not your turn',
    'not a player',
    'out of bounds',
    'occupied',
    'ko',
    'suicide',
    'lock',
    'missing channelId',
    'missing x',
    'missing y',
    'timeout'
  ];

  test('every known refusal gets its own sentence, not the raw token', () => {
    const fallback = errorWords('an error nobody mapped');
    for (const raw of SERVER_ERRORS) {
      const words = errorWords(raw);
      expect(words.title.length).toBeGreaterThan(0);
      expect(words.text.length).toBeGreaterThan(0);
      expect(words.title).not.toBe(fallback.title);
      expect(words.title).not.toBe(raw);
      // Multi-word refusals are server sentences; none may leak into member copy.
      if (raw.includes(' ')) expect(`${words.title} ${words.text}`).not.toContain(raw);
      expect(words.raw).toBe(raw);
    }
  });

  test('the important refusals say what happens next', () => {
    expect(errorWords('Game Sync is disabled on this server').title).toBe('Go is turned off here');
    expect(errorWords('not your turn').text).toBe('Wait for the other seat to move.');
    expect(errorWords('timeout').title).toBe("The board didn't answer");
  });

  test('an unknown refusal still has words, and keeps the raw string for the log', () => {
    const words = errorWords('  something new  ');
    expect(words.title).toBe('The board could not do that');
    expect(words.raw).toBe('something new');
    expect(words.text).not.toContain('something new');
  });

  test('an empty refusal is still a real error', () => {
    const words = errorWords('');
    expect(words.title).toBe('The board could not do that');
    expect(words.raw).toBeUndefined();
  });

  test('the join wait is long enough to cover a slow round trip', () => {
    expect(JOIN_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    expect(JOIN_TIMEOUT_MS).toBeLessThanOrEqual(15000);
  });
});
