import { describe, expect, test } from 'bun:test';
import {
	getNextSpriteFrame,
	getSpriteFramePosition,
	normalizeSpriteAnimation
} from './spriteAnimation';

describe('spriteAnimation', () => {
	test('defaults to an 8 fps horizontal strip', () => {
		const config = normalizeSpriteAnimation({ frameCount: 8 });
		expect(config).toEqual({
			frameCount: 8,
			columns: 8,
			rows: 1,
			fps: 8,
			loop: true
		});
	});

	test('supports multi-row sprite sheets', () => {
		const config = normalizeSpriteAnimation({ frameCount: 10, columns: 4, fps: 12 });
		const frame = getSpriteFramePosition(9, config);

		expect(config.rows).toBe(3);
		expect(frame.column).toBe(1);
		expect(frame.row).toBe(2);
		expect(frame.backgroundSizeX).toBe(400);
		expect(frame.backgroundSizeY).toBe(300);
		expect(frame.backgroundPositionX).toBeCloseTo(100 / 3);
		expect(frame.backgroundPositionY).toBe(100);
	});

	test('clamps malformed values to safe defaults', () => {
		const config = normalizeSpriteAnimation({ frameCount: -4, columns: 99, fps: 999 });
		expect(config.frameCount).toBe(1);
		expect(config.columns).toBe(1);
		expect(config.rows).toBe(1);
		expect(config.fps).toBe(60);
	});

	test('loops after the final frame when enabled', () => {
		const config = normalizeSpriteAnimation({ frameCount: 4, loop: true });
		expect(getNextSpriteFrame(3, config)).toBe(0);
	});

	test('holds on the final frame when looping is disabled', () => {
		const config = normalizeSpriteAnimation({ frameCount: 4, loop: false });
		expect(getNextSpriteFrame(3, config)).toBe(3);
	});
});
