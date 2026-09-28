# Host your Wabi community

Wabi runs one community on one Authority server. Your accounts, channels,
retained messages and uploads belong to that server. You can join other Wabi
servers from the same app; their accounts and data remain separate.

## Desktop hosting candidate

The current source includes a desktop hosting flow. This is a **release
candidate implementation**, not a claim that existing downloads contain it or
that installers have passed clean-machine acceptance. See
[desktop hosting](DESKTOP_HOSTING.md) for packaging and validation details.

A desktop package built from this source includes the server. Its users do not
need Git, Rust, Node, Docker or a separate database.

1. Open Wabi and choose **Host a community**.
2. Choose **Simple** for recommended settings or **Configurable** to open the
   full hosting settings after setup. Enter a community name, owner username
   and password. This computer stores and runs your community.
3. Create the community. Wabi starts its local server, checks that it is ready,
   creates the first owner and offers **Create invitation** and **Open community**.
   Simple invitations ask you to enable LAN sharing, detect this computer's
   private network address, and create a one-use link valid for 24 hours. If
   several addresses are found, choose the network your friend can reach.
4. Use **Open hosting settings** to stop or restart hosting and make a backup.
   After quitting and reopening Wabi, start the saved
   community from this screen; it reuses the same folder, identity and address.

Creating an owner is a local operation. Desktop communities require an
invitation for additional accounts. Hosting controls only work inside the
local desktop app; joining a server never starts another server.

## Understand reachability

| Mode | Who can connect | What to do |
| --- | --- | --- |
| Local only | This computer | The default. Complete owner setup here. |
| LAN sharing | Devices that can reach this computer's network interfaces | Simple detects private IPv4 addresses after explicit sharing confirmation. Several interfaces require a choice. Detection does not test reachability or open a firewall. |
| Internet hosting | People outside the LAN, after separate network setup | Configure a suitable HTTPS reverse proxy/tunnel and test from another network. The desktop app does not provision this automatically. |
| Private access | Enrolled clients on a separately configured private transport | Configure the transport and enrollment separately. An invitation alone does not establish a private connection. |

**LAN sharing uses HTTP.** Credentials, messages and uploads are not encrypted
in transit on that connection. Enable it only on a trusted network. The
listener accepts connections on all IPv4 interfaces, subject to your firewall;
it is not a firewall or a guarantee that only nearby devices can reach it.
Do not forward this HTTP port to the public internet. Sharing stays off until
an owner exists and returns to local-only when you quit and relaunch Wabi.
Changing sharing restarts the server and interrupts current connections.

To invite someone on your trusted network, choose **Create invitation** in
Simple mode and confirm sharing. Show the resulting one-use QR to the intended
person's system camera or copy the matching link; no IP entry is
needed for a single detected address. If none is found, connect to Wi-Fi or
Ethernet and retry. Configurable mode also accepts a reachable private HTTP
or public HTTPS address and lets you choose the invitation lifetime.
The recipient can scan the QR or choose **Join a community**, paste
the link, and create an account on that server. Existing members can sign in
using the server address. A loopback address such as `127.0.0.1` points to each
person's own computer and cannot be shared with someone on another device.

Invitations expire and admit one account. An interrupted account creation may
consume the invitation; the owner can create a replacement. Invitations do
not open router ports, provision tunnels or prove network reachability. The
host screen hides its link and QR when the displayed invitation expires.

Tailcat is bundled as an optional private transport for Wabi clients. Its
current enrollment requires an existing Wabi account and registered device
key. It is **not yet an automatic first-time invitation path**: a new guest
cannot open today's LAN invitation from anywhere just because Tailcat is
installed. Browser-only remote invitations need a reachable HTTPS endpoint.

Phone browsers require a secure context for geolocation, camera/microphone and
service workers; a plain LAN HTTP address does not provide one. Text connectivity
is not a calling or GPS test. Public access should use HTTPS, with calling/TURN
configuration and physical-device checks as separate work.

For the opt-in adult/test-account check-in board and no-internet mixed-phone
trial, see the [local field communications plan](../plans/2026-09-27-local-field-communications-trial.md).

