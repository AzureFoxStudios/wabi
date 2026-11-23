/**
 * Private office files live in this browser's storage. Browsers may clear "best effort" storage when
 * space runs low, so on a save (a deliberate user action, which is when some browsers allow asking)
 * the shell asks for persistent storage and tells the person plainly how it went.
 */
export type Persistence = 'kept' | 'not-guaranteed' | 'unknown';

interface StorageLike {
	persisted?: () => Promise<boolean>;
	persist?: () => Promise<boolean>;
}

export async function requestPersistence(storage?: StorageLike | null): Promise<Persistence> {
	const manager = storage === undefined ? (typeof navigator === 'undefined' ? null : (navigator.storage as StorageLike | undefined)) : storage;
	if (!manager?.persist) return 'unknown';
	try {
		if (manager.persisted && (await manager.persisted())) return 'kept';
		return (await manager.persist()) ? 'kept' : 'not-guaranteed';
	} catch {
		return 'unknown';
	}
}

export function savedPrivatelyMessage(result: Persistence): string {
	const base = 'Saved in this browser on this device only.';
	if (result === 'kept') return `${base} The browser has agreed to keep it. ⋯ > Backup (.wabi.json) keeps a copy elsewhere.`;
	if (result === 'not-guaranteed') return `${base} The browser may clear it if space runs low, so download a copy to be safe.`;
	return `${base} Use ⋯ > Backup (.wabi.json) to keep a copy elsewhere.`;
}
