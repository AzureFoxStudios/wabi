/**
 * Settings › Profile is one form with one save (design contract §8.9): display name, status
 * message and About me are drafts until "Save", which publishes only the fields that changed in
 * a single profile update. The server measures these limits in UTF-8 bytes, so the counters
 * count the same way; they read "12 / 32", never "bytes".
 */

export const PROFILE_LIMITS = { name: 32, status: 120, bio: 280 } as const;
export const PROFILE_NAME_MIN = 2;

export interface ProfileDraft {
	name: string;
	status: string;
	bio: string;
}

export type ProfileField = keyof ProfileDraft;

export interface ProfilePatch {
	username?: string;
	statusMessage?: string;
	bio?: string;
}

const encoder = new TextEncoder();

/** What the server counts: UTF-8 bytes of the trimmed text. */
export function profileLength(text: string): number {
	return encoder.encode(text.trim()).length;
}

/** The counter under a field: "12 / 32". */
export function profileCounter(text: string, limit: number): string {
	return `${profileLength(text)} / ${limit}`;
}

export function trimmedDraft(draft: ProfileDraft): ProfileDraft {
	return { name: draft.name.trim(), status: draft.status.trim(), bio: draft.bio.trim() };
}

/** One sentence per field that cannot be saved yet. */
export function profileIssues(draft: ProfileDraft): Partial<Record<ProfileField, string>> {
	const issues: Partial<Record<ProfileField, string>> = {};
	const name = draft.name.trim();
	if ([...name].length < PROFILE_NAME_MIN) issues.name = 'Use at least 2 characters.';
	else if (profileLength(name) > PROFILE_LIMITS.name) issues.name = 'Shorten your name. Emoji and some letters count as more than one.';
	if (profileLength(draft.status) > PROFILE_LIMITS.status) issues.status = 'Shorten your status. Emoji and some letters count as more than one.';
	if (profileLength(draft.bio) > PROFILE_LIMITS.bio) issues.bio = 'Shorten About me. Emoji and some letters count as more than one.';
	return issues;
}

/** The fields whose trimmed text differs from what is published. */
export function profilePatch(draft: ProfileDraft, published: ProfileDraft): ProfilePatch {
	const next = trimmedDraft(draft);
	const base = trimmedDraft(published);
	const patch: ProfilePatch = {};
	if (next.name !== base.name) patch.username = next.name;
	if (next.status !== base.status) patch.statusMessage = next.status;
	if (next.bio !== base.bio) patch.bio = next.bio;
	return patch;
}

export function isProfileDirty(draft: ProfileDraft, published: ProfileDraft): boolean {
	return Object.keys(profilePatch(draft, published)).length > 0;
}

/** After a save: the published baseline the server confirmed for the submitted drafts. */
export function publishedAfterSave(published: ProfileDraft, submitted: ProfileDraft): ProfileDraft {
	const patch = profilePatch(submitted, published);
	return {
		name: patch.username ?? published.name,
		status: patch.statusMessage ?? published.status,
		bio: patch.bio ?? published.bio
	};
}
