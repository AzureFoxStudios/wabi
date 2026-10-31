import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { guestSwitchAvailable, guestsAllowed, joinModeOf, needsEmailCheck, policyForJoinMode } from './adminJoinPolicy';

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
		expect(policyForJoinMode({ ...wizardOpen, allowRegister: false }, 'open')).toEqual(wizardOpen);
		// Invite only refuses guests, so it stores them off: what is saved matches the switch.
		expect(policyForJoinMode(wizardOpen, 'invite')).toEqual({ ...wizardOpen, mode: 'invite', allowGuest: false });
		expect(policyForJoinMode({ ...wizardOpen, theme: 'kept' }, 'closed').theme).toBe('kept');
		for (const mode of ['open', 'invite', 'closed'] as const) {
			expect(joinModeOf(policyForJoinMode(wizardOpen, mode))).toBe(mode);
		}
	});

	test('leaving Invite only never turns guest access back on', () => {
		// The stored allowGuest is usually still true (AuthPolicy default, the wizard) while the
		// mode refuses guests and the switch shows Off.
		const invite = { ...wizardOpen, mode: 'invite' };
		expect(guestsAllowed(invite)).toBe(false);
		for (const next of ['closed', 'open'] as const) {
			const saved = policyForJoinMode(invite, next);
			expect(saved.allowGuest).toBe(false);
			expect(guestsAllowed(saved)).toBe(false);
			expect(joinModeOf(saved)).toBe(next);
		}
		// The same for a "closed" mode set elsewhere.
		expect(guestsAllowed(policyForJoinMode({ ...wizardOpen, mode: 'closed' }, 'closed'))).toBe(false);
		expect(guestsAllowed(policyForJoinMode({ ...wizardOpen, mode: 'closed' }, 'open'))).toBe(false);
		// Between Open and Closed the guest switch is kept as it was, on or off.
		expect(guestsAllowed(policyForJoinMode(wizardOpen, 'closed'))).toBe(true);
		expect(guestsAllowed(policyForJoinMode({ ...wizardOpen, allowGuest: false }, 'closed'))).toBe(false);
		expect(guestsAllowed(policyForJoinMode({ ...wizardOpen, allowRegister: false }, 'open'))).toBe(true);
	});

	test('a policy that asks for email checks reads as unsupported, and choosing a mode repairs it', () => {
		// load_auth_policy refuses every registration and guest for these; the save route returns 400.
		for (const broken of [{ ...wizardOpen, mode: 'verified' }, { ...wizardOpen, emailVerifyRequired: true }]) {
			expect(needsEmailCheck(broken)).toBe(true);
			expect(joinModeOf(broken)).toBe('unsupported');
			expect(guestsAllowed(broken)).toBe(false);
			expect(guestSwitchAvailable(broken)).toBe(false);
			for (const mode of ['open', 'invite', 'closed'] as const) {
				const saved = policyForJoinMode(broken, mode);
				expect(saved.emailVerifyRequired).toBe(false);
				expect(saved.mode).not.toBe('verified');
				expect(needsEmailCheck(saved)).toBe(false);
				expect(joinModeOf(saved)).toBe(mode);
				// Nobody could join before, so the repair does not admit guests either.
				expect(saved.allowGuest).toBe(false);
			}
		}
		expect(needsEmailCheck(wizardOpen)).toBe(false);
		expect(needsEmailCheck(null)).toBe(false);
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
		expect(source).toContain("joinMode === 'unsupported'");
		expect(source).toContain('login.wizard.join_title');
		expect(source).not.toMatch(/\balert\(|window\.confirm/);
	});
});