## Linux runtime

The real Linux desktop app has passed local owner setup, invitations to a
second browser, restarts and native backup/restore. The app bundles the Rust
Authority; users do not need a language runtime or a database server. The GUI
uses Linux's GTK/WebKit runtime. `.deb`, `.rpm` and AppImage outputs are
configured, but installing the release-built packages on clean machines
remains an acceptance step. The locally built test executable is not a
portable Linux download.

Hosting lasts while Wabi and this computer are running. Always-on headless
Linux hosting uses the standalone Authority and an operator-managed service;
Simple desktop hosting does not install a system service or autostart at boot.

## Closing, quitting, sleeping and restarting

- Closing the desktop window hides Wabi in the system tray; a running community
  keeps running. Open it again from the tray.
- **Quit** in the tray stops the owned server cleanly before exiting. **Stop**
  stops the community while keeping Wabi open. Other members lose connectivity
  while the server is stopped.
- A sleeping or powered-off computer cannot serve its community.
- Wabi is not installed as a background system service and does not launch at
  computer startup. Reopen Wabi and start the saved community after a reboot.
- An interrupted shutdown preserves the data. If startup reports a recovery
  error, keep the folder and restore a complete backup; do not delete keys or
  lock files to make the error disappear.

## Data and backups

Hosting settings show the data folder and offer **Open hosting folder**. Each
operating-system user profile has one local hosted community. Joined servers
remain in **My communities**. Moving to a different account or computer is a
migration, not a fresh empty setup over the old files.

**Backup** briefly stops the server, copies its complete data (including keys
and uploads), checks file hashes and resumes hosting if it was running.
Snapshots appear in the hosting folder's `backups` directory. After stopping
hosting, copy the entire hosting folder, including `host.json` and the snapshots,
to another disk using your file manager. A copy on the same disk
protects against some mistakes, but not disk loss. Backups contain community
secrets and server-readable content; keep them private.

To restore an available snapshot, choose it in hosting settings and confirm.
Wabi validates the snapshot, stops hosting, restores through a staging folder
and keeps the previous data in `before-restore-…`. A failed startup retains
recovery files. It does not merge communities or delete the previous tree.
Keep the saved `host.json` with a full hosting-folder backup: it records the
community identity, local port and data location. Restoring on a different
machine currently needs an operator migration; see
[backup and recovery](BACKUP_AND_RECOVERY.md) and
[desktop hosting](DESKTOP_HOSTING.md).

Live messages are intentionally not retained. Timed messages follow their
retention period. A backup cannot recover content that was never stored or
already expired.

## If something goes wrong

| Message or symptom | Next step |
| --- | --- |
| Server missing from this installation | Install a matching desktop hosting package. Do not download an arbitrary server executable into the app folder. |
| Another app is managing this community | Return to the running Wabi app or quit it before starting a second copy. |
| Address/port already in use | Stop the other service using the saved port and retry. Wabi does not kill it or silently move your saved community address. |
| Folder unavailable or permission denied | Restore access to the folder shown in hosting settings, then retry. |
| Missing keys, damaged settings or incomplete storage | Keep all original files and restore a complete matching backup. Wabi refuses to silently create a replacement identity. |
| Server failed to start | Open the hosting folder and inspect `logs`, including startup diagnostics. Retain the folder when reporting the failure. |
| Another device cannot join | Confirm LAN sharing, the host's actual LAN address, the displayed port and firewall access. Check that both devices can reach each other. |

## Standalone server and containers

Operators can still run the same Authority without the desktop app. Use the
current [installation guide](INSTALL.md), [fresh-install guide](FRESH_INSTALL.md)
and [backup and recovery guide](BACKUP_AND_RECOVERY.md). The normal server uses
embedded WabiDB, not an external SQL or SpacetimeDB service. Container host ports
and native launch arguments must match the chosen configuration; desktop ports
are assigned on first use and then saved.

Wabi does not provide federation or production automatic failover. Experimental
Anchor, replication and standby work is described in
[project status](../PROJECT_STATUS.md). Server operators can read current
messages and DMs; private transport and retention do not make content E2EE.
