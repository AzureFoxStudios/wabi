# Moderation and arrival: implementation plan

**Status:** implementation in the current worktree; not merged or deployed  
**Date:** 2026-09-27

**Arrival UX follow-up:** [Server arrival, Reference Desk, and interactive Reader](2026-09-27-onboarding-reference-desk-reader.md) is the proposed next implementation plan. It places the reusable guide at server level through the existing Server Hub, with Reception as a first-visit presentation and compatibility entry. The channel-based implementation described below remains the current worktree baseline; the follow-up is not implemented by this documentation change.

## Product contract

Wabi is an independent-server product. Each operator moderates their own community; Wabi has no central account ban list. A server template creates an editable starter **channel layout**, not a security personality test. Admission, channel visibility, channel access, moderation, and message retention are separate controls.

The arrival experience should orient a newcomer before dropping them into a channel list. It should show server identity, readable rules, and explain rooms and the self-selected community roles that open them. These roles are distinct from staff/capability roles. Sidebar customization remains a separate view preference and must never be described as permission. A rules acknowledgment may gate community content writes only when the Authority enforces it. Material rules changes require a new acknowledgment; cosmetic changes do not. Members can always reopen the rules and revise their choices.

The server's privacy scope runs from Live rooms through timed history to Forever/public history. Each room tells members what is retained and that explicit reports can preserve a selected message. A moderation action can keep minimal actor/target/action/reason/time data without requiring a content log. Staff see historical context only if the room retained it or a participant explicitly reported it. An expired Live message cannot be reconstructed. Opening a case must not silently extend a message's retention or prevent deletion. Encryption-pending and experimental encrypted rooms must not acquire server-side plaintext scanning.

## Baseline findings before this worktree

1. `blacklist.txt` loads at startup, but admin ban/unban updates only the in-memory map. Restart loses those actions. Startup currently warns and continues when the file is unreadable.
2. REST login and refresh inspect the blacklist, while the shared REST bearer authenticator and established Socket.IO identity path do not. The WabiDB `is_user_banned` adapter returns false.
3. Safety-rule timeout/ban write WabiDB events without a registered projection or effective access check. The triggering send is refused, but the claimed continuing sanction is not enforced. Flag only writes a diagnostic line.
4. Reports preserve a selected message snapshot and staff discussion. The single Server Center sidecar contains both that evidence and policy. Its loader currently replaces corrupt/unreadable data with defaults. Cases are not connected to sanctions or an evidence-expiry control.
5. Reception exists, but role chips are component-local state and room toggles only alter the client-side hidden list. Ordinary channels have no persisted role gate. The Reception enable event is not persisted.
6. Owner bootstrap creates a general text channel and a general voice channel. There is no editable channel-layout template at setup.
7. There is no Authority-enforced rules acknowledgment or join questionnaire. Existing safety-rule patterns are not community rules.
8. No complete, operator-visible raid switch or reliable ban-evasion defense is established. IP restrictions alone are weak and should not be represented as permanent identity exclusion.

## Delivery order

### 1. Restore truthful enforcement

- Persist blacklist edits atomically, preserve existing operator entries, and refuse false success when storage fails. Damaged blacklist data must not silently become an empty allowlist.
- Check active bans on every authenticated HTTP request and live socket action. Revoke/disconnect active sessions after a ban. Keep account bans local to this Authority.
- Replace unsupported safety-rule sanctions with a persistently enforced path or remove those action choices until they work. A blocked message must never be called a successful ban or timeout.
- Make the moderation inbox show the action taken, actor, target, reason, and outcome. A report can lead to an action but does not automatically punish anyone.

### 2. Respect the privacy scope

- Keep action records separate from content evidence. Do not require universal chat logging to warn, timeout, or ban.
- Preserve content only through an explicit report or a room's stated retention policy. Limit access to staff, disclose the exception at report time, and provide an evidence deletion/expiry policy.
- Fail closed on damaged moderation state; preserve the bytes for recovery. Never reset the file on parse failure.
- Label Live/timed/Forever accurately, including the current logical-deletion limit for durable history. Policy changes apply to future messages only.

