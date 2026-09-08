import { expect, test } from 'bun:test';
import { adminPaymentPoliciesMatch, adminPaymentRolesNeedReview, canonicalAdminPaymentRole, canSaveAdminPaymentPolicy, cloneAdminPaymentPolicy, effectiveAdminPaymentRoles, readAdminPaymentPolicy, retainedAdminPaymentRoles, reviewAdminPaymentRole, setAdminPaymentGuestAccess, setAdminPaymentRole } from './adminPaymentPolicy';

const baseline = { enabled: true, allowGuest: false, allowedRoleNames: ['owner', 'admin', 'mod', 'member'] };

test('explicit empty role selection is preserved and denies every role', () => {
	const policy = readAdminPaymentPolicy({ enabled: true, allowGuest: true, allowedRoleNames: [] });
	expect(policy.allowedRoleNames).toEqual([]);
	expect(effectiveAdminPaymentRoles(policy)).toEqual([]);
});

test('malformed responses never turn guessed defaults into a policy', () => {
	for (const value of [null, {}, { ...baseline, enabled: undefined }, { ...baseline, allowGuest: 'true' }, { ...baseline, allowedRoleNames: undefined }, { ...baseline, allowedRoleNames: ['invalid/name'] }, { ...baseline, allowedRoleNames: [''] }, { ...baseline, allowedRoleNames: [1] }]) {
		expect(() => readAdminPaymentPolicy(value)).toThrow();
	}
});

test('valid legacy aliases, case variants and unknown names are retained literally without granting access', () => {
	const names = ['Moderator', 'moderator', 'OWNER', ' custom_role ', 'custom_role', 'member'];
	const policy = readAdminPaymentPolicy({ ...baseline, allowedRoleNames: names });
	expect(policy.allowedRoleNames).toEqual(names);
	expect(retainedAdminPaymentRoles(policy)).toEqual(names.slice(0, -1));
	expect(effectiveAdminPaymentRoles(policy)).toEqual(['member']);
	expect(adminPaymentRolesNeedReview(policy)).toBe(true);
	expect(adminPaymentPoliciesMatch(policy, { ...baseline, allowedRoleNames: ['mod', 'owner', 'custom_role', 'member'] })).toBe(false);
});

test('normalized unknown names remain editable and do not falsely count as effective roles', () => {
	const published = readAdminPaymentPolicy({ ...baseline, allowedRoleNames: ['moderator', 'custom_role'] });
	expect(effectiveAdminPaymentRoles(published)).toEqual([]);
	expect(adminPaymentRolesNeedReview(published)).toBe(false);
	const draft = { ...published, enabled: false };
	expect(canSaveAdminPaymentPolicy({ loaded: true, loading: false, saving: false, draft, published })).toBe(true);
	expect(draft.allowedRoleNames).toEqual(['moderator', 'custom_role']);
	expect(setAdminPaymentRole(draft, 'member', true).allowedRoleNames).toEqual(['moderator', 'custom_role', 'member']);
});

test('unrelated edits cannot silently normalize a saved name into a new grant', () => {
	for (const role of ['OWNER', ' admin ', 'Moderator', 'Custom_Role']) {
		const published = readAdminPaymentPolicy({ ...baseline, allowedRoleNames: [role] });
		const draft = { ...published, allowGuest: true };
		expect(canSaveAdminPaymentPolicy({ loaded: true, loading: false, saving: false, draft, published })).toBe(false);
		expect(effectiveAdminPaymentRoles(draft)).toEqual([]);
		expect(draft.allowedRoleNames).toEqual([role]);
	}
});

test('explicit legacy-name conversion grants only the chosen builtin and preserves all other names', () => {
	const policy = readAdminPaymentPolicy({ ...baseline, allowedRoleNames: ['Moderator', 'OWNER', 'custom_role'] });
	const converted = reviewAdminPaymentRole(policy, 'Moderator', 'use-built-in');
	expect(converted.allowedRoleNames).toEqual(['OWNER', 'custom_role', 'mod']);
	expect(effectiveAdminPaymentRoles(converted)).toEqual(['mod']);
	expect(policy.allowedRoleNames).toEqual(['Moderator', 'OWNER', 'custom_role']);
	const removed = reviewAdminPaymentRole(converted, 'OWNER', 'remove');
	expect(removed.allowedRoleNames).toEqual(['custom_role', 'mod']);
	expect(adminPaymentRolesNeedReview(removed)).toBe(false);
	expect(canSaveAdminPaymentPolicy({ loaded: true, loading: false, saving: false, draft: removed, published: policy })).toBe(true);
});

