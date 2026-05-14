/**
 * Efficient typed array utilities for cross-platform storage
 * - Tauri: Uses optimized binary format via Rust backend
 * - Web: Uses IndexedDB with serialization helpers
 */

/**
 * Serialize Int32Array to JSON-compatible format for IndexedDB
 */
export function serializeInt32Array(arr: Int32Array | null | undefined): number[] | null {
	if (!arr) return null;
	return Array.from(arr);
}

/**
 * Deserialize number array back to Int32Array
 */
export function deserializeInt32Array(arr: number[] | null | undefined): Int32Array | null {
	if (!arr) return null;
	return new Int32Array(arr);
}

/**
 * Serialize Int32Array to compact base64-encoded binary format
 * Useful for: network transmission, compact storage
 * ~50% smaller than JSON for large arrays
 */
export function serializeInt32ArrayCompact(arr: Int32Array | null | undefined): string | null {
	if (!arr || arr.length === 0) return null;

	try {
		const buffer = arr.buffer;
		const bytes = new Uint8Array(buffer, arr.byteOffset, arr.byteLength);
		// Convert to base64 for safe transmission
		return btoa(String.fromCharCode(...Array.from(bytes)));
	} catch (error) {
		console.error('[TypedArray] Error serializing compact:', error);
		return null;
	}
}

/**
 * Deserialize base64-encoded binary data back to Int32Array
 */
export function deserializeInt32ArrayCompact(encoded: string | null | undefined): Int32Array | null {
	if (!encoded) return null;

	try {
		const binaryString = atob(encoded);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return new Int32Array(bytes.buffer);
	} catch (error) {
		console.error('[TypedArray] Error deserializing compact:', error);
		return null;
	}
}

/**
 * Serialize BigInt64Array to JSON-compatible format
 * Use for: timestamps, large integer IDs
 */
export function serializeBigInt64Array(arr: BigInt64Array | null | undefined): string[] | null {
	if (!arr) return null;
	return Array.from(arr).map(n => n.toString());
}

/**
 * Deserialize string array back to BigInt64Array
 */
export function deserializeBigInt64Array(arr: string[] | null | undefined): BigInt64Array | null {
	if (!arr) return null;
	return new BigInt64Array(arr.map(s => BigInt(s)));
}

/**
 * Calculate memory savings of typed array vs regular array
 */
export function calculateMemorySavings(length: number): {
	regularArray: number;
	int32Array: number;
	savings: number;
	percent: string;
} {
	const regularArray = length * 8; // 8 bytes per float64
	const int32Array = length * 4; // 4 bytes per int32
	const savings = regularArray - int32Array;
	const percent = ((savings / regularArray) * 100).toFixed(1);

	return {
		regularArray,
		int32Array,
		savings,
		percent: `${percent}%`
	};
}

/**
 * Convert typed array to compact JSON representation
 * Format: { type: 'Int32Array', data: [...], length: N }
 */
export function typedArrayToJSON(arr: any): Record<string, any> | null {
	if (!arr) return null;

	if (arr instanceof Int32Array) {
		return {
			type: 'Int32Array',
			data: Array.from(arr as Int32Array),
			length: (arr as Int32Array).length
		};
	} else if (arr instanceof BigInt64Array) {
		return {
			type: 'BigInt64Array',
			data: Array.from(arr as BigInt64Array).map(n => n.toString()),
			length: (arr as BigInt64Array).length
		};
	}

	return null;
}

/**
 * Reconstruct typed array from JSON representation
 */
export function jsonToTypedArray(
	json: Record<string, any> | null | undefined
): Int32Array | BigInt64Array | null {
	if (!json || !json.type) return null;

	if (json.type === 'Int32Array') {
		return new Int32Array(json.data as number[]);
	} else if (json.type === 'BigInt64Array') {
		return new BigInt64Array((json.data as string[]).map(s => BigInt(s)));
	}

	return null;
}

/**
 * Batch convert multiple typed arrays
 * Useful for converting entire structures
 */
export function serializeTypedArrays<T extends Record<string, any>>(
	obj: T,
	typedArrayKeys: (keyof T)[]
): T {
	const result = { ...obj };

	for (const key of typedArrayKeys) {
		const value: any = result[key];
		if (value instanceof Int32Array) {
			result[key] = Array.from(value as Int32Array) as any;
		} else if (value instanceof BigInt64Array) {
			result[key] = Array.from(value as BigInt64Array).map(n => n.toString()) as any;
		}
	}

	return result;
}

/**
 * Batch reconstruct multiple typed arrays
 */
export function deserializeTypedArrays<T extends Record<string, any>>(
	obj: T,
	typedArrayKeys: Array<{ key: keyof T; type: 'Int32Array' | 'BigInt64Array' }>
): T {
	const result = { ...obj };

	for (const { key, type } of typedArrayKeys) {
		const value = result[key];
		if (Array.isArray(value)) {
			if (type === 'Int32Array') {
				result[key] = new Int32Array(value as number[]) as any;
			} else if (type === 'BigInt64Array') {
				result[key] = new BigInt64Array((value as string[]).map(s => BigInt(s))) as any;
			}
		}
	}

	return result;
}
