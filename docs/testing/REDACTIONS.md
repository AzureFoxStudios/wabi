# Redactions in test evidence (2026-11-13)

Before the repository was made public, operator-private details were replaced
in tracked files, including the field-test evidence under `docs/testing/`
(plain files, single-file `.gz` logs and `glance-2026-10-04/build-logs.tar.gz`).

What was replaced, consistently everywhere:

| Original kind | Replacement |
|---|---|
| Production host's tailnet address | `192.0.2.10` |
| Staging host's tailnet address | `192.0.2.20` |
| Second field host's tailnet address | `192.0.2.30` |
| Controller's tailnet address | `192.0.2.40` |
| Staging host's LAN address | `198.51.100.20` |
| Production host's observed public address | `203.0.113.10` |
| Home IPv6 address in the CGNAT design note | `2001:db8::42` |
| Real user names in home paths and SSH targets | `operator` (`/home/operator`, `/var/home/operator`, `operator@…`) |
| Production host's machine name | `prod-host` |

Machine nicknames used as site labels in reports (Tim, Iyoku, Ronin, iRonin,
dotRonin, bazzite) were left as they are.

**Recorded digests now describe the original bytes.** Many evidence JSON files
record the SHA-256 of a log, source freeze or runner (for example
`sourceFreezeSha256`, `*Sha256` fields, and `scripts/geographic-acceptance/
checkpoint-field-run.py` in `checkpoint-*.json`). Those values were left
unchanged on purpose: they are what was measured at the time. The redacted
files no longer hash to them. The original bytes remain in git history.

Nothing in CI verifies these digests. Do not "fix" them by recomputing; a
recomputed digest would claim a measurement that never happened.

The check `scripts/security/private_details_check.py` (run in the CI
`supply-chain` job) keeps new private addresses, tailnet names and real home
paths out of `docs/`, `scripts/`, `frontend/scripts/`, `.github/` and root files.
