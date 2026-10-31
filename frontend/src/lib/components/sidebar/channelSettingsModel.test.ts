import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	FOREVER_VALUE,
	GATE_OPTIONS,
	MANAGERS_LABEL,
	MANAGERS_ONLY_HINT,
	canManageChannel,
	channelDraftDirty,
	channelSettingsNote,
	channelSettingsTabs,
	channelSettingsTitle,
	hasChannelGate,
	isChatLikeKind,
	nextTab,
	persistToggleTab,
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
	gate: '',
	afkAnnounce: true
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

	test('the offline-copies switch stays reachable for every kind that has messages', () => {
		expect(persistToggleTab('text')).toBe('retention');
		expect(persistToggleTab(undefined)).toBe('retention');
		expect(persistToggleTab('group')).toBe('retention');
		for (const kind of ['voice', 'forum', 'wiki', 'gallery']) expect(persistToggleTab(kind)).toBe('general');
		expect(persistToggleTab('dm')).toBeNull();
		expect(persistToggleTab('category')).toBeNull();
		// Every kind that has no Retention section gets it in General instead.
		for (const kind of ['voice', 'forum', 'wiki', 'gallery']) {
			expect(channelSettingsTabs(kind).some((tab) => tab.id === 'retention')).toBe(false);
		}
	});

	test('who manages a room reads the same everywhere', () => {
		expect(GATE_OPTIONS.at(-1)?.label).toBe(MANAGERS_LABEL);
		expect(MANAGERS_ONLY_HINT).toBe('Only admins and the owner can change it.');
		expect(modalSource).not.toMatch(/[Oo]wners and admins/);
		expect(modalSource).toContain('{MANAGERS_LABEL}');
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

	test('turning away announcements off on its own can be saved', () => {
		expect(channelDraftDirty(draft({ afkAnnounce: false }), base)).toBe(true);
		expect(channelDraftDirty(draft({ afkAnnounce: true }), base)).toBe(false);
		// The modal compares it only while the room is live, against the client default (on).
		expect(modalSource).toContain('afkAnnounce: liveActive ? tempAfkAnnounce : true');
		expect(modalSource).toMatch(/afkAnnounce: true\s*\} satisfies ChannelDraftBaseline/);
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
		// Vertical beside the panel; a row (and announced as one) at 640px and under.
		expect(modalSource).toContain("aria-orientation={tabsHorizontal ? 'horizontal' : 'vertical'}");
		expect(modalSource).toContain("window.matchMedia('(max-width: 640px)')");
		expect(modalSource).toContain('w-srow--seal');
		// One meaning per glyph (§6): who can open is "who can see it"; the shield is moderation.
		expect(modalSource).toContain('<Icon name="eye" size={14} />Who can open');
		expect(modalSource).not.toContain('name="shield"');
		expect(modalSource).toContain('retryLabel="Retry lifetime check"');
	});

	test('every section shares one fixed frame, so switching tabs moves nothing', () => {
		expect(modalSource).toMatch(/:global\(\.w-dialog\.channel-settings\)\s*\{\s*height: min\(720px, calc\(100dvh - 64px\)\);/);
		expect(modalSource).toContain('panelClass="channel-settings"');
		expect(modalSource).not.toMatch(/\.cs-panel\s*\{[^}]*min-height/);
	});

	test('Enter in a Lore binding field saves the binding, not the dialog', () => {
		for (const id of ['lore-path', 'lore-branch', 'lore-types']) {
			expect(modalSource).toContain(`id="{uid}-${id}" class="w-field" type="text" on:keydown={handleLoreKeydown}`);
		}
		const handler = modalSource.slice(modalSource.indexOf('function handleLoreKeydown'), modalSource.indexOf('async function removeLoreBinding'));
		expect(handler).toContain('event.preventDefault()');
		expect(handler).toContain('saveLoreBinding()');
	});

	test('the description grows with its text and stays one paragraph', () => {
		expect(modalSource).toMatch(/<textarea\s+id="\{uid\}-description"\s+class="w-field cs-description"/);
		expect(modalSource).toContain('field-sizing: content');
		expect(modalSource).toContain("event.currentTarget.form?.requestSubmit()");
	});

	test('the danger zone uses outlined kit danger buttons and never the seal', () => {
		const danger = modalSource.slice(modalSource.indexOf('cs-danger'), modalSource.indexOf("activeTab === 'permissions'"));
		expect(danger).toContain('w-btn--danger');
		expect(danger).not.toContain('seal');
	});

	test('the sticky tablist rests where it sticks, so it never nudges under the pointer', () => {
		const tabsRule = modalSource.slice(modalSource.indexOf('\t.cs-tabs {'));
		expect(tabsRule).toMatch(/^\t\.cs-tabs \{\s*position: sticky;\s*top: 4px;/);
		expect(modalSource).toMatch(/\.cs-layout \{[^}]*padding-top: 4px;/);
	});

	test('the description grows by hand where field-sizing is missing (WebKit, Firefox)', () => {
		expect(modalSource).toContain("CSS.supports('field-sizing', 'content')");
		expect(modalSource).toContain('use:descriptionFit={tempDescription}');
		expect(modalSource).toMatch(/if \(descriptionGrowsNatively\) return;\s*field\.style\.height = 'auto';/);
	});

	test('away announcements stay on and say so until the server keeps the choice', () => {
		expect(modalSource).toMatch(/<Switch labelledby="\{uid\}-afk-label"[^>]*bind:checked=\{tempAfkAnnounce\} disabled \/>/);
		expect(modalSource).toContain("Always on for now: this server doesn't keep a per-room choice yet.");
	});
});
