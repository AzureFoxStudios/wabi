import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	PROFILE_LIMITS,
	isProfileDirty,
	profileCounter,
	profileIssues,
	profilePatch,
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
});