test('explicit formatting of legacy names does not invent enforcement for moderator or custom roles', () => {
	const policy = readAdminPaymentPolicy({ ...baseline, allowedRoleNames: ['Moderator', ' Custom_Role '] });
	const formatted = reviewAdminPaymentRole(reviewAdminPaymentRole(policy, 'Moderator', 'normalize'), ' Custom_Role ', 'normalize');
	expect(formatted.allowedRoleNames).toEqual(['moderator', 'custom_role']);
	expect(effectiveAdminPaymentRoles(formatted)).toEqual([]);
	expect(adminPaymentRolesNeedReview(formatted)).toBe(false);
	expect(reviewAdminPaymentRole(formatted, 'custom_role', 'use-built-in')).toEqual(formatted);
	expect(reviewAdminPaymentRole(formatted, 'not-present', 'remove')).toEqual(formatted);
});

test('known display aliases are accepted only as explicit control actions', () => {
	expect(canonicalAdminPaymentRole(' Moderator ')).toBe('mod');
	expect(canonicalAdminPaymentRole('OWNER')).toBe('owner');
	expect(canonicalAdminPaymentRole('custom_role')).toBeNull();
	const policy = { ...baseline, allowedRoleNames: ['Moderator', 'custom_role'] };
	expect(setAdminPaymentRole(policy, 'Moderator', true).allowedRoleNames).toEqual(['Moderator', 'custom_role', 'mod']);
	expect(setAdminPaymentRole(policy, 'custom_role', false).allowedRoleNames).toEqual(['Moderator', 'custom_role']);
});

test('a policy cannot save before confirmed load, without a baseline, unchanged, or during another request', () => {
	const draft = { ...baseline, enabled: false };
	const options = { loaded: true, loading: false, saving: false, draft, published: baseline };
	expect(canSaveAdminPaymentPolicy(options)).toBe(true);
	expect(canSaveAdminPaymentPolicy({ ...options, loaded: false })).toBe(false);
	expect(canSaveAdminPaymentPolicy({ ...options, published: null })).toBe(false);
	expect(canSaveAdminPaymentPolicy({ ...options, loading: true })).toBe(false);
	expect(canSaveAdminPaymentPolicy({ ...options, saving: true })).toBe(false);
	expect(canSaveAdminPaymentPolicy({ ...options, draft: baseline })).toBe(false);
});

test('draft and published role selections do not share mutable arrays', () => {
	const published = cloneAdminPaymentPolicy(baseline);
	const draft = cloneAdminPaymentPolicy(published);
	draft.allowedRoleNames.splice(0);
	expect(published.allowedRoleNames).toEqual(baseline.allowedRoleNames);
	expect(adminPaymentPoliciesMatch(draft, published)).toBe(false);
	expect(adminPaymentPoliciesMatch(cloneAdminPaymentPolicy(published), published)).toBe(true);
});

test('semantic equality ignores list order and duplicates but never ignores an access gate', () => {
	expect(adminPaymentPoliciesMatch({ ...baseline, allowedRoleNames: ['member', 'mod', 'admin', 'owner', 'owner'] }, baseline)).toBe(true);
	expect(adminPaymentPoliciesMatch({ ...baseline, allowGuest: true }, baseline)).toBe(false);
	expect(adminPaymentPoliciesMatch({ ...baseline, enabled: false }, baseline)).toBe(false);
});

test('unchecking every registered role does not inject defaults or grant guests', () => {
	let policy = cloneAdminPaymentPolicy(baseline);
	for (const role of baseline.allowedRoleNames) policy = setAdminPaymentRole(policy, role, false);
	expect(policy).toEqual({ enabled: true, allowGuest: false, allowedRoleNames: [] });
	expect(baseline.allowedRoleNames).toHaveLength(4);
});

test('guest admission requires both role and guest gate; explicit guest choice sets both', () => {
	const guestRoleOnly = { enabled: true, allowGuest: false, allowedRoleNames: ['guest'] };
	expect(effectiveAdminPaymentRoles(guestRoleOnly)).toEqual([]);
	const gateOnly = { enabled: true, allowGuest: true, allowedRoleNames: [] };
	expect(effectiveAdminPaymentRoles(gateOnly)).toEqual([]);
	const allowed = setAdminPaymentGuestAccess(gateOnly, true);
	expect(allowed).toEqual({ enabled: true, allowGuest: true, allowedRoleNames: ['guest'] });
	expect(effectiveAdminPaymentRoles(allowed)).toEqual(['guest']);
	expect(setAdminPaymentGuestAccess(allowed, false)).toEqual({ enabled: true, allowGuest: false, allowedRoleNames: [] });
});

test('master switch denies requests without destroying stored role/guest choices', () => {
	const policy = setAdminPaymentGuestAccess(baseline, true);
	const paused = { ...policy, enabled: false };
	expect(effectiveAdminPaymentRoles(paused)).toEqual([]);
	expect(paused.allowedRoleNames).toEqual(['owner', 'admin', 'mod', 'member', 'guest']);
	expect(paused.allowGuest).toBe(true);
});
