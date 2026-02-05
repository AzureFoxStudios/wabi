/**
 * Cross-platform storage abstraction for business data
 * - Tauri: Uses optimized binary format via Rust backend
 * - Web: Uses IndexedDB with serialization
 */

import { invoke } from '@tauri-apps/api/core';
import { chatStorage } from '$lib/storage';
import {
	serializeInt32Array,
	deserializeInt32Array,
	serializeBigInt64Array,
	deserializeBigInt64Array,
	serializeTypedArrays,
	deserializeTypedArrays,
} from '$lib/typed-array-utils';
import { isRunningInTauri } from '$lib/tauri-storage';
import type { BurnChartDataPoint } from './types';

/**
 * Save burndown chart data with optimal storage strategy
 */
export async function saveBurndownChart(
	projectId: string,
	data: BurnChartDataPoint[]
): Promise<void> {
	if (isRunningInTauri()) {
		// Tauri: Send to Rust backend (MessagePack binary format)
		// Convert to plain objects for Rust serialization
		const plainData = data.map(point => ({
			date: point.date,
			total_points: typeof point.totalPoints === 'number'
				? point.totalPoints
				: Array.from(point.totalPoints as Int32Array)[0] || 0,
			completed_points: typeof point.completedPoints === 'number'
				? point.completedPoints
				: Array.from(point.completedPoints as Int32Array)[0] || 0,
			remaining_points: typeof point.remainingPoints === 'number'
				? point.remainingPoints
				: Array.from(point.remainingPoints as Int32Array)[0] || 0,
		}));

		await invoke('save_burndown_chart', {
			projectId,
			data: plainData,
		});
	} else {
		// Web: Store in IndexedDB with serialization
		const serialized = data.map(point => ({
			date: point.date,
			totalPoints: serializeInt32Array(
				typeof point.totalPoints === 'number'
					? new Int32Array([point.totalPoints])
					: (point.totalPoints as Int32Array)
			),
			completedPoints: serializeInt32Array(
				typeof point.completedPoints === 'number'
					? new Int32Array([point.completedPoints])
					: (point.completedPoints as Int32Array)
			),
			remainingPoints: serializeInt32Array(
				typeof point.remainingPoints === 'number'
					? new Int32Array([point.remainingPoints])
					: (point.remainingPoints as Int32Array)
			),
		}));

		await chatStorage.setSetting(`burndown_${projectId}`, serialized);
	}
}

/**
 * Load burndown chart data from optimal storage
 */
export async function loadBurndownChart(projectId: string): Promise<BurnChartDataPoint[]> {
	if (isRunningInTauri()) {
		const data = await invoke<
			Array<{
				date: number;
				total_points: number;
				completed_points: number;
				remaining_points: number;
			}>
		>('load_burndown_chart', { projectId });

		return data.map(point => ({
			date: point.date,
			totalPoints: point.total_points,
			completedPoints: point.completed_points,
			remainingPoints: point.remaining_points,
		}));
	} else {
		const serialized = await chatStorage.getSetting(`burndown_${projectId}`);
		if (!serialized) return [];

		return serialized.map(
			(point: {
				date: number;
				totalPoints: number[] | null;
				completedPoints: number[] | null;
				remainingPoints: number[] | null;
			}) => ({
				date: point.date,
				totalPoints: deserializeInt32Array(point.totalPoints)?.[0] || 0,
				completedPoints: deserializeInt32Array(point.completedPoints)?.[0] || 0,
				remainingPoints: deserializeInt32Array(point.remainingPoints)?.[0] || 0,
			})
		);
	}
}

/**
 * Save calendar reminders with optimal storage
 */
export async function saveReminders(eventId: string, minutes: Int32Array): Promise<void> {
	if (isRunningInTauri()) {
		// Tauri: Send to Rust backend (MessagePack)
		await invoke('save_reminders', {
			eventId,
			minutes: Array.from(minutes),
		});
	} else {
		// Web: Store in IndexedDB
		await chatStorage.setSetting(`reminders_${eventId}`, serializeInt32Array(minutes));
	}
}

/**
 * Load calendar reminders
 */
export async function loadReminders(eventId: string): Promise<Int32Array | null> {
	if (isRunningInTauri()) {
		const data = await invoke<number[]>('load_reminders', { eventId });
		return new Int32Array(data);
	} else {
		const serialized = await chatStorage.getSetting(`reminders_${eventId}`);
		return deserializeInt32Array(serialized);
	}
}

/**
 * Delete calendar reminders
 */
export async function deleteReminders(eventId: string): Promise<void> {
	if (isRunningInTauri()) {
		await invoke('delete_reminders', { eventId });
	} else {
		await chatStorage.setSetting(`reminders_${eventId}`, null);
	}
}

/**
 * Save cancelled dates with BigInt64Array for large timestamps
 */
export async function saveCancelledDates(
	eventId: string,
	dates: BigInt64Array
): Promise<void> {
	if (isRunningInTauri()) {
		// Note: Tauri doesn't handle BigInt64 directly, so convert to strings
		const serialized = Array.from(dates).map(d => d.toString());
		await chatStorage.setSetting(`cancelled_${eventId}`, serialized);
	} else {
		// Web: Store serialized
		await chatStorage.setSetting(
			`cancelled_${eventId}`,
			serializeBigInt64Array(dates)
		);
	}
}

/**
 * Load cancelled dates
 */
export async function loadCancelledDates(eventId: string): Promise<BigInt64Array | null> {
	const serialized = await chatStorage.getSetting(`cancelled_${eventId}`);
	return deserializeBigInt64Array(serialized);
}

/**
 * Get storage statistics (Tauri only)
 */
export async function getStorageStats(): Promise<{
	totalBurndownFiles: number;
	totalReminderFiles: number;
	totalSizeBytes: number;
} | null> {
	if (!isRunningInTauri()) {
		return null;
	}

	const stats = await invoke<{
		total_burndown_files: number;
		total_reminder_files: number;
		total_size_bytes: number;
	}>('get_data_stats', {});

	return {
		totalBurndownFiles: stats.total_burndown_files,
		totalReminderFiles: stats.total_reminder_files,
		totalSizeBytes: stats.total_size_bytes,
	};
}

/**
 * Clear all binary data (Tauri only)
 */
export async function clearBinaryData(): Promise<string> {
	if (!isRunningInTauri()) {
		return 'Not running in Tauri';
	}

	return invoke<string>('clear_binary_data', {});
}

/**
 * Memory usage calculator for data structures
 */
export function calculateMemoryUsage(
	burndownPoints: number,
	reminderCounts: number
): {
	before: number;
	after: number;
	savings: number;
	percent: string;
} {
	// Before: All number arrays (floats)
	const beforeBurndown = burndownPoints * 4 * 8; // 4 fields * 8 bytes each
	const beforeReminders = reminderCounts * 8; // floats

	// After: Int32Array + BigInt64Array
	const afterBurndown = burndownPoints * 4 * 4; // 4 fields * 4 bytes each
	const afterReminders = reminderCounts * 4; // int32

	const beforeTotal = beforeBurndown + beforeReminders;
	const afterTotal = afterBurndown + afterReminders;
	const savings = beforeTotal - afterTotal;
	const percent = ((savings / beforeTotal) * 100).toFixed(1);

	return {
		before: beforeTotal,
		after: afterTotal,
		savings,
		percent: `${percent}%`,
	};
}
