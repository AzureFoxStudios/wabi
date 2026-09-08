# Server policies: storage and enforcement

The Rust server does not implement the old Node policy registry. A settings
editor is only an effective policy control when the runtime consumes the same
value. Do not infer enforcement from a successful configuration save.

## Payment access

Payment access has one authority: WabiDB's payments policy index under
policy:payments_access. Both administrative routes and payment creation use
api/payments/access.rs; saves go through the existing
WabiStore command → event → projection acknowledgement.

| Endpoint | Shape |
| --- | --- |
| GET /api/admin/policies/payments_access | {key, config, defaults} |
| POST /api/admin/policies/payments_access | Raw policy object → {config} |
| GET /api/payments/access | {success, policy, actor} |
| POST /api/payments/access | {policy} → {success, policy} |

The actor is evaluated by the server, including account authentication, actual
RBAC membership, guest permission and user blocks. The client must not replace it
with “a token exists, therefore creation is allowed.” The create endpoint
re-evaluates access; the UI snapshot is not an authorization credential.

The policy contains enabled, allowGuest and allowedRoleNames. An explicitly empty
role list stays empty; it must never silently restore a permissive default.
Omitted input fields retain the route's defaulting contract. Malformed supplied
types are rejected, not coerced into permission.

Policy role names match the actor's lower-case names exactly: owner, admin, mod,
member and guest. The actor derives mod from the server's Moderator membership;
this does not mean a saved policy string Moderator or moderator matches mod.
Saved-row reads preserve existing strings, while explicit saves trim and
lowercase submitted names. The editor preserves inactive legacy/custom strings,
shows them separately, and requires explicit review before a save could normalize
one into a grant. It never silently drops names or treats unknown names as active.

### Existing installations

1. A saved WabiDB policy wins.
2. Only if that record is truly absent, read an explicitly saved payments_access
   entry in data-dir/admin_policies.json.
3. If neither exists, preserve the already-enforced payment default (enabled).
4. A malformed/unreadable existing record is unavailable, not an absent record.
   Access/create fail closed. A valid explicit admin save can repair the canonical
   value without deleting the legacy file.
5. Only an authenticated administrator may persist a legacy import. Public and
   ordinary member reads do not mutate WabiDB.
6. Import and both save routes share an AppState-local mutex; a delayed import
   cannot overwrite an explicit save.

No postcard record, domain event or projection encoding is extended by this
migration. The old JSON key is retained for recovery, but is not a second authority.

## Other configuration

The generic non-payment Admin policy routes still use admin_policies.json.
Branding has real consumers: the public frontend metadata/launch-page responses.
Its editor reads the published value, owns an unpublished draft and waits for a
successful save before claiming publication. The file store reads the same file
as public consumers, replaces it atomically after writing/syncing a unique
same-directory temporary file, and propagates storage errors. Corrupt content
must not be overwritten as an empty default map. Unix also syncs the directory.
A post-rename sync failure is an uncertain outcome, not proof that nothing changed.
Boot HTML caches the loaded policy content, not a separately sampled filesystem
mtime; replacing a policy with the same timestamp must still refresh branding.
Artwork uploads remain drafts. Closing the editor cancels its upload owner, and
the upload deadline includes response-body consumption. Failed or uncertain
uploads/publications do not become successful status messages.

The following historical configuration forms have no corresponding Rust runtime
enforcement and are not exposed as working Admin controls:

- upload_limits and download_limits role/global policies;
- community_node_access and community_node_announcements;
- Node thread-pool/runtime-tuning controls.

Existing configuration and compatibility APIs are retained; removing an editor
does not delete saved data. The actual request-body limit in app_router.rs is
separate from per-file or per-role upload enforcement. In particular, resumable
upload admission and cumulative chunk accounting require their own security
review; this UI work does not certify those paths.

Authentication admission policy is a separate outstanding boundary: its current
file loader can fall back to default admission when the file is unreadable or
malformed. The payment fail-closed guarantees above must not be generalized to
every historical policy loader.

## Extending a policy

Trace the editor, endpoint, canonical storage, runtime consumer and reload/replay
behavior before adding a control. Validate the contract at the boundary, await
persistence/application, enforce on the server, and test denial and failed writes.
Do not introduce another JSON store for a WabiDB-owned policy.

Admin headers-based handlers use the shared account-access authentication boundary,
then the required owner/admin or step-up check. Refresh, pre-auth, scoped Lore and
step-up credentials are not ordinary account access tokens. See the
[API skill](../../.agents/skills/wabidb/wabidb-api-handlers/SKILL.md) and the
[active Admin verification log](../plans/2026-09-08-full-frontend-polish.md).
