import { describe, expect, test } from 'bun:test';
import { createModelRenderLoop } from './modelRenderLoop';

describe('model render visibility', () => {
	test('pauses offscreen work and resumes without a hidden-time jump', () => {
		const frames = new Map<number, FrameRequestCallback>();
		let nextFrame = 1;
		let renders = 0;
		let clockResets = 0;
		const loop = createModelRenderLoop(
			() => { renders++; },
			() => { clockResets++; },
			(callback) => { const id = nextFrame++; frames.set(id, callback); return id; },
			(id) => { frames.delete(id); }
		);

		loop.setActive(true);
		loop.setActive(true);
		expect(frames.size).toBe(1);
		expect(clockResets).toBe(1);
		const first = frames.get(1)!;
		frames.delete(1);
		first(0);
		expect(renders).toBe(1);
		expect(frames.size).toBe(1);

		loop.setActive(false);
		expect(frames.size).toBe(0);
		first(0); // A callback already queued before cancellation must be harmless.
		expect(renders).toBe(1);
		loop.setActive(true);
		expect(clockResets).toBe(2);
		loop.dispose();
		expect(frames.size).toBe(0);
		loop.setActive(true);
		expect(frames.size).toBe(0);
	});
});
