import type { BusinessDataSnapshot } from './types';
import type { PlannerPersistence } from './persistence';

export interface PlannerOwner { scopeId: string; isCurrent(): boolean }
/** One account/window's draft. Writes always capture this scope and snapshot. */
export class PlannerSession {
	data: BusinessDataSnapshot;
	revision: number;
	dirty = false;
	error: string | null = null;
	private generation = 0;
	private pending: Promise<boolean> | null = null;
	readonly draftId = crypto.randomUUID();
	constructor(readonly scope: string, data: BusinessDataSnapshot, revision: number,
		private persistence: PlannerPersistence, private changed: () => void) {
		this.data = structuredClone(data); this.revision = revision;
	}
	edit(data: BusinessDataSnapshot): void {
		this.data = structuredClone(data); this.generation++; this.dirty = true;
		this.changed();
	}
	async flush(): Promise<boolean> {
		if (this.pending) return this.pending;
		if (!this.dirty) return !this.error;
		this.pending = this.save();
		try { return await this.pending; } finally { this.pending = null; }
	}
	private async save(): Promise<boolean> {
		while (this.dirty) {
			const generation = this.generation;
			const data = structuredClone(this.data);
			try {
				this.revision = await this.persistence.write(this.scope, this.revision, data, this.draftId);
				this.error = null;
				this.dirty = generation !== this.generation;
				this.changed();
			} catch (error) {
				this.error = error instanceof Error ? error.message : 'Planner could not be saved. Export your draft and retry.';
				this.changed(); return false;
			}
		}
		return true;
	}
}
