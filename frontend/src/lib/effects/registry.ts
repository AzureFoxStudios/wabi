import type { AmbientEffect } from './types';

const effects = new Map<string, AmbientEffect>();

export const effectsRegistry = {
	register(effect: AmbientEffect): void {
		effects.set(effect.id, effect);
	},

	get(id: string): AmbientEffect | undefined {
		return effects.get(id);
	},

	list(): AmbientEffect[] {
		return Array.from(effects.values());
	},

	remove(id: string): void {
		effects.delete(id);
	},
};
