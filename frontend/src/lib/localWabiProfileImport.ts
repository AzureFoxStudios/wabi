import type { User } from '$lib/socket';
import { get } from 'svelte/store';
import { brandName } from './branding';
import { currentUser, updateProfile } from './socket';
import {
	getLocalWabiAccountByKey,
	getLocalWabiAccountDisplayLabel,
	getLocalWabiAccountKey,
	type LocalWabiAccountRecord
} from './localWabiAccounts';
import { importProfilePictureToCurrentServer } from './profilePictureUpload';
import { getServerUrl } from './serverUrl';

export interface LocalWabiProfileImportSelection {
	displayName: boolean;
	profilePicture: boolean;
}

export interface LocalWabiProfileImportPreview {
	source: LocalWabiAccountRecord;
	sourceLabel: string;
	targetKey: string;
	importableFields: Array<'displayName' | 'profilePicture'>;
	canImport: boolean;
}

export interface LocalWabiProfileImportResult {
	success: boolean;
	importedFields: string[];
	skippedFields: string[];
	errors: string[];
}

export const DEFAULT_LOCAL_WABI_PROFILE_IMPORT_SELECTION: LocalWabiProfileImportSelection = {
	displayName: true,
	profilePicture: true
};

function updateProfileAsync(
	patch: { username?: string; profilePicture?: string }
): Promise<{ success: boolean; error?: string }> {
	return new Promise((resolve) => {
		let settled = false;
		const timeout = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve({ success: false, error: 'Timed out while updating the profile.' });
		}, 8000);

		updateProfile({ username: patch.username, profilePicture: patch.profilePicture });
		window.clearTimeout(timeout);
		settled = true;
		resolve({ success: true });
	});
}

export function getLocalWabiProfileImportPreview(
	sourceAccountKey: string | null | undefined,
	targetUser?: Pick<User, 'dbUserId' | 'username' | 'profilePicture'> | null
): LocalWabiProfileImportPreview | null {
	const source = getLocalWabiAccountByKey(sourceAccountKey);
	const resolvedTargetUser = targetUser || get(currentUser);
	const targetKey = getLocalWabiAccountKey(resolvedTargetUser, getServerUrl());
	if (!source || !resolvedTargetUser?.dbUserId || !targetKey || source.key === targetKey) return null;

	const importableFields: Array<'displayName' | 'profilePicture'> = [];
	const nextDisplayName = source.usernameSnapshot?.trim() || '';
	if (nextDisplayName && nextDisplayName !== (resolvedTargetUser.username || '').trim()) {
		importableFields.push('displayName');
	}
	const nextProfilePicture = source.profilePictureSnapshot?.trim() || '';
	if (
		nextProfilePicture &&
		nextProfilePicture !== (resolvedTargetUser.profilePicture || '').trim()
	) {
		importableFields.push('profilePicture');
	}

	return {
		source,
		sourceLabel: getLocalWabiAccountDisplayLabel(source),
		targetKey,
		importableFields,
		canImport: importableFields.length > 0
	};
}

export async function applyLocalWabiProfileImport(
	sourceAccountKey: string | null | undefined,
	selection: LocalWabiProfileImportSelection = DEFAULT_LOCAL_WABI_PROFILE_IMPORT_SELECTION
): Promise<LocalWabiProfileImportResult> {
	const preview = getLocalWabiProfileImportPreview(sourceAccountKey);
	if (!preview) {
		return {
			success: false,
			importedFields: [],
			skippedFields: [],
			errors: [`No valid local ${brandName} account is available to import from.`]
		};
	}

	const result: LocalWabiProfileImportResult = {
		success: true,
		importedFields: [],
		skippedFields: [],
		errors: []
	};

	if (selection.displayName) {
		if (preview.importableFields.includes('displayName')) {
			const response = await updateProfileAsync({ username: preview.source.usernameSnapshot || undefined });
			if (response.success) {
				result.importedFields.push('display name');
			} else {
				result.success = false;
				result.errors.push(response.error || 'Failed to import display name.');
			}
		} else {
			result.skippedFields.push('display name');
		}
	}

	if (selection.profilePicture) {
		if (preview.importableFields.includes('profilePicture')) {
			try {
				const uploadedProfilePictureUrl = await importProfilePictureToCurrentServer(
					preview.source.profilePictureSnapshot || '',
					preview.source.serverUrl
				);
				const response = await updateProfileAsync({
					profilePicture: uploadedProfilePictureUrl
				});
				if (response.success) {
					result.importedFields.push('profile picture');
				} else {
					result.success = false;
					result.errors.push(response.error || 'Failed to import profile picture.');
				}
			} catch (error) {
				result.success = false;
				result.errors.push(
					error instanceof Error ? error.message : 'Failed to import profile picture.'
				);
			}
		} else {
			result.skippedFields.push('profile picture');
		}
	}

	if (result.importedFields.length === 0 && result.errors.length === 0) {
		result.success = false;
		result.errors.push('Nothing new was available to import from that account.');
	}

	return result;
}
