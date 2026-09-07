import { expect, test } from 'bun:test';
import { buildChannelMediaSharers } from './voiceMediaRoster';

const stream = {} as MediaStream;

test('same account has independent camera/screen badges in each channel', () => {
  const rows = buildChannelMediaSharers(new Map([
    ['a', new Map([['user-2:camera', stream]])],
    ['b', new Map([['user-2:screen', stream]])],
  ]), []);
  expect([...rows.get('a')!.cameraIds]).toEqual(['user-2']);
  expect(rows.get('a')!.screenIds.size).toBe(0);
  expect([...rows.get('b')!.screenIds]).toEqual(['user-2']);
  expect(rows.get('b')!.cameraIds.size).toBe(0);
});

test('scoped P2P shares normalize accounts, never borrowing direct-call shares', () => {
  const rows = buildChannelMediaSharers(new Map(), [
    { channelId: 'a', userId: '2' }, { channelId: 'b', userId: 'guest-socket' },
    { userId: 'user-9' },
  ]);
  expect([...rows.get('a')!.screenIds]).toEqual(['user-2']);
  expect([...rows.get('b')!.screenIds]).toEqual(['guest-socket']);
  expect([...rows.values()].some(row => row.screenIds.has('user-9'))).toBe(false);
});

test('removed feeds and unrecognized media keys do not retain badges', () => {
  const rows = buildChannelMediaSharers(new Map([
    ['a', new Map([['2:camera', stream], ['2:unknown', stream]])],
    ['b', new Map<string, MediaStream>()],
  ]), []);
  expect([...rows.get('a')!.cameraIds]).toEqual(['user-2']);
  expect(rows.has('b')).toBe(false);
  expect(buildChannelMediaSharers(new Map(), []).size).toBe(0);
});
