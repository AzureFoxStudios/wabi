# E — New-Server Join Scaffolding: Decision Memo (2026-08-04)

## Status
**Decision pending — flagged to Ronin.** No code written. This memo captures the options
and a recommendation so the decision can be made quickly.

## Current state
Joining a new server is thin/confusing: essentially a server-address + password field
with no guided flow. A half-idea about password autofill was floated and rejected as
too "SaaS-y".

## Options

### Option 1 — Dedicated join flow (guided)
A step-by-step surface: server address → password (if required) → roles/preview
(what you'll get access to) → confirm & join.

Pros:
- New users can't get lost; each step explains itself
- Roles preview sets expectations before committing
- Matches the polish level of the rest of the app

Cons:
- More surface area to build and maintain
- Slower for power users who just want to paste an address and go

### Option 2 — Keep inline, polish the copy/flow (recommended starting point)
Keep the existing inline join (address + password), but:
- Clearer labels and placeholder text ("Server address, e.g. wabi.chat" / "Password
  (only if the server requires one)")
- Inline error messages instead of generic failures (wrong password vs. unreachable
  server vs. already-joined)
- A "recently joined" / server list so re-joining doesn't require re-typing

Pros:
- Small, shippable now; no new surface
- Fixes the actual confusion (unclear errors, no feedback) without a redesign

Cons:
- Still no roles preview; doesn't hold the user's hand

## Recommendation
Ship **Option 2** now (inline polish — error states, copy, server list), and only build
the guided flow (Option 1) if onboarding feedback says new users are still getting lost.
The handoff's own rejection of the "SaaS-y" autofill idea points toward keeping this
lightweight.

## Acceptance target (whichever option is chosen)
A new user can join a server end-to-end from an empty/list state without guessing.

**Awaiting Ronin's call: Option 1 (guided flow) or Option 2 (inline polish).**
