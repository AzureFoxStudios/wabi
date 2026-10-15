// Wire types for the game-sync addon. Mirrors the server contract in
// core/crates/wabi-server/src/socketio/game_ops.rs (see docs/plans/...).
export type Stone = 0 | 1 | -1;
export type GameStatus = 'waiting' | 'active' | 'finished';
export interface GoMove { x?: number; y?: number; pass?: boolean; }
export interface GameSessionState {
  channelId: string;
  size: number;
  board: number[];
  toPlay: number;
  seats: (number | null)[];
  seatNames: (string | null)[];
  moves: GoMove[];
  consecutivePasses: number;
  status: GameStatus;
  winner: number | null;
  reason: string;
  revision: number;
  ko: { x: number; y: number } | null;
  createdAt?: number;
}
export interface GameNone { channelId: string; status: 'none'; }
export type GameIncoming = GameSessionState | GameNone;

export const GO_SIZES = [9, 13, 19] as const;
export type GoSize = typeof GO_SIZES[number];
export const KOMI = 6.5;
export const STONE_LABEL: Record<number, string> = { 0: 'Black', 1: 'White' };