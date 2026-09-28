# Service roles and the service gateway

Working-tree implementation, September 21, 2026. Service roles are additional
memberships for registered accounts. They never change `highestRole`, Lore
capabilities, server administrator rights, Tailcat device keys or Tailcat pipes.

## Admin Roles

Admin → Roles contains protected built-in role rows and custom service roles.
Create a custom role, open its Services checkboxes, and select Members in the
same row. Rename keeps its immutable ID and memberships. Delete removes the
role, its grants and memberships in one durable write; other roles still apply.
Built-in authority roles cannot be renamed, deleted or assigned through this
API. Their service picker applies to accounts whose **current exact effective
built-in role** matches. There is no implicit rank inheritance or admin bypass.
Custom grants are the union of all custom roles assigned to that account.
Guests and bots are ineligible. Unavailable members and removed services can
be unchecked without changing other grants.

Saving uses a catalog revision. Concurrent stale saves return 409 instead of
silently overwriting changes. Reload before trying again. Mutations are online
only, checked against live administrator authority and active registration.
They share the server membership gate with existing authority-role changes.

## Explicit endpoint registration

The host operator registers endpoints in `<data_dir>/service_endpoints.json`.
No file means no exposed services. Invalid files fail closed. Replace the file
atomically when editing it. For example (addresses are illustrative):

```json
[
  {"id":"office-printer","name":"Office printer","kind":"printing","address":"127.0.0.1:9100","exposed":false},
  {"id":"minecraft","name":"Minecraft","kind":"game","address":"127.0.0.1:25565","exposed":false},
  {"id":"remote-support","name":"Remote support","kind":"support","address":"127.0.0.1:5900","exposed":false}
]
```

Set `exposed` to true only for endpoints intended for this gateway. IDs are
stable lowercase ASCII letters/digits, hyphens or underscores, at most 64 bytes.
Names are at most 80 bytes, kinds at most 40, and there are at most 128 services.
`kind` is descriptive metadata; there is no hard-coded printer/game/support
permission set. Targets must be literal IPv4/IPv6 socket addresses with nonzero
ports. No DNS lookup, URL, redirect, wildcard destination or client-supplied
host is supported. Addresses are never included in the client catalog.

Use a new ID when replacing a service with a different trust boundary: reusing
an ID intentionally retains its old grants. The gateway connects from the
Authority host. Backend services must bind to loopback or be firewalled so
clients cannot bypass the gateway by connecting directly. A service role cannot
protect a printer/game/VNC port independently exposed on the LAN or Internet.

## API contract

All paths are under `/api`. Account credentials use `Authorization: Bearer …`;
refresh tokens, step-up tokens and bot credentials cannot access services.

- `GET /admin/service-access`: administrator-only `{access, services, members}`.
  `access = {schema:1, revision, updatedBy, roles}`; each role is
  `{id,name,services:string[],members:number[]}`. Built-ins have IDs
  `builtin:owner/admin/developer/mod/artist/member` and empty explicit members.
  Custom IDs are UUIDs. Service rows expose `{id,name,kind,exposed}`; member rows
  expose `{id,name}` for active registered accounts.
- `PUT /admin/service-access`: administrator-only `{revision,roles}` replaces
  the catalog atomically and returns the confirmed snapshot. Missing built-ins,
  duplicated IDs/names, newly unknown services/members and guest memberships
  are rejected. Retained orphan associations can be removed. Maximum 128 custom
  roles, 40 characters per name, 10,000 memberships per role, 1 MiB aggregate.
- `GET /services`: registered-account list of currently exposed and granted
  services, `{services:[{id,name,kind}]}`. This list is informational; it is not
  an access ticket.
- `GET /services/{id}/connect`: authenticated WebSocket upgrade. Binary frames
  carry a TCP byte stream to the one registered endpoint. Denial returns 403
  before opening the upstream. No token in a URL, no service-wide shared token,
  no arbitrary SOCKS destination. Native clients/integrations must set the
  Bearer header. Text frames close the connection. Ping/pong is supported.

The gateway rechecks account/token validity, endpoint exposure and current role
permission before opening TCP, before forwarding each payload, and every second
while idle. Grant changes serialize with forwarding; a completed revocation
cannot forward further bytes through that connection. Host-file changes and
account-token revocation are observed on the next check (they do not share the
role-write lock). Already-delivered bytes cannot be recalled. Upstream failures
close the WebSocket; a 101 upgrade alone does not prove upstream reachability.

Limits: 128 concurrent service connections per process, 64 KiB maximum frame
and message, 5-second connection/write deadlines, 5-minute payload-idle timeout.
TCP ordering and bytes are preserved, not application packet boundaries.

## Transport and product boundaries

Device admission → explicit Tailcat Wabi pipe → account authentication →
service exposure and role grant → configured TCP endpoint remain separate.
This feature does not enroll devices, open Tailcat ports, create subnet routes,
add UDP forwarding, provide E2EE, or grant admin actions. The existing Wabi
listener and its Tailcat forwarder still own transport admission. The service
operator/Authority can read traffic at their endpoints.

This change provides the permission UI, registry and tested TCP gateway API.
It does **not** automatically configure native printer drivers, Minecraft
clients or remote-desktop apps. Those require an authenticated local bridge or
an integration using this WebSocket contract; no native launcher/bridge UI is
included. UDP-only services are unsupported. Use HTTPS/WSS for access outside
an already encrypted private transport. No deployment or real-device service
certification is implied by local fixture tests.

## Persistence and compatibility

A new `service_access_replaced_v1` event and `service_access` JSON projection
store the whole versioned aggregate, with actor attribution. Existing RBAC,
user and postcard record layouts are unchanged. Old databases start with six
protected built-ins and zero grants; no old role gains service access during
upgrade. Normal WabiDB commit/replay restores grants and memberships. Malformed
projection data returns 503 and is never replaced with permissive defaults.
The host endpoint file is separate operator configuration; include it alongside
normal database backups. No operator file is created by opening Admin Roles.

Upgrade all Authority readers before writing the new event type. Downgrading
a database after new event writes to a binary unaware of the projection is not
supported; restore a pre-upgrade backup instead. Older clients retain existing
server-role behavior; the new UI reports unsupported servers explicitly.

## Validation

`cargo test -p wabi-server --test service_access_contract --test admin_role_contract --test tailcat_private_access_contract`
checks real TCP transfer, pre-connection denials, live grant deletion, exposure
separation, admin-only actions, malformed state, stale revisions and replay in
a fresh process. The ignored child fixture is invoked by the replay test.

`node frontend/scripts/service-roles-browser-smoke.mjs` renders the real component
in headful Chromium against an isolated API fixture. It covers inline CRUD,
checkboxes, conflicts, delete confirmation, mobile overflow and disconnected
editing. This complements backend enforcement tests; it is not a physical
printer/game/remote-support test.

A [physical Ronin-to-iRonin Tailcat check](../testing/TAILCAT_SERVICE_PORT_FIELD_2026-09-27.md)
used one disposable loopback HTTP endpoint to verify no grant → 403, an
explicit member grant → WebSocket 101 with real TCP response bytes, and
revocation → 403. A separate Tailcat-only probe reached Ronin's observed
RustDesk TCP listener through a device-limited port. The native RustDesk app
still needs an authenticated local bridge before Wabi service roles can
control its traffic; allowing its port directly in Tailcat does not apply a
Wabi account grant.
