# Direct Wabi Project plugin acceptance — 2026-09-30

Ronin authorized building the direct assistant plugin. The current source
checkout is a shared worktree at base `138abe39`; existing concurrent changes
were preserved. No commit, push, Authority deployment, public plugin submission
or actual Dot installation is included in this acceptance. The isolated personal
connector service and its narrow HTTPS proxy routes were deployed separately.

## Implemented

- Optional Node 22 stateless Streamable HTTP MCP gateway, reusing the existing
  card/wiki connector and permissioned Wabi API.
- Named connection profile identifying one configured server/Project and a
  tools-only bot service, without a claimed coding harness or local workspace.
- Private one-use ten-minute linking code and explicit browser consent;
  PKCE S256, exact approved redirects, resource/client binding and OAuth
  discovery; rotating refresh tokens and local revocation.
- Bounded requests/maps/concurrency, Host/Origin validation, CSRF transaction
  cookie, no-store/anti-frame headers and credential-free error responses.
- Portable plugin manifest/skill and an endpoint-specific package generator
  that refuses to overwrite existing output. No credential-bearing package.
- Initialization and model-visible write guidance for evidence/read-back and
  accurate Done state. No automatic card completion or new model call.
- Focused CI workflow using the repository’s Node 22 runtime.

## Verified

**24 focused tests pass:** eleven existing stdio/API connector regressions and
thirteen HTTP/authentication/packaging/control-socket tests. They cover discovery, transport,
PKCE, callback/resource/client binding, consent/CSRF, expiry, code replay,
refresh rotation/revocation, the slow-request revocation boundary, Host/Origin
refusal, scoped tools, secret redaction, stale saves and package preservation.
The real account-linking attempt exposed a consent-page bug: `no-referrer`
makes native browser form submissions send `Origin: null`, which the strict
origin check correctly refuses. The consent HTML now uses `same-origin`;
other responses retain `no-referrer`. A regression test confirms null, foreign
and missing origins remain refused without consuming legitimate consent.
Actual ChatGPT browser completion is still pending after these focused fixes.
ChatGPT retains its dynamic public client ID across reconnects. A protected,
operator-selected registration file now restores that existing ID and exact
callback after connector restart, with a fixed expiry under thirty days.
It contains no access/refresh tokens, private linking codes or client secrets.
Tests confirm fresh private consent/PKCE are still necessary, expired clients
cannot authorize, and foreign callbacks/issuers and duplicate IDs fail closed.
The native form fixture then reproduced a second bug: the server accepted
consent with HTTP 303, but `form-action 'self'` prevented the browser from
following the cross-origin callback. The policy now includes only approved
callback origins; OAuth still validates the exact redirect URI. The corrected
fixture reached its callback in the real in-app browser with origin, cookie
and private-code checks intact. See [browser proof](screenshots/2026-09-30-dot-plugin/native-callback-passed.png).
This fixture has synthetic credentials and grants no actual account access.
A private control `status` command exposes only the last failure's fixed reason
and time; it exposes no codes, cookies, tokens, submitted text or account data.
The bundled skill’s validation passes. Script syntax and diff whitespace pass.
No full Rust/frontend rebuild was required for this optional script integration.

**Standard client compatibility:** `@modelcontextprotocol/sdk` version 1.31.0
was installed only in an isolated temporary test directory, with install scripts
disabled. Its actual StreamableHTTPClientTransport connected, initialized,
listed eleven tools, read the connection profile/brief and received an invalid
argument refusal. The backend in this compatibility fixture was synthetic.
See [SDK evidence](PROJECT_PLUGIN_SDK_PROOF_2026-09-30.json). The SDK is not a
new Wabi runtime dependency.

**Live Wabi proof:** a separate owner-created bot, user **3296**,
`dot-plugin-test-9b139a04`, was admitted only to disposable Project `ch_c72`.
A direct authenticated HTTP MCP client:

