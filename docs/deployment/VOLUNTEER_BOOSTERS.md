# Network health and voluntary file boosters

Status: working-tree candidate, 2026-09-20. Not a release/deployment claim.

Wabi remains one Authority. Operator helpers and voluntary member contributions
are separate. A volunteer never receives Authority credentials, a database,
account-management privileges, a backup, or an election/failover role.

## Enable and volunteer

1. An owner/admin opens **Admin → Infrastructure → Volunteer boosters** and
   chooses **Allow members to volunteer**. It is disabled on a fresh server.
2. A registered member opens **Settings → Server → Boost this server**, chooses
   a device name, file-upload speed, memory-cache quota and session upload budget,
   explicitly accepts the network/data implications, then starts boosting.
3. Eligible attachments that member explicitly downloads enter the memory cache.
   Starting without cached files displays ready/empty, not useful contribution.
4. Other members may independently opt into **Try volunteer downloads** for this
   app session. This is optional and does not require volunteering.
5. **Stop boosting and clear cache** closes peer connections and clears cached
   files. Closing/reloading Wabi, signing out, switching server/account, losing
   the lease, or an admin stopping the session also ends contribution. It does
   not automatically restart. Restarting manually begins a new upload budget.

Controls apply to file payload. Connection/signaling overhead uses additional
data. Budget is per session, not per day or per account across devices. The
Authority permits at most four volunteer sessions per member and 128 total.

## What this version actually shares

- Explicit attachment downloads from the current server's `/uploads/` namespace.
  Inline image/audio/video loading retains its ordinary origin path.
- Files at most 8 MiB, already downloaded by the volunteer; at most 16 cached
  files, bounded by the selected 8–128 MiB memory quota.
- Five-minute cache expiry; files are not written to a volunteer disk by this
  feature. Browser/process memory accounting can exceed the cache quota.
- Both sender and receiver must currently have channel access. DMs and group
  DMs, untracked uploads, revoked files, external URLs, files without channel
  ownership, and oversize files do not enter the booster path.
- Authority-derived SHA-256 and exact size protect the recipient from a damaged
  or altered peer response. This is integrity checking, not operator-blind E2EE.
  Wabi's existing server-readable content model is unchanged.

The Authority performs access checks and issues 30-second transfer tickets. A
45-second heartbeat lease bounds disappearance of a crashed volunteer. The
browser renews its session, drops rejected inventory, and stops on renewal
failure. Already-started transfers may take until the next check to end after
remote revocation; stopping locally closes them immediately. Revocation cannot
recall bytes someone already downloaded.

## Transport and fallback

File data uses a WebRTC data channel directly between the consenting devices.
Only configured/explicitly opted-in STUN discovery is reused. TURN relaying is
not used for booster traffic: bouncing file data through the Authority's media
relay would undermine the bandwidth-offload purpose.

Direct transfers disclose peer network addresses. Home/mobile NAT, browser
restrictions, suspension and firewall rules can prevent a usable direct path.
There is no promise that every volunteer can help every recipient.

If no eligible cache exists, signaling fails, a peer leaves, the transfer times
out, or the hash/size fails, the download retries the original Authority URL.
The caller still sees an ordinary download failure if the Authority itself is
unavailable. A helper can offload file delivery; it is not a backup or a guarantee of faster downloads.

Small-file transfers are bounded to about 22 seconds including connection
setup. Candidates whose configured speed would need over 15 seconds for the
payload are skipped. Limits are enforced by the honest volunteer client; the
Authority additionally bounds inventory, sessions, ticket count, signaling size
and concurrent file hashing. This is not a sandbox for a malicious modified
client. Peers receive neither each other's bearer token nor the Authority key.

## Admin measurements

**Network health** refreshes every five seconds while visible:

- current device-to-Authority HTTP response time;
- Authority process RSS and CPU delta (100% = one logical core);
- total HTTP request count;
- per-interface receive/send rates in the server's network namespace.

Linux process/interface readers return unavailable when unsupported; CPU/rates
need a second sample. Interfaces include other applications and may count the
same packet at both physical and overlay layers. They are never summed or
presented as Wabi-only bandwidth. Remaining uplink capacity is not inferred.

The operator helper roster uses the current `/api/nodes` registry, including
freshness, declared capabilities, reported load, and Authority media-room
assignment/reported-active counts. A heartbeat or assignment does not establish
actual media delivery, capacity or bandwidth saved. Missing readings remain
unknown. Call diagnostics identify signaling round-trip time separately from
WebRTC round-trip time; neither is microphone-to-speaker delay.

Volunteer counters separate:

- volunteer-reported payload sent (including attempts);
- recipient-confirmed payload after the normal client verifies its hash;
- completed transfers, available sessions and cache inventory.

Authenticated recipients can lie about receipts; this is operational telemetry,
not billing or an independently audited bandwidth measurement. Aggregate counts
reset on Authority restart, and ended sessions disappear from the live roster.

Legacy `/api/relays` registration and Desktop Assist profiles do not start a
working Rust helper. Their automatic lifecycle and unverified file-URL rewrite
are disabled; old preferences are not silently converted into volunteer consent.

## Tailcat port and device controls

**Admin → Runtime → Private access** shows the private pipe port and its fixed
loopback Wabi destination. Admins can select an unused port 1024–65535 distinct
from the Wabi server port. The new socket is reserved before changing saved
settings, so conflicts preserve the old configuration. A successful change
rebinds the local forwarder and restarts private access, not the Authority.

Existing private connections must reconnect using the updated port. If the
admin page itself uses that connection, its save response may be interrupted;
check the resulting setting after reconnecting. This is explicitly explained by
the control. The instance still exposes only Wabi through this pipe; arbitrary
SSH/database/other-LAN service mappings are not supported by this candidate.

**Block** retains the key as denied, including re-registration under an equivalent
key encoding. **Allow** restores it. **Forget key** removes the record and allows
the member to register it again. These are device transport permissions; Wabi
account/channel permissions still apply. Keys are normalized and validated,
mutations are serialized, and the listener never starts without an allow-list.
The running badge identifies a live process, not verified remote reachability.

## Acceptance and boundaries

See [the implementation/acceptance record](../testing/NETWORK_BOOSTERS_2026-09-20.md).
Real-browser checks prove the direct file path and origin fallback locally and
in a [three-machine field run](../testing/BOOSTER_FIELD_TEST_2026-09-20.md).
That field run offloaded file payload over public UDP, but small-file peer
startup was slower than an origin download. Another tested network pair could
not establish a direct path and used the origin. These checks do not certify native WebKit,
mobile batteries, every home/mobile network, long-duration capacity,
physical calls, SFU offload, or generic mesh/workload sharing. No public service,
production deployment, or state replication is added by enabling volunteers.
