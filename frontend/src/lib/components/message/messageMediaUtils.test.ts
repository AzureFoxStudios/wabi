import { describe, expect, test } from 'bun:test';
import { getMediaType, isAudio, isVideo } from './messageMediaUtils';

describe('message URL media classification', () => {
	test('classifies OGG as audio rather than video', () => {
		expect(getMediaType('https://example.test/uploads/voice.ogg')).toBe('audio');
		expect(isAudio('voice.ogg')).toBe(true);
		expect(isVideo('voice.ogg')).toBe(false);
	});

	test('classifies recorded WEBA audio as audio', () => {
		expect(getMediaType('https://example.test/uploads/audio-123.weba')).toBe('audio');
		expect(isAudio('audio-123.weba')).toBe(true);
		expect(isVideo('audio-123.weba')).toBe(false);
	});

	test('keeps common video URLs as video', () => {
		expect(getMediaType('https://example.test/uploads/clip.mp4')).toBe('video');
		expect(getMediaType('https://example.test/uploads/clip.webm')).toBe('video');
	});
});