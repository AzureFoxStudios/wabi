/**
 * storageSettings.ts
 * Storage settings, rotation configuration, and period key generation
 */

import { browser } from '$app/environment';
import type { RotationPeriod } from './storageTypes';
import type { IndexedDBWrapper } from './storageDb';

export class StorageSettings {
	private rotationPeriod: RotationPeriod = 'month';
	private maxArchives = 2;

	constructor(private db: IndexedDBWrapper) {}

	async load(): Promise<void> {
		if (!browser) return;

		const period = await this.db.getSetting('rotationPeriod');
		if (period) this.rotationPeriod = period as RotationPeriod;

		const max = await this.db.getSetting('maxArchives');
		if (max) this.maxArchives = parseInt(max);
	}

	async setRotationPeriod(period: RotationPeriod): Promise<void> {
		if (!browser) return;
		this.rotationPeriod = period;
		await this.db.setSetting('rotationPeriod', period);
	}

	async setMaxArchives(max: number): Promise<void> {
		if (!browser) return;
		this.maxArchives = max;
		await this.db.setSetting('maxArchives', max.toString());
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (!browser) return;
		await this.db.setSetting('saveHistory', enabled.toString());
	}

	async isEnabled(): Promise<boolean> {
		if (!browser) return false;
		const enabled = await this.db.getSetting('saveHistory');
		return enabled === 'true' || enabled === true;
	}

	async getSetting(key: string): Promise<any> {
		if (!browser) return null;
		return this.db.getSetting(key);
	}

	async setSetting(key: string, value: any): Promise<void> {
		if (!browser) return;
		return this.db.setSetting(key, value);
	}

	getRotationPeriod(): RotationPeriod {
		return this.rotationPeriod;
	}

	getMaxArchives(): number {
		return this.maxArchives;
	}

	getPeriodKey(): string {
		const now = new Date();
		const year = now.getFullYear();

		switch (this.rotationPeriod) {
			case 'week': {
				const week = this.getWeekNumber(now);
				return `${year}-W${String(week).padStart(2, '0')}`;
			}
			case 'month': {
				const month = now.getMonth() + 1;
				return `${year}-${String(month).padStart(2, '0')}`;
			}
			case 'half-year': {
				const half = now.getMonth() < 6 ? 'H1' : 'H2';
				return `${year}-${half}`;
			}
			case 'year': {
				return `${year}`;
			}
		}
	}

	private getWeekNumber(date: Date): number {
		const firstDay = new Date(date.getFullYear(), 0, 1);
		const days = Math.floor((date.getTime() - firstDay.getTime()) / (24 * 60 * 60 * 1000));
		return Math.ceil((days + firstDay.getDay() + 1) / 7);
	}
}
