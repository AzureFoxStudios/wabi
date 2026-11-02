// The Game Sync panel's copy, kept out of the component so every sentence can be
// tested and every server refusal gets words a person can act on (design
// contract §7.16 "real states"). Sessions are in memory only; the panel says so
// through its frame's locality tag, not here.
import type { Channel } from '$lib/socket-types';
import type { SelectOption } from '$lib/components/ui/Select.svelte';
import { KOMI, STONE_LABEL, type GameSessionState } from './protocol';

/** How long the panel waits for `game:state` after join before it offers Retry. */
export const JOIN_TIMEOUT_MS = 7000;

/** A failure in the panel's own words: a cause line and one consequence line. */
export interface PanelError {
  title: string;
  text: string;
  /** The raw server string, logged by Notice and never rendered. */
  raw?: string;
}

export function turnWords(seat: number): string {
  const label = STONE_LABEL[seat];
  return label ? `${label} to play` : 'To play';
}

export function resultWords(
  session: Pick<GameSessionState, 'winner' | 'reason'>
): string {
  if (session.winner === null) return 'The game ended.';
  const winner = STONE_LABEL[session.winner] ?? 'A player';
  switch (session.reason) {
    case 'resign':
      return `${winner} wins by resignation.`;
    case 'tie-komi':
      return `${winner} wins on komi (${KOMI}).`;
    case 'area':
      return `${winner} wins on points (komi ${KOMI}).`;
    default:
      return `${winner} wins.`;
  }
}

/** "Black 34 · White 29.5"; the server already counts komi into White. */
export function scoreWords(
  score: GameSessionState['score']
): string | null {
  if (!score) return null;
  return `Black ${points(score.black)} · White ${points(score.white)}`;
}

export function boardMetaWords(size: number, moves: number): string {
  const count = moves === 1 ? '1 move' : `${moves} moves`;
  return `${size}×${size} · ${count} · komi ${KOMI}`;
}

export function channelOptions(list: readonly Channel[]): SelectOption[] {
  return list.map((channel) => ({
    value: channel.id,
    label: channel.type === 'dm' || channel.type === 'group' ? channel.name : `#${channel.name}`
  }));
}

/**
 * One refusal vocabulary for the panel. The raw strings are the server's
 * (`core/crates/wabi-server/src/socketio/game_ops.rs`); `timeout` is the
 * client's own no-answer sentinel. Anything unknown still gets a real
 * sentence, and the raw string only reaches the console.
 */
const ERROR_COPY: Record<string, Omit<PanelError, 'raw'>> = {
  'Game Sync is disabled on this server': {
    title: 'Go is turned off here',
    text: 'An owner can turn on the Game Sync add-on in Server Center → Add-ons.'
  },
  'Channel access denied': {
    title: "You can't open this channel",
    text: 'Your access may have changed. Choose another channel, or reload the app.'
  },
  'A game is already in progress in this channel': {
    title: 'This channel already has a game',
    text: 'Finish the current board before starting another.'
  },
  'game already started': {
    title: 'That game has already started',
    text: 'Both seats are filled, so you can watch this board instead.'
  },
  'already seated': {
    title: 'You already have a seat',
    text: 'You are one of the two players in this game.'
  },
  'no open seat': {
    title: 'No seat is open',
    text: 'Both seats are filled in this channel.'
  },
  'no game': {
    title: 'No game in this channel',
    text: 'That board has ended. Start a new one.'
  },
  'game not active': {
    title: 'This game is not running',
    text: 'It may have ended. Start a new board or pick another channel.'
  },
  'not your turn': {
    title: 'Not your turn',
    text: 'Wait for the other seat to move.'
  },
  'not a player': {
    title: 'You are watching this game',
    text: 'Only the two people in the seats can move stones.'
  },
  'out of bounds': {
    title: 'That point is off the board',
    text: 'Choose an intersection inside the grid.'
  },
  occupied: {
    title: 'That point is taken',
    text: 'Choose an empty intersection.'
  },
  ko: {
    title: 'The ko rule blocks that point',
    text: 'Play elsewhere first; the marked point opens after the next move.'
  },
  suicide: {
    title: 'That move would leave no liberties',
    text: 'A stone needs a liberty or a capture. Choose another point.'
  },
  lock: {
    title: 'The board is busy',
    text: 'Another move reached the server first. Try again.'
  },
  'missing channelId': {
    title: 'Choose a channel',
    text: 'Pick a channel above before starting or joining.'
  },
  'missing x': {
    title: 'That move was incomplete',
    text: 'Choose an intersection and try again.'
  },
  'missing y': {
    title: 'That move was incomplete',
    text: 'Choose an intersection and try again.'
  },
  timeout: {
    title: "The board didn't answer",
    text: 'The server did not reply. Retry to ask again.'
  }
};

const FALLBACK: Omit<PanelError, 'raw'> = {
  title: 'The board could not do that',
  text: 'Nothing changed. Try again, or start a new game.'
};

export function errorWords(raw: string | null | undefined): PanelError {
  const key = String(raw ?? '').trim();
  const copy = ERROR_COPY[key] ?? FALLBACK;
  return { ...copy, raw: key || undefined };
}

function points(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
