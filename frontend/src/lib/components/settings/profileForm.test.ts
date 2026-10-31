import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	PROFILE_LIMITS,
	isProfileDirty,
	profileCounter,
	profileIssues,
	profilePatch,
	profileSaveCause,
	profileSaveFailure,
	profileSaveUnconfirmed,
	publishedAfterSave
} from './profileForm';

const published = { name: 'Mira', status: '', bio: 'Making room for good ideas.' };

describe('Settings › Profile is one form with one save', () => {
	test('only changed fields are published, trimmed', () => {
		expect(profilePatch({ ...published }, published)).toEqual({});
		expect(profilePatch({ ...published, name: '  Mira  ' }, published)).toEqual({});
		expect(profilePatch({ name: 'Mira K', status: ' Out walking ', bio: published.bio }, published)).toEqual({
			username: 'Mira K',
			statusMessage: 'Out walking'
		});
		expect(profilePatch({ ...published, bio: '' }, published)).toEqual({ bio: '' });
	});

	test('dirty follows the trimmed drafts, so whitespace alone never shows the save bar', () => {
		expect(isProfileDirty({ ...published, bio: `${published.bio}  ` }, published)).toBe(false);
		expect(isProfileDirty({ ...published, status: 'Back at 3' }, published)).toBe(true);
	});

	test('after a save the baseline is what was submitted, untouched fields keep their published text', () => {
		const submitted = { name: 'Mira K', status: 'Back at 3', bio: published.bio };
		expect(publishedAfterSave(published, submitted)).toEqual(submitted);
		expect(isProfileDirty(submitted, publishedAfterSave(published, submitted))).toBe(false);
	});

	test('counters read "N / limit" in the unit the server checks, never "bytes"', () => {
		expect(profileCounter('Mira', PROFILE_LIMITS.name)).toBe('4 / 32');
		expect(profileCounter(' é ', PROFILE_LIMITS.name)).toBe('2 / 32');
		expect(profileCounter('', PROFILE_LIMITS.bio)).toBe('0 / 280');
	});

	test('issues name the field and the fix', () => {
		expect(profileIssues(published)).toEqual({});
		expect(profileIssues({ ...published, name: 'M' }).name).toBe('Use at least 2 characters.');
		expect(profileIssues({ ...published, name: '😀'.repeat(9) }).name).toMatch(/Shorten your name/);
		expect(profileIssues({ ...published, status: 'x'.repeat(121) }).status).toMatch(/Shorten your status/);
		expect(profileIssues({ ...published, bio: 'x'.repeat(281) }).bio).toMatch(/Shorten About me/);
	});

	test('the tab renders one form, one save bar, no byte counters and no per-field save buttons', () => {
		const source = readFileSync(new URL('./ProfileSettingsTab.svelte', import.meta.url), 'utf8');
		expect(source).not.toMatch(/bytes/);
		expect(source).not.toMatch(/Save bio|Save status message|profile-mock/);
		expect(source).not.toMatch(/\balert\(|window\.confirm|<details/);
		expect(source.match(/<form\b/g)?.length).toBe(1);
		expect(source).toMatch(/Unsaved changes/);
		expect(source).toMatch(/\{#if dirty \|\| saving\}/);
		expect(source).toMatch(/onclick=\{discard\}/);
	});

	test('a failed save says what happened in plain words, never the server reason (§7.16)', () => {
		// requestProfileSave rejects with the server's profile-update-failed reason as the message.
		const failure = new Error('username must be nonempty text of at most 32 characters without control characters');
		expect(profileSaveFailure(failure)).toBe('Not saved. The server did not accept that display name.');
		expect(profileSaveFailure(failure)).not.toMatch(/nonempty|control characters|username/);

		expect(profileSaveFailure(new Error('Connect to your server to publish profile changes.'))).toBe('Not saved. Connect to your server first.');
		expect(profileSaveFailure(new Error('statusMessage must be text'))).toBe('Not saved. The server did not accept that status message.');
		expect(profileSaveFailure(new Error('failed to persist profile'))).toBe('Not saved. The server did not save it. Try again in a moment.');
		expect(profileSaveFailure(new TypeError('sock.emit is not a function'))).toBe('Not saved. The server did not save it. Try again in a moment.');
		expect(profileSaveCause(new Error('failed to persist profile'))).toBeNull();
	});

	test('a save the server never answered says to check, not that it failed', () => {
		const dropped = new Error('Disconnected before the save was confirmed. Reconnect and check your profile before retrying.');
		const timedOut = new Error('The save could not be confirmed. Check your profile after reconnecting before retrying.');
		for (const error of [dropped, timedOut]) {
			expect(profileSaveUnconfirmed(error)).toBe(true);
			expect(profileSaveFailure(error)).toBe('Not confirmed. Check your profile after reconnecting before you try again.');
		}
		expect(profileSaveUnconfirmed(new Error('failed to persist profile'))).toBe(false);
	});

	test('the save bar shows mapped words, keeps the edits, and drops a stale failure on the next edit', () => {
		const source = readFileSync(new URL('./ProfileSettingsTab.svelte', import.meta.url), 'utf8');
		expect(source).toContain('saveError = profileSaveFailure(error);');
		expect(source).not.toMatch(/saveError = error instanceof Error \? error\.message/);
		expect(source).not.toMatch(/mediaStatus = e(rror)? instanceof Error \? e(rror)?\.message/);
		expect(source).toContain('{saveError} Your edits are still here.');
		expect(source).toMatch(/void draft\.name;[\s\S]*?if \(!saving\) saveError = '';/);
	});

	test('the name style studio waits behind a closed disclosure under a serif title', () => {
		const source = readFileSync(new URL('./ProfileSettingsTab.svelte', import.meta.url), 'utf8');
		const block = source.slice(source.indexOf('class="settings-block w-profile__studio"'));
		expect(block).toMatch(/^[^]*?<h3 class="settings-block__title" id="profile-name-style-title">Name style<\/h3>/);
		expect(source).toContain('let nameStyleOpen = $state(false);');
		expect(block.indexOf('class="w-disclosure"')).toBeLessThan(block.indexOf('<UsernameFontCustomizer'));
		expect(block).toContain('hidden={!nameStyleOpen}');
		// "Use design" in the artwork guide opens the studio before loading the example.
		expect(source).toMatch(/nameStyleOpen = true;\s*await tick\(\);\s*nameDesignStudio\?\.loadExampleDraft\(example\);/);
	});
});
