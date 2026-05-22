export function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const mb = bytes / (1024 * 1024);
	return mb >= 0.01 ? `${mb.toFixed(2)} MB` : `${(bytes / 1024).toFixed(2)} KB`;
}

export function formatPeriod(period: string): string {
	if (period.includes('-W')) {
		const [year, week] = period.split('-W');
		return `Week ${week}, ${year}`;
	} else if (period.includes('-H')) {
		const [year, half] = period.split('-');
		return `${half === 'H1' ? 'First' : 'Second'} Half ${year}`;
	} else if (period.match(/^\d{4}-\d{2}$/)) {
		const [year, month] = period.split('-');
		const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		return `${monthNames[parseInt(month) - 1]} ${year}`;
	} else {
		return `Year ${period}`;
	}
}

export interface StorageStats {
	archives: Array<{ period: string; size: number; messageCount: number }>;
	totalSize: number;
	totalMessages: number;
}

export type RotationPeriod = 'week' | 'month' | 'half-year' | 'year';

export async function toggleStorage(
	chatStorage: { setEnabled: (v: boolean) => Promise<void>; getStats: () => Promise<StorageStats> },
	currentEnabled: boolean
): Promise<{ enabled: boolean; stats: StorageStats }> {
	const next = !currentEnabled;
	await chatStorage.setEnabled(next);
	const stats = await chatStorage.getStats();
	return { enabled: next, stats };
}

export async function updateRotationPeriod(
	chatStorage: { setRotationPeriod: (p: RotationPeriod) => Promise<void>; getStats: () => Promise<StorageStats> },
	period: RotationPeriod
): Promise<StorageStats> {
	await chatStorage.setRotationPeriod(period);
	return await chatStorage.getStats();
}

export async function updateMaxArchives(
	chatStorage: { setMaxArchives: (n: number) => Promise<void>; getStats: () => Promise<StorageStats> },
	max: number
): Promise<StorageStats> {
	await chatStorage.setMaxArchives(max);
	return await chatStorage.getStats();
}
