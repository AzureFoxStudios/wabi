# Wabi Project plugin — personal development candidate

The plugin connects an assistant directly to a shared Wabi Project’s cards and
wiki. It reuses the permission-checked Project API rather than asking Codex to
perform bookkeeping. It adds no model, provider call or terminal execution.
The gateway is optional and separate from the Authority binary. Core Wabi works
without it. Any self-hosted HTTPS Wabi origin can be configured.

**September 30 status:** source and local HTTP tests pass; a direct MCP client
completed a disposable live card/wiki workflow on wabi.chat. The consent screen
was rendered in a real browser. The user’s personal endpoint at
`https://wabi.chat/mcp` is deployed and passed public OAuth/standard-client
acceptance. The private plugin entry was installed in the user’s ChatGPT account. Actual
Dot tool acceptance remains a separate gate, deferred by the user on October 1. Other operators use their own endpoint and Wabi server. This is
not a published directory plugin or a production multi-user OAuth service.
See [acceptance evidence](../testing/PROJECT_PLUGIN_ACCEPTANCE_2026-09-30.md).

## Assistant experience

The eleven tools are `connection_profile`, `project_brief`, `list_cards`,
`read_card`, `create_card`, `claim_card`, `update_card`, `list_wiki`, `read_wiki`,
`create_wiki` and `update_wiki`. Every connection has one fixed server/Project.
The profile reports a named configured bot service and tools-only access. It
does not claim a running harness, verified repository, computer or model.

Reads are bounded; human effort estimates are excluded. Card writes require
the observed revision, wiki writes the source edit token. Existing fields are
preserved. Creation uses an operation UUID for cards; wiki creation is not
idempotent. Uncertain writes must be reconciled by read-back before retrying.
Initialization guidance, a bundled skill and model-visible write reminders ask
the AI to record evidence and leave an accurate card state. They do not infer
completion, automatically close cards, or launch another model.

## Operator setup

Use Node 22, matching the repository CI runtime. No additional runtime package
is required. Give this connection a **distinct bot** through the existing
owner-only bot setup, and admit it to the selected Project. Sharing a token
with Codex shares its service identity and permissions. Do not use an owner
login token as the connection credential.

Keep the version-1 connection JSON outside the checkout, readable only by its
operator (0600 on Unix). Its fields are `version`, `serverUrl`, `channelId` and
`botToken`, as in the local Codex connector. The gateway ignores local runtime
labels because a remote tool connection is not a local coding harness.

Run from the repository root:

```bash
node scripts/wabi-project-plugin.mjs \
  --connection /private/path/project-connection.json \
  --public-url https://your-mcp.example \
  --name 'Dot · Design Project' \
  --callback https://chatgpt.com/connector_platform_oauth_redirect \
  --port 4319
```

Bind a dedicated HTTPS reverse proxy origin to the gateway’s loopback port.
Forward paths and methods unchanged, preserve the public Host and Origin, and
disable caching. Discovery, authorization, registration, token and revocation
routes live at that origin; proxying only `/mcp` is insufficient. The public
origin is explicitly configured, never inferred from forwarded headers. Set
edge rate/connection limits too; the prototype’s process-wide budget is not a
distributed abuse defense. Do not log Authorization headers or request bodies.

The consent HTML must retain its `same-origin` referrer policy: `no-referrer`
turns native form POST origins opaque and breaks the strict CSRF origin check.
Do not work around this by allowing `Origin: null`.
Preserve the connector's `form-action` policy, which includes approved callback
origins. Limiting it to `'self'` can block the successful post-consent redirect
in Chromium even when the server returns HTTP 303. The gateway continues to
validate the exact approved callback URI before issuing a code.

Use the exact redirect URL shown in ChatGPT’s connection management page.
Repeat `--callback` for additional approved URLs; there are no wildcard or
arbitrary client redirects. This prototype uses dynamic client registration,
not CIMD. The documented stable callback above applies to issuer-identifying
authorization servers; confirm the actual account’s callback before linking.

In the connector’s private interactive terminal, type `link` to generate a
one-use, ten-minute code. The code is printed only to an interactive terminal,
never ordinary service logs. Enter it privately on the connection page and
explicitly consent. Do not paste it into an AI conversation.

For a background Unix service, configure `--control-socket` inside a private
0700 directory. In a private terminal, invoke the script with
`--control /private/control.sock link`; use `revoke` to revoke all links. The
control CLI refuses to print codes without an interactive terminal. There is
no public link-code administration endpoint.
The private control command `status` reports only the last consent failure's
fixed reason and time, with no credentials or submitted content.

