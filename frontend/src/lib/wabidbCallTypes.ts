// Row types matching the wabidb call-session domain types, kept in sync
// with the backend so the frontend's view of the data stays identical.

export interface StateCallSessionRow {
  sessionId: string;
  channelId: string;
  callType: string;
  hostUserId: bigint | null;
  startedAt: bigint;
  endedAt: bigint | null;
  transport: string;
  maxParticipants: bigint;
  active: boolean;
  lastUpdatedAt: number; // micros
}

export interface StateCallParticipantRow {
  participantKey: string;
  sessionId: string;
  userId: bigint;
  stableUserId: string;
  joinedAt: bigint;
  leftAt: bigint | null;
  isHost: boolean;
  muted: boolean;
  videoEnabled: boolean;
  lastUpdatedAt: number; // micros
}

export interface StateCallSignalRow {
  signalId: number;
  sessionId: string;
  fromUserId: bigint;
  signalType: string;
  targetUserId: bigint | null;
  payload: string;
  createdAt: number; // micros
}
