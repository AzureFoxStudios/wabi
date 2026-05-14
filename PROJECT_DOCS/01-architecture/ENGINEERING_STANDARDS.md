# Engineering Standards

This is the standing engineering bar for Wabi work, including feature work.

## Core Rules

1. Deduplicate and consolidate code, applying DRY only when it reduces complexity.
2. Consolidate shared type definitions when they should actually be shared.
3. Remove unused code only after verifying it is truly unused.
4. Untangle circular dependencies where they exist.
5. Replace weak types such as `any` and `unknown` with strong, researched types.
6. Remove unnecessary `try/catch`, defensive fallback logic, and error-hiding patterns unless they serve a real boundary or input-safety role.
7. Remove deprecated, legacy, or fallback code where confidence is high.
8. Remove AI slop, stubs, larp, and unhelpful comments. Keep comments concise and only when they help a new engineer understand the code.

## Feature Work Rules

Feature work should still follow the same cleanup standards.

- Prefer solutions that improve long-term structure instead of layering quick patches.
- Keep touched areas simpler after the change than before it.
- Do not add duplicate state paths, duplicate UI logic, or parallel contract definitions without a strong reason.
- Avoid broad “temporary” fallback behavior unless there is a real compatibility or safety need.
- After implementing a feature, do a short cleanup pass on the touched area so the feature does not regress the codebase back toward sludge.

## Practical Expectations

- Favor explicit contracts over loose object passing.
- Prefer one clear code path over multiple fallback branches.
- Keep components and modules scoped to one main responsibility.
- Preserve established visual language when editing existing UI, but do not preserve bad structure just because it already exists.
- Do not rely on chat memory as the source of truth for standards. This file is the source of truth.

## Cleanup Campaign End State

The large cleanup campaign completed with these verified results:

- `backend/src/server.ts` reduced from `11844` lines to `4703`
- backend tests pass
- backend build passes
- frontend check passes with `0 errors / 0 warnings`

That campaign is complete. New work should maintain that bar rather than reopening the same structural debt.