Type `revoke` to invalidate all gateway links; removing the bot’s Project grant
also rejects further Project operations. A restart deliberately revokes all
gateway links, requiring new authorization. Codes and OAuth tokens are
memory-only and bounded. Public client registrations are memory-only by default.
For a host that retains its dynamic client ID across reconnects, an operator can
preserve that known registration in a protected absolute `--registered-clients`
JSON file (0600 on Unix): version `1`, configured `issuer`, and a `clients` array
of `clientId`, exact approved `redirectUris`, and fixed Unix-millisecond `expires`.
Expiry must be within thirty days; expired entries are ignored. This file
contains no client secret, consent code or access token. It restores registration
only: fresh private linking and PKCE are still required after restart. New dynamic
registrations are not automatically saved. Access lasts one hour; rotating refresh tokens
last up to 24 hours. This personal prototype does not provide durable OAuth
sessions, per-user account enrollment, individual connection administration,
automated relinking after service recovery or independently audited authentication.

## Personal deployment and reverse proxy

The user’s personal deployment is separate from the Authority: an unprivileged,
read-only Node 22 container on the existing proxy network, with no published
container port. A private tmpfs control socket resets with the container.
The selected Wabi origin and bot credential are operator files outside Git.
The server’s system Node was not upgraded. The original proxy configuration
was backed up before adding only `/mcp`, OAuth discovery and `/project-plugin/*`
routes. The Authority container was not restarted.

For another installation, copy `integrations/wabi-project-plugin/compose.example.yml`
to an operator-owned directory, supply the two gateway scripts, protected
connection file and its own public origin/network/callback values. Use
`--auth-path /project-plugin` to keep authorization routes out of ordinary app
paths. The public metadata remains at the two `/.well-known/oauth-*` discovery
routes and points at the namespaced endpoints. A dedicated proxy origin is
also supported. The example container’s `--listen 0.0.0.0` applies only inside
its private Docker network; do not publish an unrestricted host port.

For the user’s deployed service, obtain a code in a private SSH terminal:

```bash
# On the connector host, in your own terminal:
docker exec -it wabi-project-plugin node wabi-project-plugin.mjs \
  --control /run/control/control.sock link
```

Codes expire after ten minutes; run that only when ready to link. Do not send
the code back to an AI. The test OAuth link was revoked; the configured bot
remains admitted only to disposable Project `ch_c72` for the personal trial.

## Install the personal plugin

Enable Developer mode in ChatGPT’s **Settings → Security and login** if the
account/workspace permits it. In **Plugins**, choose the plus button and add
the deployed `https://your-mcp.example/mcp` connection. Choose OAuth, complete
private linking, and check the discovered tools and connection identity. Then
enable the personal plugin for the assistant. Public-directory submission is a
separate process. These steps follow the
[official OpenAI quickstart](https://developers.openai.com/plugins/quickstart)
and [connection testing guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).

For a portable local/team package with the workflow skill:

```bash
node scripts/package-wabi-project-plugin.mjs \
  https://your-mcp.example/mcp /new/path/wabi-project-plugin
```

The generator refuses an existing output directory and produces `plugin.json`,
`mcp.json` and `skills/wabi-project/SKILL.md`. No bot token is included. Loading
a local package varies by product surface; connecting the MCP endpoint is the
personal ChatGPT route. Package generation does not itself install or publish
anything. If a registered OpenAI app mapping is required for a target surface,
use the real technical connection ID obtained after registration, never invent
one. See [official packaging guidance](https://developers.openai.com/plugins/build/plugins).

## Acceptance and limitations

```bash
node --test scripts/tests/wabi-project-mcp.test.mjs scripts/tests/wabi-project-plugin.test.mjs
```

With explicit authorization for a disposable Project only:

```bash
node scripts/wabi-project-plugin-smoke.mjs \
  /private/path/disposable-project.json /new/path/smoke-evidence.json
```

This creates one toy card and one wiki page, records their IDs, finishes the
toy card and checks read-back, stale edits, cross-Project arguments and gateway
revocation. It performs no model call. Existing evidence files are refused;
after a failure inspect the saved operation/IDs before any new attempt.

The actual Dot acceptance remains: profile/brief → create a disposable card →
claim → add evidence → Done → read back; then check access removal and stale
edits. Test actual tool selection and approval behavior in the account. A
direct HTTP/SDK test is not proof that Dot installed or selected the plugin.

The OAuth design uses PKCE S256, resource/client/redirect binding, single-use
authorization codes, explicit consent and cookie/Origin checks. Every Project
tool uses the existing bot API, so Wabi owns admission and write checks. Local
revocation stops new calls but cannot undo an accepted write or cancel an
upstream write already in flight. Retrieved Project/wiki text is untrusted.
The connection exposes no personal Planner, DMs, shell, Lore files, model
launches, native harness commands or automatic coding recovery. It transfers
selected Project tool results to the connected assistant’s hosting service.
See [official MCP authentication guidance](https://developers.openai.com/plugins/build/auth).
