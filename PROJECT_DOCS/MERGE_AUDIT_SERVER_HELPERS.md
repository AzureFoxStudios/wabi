# Merge Audit: `backend/src/server.ts` Helper Placement

## Context

- Merge commit: `8af45ab`
- Merge direction: `Shaplooba` -> `main`
- Conflict file: `backend/src/server.ts`
- Resolution used: keep `Shaplooba` version for conflicted section

This note tracks helper-placement differences so we can revisit/refactor later.

## What Changed

Before merge (main parent), `server.ts` imported helper logic from modules:

- `./db/repositories/roleRepository.js`
  - `getUserRoleInfo`
  - `getRoleDefinitions`
  - `getRolePriority`
  - `workspaceHasOwner`
- `./services/fileEncryptionService.js`
  - `maybeEncryptForAtRest`
  - `maybeDecryptFromAtRest`
  - `writeUploadFile`
- `./services/uploadTokenService.js`
  - `signUploadToken`
  - `verifyUploadToken`

After merge, `server.ts` contains inline implementations for those same responsibilities:

- `getUserRoleInfo(...)`
- `getRoleDefinitions(...)`
- `getRolePriority(...)`
- `workspaceHasOwner(...)`
- `signUploadToken(...)`
- `verifyUploadToken(...)`
- `maybeEncryptForAtRest(...)`
- `maybeDecryptFromAtRest(...)`
- `writeUploadFile(...)`

## Why This Was Chosen

The conflict occurred in the combined import/helper block near file start. Keeping the `Shaplooba` side preserved that branch's internal structure consistently and avoided mixed patterns in one conflict hunk.

## Follow-Up Refactor Option (Future)

If we want cleaner separation again:

1. Move inline role helpers back to repository modules.
2. Move upload token helpers back to `services/uploadTokenService`.
3. Move encryption file helpers back to `services/fileEncryptionService`.
4. Replace inline usages with imports.
5. Add focused tests around upload token validation and role-policy lookups before/after refactor.

