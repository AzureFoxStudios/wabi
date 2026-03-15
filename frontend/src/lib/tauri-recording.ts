import { invoke } from '@tauri-apps/api/core';
import { isDesktopTauri } from './tauri-platform';

function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const slice = bytes.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...slice);
	}
	return btoa(binary);
}

export async function saveCallRecordingToDesktop(suggestedName: string, blob: Blob): Promise<string | null> {
	if (!isDesktopTauri()) return null;
	const buffer = await blob.arrayBuffer();
	const bytesBase64 = uint8ArrayToBase64(new Uint8Array(buffer));
	return invoke<string>('save_call_recording', {
		suggested_name: suggestedName,
		bytes_base64: bytesBase64
	});
}
