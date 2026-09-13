# Wabi Multi-Server Client Model — Not Federation

**Status:** architectural product invariant  
**Updated:** 2026-09-14  
**Scope:** how one Wabi client can work with multiple independent Wabi servers.

This is separate from `SERVER_MESH_PLAN.md`, which discusses nodes/helpers inside **one** Wabi deployment.

## Core rule

**Wabi is a tool, not a mandatory service or federation network.**

A user can keep multiple Wabi communities in one client, similar to keeping several independent workspaces/accounts in one application. The convenience lives primarily in the client. It does not merge the servers into one distributed social graph.

```text
                         ┌─ Authority A (friends)
Wabi client / server bar ├─ Authority B (project)
                         └─ Authority C (class/community)

A, B, and C do not synchronize community state with each other.
```

## Independent trust boundaries

Each Authority owns its own:

- accounts and password/session state;
- owner/admin/moderator roles;
- channels and conversations;
- messages/files/workspaces;
- retention policies;
- plugins/integrations;
- backups and encryption keys;
- operator/legal/moderation policy.

A user may have different handles, roles, passwords, or even identities on different servers.

There is no global Wabi account database or global username registry.

## Client behavior

The Wabi client can remember server URLs and make switching communities fast. Depending on client/runtime implementation, it may also preserve per-server UI state or background notification connections.

The architectural guarantee is **not** “every client must keep all servers simultaneously connected forever.” The guarantee is that servers remain independently addressable and their credentials/state are scoped to the correct server.

Important client rules:

- credentials for Server A must never be sent to Server B;
- cached/draft/offline actions must include a server/account scope;
- switching servers must not merge channel/user identifiers by display name;
- server-local settings/permissions remain server-local;
- a failure on one Authority should not corrupt another server's local client state.

## What Wabi does not do

The multi-server UI is **not** Matrix/ActivityPub-style federation.

Independent Wabi servers do not currently provide:

- server-to-server DMs;
- shared channels across Authorities;
- globally unique Wabi identities;
- global presence;
- a global friend graph;
- automatic profile synchronization;
- shared moderation/ban lists;
- automatic state/database replication between different communities.

WabiDB replication work, where it exists, is for experimental **intra-deployment** state replication of one Authority's data. It must never be confused with social federation between unrelated communities.

## Cross-server friends: design invariant

A future “friend across my saved Wabi servers” experience may be useful, but the preferred design is **client-owned/non-federated**:

- the client may remember that two independently authenticated accounts belong to people the user wants grouped together;
- the relationship should not require the two Authorities to exchange their user databases;
- one server should not gain authority over another server's identity;
- the user should be able to remove the local relationship without mutating remote community state.

If Wabi ever intentionally adopts server-to-server social federation, that is a new protocol/security/privacy project and must not be smuggled in through a convenience feature.

## Per-server architecture

A normal Wabi community runs one `wabi-server` Authority containing:

- the embedded SvelteKit frontend;
- HTTP API;
- Socket.IO / WebSocket realtime services;
- WabiDB for that community's durable state;
- uploads and configured integrations.

Optional TURN/SFU/tunnel/Tailcat/helper services belong to that deployment's networking/feature topology; they do not combine independent communities.

## Authority / Anchor terminology

Do not confuse a user's saved independent servers with the experimental **Anchor** runtime.

An Anchor belongs to one deployment and proxies toward one Authority. It has no independent community identity/state. Current Anchor behavior is experimental and HTTP-oriented; it is not a federated peer.

See `SERVER_MESH_PLAN.md` and `../NETWORKING.md`.

## Privacy consequences

Because servers are independent:

- joining another server means trusting another operator;
- the second server does not inherit data/permissions from the first;
- a username match is not identity proof;
- the client must keep credentials and offline state correctly scoped;
- deleting an account on one server does not delete accounts on other servers.

This separation is a feature: compromise, policy mistakes, or downtime on one community should not automatically become compromise of a global Wabi identity/service.

## Cross-references

- `SERVER_MESH_PLAN.md` — intra-deployment Authority/helper/Anchor/replication work
- `ARCHITECTURE.md` / `overview.md` — server/client internals
- `../NETWORKING.md` — how a client reaches an Authority
- `../PROJECT_STATUS.md` — current shipped/experimental boundary