1. Read the named profile and Project brief.
2. Created card `task_05d1e43719874fecbfef432900a6831a` with stable operation
   `05d1e437-1987-4fec-bfef-432900a6831a`.
3. Claimed it, created wiki page `page_ce4`, read and updated that page.
4. Recorded evidence, moved the toy card to Done and read both records back.
5. Confirmed stale card/wiki edits and cross-Project arguments were refused.
6. Removed only that test bot’s Project grant and confirmed a subsequent live
   card read was refused. Then revoked the gateway OAuth credential and
   confirmed HTTP 401.

The first trial ended with its bot grant revoked. During the later public
acceptance, only this dedicated bot’s grant was restored for the personal
trial; its test OAuth link was subsequently revoked. Its credential is protected in a temporary
operator file, outside the checkout; no credential is in this evidence or Git.
No private repository files, model calls, owner passwords or tokens were put
in a model prompt. See [live evidence](PROJECT_PLUGIN_LIVE_PROOF_2026-09-30.json).
This proof used a local gateway forwarding to wabi.chat, not a public gateway
or an actual Dot assistant.

**Rendering:** the consent page rendered in the real Codex in-app browser using
a synthetic authentication fixture. The visible page identified the named
connection, Wabi origin, Project, card/wiki permissions, consent and private
code entry. [Desktop screenshot](screenshots/2026-09-30-dot-plugin/connect-desktop.jpg).
This proves rendering, not a completed real browser account-linking flow.

## Personal endpoint deployment and public acceptance

The optional connector is live at **https://wabi.chat/mcp**. The proxy exposes
only that MCP route, OAuth discovery and `/project-plugin/*`. The rest of the
existing Wabi routing is preserved. A guarded hash comparison and exact backup
preceded an in-place proxy update; Caddy validation/reload succeeded. The
Authority container retained its existing start time
`2026-09-29T00:31:11.463520573Z` and stayed healthy. The existing public page and
Authority health were independently read through the public address.

The separate connector runs as UID/GID 1000 in a read-only, capability-dropped,
resource-bounded Node container, without a published host port. Its credential
and deployment settings are private operator files outside Git. The control
socket lives in private tmpfs, so container restarts discard it and all OAuth
links. Tim’s system Node 18 and the Wabi Authority binary were not replaced.

Deployed Node image: `node:22.22.3-bookworm-slim`, resolved digest
`sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752`.
Deployed script SHA-256 values match the local tested source:

- Gateway (browser callback and private diagnostic repair): `ab0bb90e55b8760239b0f7c2b959ec381dda46d7c8a59dc5e70b2aee420f44d6`.
- API connector: `5bb4ef7815742cf9d9af1faa9afad0b813de9d325fd2e73f7a2c3f4765c61dbd`.

The standard MCP SDK 1.31.0 then performed public OAuth with private linking,
initialized and discovered eleven tools, verified the named profile, updated
the original toy card/wiki and read both back, refused a stale edit and received
401 after its test OAuth token was revoked. No additional toy entity, model
request or native coding task was launched. See
[public acceptance evidence](PROJECT_PLUGIN_PUBLIC_PROOF_2026-09-30.json).
The personal bot is still restricted to the disposable Project; the public
endpoint does not provide Wabi account signup or public anonymous data access.

## Remaining acceptance

Connect the deployed endpoint in the user’s ChatGPT account and prove Dot
directly selects/calls the tools. No unrelated Wabi accounts are required.
Other installations configure their own Wabi origin and optional connector;
wabi.chat is not a product-wide central dependency.

The personal prototype deliberately loses all OAuth links on restart and
requires an interactive operator to issue private link codes. Durable identity,
multi-user enrollment, individual connection management, service restart
onboarding and independent security review remain future work. A gateway
cannot undo a committed upstream write or revoke an already admitted effect.
See [setup and maturity boundary](../features/PROJECT_PLUGIN.md).