### 3. Welcome and organize

- Offer a small editable starter-channel layout at owner setup: basic, project, community, or blank. Keep security controls in settings.
- Make Reception a real newcomer landing: server introduction, rules in a readable overlay/page, and a short optional channel-interest choice. Keep rules available later.
- Store a rules revision and member acknowledgment per Authority. If the owner opts into required acceptance, enforce it server-side before posting, editing, reacting, or creating community content; reading rules and reporting remain available. Only a material rules revision invalidates prior acknowledgments.
- Community role choices are persisted on the Authority and open their linked rooms immediately for registered members. Staff roles are never self-selected. Separate room switches personalize the list and never change access.

### 4. Admission under pressure

- Expose current open/invite/closed controls honestly. Do not label an unimplemented verified mode as email verification.
- Add an explicit, time-bounded raid posture for the local Authority: restrict new joins or require invitations, with a visible expiry and owner override. It should not silently retain extra message content.
- Rate-limit account creation and repeat join attempts per useful, disclosed signals; expect evasion. Avoid secret permanent locks, device fingerprinting, or a claimed cross-server ban.

## Acceptance boundary

For each delivered item, inspect both HTTP and Socket.IO paths, restart with a disposable Authority, and check that the persisted result and UI agree. Exercise both Live and durable channels, ordinary/public and private conversations, a reported message after deletion, rule revisions, and a second independently hosted server. Privacy claims must match `docs/PRIVACY_STANCE.md` and `docs/features/MESSAGE_RETENTION.md`. Update `docs/PROJECT_STATUS.md` only for behavior actually present on the branch; deployment remains a separate step.

## Worktree implementation and remaining gates

The current worktree now saves account bans, channel bans, and channel timeouts in `blacklist.txt` before reporting success. Expired-entry cleanup and clearing the blacklist also persist. The Authority refuses to start with a damaged blacklist or Server Center sidecar, including a malformed raid expiry. REST bearer requests and live Socket.IO actions consult account bans; channel access and message/reaction sends consult channel restrictions. Operator IP deny entries use the same trusted-proxy address rule as rate limits and cover HTTP and Socket.IO; shared proxy IPs require care. The admin overview counts active account bans from the enforcement store instead of treating every inactive user as banned; mute count remains unavailable. Case actions journal actor, target, reason, outcome, and optional timeout separately from the reported message snapshot. The owner can remove a case's preserved snapshot or set expiry for new reports; this does not erase old backups or text quoted in staff comments. Automated safety flags now create cases with references but no content snapshot. See [operator recovery](../deployment/MODERATION_POLICY_RECOVERY.md).

Owner setup now accepts an editable list of starter text/voice channels. Browser and desktop host setup offer basic, project, community, and blank starting lists. New Authorities create a Reception landing channel separately from those starter rooms, and existing Authorities can add one with channel creation. Published server rules have revisions and member acknowledgments; an operator can require acknowledgment before community messages, edits, reactions, forum/wiki/gallery/incident writes, and channel-scoped upload publication. Reception shows server identity and rules, room descriptions, and operator-defined community roles. Registered members can choose those roles immediately; the Authority persists and enforces their linked room access. Sidebar room switches separately personalize the view. Admins can set a persisted minimum staff role on ordinary channels. The server filters discovery, reads, joins, and live subscriptions by these gates, including after a role or policy change. A temporary raid control requires invitations for new accounts and pauses guest joins for a bounded period. Guest and registration creation counters have actual one-hour windows.

Still open before a release claim: disposable restart and browser acceptance; a complete audit of every other community mutation against rules acknowledgment; and stronger but still limited account-evasion controls. The unsupported `verified`/email-verification admission setting is rejected on save and blocks new registrations for legacy configurations until an admin changes the policy to open, invite, or closed. No central FOSS-wide ban is proposed.
