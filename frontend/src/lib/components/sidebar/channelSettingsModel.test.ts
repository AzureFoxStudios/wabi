import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	FOREVER_VALUE,
	GATE_OPTIONS,
	canManageChannel,
	channelDraftDirty,
	channelSettingsNote,
	channelSettingsTabs,
	channelSettingsTitle,
	hasChannelGate,
	isChatLikeKind,
	nextTab,
	retentionChoiceFor,
	retentionOptions,
	retentionValue,
	type ChannelDraft,
	type ChannelDraftBaseline
} from './channelSettingsModel';

const here = dirname(fileURLToPath(import.meta.url));
const modalSource = readFileSync(join(here, 'ChannelSettingsModal.svelte'), 'utf8');

const base: ChannelDraftBaseline = {
	name: 'introductions',
	description: 'Say hello',
	forceSpoiler: false,
	watchQueueEnabled: false,
	persistMessages: false,
	voiceUserLimit: '',
	voiceForceSolo: false,
	renderWindow: 250,
	gate: ''
};
const draft = (patch: Partial<ChannelDraft> = {}): ChannelDraft => ({ ...base, retention: undefined, liveFields: [], ...patch });

describe('channel settings words', () => {
	test('titles are sentence case and named by kind', () => {
		expect(channelSettingsTitle('text')).toBe('Channel settings');
		expect(channelSettingsTitle(undefined)).toBe('Channel settings');
		expect(channelSettingsTitle('wiki')).toBe('Wiki settings');
		expect(channelSettingsTitle('voice')).toBe('Voice room settings');
		expect(channelSettingsTitle('category')).toBe('Folder settings');
	});

	test('the scope note names the place without a text glyph', () => {
		expect(channelSettingsNote('text', 'general')).toBe('#general');
		expect(channelSettingsNote('wiki', 'community-guide')).toBe('community-guide');
	});

	test('Retention is a section only where a chat stream keeps messages', () => {
		expect(channelSettingsTabs('text').map((tab) => tab.id)).toEqual(['general', 'permissions', 'retention']);
		expect(channelSettingsTabs('forum').map((tab) => tab.id)).toEqual(['general', 'permissions']);
		expect(channelSettingsTabs('voice').map((tab) => tab.id)).toEqual(['general', 'permissions']);
		expect(isChatLikeKind('gallery')).toBe(false);
		expect(isChatLikeKind('lore')).toBe(true);
	});

	test('lifetimes read like the colophon chip and never say private', () => {
		const options = retentionOptions();
		expect(options[0]).toEqual({ value: 'live', label: 'Live only · not saved' });
		expect(options[1]).toEqual({ value: FOREVER_VALUE, label: 'Kept until someone deletes them' });
		expect(options.find((option) => option.value === '24h')?.label).toBe('Kept 24 hours');
		expect(options.every((option) => !/private/i.test(option.label))).toBe(true);
		expect(options.filter((option) => option.group === 'Timed').length).toBe(14);
	});

	test('select values round-trip the stored lifetime', () => {
		expect(retentionValue(null)).toBe(FOREVER_VALUE);
		expect(retentionValue(undefined)).toBe('');
		expect(retentionValue('live')).toBe('live');
		expect(retentionChoiceFor(FOREVER_VALUE)).toBeNull();
		expect(retentionChoiceFor('7d')).toBe('7d');
	});

	test('the gate matches the server roles and skips conversations and folders', () => {
		expect(GATE_OPTIONS.map((option) => option.value)).toEqual(['', 'member', 'moderator', 'admin']);
		expect(hasChannelGate('text')).toBe(true);
		expect(hasChannelGate('voice')).toBe(true);
		for (const kind of ['dm', 'group', 'category', 'reception']) expect(hasChannelGate(kind)).toBe(false);
	});

	test('only owners and admins manage a channel', () => {
		expect(canManageChannel('owner')).toBe(true);
		expect(canManageChannel('admin')).toBe(true);
		expect(canManageChannel('mod')).toBe(false);
		expect(canManageChannel(undefined)).toBe(false);
	});
});

describe('channel settings save rules', () => {
	test('an untouched draft is clean', () => {
		expect(channelDraftDirty(draft(), base)).toBe(false);
	});

	test('a blank name falls back to the current one instead of counting as a change', () => {
		expect(channelDraftDirty(draft({ name: '   ' }), base)).toBe(false);
		expect(channelDraftDirty(draft({ name: 'hello' }), base)).toBe(true);
	});

	test('a lifetime choice, a typed live field or a toggle makes it dirty', () => {
		expect(channelDraftDirty(draft({ retention: null }), base)).toBe(true);
		expect(channelDraftDirty(draft({ liveFields: ['', '10m'] }), base)).toBe(true);
		expect(channelDraftDirty(draft({ liveFields: ['  '] }), base)).toBe(false);
		expect(channelDraftDirty(draft({ forceSpoiler: true }), base)).toBe(true);
		expect(channelDraftDirty(draft({ voiceUserLimit: ' ' }), base)).toBe(false);
	});

	test('an unloaded gate never counts as a change', () => {
		expect(channelDraftDirty(draft({ gate: null }), base)).toBe(false);
		expect(channelDraftDirty(draft({ gate: 'admin' }), { ...base, gate: null })).toBe(false);
		expect(channelDraftDirty(draft({ gate: 'admin' }), base)).toBe(true);
	});

	test('the section list moves with arrows, Home and End', () => {
		const tabs = ['general', 'permissions', 'retention'];
		expect(nextTab(tabs, 'general', 'ArrowDown')).toBe('permissions');
		expect(nextTab(tabs, 'general', 'ArrowUp')).toBe('retention');
		expect(nextTab(tabs, 'permissions', 'End')).toBe('retention');
		expect(nextTab(tabs, 'retention', 'Home')).toBe('general');
		expect(nextTab(tabs, 'general', 'Enter')).toBeNull();
	});
});

describe('ChannelSettingsModal frame (§7.13, §8.9)', () => {
	test('sits on BaseModal lg with a sentence-case title and no native dialogs', () => {
		expect(modalSource).toContain('<BaseModal');
		expect(modalSource).toMatch(/size="lg"/);
		expect(modalSource).not.toMatch(/window\.(alert|confirm|prompt)\(/);
		expect(modalSource).not.toContain('Channel Settings');
		expect(modalSource).not.toMatch(/🔒|&times;/);
	});

	test('sections are a vertical tablist and permission rows wear the seal', () => {
		expect(modalSource).toContain('role="tablist"');
		expect(modalSource).toContain('aria-orientation="vertical"');
		expect(modalSource).toContain('w-srow--seal');
		expect(modalSource).toContain('retryLabel="Retry lifetime check"');
	});

	test('the danger zone uses outlined kit danger buttons and never the seal', () => {
		const danger = modalSource.slice(modalSource.indexOf('cs-danger'), modalSource.indexOf("activeTab === 'permissions'"));
		expect(danger).toContain('w-btn--danger');
		expect(danger).not.toContain('seal');
	});
});
