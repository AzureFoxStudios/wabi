import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { guestSwitchAvailable, guestsAllowed, joinModeOf, policyForJoinMode } from './adminJoinPolicy';

const wizardOpen = { mode: 'open', allowRegister: true, allowGuest: true, emailVerifyRequired: false };

describe('Settings › Admin › Who can join reads auth_policy the way the server does', () => {
	test('the wizard choices read back as Open or Closed', () => {
		expect(joinModeOf(wizardOpen)).toBe('open');
		expect(joinModeOf({ ...wizardOpen, allowRegister: false })).toBe('closed');
		expect(joinModeOf(null)).toBe('open');
	});

	test('a closed or invite mode set elsewhere is shown, never hidden behind "Open"', () => {
		expect(joinModeOf({ ...wizardOpen, mode: 'closed' })).toBe('closed');
		expect(joinModeOf({ ...wizardOpen, mode: 'invite' })).toBe('invite');
		// allowRegister=false wins over invite mode: the server refuses before it checks invites.
		expect(joinModeOf({ ...wizardOpen, mode: 'invite', allowRegister: false })).toBe('closed');
	});

	test('choosing a mode writes what the server checks and keeps the other fields', () => {
		expect(policyForJoinMode(wizardOpen, 'closed')).toEqual({ ...wizardOpen, mode: 'open', allowRegister: false });
		expect(policyForJoinMode({ ...wizardOpen, mode: 'closed', allowRegister: false }, 'open')).toEqual(wizardOpen);
		expect(policyForJoinMode(wizardOpen, 'invite')).toEqual({ ...wizardOpen, mode: 'invite' });
		for (const mode of ['open', 'invite', 'closed'] as const) {
			expect(joinModeOf(policyForJoinMode(wizardOpen, mode))).toBe(mode);
		}
	});

	test('guest access is on only when the server would let a guest in', () => {
		expect(guestsAllowed(wizardOpen)).toBe(true);
		expect(guestsAllowed({ ...wizardOpen, allowGuest: false })).toBe(false);
		expect(guestsAllowed({ ...wizardOpen, mode: 'invite' })).toBe(false);
		expect(guestsAllowed({ ...wizardOpen, mode: 'closed' })).toBe(false);
		// Closed registration (the wizard's Closed) still lets guests in when allowed.
		expect(guestsAllowed({ ...wizardOpen, allowRegister: false })).toBe(true);
		expect(guestSwitchAvailable({ ...wizardOpen, mode: 'invite' })).toBe(false);
		expect(guestSwitchAvailable({ ...wizardOpen, allowRegister: false })).toBe(true);
	});

	test('the tab saves auth_policy through the helpers, with words for every mode', () => {
		const source = readFileSync(new URL('./AdminSettingsTab.svelte', import.meta.url), 'utf8');
		expect(source).toContain("getAdminPolicy<AuthPolicy>(token, 'auth_policy')");
		expect(source).toContain("saveAdminPolicy<AuthPolicy>(token, 'auth_policy', next)");
		expect(source).toContain('policyForJoinMode(policy, value as JoinMode)');
		expect(source).toContain('checked={guestsAllowed(policy)}');
		expect(source).toContain('login.wizard.join_title');
		expect(source).not.toMatch(/\balert\(|window\.confirm/);
	});
});
