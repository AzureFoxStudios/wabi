# Project Connections and worker recovery — development candidate

The optional **AI Worker Connections** addon (`project-workers`) adds a
**Connections** tab to each Project. It is compiled with the server but disabled
by default. The server owner can enable it through Server Center → Addons, or
set `WABI_PROJECT_WORKERS_ENABLED=1`. This candidate has not been deployed to Tim
or wabi.chat. It is worker coordination, not Authority failover or WabiDB HA.

## What people see

Project members see only that Project's admitted worker registrations: a shared
computer label, reported harness/provider/model, bot service, recent contact,
recorded work and selected backup status. Contact loss means the worker stopped
reporting; it does not prove the computer is powered off. Reported capabilities
are not verified installation or model-availability checks.

The roster contains no machine address, local repository path or credential.
These shared labels are server-readable Project content; use labels suitable
for the Project's members. Server owners and the owning bot can remove a
registration. Ordinary members cannot remove it. Revoked Project membership
hides the worker and rejects its work. Disabling the addon stops registered
worker access and writes; it cannot undo a provider request already in flight.
The legacy unregistered API worker remains compatible without this addon and
has no automatic recovery. The addon switch is therefore not a global AI stop.

## Portable setup

Use the existing scoped bot/provider configuration in
[Project Assistant](PROJECT_ASSISTANT.md), plus:

- `WABI_WORKER_ID`: a persistent UUID generated once for this computer/service.
- `WABI_WORKER_NAME`: its shared computer label.

Run `wabi-project-helper worker` continuously on the primary and standby
computers. Each connects outward to the configured HTTPS Authority. No VPN,
LAN discovery, inbound SSH, particular host name or cloud provider is required.
Tokens and provider keys stay in each worker's protected local configuration.
Distinct admitted bot services are supported; computers sharing a bot token
share that bot's trust and permissions, rather than gaining independent trust.
Removed worker IDs cannot silently enroll again.

This runner reports `api_worker`. It exposes bounded card/wiki tools, without
shell or filesystem execution. Registration does not turn Codex, OpenCode or
Hermes into a resumable native harness. Setup is still operator configuration,
not a completed one-click Add computer flow.

## Manual and automatic recovery

Manual resume is the default. A human selects a recently reporting compatible
computer and chooses **Resume saved work**. The Authority advances the attempt
and transfers the selected bot/worker; accepted tool results remain recorded.
Uncertain pending edits require review and cannot be automatically resumed.

Automatic recovery requires explicit consent on each request, chosen backup
workers, and the same reported harness/provider/model. The composer allows one
recovery; the API supports a bounded maximum of three and up to eight chosen
backups. Consent explains that another provider call can incur cost. Recovery
uses an already-running standby: it does not boot a computer, install a stack,
launch a native agent, substitute a model or spawn subagents. The recovery count
is a bound on attempts, not a verified monetary spending ceiling.

Under the Authority's run-write lock, a backup must satisfy all of these:

- the two-minute lease expired and the primary has not reported for three minutes;
- the request explicitly allows this worker and has recovery allowance remaining;
- the backup registration, bot access and human requester access remain valid;
- the backup recently reported and matches the pinned harness/provider/model;
- no pending side effect exists and no other run is active in that Project;
- the observed run revision is current.

The Authority increments the attempt, issues a fresh lease and records the new
worker. Steps must match the active worker, attempt, revision and lease. A late
old worker cannot admit a new edit. Acknowledged operation IDs return the saved
result without repeating the effect. The runner checks before and after model
generation, discards stale responses and cannot fail the replacement attempt.
Server time guides expiry; Wabi/provider HTTP redirects are refused.

## API and persistence

The Project API adds `GET/POST /api/projects/:channel/workers`,
`POST /api/projects/:channel/workers/:worker/heartbeat` and
`DELETE /api/projects/:channel/workers/:worker`. Existing run create/claim/step
and human-control routes accept the selected worker and bounded recovery policy.
Roster reads require Project access; enrollment/heartbeats require the owning
bot. Registration is capped at 64 enabled workers per Project. Heartbeats are
coalesced to limit durable writes.

`project_worker_updated_v1` is a schema-version-1 JSON channel event with a
`project_workers` projection and actual-parent/local-owner admission. Added run
fields have defaults, so older JSON runs remain manual/unregistered. No durable
postcard field layout changes. An older binary must not be assumed to understand
the new event; retain a pre-upgrade backup for rollback.

## Proven boundary and remaining work

An isolated trial on two physical computers interrupted the primary worker
process after one saved card, waited for real lease/contact expiry, resumed on
the backup and rejected a returning primary write with 409. One card and two
recorded steps remained. The provider was a deterministic stub, with no model
call. See [dated evidence](../testing/PROJECT_WORKER_RECOVERY_2026-09-30.md).

Native coding recovery still needs a harness adapter, verified repository/base
revision, reviewed patch or artifact digests, check evidence, local checkout
mapping and resource claims. A card/wiki checkpoint cannot recover uncommitted
code or migrate a Codex chat. Native commands and billing must remain explicit;
missing stacks or unavailable models must stop rather than trigger upgrades or
substitution. Lore read-back and mirror revision checks remain separate gates.
